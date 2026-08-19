import { execFile, ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { EmbeddedWin32RuntimeSpec } from './embedded-runtime'

const READY_MARKER = '.dsh-desktop-ready'
const INSTALL_LOCK_TIMEOUT_MS = 10 * 60 * 1000
const STALE_LOCK_MS = 30 * 60 * 1000

export interface Win32Runtime {
  kind: 'win32'
  home: string
  nodePath: string
  dshScriptPath: string
  pathEnv: string
  cwd: string
  source: 'embedded'
  runtimeId: string
}

function assertWindowsAbsolutePath(name: string, value: string): string {
  const clean = value.trim()
  if (!path.win32.isAbsolute(clean) || /[\r\n\0]/.test(clean)) {
    throw new Error(`${name} 不是有效的 Windows 绝对路径：${JSON.stringify(value)}`)
  }
  return path.win32.normalize(clean)
}

export function defaultWin32RuntimeRoot(): string {
  const localAppData = process.env.LOCALAPPDATA
    ? assertWindowsAbsolutePath('LOCALAPPDATA', process.env.LOCALAPPDATA)
    : path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'DSH Desktop', 'runtimes')
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function execFileText(
  command: string,
  args: string[],
  timeout: number,
  onChild?: (child: ChildProcess | null) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024,
        env,
      },
      (error, stdout, stderr) => {
        onChild?.(null)
        if (error) {
          const detailed = error as Error & { stderr?: string }
          detailed.stderr = stderr
          reject(detailed)
        } else {
          resolve(stdout.trim())
        }
      },
    )
    onChild?.(child)
  })
}

function lockOwnerIsAlive(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { pid?: unknown; createdAt?: unknown }
    if (!Number.isSafeInteger(parsed.pid) || typeof parsed.createdAt !== 'number') return false
    if (Date.now() - parsed.createdAt > STALE_LOCK_MS) return false
    process.kill(parsed.pid as number, 0)
    return true
  } catch {
    return false
  }
}

async function acquireInstallLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await fs.promises.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      )
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      let owner = ''
      try {
        owner = await fs.promises.readFile(lockPath, 'utf8')
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') throw readErr
      }
      if (owner && !lockOwnerIsAlive(owner)) {
        await fs.promises.unlink(lockPath).catch((unlinkErr: NodeJS.ErrnoException) => {
          if (unlinkErr.code !== 'ENOENT') throw unlinkErr
        })
        continue
      }
      if (Date.now() >= deadline) throw new Error('等待 Windows 运行时部署锁超时')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

