import { spawn, execFile, ChildProcess } from 'child_process'
import type { EmbeddedRuntimeSpec, EmbeddedWin32RuntimeSpec } from './embedded-runtime'
import { provisionWin32Runtime } from './native-runtime'
import type { Win32Runtime } from './native-runtime'

export interface DshCallbacks {
  onUrl(url: string): void
  onExit(code: number | null): void
  onError(message: string): void
  onLog?(line: string): void
  onStage?(stage: 'runtime' | 'interface', message: string): void
}

interface WslRuntime {
  kind: 'wsl'
  distro: string
  home: string
  nodePath: string
  dshScriptPath: string
  pathEnv: string
  cwd: string
  source: 'embedded' | 'external'
  runtimeId: string
}

interface ResolvedCommand {
  command: string
  args: string[]
  runtime: WslRuntime | Win32Runtime
  env: NodeJS.ProcessEnv
}

export type DshRuntimeSelection =
  | { mode: 'wsl'; embeddedRuntime: EmbeddedRuntimeSpec }
  | { mode: 'win32'; embeddedRuntime: EmbeddedWin32RuntimeSpec }

export interface WslAvailability {
  available: boolean
  distro: string
  reason?: string
}

const DEFAULT_WSL_DISTRO = 'Ubuntu'
const DEFAULT_WSL_CWD = '/mnt/d/DeepSeekHarness'
const LINUX_PID_PREFIX = '__DSH_LINUX_PID__='
const NODE_USE_ENV_PROXY_VALUE = '1'

/**
 * Node 24 的内置 fetch 默认不会读取 HTTP_PROXY / HTTPS_PROXY。
 * 桌面端统一开启环境代理支持，使 WSL autoProxy、企业代理和显式代理变量真正生效。
 */
export function nodeProxyAssignment(): string {
  return `NODE_USE_ENV_PROXY=${NODE_USE_ENV_PROXY_VALUE}`
}

export function withNodeEnvironmentProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, NODE_USE_ENV_PROXY: NODE_USE_ENV_PROXY_VALUE }
}

function assertLinuxPath(name: string, value: string): string {
  const clean = value.trim()
  if (!clean.startsWith('/') || /[\r\n\0]/.test(clean)) {
    throw new Error(`${name} 不是有效的 Linux 绝对路径：${JSON.stringify(value)}`)
  }
  return clean
}

function parseProbe(output: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1))
  }
  return values
}

function commandErrorMessage(err: unknown): string {
  const error = err as Error & { stderr?: Buffer | string }
  const stderr = error.stderr == null ? '' : String(error.stderr).trim()
  return stderr ? `${error.message}\n${stderr}` : error.message
}

function execFileText(
  args: string[],
  timeout: number,
  onChild?: (child: ChildProcess | null) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'wsl.exe',
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        onChild?.(null)
        if (error) {
          const execError = error as Error & { stderr?: string }
          execError.stderr = stderr
          reject(error)
        } else {
          resolve(stdout)
        }
      },
    )
    onChild?.(child)
  })
}

/** 只做轻量探测，不部署运行时；用于决定是否需要征求 Windows 本机模式授权。 */
export async function detectWslAvailability(
  onChild?: (child: ChildProcess | null) => void,
): Promise<WslAvailability> {
  const distro = (process.env.DSH_WSL_DISTRO || DEFAULT_WSL_DISTRO).trim()
  if (!distro || /[\r\n\0]/.test(distro)) {
    return { available: false, distro, reason: 'DSH_WSL_DISTRO 无效' }
  }
  if (process.env.DSH_TEST_WSL_UNAVAILABLE === '1') {
    return { available: false, distro, reason: '测试模式：模拟 WSL 不可用' }
  }
  try {
    const output = await execFileText(
      ['-d', distro, '--exec', '/bin/sh', '-c', "printf 'dsh-wsl-ready'"],
      15000,
      onChild,
    )
    if (output.trim() !== 'dsh-wsl-ready') {
      return { available: false, distro, reason: 'WSL 探测返回了意外结果' }
    }
    return { available: true, distro }
  } catch (err) {
    return {
      available: false,
      distro,
      reason: commandErrorMessage(err),
    }
  }
}

/**
 * Provision and probe the immutable runtime embedded in the desktop package.
 * DSH_WSL_NODE and DSH_WSL_DSH_SCRIPT must be supplied together to opt into
 * an external development runtime.
 */
