import { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { DshProcess, detectWslAvailability } from './dsh'
import type { DshRuntimeSelection } from './dsh'
import {
  embeddedRuntimeDirectory,
  loadEmbeddedRuntime,
  loadEmbeddedWin32Runtime,
} from './embedded-runtime'

const SMOKE = !!process.env.DSH_SMOKE
const DEV = process.argv.includes('--dev')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let dsh: DshProcess | null = null
let quitting = false
let stoppingDsh = false
let smokeTimer: NodeJS.Timeout | null = null
let smokeFinished = false
let pageErrors: string[] = []

type RequestedRuntimeMode = 'auto' | 'wsl' | 'win32'
type SplashPhase = 'environment' | 'runtime' | 'interface'

interface SplashStatus {
  phase: SplashPhase
  message: string
  note: string
}

let splashStatus: SplashStatus = {
  phase: 'environment',
  message: '正在检测运行环境…',
  note: '首次启动会校验并部署内嵌运行时',
}

interface RuntimePreference {
  schemaVersion: 1
  noWslFallback: 'win32'
}

function log(msg: string): void {
  console.log(`[dsh-desktop] ${msg}`)
}

/** 优先使用 asar 解包目录中的资源（托盘图标等需要真实文件路径）。 */
function assetPath(name: string): string {
  const base = app.getAppPath()
  const packed = path.join(base, 'assets', name)
  const unpacked = path.join(base.replace(/app\.asar$/, 'app.asar.unpacked'), 'assets', name)
  return fs.existsSync(unpacked) ? unpacked : packed
}

function page(name: string): string {
  return path.join(app.getAppPath(), 'renderer', name)
}

function isSplashPage(window: BrowserWindow): boolean {
  try {
    return new URL(window.webContents.getURL()).pathname.endsWith('/renderer/splash.html')
  } catch {
    return false
  }
}

function applySplashStatus(): void {
  const window = win
  if (!window || window.isDestroyed() || !isSplashPage(window)) return
  const args = JSON.stringify([
    splashStatus.phase,
    splashStatus.message,
    splashStatus.note,
  ])
  void window.webContents.executeJavaScript(
    `window.dshSplash?.setPhase(...${args})`,
    true,
  ).catch((err) => {
    if (SMOKE || DEV) log(`更新启动页状态失败：${(err as Error).message}`)
  })
}

function updateSplashStatus(
  phase: SplashPhase,
  message: string,
  note?: string,
): void {
  splashStatus = {
    phase,
    message,
    note: note || (
      phase === 'interface'
        ? '本地服务就绪后将自动进入工作界面'
        : '首次启动会校验并部署内嵌运行时'
    ),
  }
  if (SMOKE || DEV) log(`SPLASH_STAGE: ${phase} — ${message}`)
  applySplashStatus()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f5f2',
    icon: assetPath('icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.on('did-finish-load', applySplashStatus)
  win.on('close', (e) => {
    // 有托盘时关闭按钮 = 最小化到托盘；否则直接退出
    if (!quitting && tray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // 冒烟/开发模式下记录页面错误（信任围栏被拒时会表现为 fetch 错误）
  // Electron 43 新签名：事件对象自带 level / message 属性
  win.webContents.on(
    'console-message' as never,
    ((e: { level?: unknown; message?: unknown }) => {
      if (e.level === 'error') {
        const text = String(e.message)
        pageErrors.push(text)
        if (SMOKE || DEV) log(`PAGE_ERROR: ${text}`)
      }
    }) as never,
  )
  void win.loadFile(page('splash.html')).catch((err) => {
    showError(`加载启动页失败：${err.message}`)
  })
}

function showError(message: string): void {
  log(`ERROR: ${message}`)
  if (SMOKE) {
    finishSmoke(1, message)
  }
  if (win && !win.isDestroyed()) {
    win.loadFile(page('error.html'), { query: { msg: message } }).catch(() => {})
  }
}

function requestedRuntimeMode(): RequestedRuntimeMode {
  const value = (process.env.DSH_RUNTIME_MODE || 'auto').trim().toLowerCase()
  if (value !== 'auto' && value !== 'wsl' && value !== 'win32') {
    throw new Error('DSH_RUNTIME_MODE 仅支持 auto、wsl 或 win32')
  }
  return value
}

function runtimePreferencePath(): string {
  const override = (process.env.DSH_RUNTIME_PREFERENCE_PATH || '').trim()
  if (override) {
    if (!path.win32.isAbsolute(override) || /[\r\n\0]/.test(override)) {
      throw new Error('DSH_RUNTIME_PREFERENCE_PATH 必须是 Windows 绝对路径')
    }
    return path.win32.normalize(override)
  }
  return path.join(app.getPath('userData'), 'runtime-preference.json')
}

async function hasWin32FallbackPreference(): Promise<boolean> {
  try {
    const value = JSON.parse(
      await fs.promises.readFile(runtimePreferencePath(), 'utf8'),
    ) as Partial<RuntimePreference>
    return value.schemaVersion === 1 && value.noWslFallback === 'win32'
  } catch {
    return false
  }
}

async function saveWin32FallbackPreference(): Promise<void> {
  const preferencePath = runtimePreferencePath()
  await fs.promises.mkdir(path.dirname(preferencePath), { recursive: true })
  const value: RuntimePreference = { schemaVersion: 1, noWslFallback: 'win32' }
  await fs.promises.writeFile(preferencePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function selectRuntime(
  runtimeDirectory: string,
): Promise<DshRuntimeSelection | null> {
  const requested = requestedRuntimeMode()
  if (requested === 'wsl') {
    return { mode: 'wsl', embeddedRuntime: loadEmbeddedRuntime(runtimeDirectory) }
  }
  if (requested === 'win32') {
    return {
      mode: 'win32',
      embeddedRuntime: loadEmbeddedWin32Runtime(runtimeDirectory),
    }
  }

  const availability = await detectWslAvailability()
  if (availability.available) {
    log(`已检测到 WSL 发行版 ${availability.distro}，使用 WSL 模式`)
    return { mode: 'wsl', embeddedRuntime: loadEmbeddedRuntime(runtimeDirectory) }
  }

  log(`WSL 不可用（${availability.distro}）：${availability.reason || '未知原因'}`)
  const win32Runtime = loadEmbeddedWin32Runtime(runtimeDirectory)
  if (await hasWin32FallbackPreference()) {
    log('已读取用户此前确认的 Windows 本机模式偏好')
    return { mode: 'win32', embeddedRuntime: win32Runtime }
  }

  const unattendedChoice = (process.env.DSH_NO_WSL_CHOICE || '').trim().toLowerCase()
  let useWin32: boolean
  if (unattendedChoice) {
    if (unattendedChoice !== 'win32' && unattendedChoice !== 'exit') {
      throw new Error('DSH_NO_WSL_CHOICE 仅支持 win32 或 exit')
    }
    useWin32 = unattendedChoice === 'win32'
    log(`使用自动化的无 WSL 选择：${unattendedChoice}`)
  } else {
    const detail = [
      `未能使用 WSL 发行版“${availability.distro}”。`,
      availability.reason ? `原因：${availability.reason}` : '',
      '',
      '选择“使用 Windows 本机模式”后，程序会解压并使用安装包内置的 Node.js 与 dsh，',
      '不会安装全局 npm 包；会话和插件配置使用 %USERPROFILE%\\.dsh，与 WSL ~/.dsh 相互独立。',
      '',
      '选择“暂不配置并退出”不会在非 WSL 环境部署或配置 dsh。',
    ].filter((line) => line !== '').join('\n')
    const options = {
      type: 'question' as const,
      title: '未检测到可用的 WSL',
      message: '是否改用 Windows 本机环境配置 dsh？',
      detail,
      buttons: ['使用 Windows 本机模式', '暂不配置并退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }
    const result = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    useWin32 = result.response === 0
  }

  if (!useWin32) {
    log('用户选择暂不在非 WSL 环境配置 dsh，应用退出')
    quitting = true
    app.quit()
    return null
  }
  await saveWin32FallbackPreference()
  log('用户已确认使用 Windows 本机模式')
  return { mode: 'win32', embeddedRuntime: win32Runtime }
}

function finishSmoke(code: number, reason?: string): void {
  if (smokeFinished) return
  smokeFinished = true
  if (smokeTimer) {
    clearTimeout(smokeTimer)
    smokeTimer = null
  }
  log(`SMOKE_${code === 0 ? 'OK' : 'FAIL'}${reason ? `: ${reason}` : ''}`)
  if (pageErrors.length > 0) {
    log(`PAGE_ERRORS: ${pageErrors.length}`)
  }
  // 等待 dsh 进程树清理完成后再退出
  const cleanup = dsh ? dsh.stop() : Promise.resolve()
  void cleanup.finally(() => setTimeout(() => app.exit(code), 100))
}

/** 冒烟模式：加载真实页面并轮询验证 __DSH_BOOT__（dsh web 注入的启动配置）。 */
async function smokeBootCheck(url: string): Promise<void> {
  const w = win
  if (!w || w.isDestroyed()) {
    finishSmoke(1, '窗口已销毁')
    return
  }
  try {
    await w.loadURL(url)
  } catch (err) {
    finishSmoke(1, `loadURL 失败: ${(err as Error).message}`)
    return
  }
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (smokeFinished) return
    try {
      const v = await w.webContents.executeJavaScript(
        'typeof window.__DSH_BOOT__',
        true,
      )
      if (v === 'object') {
        finishSmoke(0)
        return
      }
    } catch {
      // 页面尚在导航中，继续轮询
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  finishSmoke(1, '__DSH_BOOT__ 20 秒内未注入')
}

async function startDsh(): Promise<void> {
  let selection: DshRuntimeSelection | null
  updateSplashStatus('environment', '正在检测运行环境…')
  try {
    const runtimeDirectory = embeddedRuntimeDirectory(
      app.getAppPath(),
      process.resourcesPath,
      app.isPackaged,
    )
    selection = await selectRuntime(runtimeDirectory)
    if (!selection) return
    const embeddedRuntime = selection.embeddedRuntime
    log(
      `内嵌运行时 (${selection.mode}): ${embeddedRuntime.runtimeId}, ` +
        `${embeddedRuntime.archiveSize} bytes, ${embeddedRuntime.archiveSha256}`,
    )
  } catch (err) {
    showError(`内嵌运行时不可用：${(err as Error).message}`)
    return
  }

  dsh = new DshProcess(
    {
      onUrl: (url) => {
        log(`DSH_URL: ${url}`)
        updateSplashStatus('interface', '正在连接本地界面…')
        if (SMOKE) {
          void smokeBootCheck(url)
          return
        }
        if (win && !win.isDestroyed()) {
          win.loadURL(url).catch((err) => showError(`加载界面失败：${err.message}`))
        }
      },
      onExit: (code) => {
        log(`dsh 退出，code=${code}`)
        if (!quitting) {
          showError(`dsh 进程已退出（code ${code}）。\n请退出应用后重新打开。`)
        }
      },
      onError: (msg) => showError(msg),
      onLog: DEV || SMOKE ? (line) => log(`dsh: ${line}`) : undefined,
      onStage: (stage, message) => updateSplashStatus(stage, message),
    },
    selection,
  )
  dsh.start()
}

function createTray(): void {
  const trayIcon = assetPath('tray.png')
  if (!fs.existsSync(trayIcon)) {
    log('未找到托盘图标，托盘功能跳过')
    return
  }
  // tray.png（16px）为 1x 基准，tray-32.png（32px）作为 2x 表示：高 DPI 任务栏更清晰
  let icon = nativeImage.createFromPath(trayIcon)
  const hiRes = assetPath('tray-32.png')
  if (fs.existsSync(hiRes)) {
    icon = icon.resize({ width: 16, height: 16 })
    icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(hiRes) })
  }
  tray = new Tray(icon)
  const menu = Menu.buildFromTemplate([
    { label: '显示 DSH Desktop', click: () => { win?.show(); win?.focus() } },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ])
  tray.setToolTip('DSH Desktop')
  tray.setContextMenu(menu)
  tray.on('double-click', () => { win?.show(); win?.focus() })
}

// ---- 入口 ----
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    createWindow()
    createTray()
    void startDsh()

    if (SMOKE) {
      smokeTimer = setTimeout(
        () => finishSmoke(1, '10 分钟内未获取到 dsh URL'),
        10 * 60 * 1000,
      )
    }
  })

  app.on('before-quit', (e) => {
    quitting = true
    if (!stoppingDsh && dsh) {
      // 先等 dsh 进程树清理完成，再真正退出
      stoppingDsh = true
      e.preventDefault()
      void dsh.stop().finally(() => app.quit())
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