async function runtimeIsReady(
  runtimeDirectory: string,
  fingerprint: string,
): Promise<boolean> {
  try {
    const marker = await fs.promises.readFile(path.join(runtimeDirectory, READY_MARKER), 'utf8')
    if (marker.trim() !== fingerprint) return false
    const nodeStat = await fs.promises.stat(path.join(runtimeDirectory, 'node.exe'))
    const dshStat = await fs.promises.stat(
      path.join(runtimeDirectory, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    )
    return nodeStat.isFile() && dshStat.isFile()
  } catch {
    return false
  }
}

async function removeStaleTemporaryDirectories(
  runtimeRoot: string,
  runtimeId: string,
): Promise<number> {
  const prefix = `.${runtimeId}.tmp.`
  let removed = 0
  for (const entry of await fs.promises.readdir(runtimeRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) {
      await fs.promises.rm(path.join(runtimeRoot, entry.name), { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

function commandErrorMessage(err: unknown): string {
  const error = err as Error & { stderr?: Buffer | string }
  const stderr = error.stderr == null ? '' : String(error.stderr).trim()
  return stderr && !error.message.includes(stderr)
    ? `${error.message}\n${stderr}`
    : error.message
}

/**
 * 用户明确选择 Windows 本机模式后，把受校验的内嵌运行时原子部署到 LocalAppData。
 * 用户数据仍使用 %USERPROFILE%\.dsh，不会写入运行时目录。
 */
export async function provisionWin32Runtime(
  embeddedRuntime: EmbeddedWin32RuntimeSpec,
  onChild?: (child: ChildProcess | null) => void,
  onLog?: (message: string) => void,
): Promise<Win32Runtime> {
  const runtimeRoot = process.env.DSH_WIN_RUNTIME_ROOT
    ? assertWindowsAbsolutePath('DSH_WIN_RUNTIME_ROOT', process.env.DSH_WIN_RUNTIME_ROOT)
    : defaultWin32RuntimeRoot()
  const home = process.env.DSH_WIN_HOME
    ? assertWindowsAbsolutePath('DSH_WIN_HOME', process.env.DSH_WIN_HOME)
    : path.join(os.homedir(), '.dsh')
  const cwd = process.env.DSH_WIN_CWD
    ? assertWindowsAbsolutePath('DSH_WIN_CWD', process.env.DSH_WIN_CWD)
    : os.homedir()
  await fs.promises.mkdir(runtimeRoot, { recursive: true })
  await fs.promises.mkdir(home, { recursive: true })
  const cwdStat = await fs.promises.stat(cwd).catch(() => null)
  if (!cwdStat?.isDirectory()) throw new Error(`Windows 工作目录不存在：${cwd}`)

  const runtimeDirectory = path.join(runtimeRoot, embeddedRuntime.runtimeId)
  const fingerprint = [
    embeddedRuntime.archiveSha256,
    embeddedRuntime.nodeVersion,
    embeddedRuntime.dshVersion,
  ].join('|')
  if (!(await runtimeIsReady(runtimeDirectory, fingerprint))) {
    const lockPath = path.join(runtimeRoot, `.install-${embeddedRuntime.runtimeId}.lock`)
    onLog?.(`等待 Windows 运行时部署锁：${lockPath}`)
    await acquireInstallLock(lockPath)
    onLog?.('已取得 Windows 运行时部署锁')
    try {
      if (!(await runtimeIsReady(runtimeDirectory, fingerprint))) {
        const staleCount = await removeStaleTemporaryDirectories(
          runtimeRoot,
          embeddedRuntime.runtimeId,
        )
        if (staleCount > 0) onLog?.(`已清理 ${staleCount} 个中断的 Windows 运行时临时目录`)
        onLog?.('正在校验 Windows 运行时归档大小与 SHA-256')
        const archiveStat = await fs.promises.stat(embeddedRuntime.archivePath)
        if (!archiveStat.isFile() || archiveStat.size !== embeddedRuntime.archiveSize) {
          throw new Error('Windows 内嵌运行时归档大小不匹配')
        }
        const actualSha = await sha256File(embeddedRuntime.archivePath)
        if (actualSha !== embeddedRuntime.archiveSha256) {
          throw new Error(`Windows 内嵌运行时 SHA-256 不匹配：${actualSha}`)
        }
        const temporaryDirectory = path.join(
          runtimeRoot,
          `.${embeddedRuntime.runtimeId}.tmp.${process.pid}.${Date.now()}`,
        )
        let backupDirectory = ''
        await fs.promises.mkdir(temporaryDirectory, { recursive: false, mode: 0o700 })
        try {
          onLog?.(`正在解压 Windows 运行时：${temporaryDirectory}`)
          const extractorScript = path.join(__dirname, 'extract-runtime.js')
          const extractorResult = await execFileText(
            process.execPath,
            [extractorScript, embeddedRuntime.archivePath, temporaryDirectory],
            10 * 60 * 1000,
            onChild,
            {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
              FORCE_COLOR: '0',
            },
          )
          if (!/^EXTRACTED=\d+$/.test(extractorResult)) {
            throw new Error(`Windows 运行时解压器返回了意外结果：${extractorResult}`)
          }
          const nodePath = path.join(temporaryDirectory, 'node.exe')
          const dshScriptPath = path.join(
            temporaryDirectory,
            'lib',
            'node_modules',
            '@deepseek-ai',
            'dsh',
            'lib',
            'bin.js',
          )
          onLog?.('正在验证 Windows 内嵌 Node.js 与 dsh 版本')
          const nodeVersion = await execFileText(nodePath, ['--version'], 10000, onChild)
          if (nodeVersion !== `v${embeddedRuntime.nodeVersion}`) {
            throw new Error(`Windows 内嵌 Node.js 版本不匹配：${nodeVersion}`)
          }
          const dshVersion = await execFileText(
            nodePath,
            [dshScriptPath, '--version'],
            30000,
            onChild,
          )
          if (dshVersion !== embeddedRuntime.dshVersion) {
            throw new Error(`Windows 内嵌 dsh 版本不匹配：${dshVersion}`)
          }
          await fs.promises.writeFile(
            path.join(temporaryDirectory, READY_MARKER),
            `${fingerprint}\n`,
            { encoding: 'utf8', mode: 0o600 },
          )

          if (await fs.promises.stat(runtimeDirectory).catch(() => null)) {
            backupDirectory = path.join(
              runtimeRoot,
              `.${embeddedRuntime.runtimeId}.replaced.${process.pid}.${Date.now()}`,
            )
            await fs.promises.rename(runtimeDirectory, backupDirectory)
          }
          await fs.promises.rename(temporaryDirectory, runtimeDirectory)
          onLog?.(`Windows 运行时已部署：${runtimeDirectory}`)
          if (backupDirectory) {
            await fs.promises.rm(backupDirectory, { recursive: true, force: true })
            backupDirectory = ''
          }
        } catch (err) {
          await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {})
          if (backupDirectory && !(await fs.promises.stat(runtimeDirectory).catch(() => null))) {
            await fs.promises.rename(backupDirectory, runtimeDirectory).catch(() => {})
          }
          throw err
        }
      }
    } catch (err) {
      throw new Error(`无法准备 Windows 本机内嵌运行时：${commandErrorMessage(err)}`)
    } finally {
      await fs.promises.unlink(lockPath).catch(() => {})
    }
  } else {
    onLog?.(`复用已部署的 Windows 运行时：${runtimeDirectory}`)
  }

  const nodePath = path.join(runtimeDirectory, 'node.exe')
  const dshScriptPath = path.join(
    runtimeDirectory,
    'lib',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )
  const pathEnv = [path.dirname(nodePath), process.env.PATH || ''].filter(Boolean).join(path.delimiter)
  return {
    kind: 'win32',
    home,
    nodePath,
    dshScriptPath,
    pathEnv,
    cwd,
    source: 'embedded',
    runtimeId: embeddedRuntime.runtimeId,
  }
}
