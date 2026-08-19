import { app, BrowserWindow, Tray, Menu, shell, nativeImage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { DshProcess } from './dsh'
import { embeddedRuntimeDirectory, loadEmbeddedRuntime } from './embedded-runtime'
import type { EmbeddedRuntimeSpec } from './embedded-runtime'

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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    icon: assetPath('icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadFile(page('splash.html'))
  win.once('ready-to-show', () => win?.show())
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

function startDsh(): void {
  let embeddedRuntime: EmbeddedRuntimeSpec
  try {
    const runtimeDirectory = embeddedRuntimeDirectory(
      app.getAppPath(),
      process.resourcesPath,
      app.isPackaged,
    )
    embeddedRuntime = loadEmbeddedRuntime(runtimeDirectory)
    log(
      `内嵌运行时: ${embeddedRuntime.runtimeId}, ` +
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
    },
    embeddedRuntime,
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
    startDsh()

    if (SMOKE) {
      smokeTimer = setTimeout(() => finishSmoke(1, '60 秒内未获取到 dsh URL'), 60000)
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