async function probeWslRuntime(
  embeddedRuntime: EmbeddedRuntimeSpec,
  onChild?: (child: ChildProcess | null) => void,
): Promise<WslRuntime> {
  const distro = (process.env.DSH_WSL_DISTRO || DEFAULT_WSL_DISTRO).trim()
  if (!distro || /[\r\n\0]/.test(distro)) throw new Error('DSH_WSL_DISTRO 无效')

  const externalNodeRaw = (process.env.DSH_WSL_NODE || '').trim()
  const externalDshRaw = (process.env.DSH_WSL_DSH_SCRIPT || '').trim()
  if (!!externalNodeRaw !== !!externalDshRaw) {
    throw new Error('DSH_WSL_NODE 与 DSH_WSL_DSH_SCRIPT 必须同时设置')
  }
  const externalNode = externalNodeRaw
    ? assertLinuxPath('DSH_WSL_NODE', externalNodeRaw)
    : ''
  const externalDsh = externalDshRaw
    ? assertLinuxPath('DSH_WSL_DSH_SCRIPT', externalDshRaw)
    : ''
  const runtimeRootOverride = process.env.DSH_WSL_RUNTIME_ROOT
    ? assertLinuxPath('DSH_WSL_RUNTIME_ROOT', process.env.DSH_WSL_RUNTIME_ROOT)
    : ''

  const probe = String.raw`set -eu
home="$HOME"
archive_windows="$1"
expected_sha="$2"
runtime_id="$3"
expected_node="$4"
expected_dsh="$5"
external_node="$6"
external_dsh="$7"
runtime_root_override="$8"

if [ -n "$external_node" ] || [ -n "$external_dsh" ]; then
  if [ -z "$external_node" ] || [ -z "$external_dsh" ]; then
    echo 'external Node and dsh paths must be supplied together' >&2
    exit 1
  fi
  node_path="$external_node"
  dsh_script="$external_dsh"
  runtime_path="$(dirname "$node_path"):$home/.local/bin:$PATH"
  runtime_source='external'
  runtime_label='external'
else
  case "$runtime_id" in
    ''|*[!a-z0-9._-]*) echo 'invalid embedded runtime id' >&2; exit 1 ;;
  esac
  for required_command in wslpath sha256sum tar flock; do
    command -v "$required_command" >/dev/null || {
      echo "WSL is missing required command: $required_command" >&2
      exit 1
    }
  done

  runtime_root="$runtime_root_override"
  if [ -z "$runtime_root" ]; then
    runtime_root="$home/.local/share/dsh-desktop/runtimes"
  fi
  case "$runtime_root" in
    /*) ;;
    *) echo 'runtime root must be an absolute Linux path' >&2; exit 1 ;;
  esac
  mkdir -p -- "$runtime_root"

  runtime_dir="$runtime_root/$runtime_id"
  marker_path="$runtime_dir/.dsh-desktop-ready"
  fingerprint="$expected_sha|$expected_node|$expected_dsh"
  runtime_ready() {
    [ -f "$marker_path" ] &&
      IFS= read -r marker_value <"$marker_path" &&
      [ "$marker_value" = "$fingerprint" ] &&
      [ -x "$runtime_dir/bin/node" ] &&
      [ -f "$runtime_dir/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" ]
  }

  if ! runtime_ready; then
    lock_path="$runtime_root/.install-$runtime_id.lock"
    exec 9>"$lock_path"
    flock -w 120 9 || { echo 'timed out waiting for embedded runtime install lock' >&2; exit 1; }

    if ! runtime_ready; then
      archive_path="$(wslpath -a -u "$archive_windows")"
      [ -f "$archive_path" ] || { echo "embedded runtime archive not found: $archive_path" >&2; exit 1; }
      actual_sha="$(sha256sum "$archive_path" | awk '{print $1}')"
      [ "$actual_sha" = "$expected_sha" ] || {
        echo "embedded runtime SHA-256 mismatch: $actual_sha" >&2
        exit 1
      }

      temp_dir="$runtime_root/.$runtime_id.tmp.$$"
      [ ! -e "$temp_dir" ] || { echo "temporary runtime path already exists: $temp_dir" >&2; exit 1; }
      mkdir -m 0700 -- "$temp_dir"
      cleanup_temp() {
        if [ -n "$temp_dir" ] && [ -d "$temp_dir" ]; then
          rm -rf -- "$temp_dir"
        fi
      }
      trap cleanup_temp EXIT HUP INT TERM

      tar --no-same-owner -xzf "$archive_path" -C "$temp_dir"
      chmod 0755 "$temp_dir/bin/node"
      [ "$("$temp_dir/bin/node" --version)" = "v$expected_node" ] || {
        echo 'embedded Node.js version check failed' >&2
        exit 1
      }
      [ "$("$temp_dir/bin/node" \
        "$temp_dir/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" --version)" = "$expected_dsh" ] || {
        echo 'embedded dsh version check failed' >&2
        exit 1
      }
      printf '%s\n' "$fingerprint" >"$temp_dir/.dsh-desktop-ready"

      backup_dir=''
      if [ -e "$runtime_dir" ]; then
        backup_dir="$runtime_root/.$runtime_id.replaced.$$.$(date +%s)"
        mv -- "$runtime_dir" "$backup_dir"
      fi
      if ! mv -- "$temp_dir" "$runtime_dir"; then
        if [ -n "$backup_dir" ] && [ -e "$backup_dir" ]; then
          mv -- "$backup_dir" "$runtime_dir" || true
        fi
        exit 1
      fi
      temp_dir=''
      trap - EXIT HUP INT TERM
    fi
  fi

  node_path="$runtime_dir/bin/node"
  dsh_script="$runtime_dir/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
  runtime_path="$runtime_dir/bin:$home/.local/bin:$PATH"
  runtime_source='embedded'
  runtime_label="$runtime_id"
fi
default_cwd="$home"
if [ -d "$9" ]; then
  default_cwd="$9"
fi
printf 'HOME=%s\nNODE=%s\nDSH_SCRIPT=%s\nPATH=%s\nCWD=%s\nSOURCE=%s\nRUNTIME_ID=%s\n' \
  "$home" "$node_path" "$dsh_script" "$runtime_path" "$default_cwd" "$runtime_source" "$runtime_label"`

  let output: string
  try {
    output = await execFileText(
      [
        '-d',
        distro,
        '--exec',
        '/bin/sh',
        '-c',
        probe,
        'dsh-desktop-provision',
        embeddedRuntime.archivePath,
        embeddedRuntime.archiveSha256,
        embeddedRuntime.runtimeId,
        embeddedRuntime.nodeVersion,
        embeddedRuntime.dshVersion,
        externalNode,
        externalDsh,
        runtimeRootOverride,
        DEFAULT_WSL_CWD,
      ],
      180000,
      onChild,
    )
  } catch (err) {
    throw new Error(`无法在 WSL 发行版 ${distro} 中准备内嵌运行时：${commandErrorMessage(err)}`)
  }

  const values = parseProbe(output)
  const home = assertLinuxPath('WSL HOME', process.env.DSH_WSL_HOME || values.get('HOME') || '')
  const nodePath = assertLinuxPath('WSL Node', process.env.DSH_WSL_NODE || values.get('NODE') || '')
  const dshScriptPath = assertLinuxPath(
    'WSL dsh 脚本',
    process.env.DSH_WSL_DSH_SCRIPT || values.get('DSH_SCRIPT') || '',
  )
  const pathEnv = (process.env.DSH_WSL_PATH || values.get('PATH') || '').trim()
  if (!pathEnv || /[\r\n\0]/.test(pathEnv)) throw new Error('WSL PATH 探测失败')
  const cwd = assertLinuxPath(
    'WSL 工作目录',
    process.env.DSH_WSL_CWD || values.get('CWD') || home,
  )
  const source = values.get('SOURCE')
  if (source !== 'embedded' && source !== 'external') throw new Error('WSL 运行时来源探测失败')
  const runtimeId = (values.get('RUNTIME_ID') || '').trim()
  if (!runtimeId || /[\r\n\0]/.test(runtimeId)) throw new Error('WSL runtime id 探测失败')
  if (source === 'embedded' && runtimeId !== embeddedRuntime.runtimeId) {
    throw new Error(`WSL 内嵌 runtime id 不匹配：${runtimeId}`)
  }

  const verify = String.raw`set -eu
test -x "$1"
test -f "$2"
test -d "$3"`
  try {
    await execFileText(
      [
        '-d',
        distro,
        '--exec',
        '/bin/sh',
        '-c',
        verify,
        'dsh-desktop-verify',
        nodePath,
        dshScriptPath,
        cwd,
      ],
      10000,
      onChild,
    )
  } catch {
    throw new Error(
      `WSL 中未找到可用的 Linux 原生 dsh 或工作目录（Node=${nodePath}, dsh=${dshScriptPath}, cwd=${cwd}）`,
    )
  }

  return { kind: 'wsl', distro, home, nodePath, dshScriptPath, pathEnv, cwd, source, runtimeId }
}

