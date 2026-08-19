import { spawn, execFile, execFileSync, ChildProcess } from 'child_process'

export interface DshCallbacks {
  onUrl(url: string): void
  onExit(code: number | null): void
  onError(message: string): void
  onLog?(line: string): void
}

interface WslRuntime {
  distro: string
  home: string
  nodePath: string
  dshScriptPath: string
  pathEnv: string
  cwd: string
}

interface ResolvedCommand {
  command: string
  args: string[]
  runtime: WslRuntime
}

const DEFAULT_WSL_DISTRO = 'Ubuntu'
const DEFAULT_WSL_CWD = '/mnt/d/DeepSeekHarness'
const LINUX_PID_PREFIX = '__DSH_LINUX_PID__='

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

/**
 * Probe a native Linux dsh runtime inside WSL2. Environment overrides accept
 * Linux paths: DSH_WSL_DISTRO, DSH_WSL_HOME, DSH_WSL_NODE,
 * DSH_WSL_DSH_SCRIPT, DSH_WSL_PATH, and DSH_WSL_CWD.
 */
function probeWslRuntime(): WslRuntime {
  const distro = (process.env.DSH_WSL_DISTRO || DEFAULT_WSL_DISTRO).trim()
  if (!distro || /[\r\n\0]/.test(distro)) throw new Error('DSH_WSL_DISTRO 无效')

  const probe = String.raw`set -eu
home="$HOME"
runtime_path="$home/.local/bin:$PATH"
if [ -x "$home/.local/bin/node" ]; then
  node_path="$(readlink -f "$home/.local/bin/node")"
else
  node_path="$(PATH="$runtime_path" command -v node || true)"
fi
dsh_script="$home/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ ! -f "$dsh_script" ]; then
  npm_root="$(PATH="$runtime_path" npm root -g 2>/dev/null || true)"
  dsh_script="$npm_root/@deepseek-ai/dsh/lib/bin.js"
fi
default_cwd="$home"
if [ -d '${DEFAULT_WSL_CWD}' ]; then
  default_cwd='${DEFAULT_WSL_CWD}'
fi
printf 'HOME=%s\nNODE=%s\nDSH_SCRIPT=%s\nPATH=%s\nCWD=%s\n' "$home" "$node_path" "$dsh_script" "$runtime_path" "$default_cwd"`

  let output: string
  try {
    output = execFileSync(
      'wsl.exe',
      ['-d', distro, '--exec', '/bin/sh', '-lc', probe],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch (err) {
    throw new Error(`无法访问 WSL 发行版 ${distro}：${(err as Error).message}`)
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

  const verify = String.raw`set -eu
test -x "$1"
test -f "$2"
test -d "$3"`
  try {
    execFileSync(
      'wsl.exe',
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
      { windowsHide: true, timeout: 10000, stdio: 'ignore' },
    )
  } catch {
    throw new Error(
      `WSL 中未找到可用的 Linux 原生 dsh 或工作目录（Node=${nodePath}, dsh=${dshScriptPath}, cwd=${cwd}）`,
    )
  }

  return { distro, home, nodePath, dshScriptPath, pathEnv, cwd }
}

export function resolveDsh(extraArgs: string[] = []): ResolvedCommand {
  const runtime = probeWslRuntime()
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
      runtime.nodePath,
      runtime.dshScriptPath,
      ...appArgs,
    ],
    runtime,
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
 * dsh web lifecycle through WSL2:
 * probe native runtime -> start isolated Linux process group -> parse URL ->
 * stop that group cleanly (Windows taskkill is only a final wrapper fallback).
 */
export class DshProcess {
  private child: ChildProcess | null = null
  private runtime: WslRuntime | null = null
  private linuxPid: number | null = null
  private stopped = false
  private urlSent = false

  constructor(private readonly callbacks: DshCallbacks) {}

  start(extraArgs: string[] = []): void {
    let resolved: ResolvedCommand
    try {
      resolved = resolveDsh(extraArgs)
    } catch (err) {
      this.callbacks.onError(
        `未找到 WSL2 中的 dsh。\n${(err as Error).message}\n\n` +
          '请确认 Ubuntu 可用，并在 WSL 中安装 Linux 原生 Node.js 与：\n\n' +
          '    npm install -g @deepseek-ai/dsh\n\n' +
          '可用 DSH_WSL_DISTRO / DSH_WSL_NODE / DSH_WSL_DSH_SCRIPT 指定自定义位置。',
      )
      return
    }

    this.runtime = resolved.runtime
    this.callbacks.onLog?.(
      `启动 WSL dsh (${resolved.runtime.distro}): ` +
        `${resolved.runtime.nodePath} ${resolved.runtime.dshScriptPath} web --port 0`,
    )

    const child = spawn(resolved.command, resolved.args, {
      windowsHide: true,
      shell: false,
      env: { ...process.env, FORCE_COLOR: '0' },
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
    const child = this.child
    if (!child || hasExited(child)) return

    if (this.runtime && this.linuxPid) {
      await runWslKill(this.runtime, this.linuxPid, 'TERM')
      if (await waitForExit(child, 4000)) return
      await runWslKill(this.runtime, this.linuxPid, 'KILL')
      if (await waitForExit(child, 2000)) return
    }

    // The Linux process should already be gone. This only closes a stuck
    // wsl.exe wrapper and never terminates the Ubuntu distribution itself.
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
}