export async function resolveDsh(
  embeddedRuntime: EmbeddedRuntimeSpec,
  extraArgs: string[] = [],
  onProbeChild?: (child: ChildProcess | null) => void,
): Promise<ResolvedCommand> {
  const runtime = await probeWslRuntime(embeddedRuntime, onProbeChild)
  const appArgs = ['web', '--port', '0', ...extraArgs]

  // setsid gives this desktop-owned dsh an isolated Linux process group. The
  // wrapper prints its PID before waiting, so stop() can terminate only that
  // group without shutting down the whole WSL distribution.
  const launcher = String.raw`set -eu
/usr/bin/setsid "$@" &
dsh_pid=$!
printf '${LINUX_PID_PREFIX}%s\n' "$dsh_pid"
wait "$dsh_pid"`

  return {
    command: 'wsl.exe',
    args: [
      '-d',
      runtime.distro,
      '--cd',
      runtime.cwd,
      '--exec',
      '/bin/sh',
      '-c',
      launcher,
      'dsh-desktop-launcher',
      '/usr/bin/env',
      `DSH_HOME=${runtime.home}/.dsh`,
      `PATH=${runtime.pathEnv}`,
      nodeProxyAssignment(),
      runtime.nodePath,
      runtime.dshScriptPath,
      ...appArgs,
    ],
    runtime,
    env: withNodeEnvironmentProxy({ ...process.env, FORCE_COLOR: '0' }),
  }
}

async function resolveWin32Dsh(
  embeddedRuntime: EmbeddedWin32RuntimeSpec,
  extraArgs: string[] = [],
  onProbeChild?: (child: ChildProcess | null) => void,
  onLog?: (message: string) => void,
): Promise<ResolvedCommand> {
  const runtime = await provisionWin32Runtime(embeddedRuntime, onProbeChild, onLog)
  return {
    command: runtime.nodePath,
    args: [runtime.dshScriptPath, 'web', '--port', '0', ...extraArgs],
    runtime,
    env: withNodeEnvironmentProxy({
      ...process.env,
      DSH_HOME: runtime.home,
      PATH: runtime.pathEnv,
      FORCE_COLOR: '0',
    }),
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs)
    child.once('exit', onExit)
  })
}

async function terminateWindowsChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return
  const pid = child.pid
  if (pid && process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    })
  } else {
    try {
      child.kill()
    } catch {
      // already exited
    }
  }
  await waitForExit(child, 1500)
}

function runWslKill(runtime: WslRuntime, pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-d', runtime.distro, '--exec', '/usr/bin/kill', `-${signal}`, '--', `-${pid}`],
      { windowsHide: true },
      () => resolve(),
    )
  })
}

/**
 * dsh web 生命周期：根据用户选择准备 WSL 或 Windows 内嵌运行时，解析动态 URL，
 * 退出时只清理本桌面实例创建的进程树。
 */
export class DshProcess {
  private child: ChildProcess | null = null
  private provisionChild: ChildProcess | null = null
  private runtime: WslRuntime | Win32Runtime | null = null
  private linuxPid: number | null = null
  private stopped = false
  private urlSent = false

  constructor(
    private readonly callbacks: DshCallbacks,
    private readonly selection: DshRuntimeSelection,
  ) {}

  start(extraArgs: string[] = []): void {
    void this.prepareAndStart(extraArgs)
  }

  private async prepareAndStart(extraArgs: string[]): Promise<void> {
    let resolved: ResolvedCommand
    this.callbacks.onStage?.(
      'runtime',
      this.selection.mode === 'wsl'
        ? '正在准备 WSL 内嵌运行时…'
        : '正在准备 Windows 本机运行时…',
    )
    try {
      resolved = this.selection.mode === 'wsl'
        ? await resolveDsh(
          this.selection.embeddedRuntime,
          extraArgs,
          (child) => { this.provisionChild = child },
        )
        : await resolveWin32Dsh(
          this.selection.embeddedRuntime,
          extraArgs,
          (child) => { this.provisionChild = child },
          (message) => {
            this.callbacks.onLog?.(message)
            if (message.startsWith('正在校验 Windows 运行时归档')) {
              this.callbacks.onStage?.('runtime', '正在校验 Windows 运行时归档…')
            } else if (message.startsWith('正在解压 Windows 运行时')) {
              this.callbacks.onStage?.('runtime', '正在部署 Windows 本机运行时…')
            } else if (message.startsWith('正在验证 Windows 内嵌')) {
              this.callbacks.onStage?.('runtime', '正在验证 Windows 内嵌运行时…')
            } else if (message.startsWith('复用已部署的 Windows 运行时')) {
              this.callbacks.onStage?.('runtime', '正在校验已部署的 Windows 运行时…')
            }
          },
        )
    } catch (err) {
      if (this.stopped) return
      if (this.selection.mode === 'wsl') {
        this.callbacks.onError(
          `无法启动 WSL2 中的内嵌 dsh。\n${(err as Error).message}\n\n` +
            '请确认 WSL2 与 Ubuntu 发行版可用。安装包已包含 Node.js 与 dsh，无需另行 npm install。\n\n' +
            '可用 DSH_WSL_DISTRO 指定发行版；开发调试时可同时设置 ' +
            'DSH_WSL_NODE / DSH_WSL_DSH_SCRIPT。',
        )
      } else {
        this.callbacks.onError(
          `无法启动 Windows 本机内嵌 dsh。\n${(err as Error).message}\n\n` +
            '该模式只部署桌面程序自带的 Node.js 与 dsh，不会安装全局 npm 包。' +
            '可用 DSH_WIN_RUNTIME_ROOT / DSH_WIN_HOME / DSH_WIN_CWD 指定调试目录。',
        )
      }
      return
    }
    if (this.stopped) return

    this.runtime = resolved.runtime
    this.callbacks.onStage?.('interface', '正在启动本地界面…')
    if (resolved.runtime.kind === 'wsl') {
      this.callbacks.onLog?.(
        `启动 WSL dsh (${resolved.runtime.distro}, ${resolved.runtime.source}:${resolved.runtime.runtimeId}): ` +
          `${resolved.runtime.nodePath} ${resolved.runtime.dshScriptPath} web --port 0`,
      )
    } else {
      this.callbacks.onLog?.(
        `启动 Windows 本机 dsh (${resolved.runtime.source}:${resolved.runtime.runtimeId}): ` +
          `${resolved.runtime.nodePath} ${resolved.runtime.dshScriptPath} web --port 0`,
      )
    }

    const child = spawn(resolved.command, resolved.args, {
      windowsHide: true,
      shell: false,
      env: resolved.env,
    })
    this.child = child

    const handleLine = (line: string) => {
      if (!line) return
      if (line.startsWith(LINUX_PID_PREFIX)) {
        const pid = Number(line.slice(LINUX_PID_PREFIX.length))
        if (Number.isSafeInteger(pid) && pid > 1) {
          this.linuxPid = pid
          this.callbacks.onLog?.(`WSL dsh 进程组: ${pid}`)
        }
        return
      }
      this.callbacks.onLog?.(line)
      if (!this.urlSent) {
        const match = line.match(/https?:\/\/[^\s"'<>]+/i)
        if (match) {
          this.urlSent = true
          this.callbacks.onUrl(match[0].replace(/[.,;)\]]+$/, ''))
        }
      }
    }

    const attach = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return
      let pending = ''
      stream.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8')
        for (;;) {
          const at = pending.indexOf('\n')
          if (at < 0) break
          handleLine(pending.slice(0, at).replace(/\r$/, ''))
          pending = pending.slice(at + 1)
        }
      })
      stream.on('end', () => handleLine(pending.replace(/\r$/, '')))
    }
    attach(child.stdout)
    attach(child.stderr)

    child.on('error', (err) => this.callbacks.onError(`启动失败：${err.message}`))
    child.on('exit', (code) => {
      if (!this.stopped) this.callbacks.onExit(code)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    const provisionChild = this.provisionChild
    if (provisionChild && !hasExited(provisionChild)) {
      await terminateWindowsChild(provisionChild)
    }
    this.provisionChild = null

    const child = this.child
    if (!child || hasExited(child)) return

    if (this.runtime?.kind === 'wsl' && this.linuxPid) {
      await runWslKill(this.runtime, this.linuxPid, 'TERM')
      if (await waitForExit(child, 4000)) return
      await runWslKill(this.runtime, this.linuxPid, 'KILL')
      if (await waitForExit(child, 2000)) return
    }

    // The Linux process should already be gone. This only closes a stuck
    // wsl.exe wrapper and never terminates the Ubuntu distribution itself.
    await terminateWindowsChild(child)
  }
}
