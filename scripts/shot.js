// scripts/shot.js — 预览截图：加载 splash/error 页面并截图到 docs/art/（供人工/像素核验）
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OUT = path.resolve(__dirname, '..', 'docs', 'art')
const HOLD = !!process.env.DSH_SHOT_HOLD // 屏幕级截图模式：窗口固定在角落并延长停留
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function capture(win, file) {
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(OUT, file), img.toPNG())
  console.log('[shot] wrote', file, img.toPNG().length, 'B')
}

app.whenReady().then(async () => {
  const errors = []
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: true, // 必须可见：隐藏窗口会暂停 rAF/合成，导致粒子动画冻结
    backgroundColor: '#0f172a',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  })
  // Electron 43 新签名：事件对象自带 level / message
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(String(e.message))
  })
  try {
    await win.loadFile(path.resolve(__dirname, '..', 'renderer', 'splash.html'))
    if (HOLD) {
      win.setBounds({ x: 80, y: 60, width: 1360, height: 860 })
      win.setAlwaysOnTop(true) // 屏幕级截图时置顶，避免被其他窗口遮挡
      win.focus()
    }
    await sleep(4200) // 等待粒子收敛（约 2.6s）+ 玻璃卡片入场
    // 中和鼠标（物理光标若悬停在窗口中央会触发粒子斥力散射）：
    // 合成一次角落移动事件 + pointerleave，让粒子回弹成鲸鱼形状
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 })
    await win.webContents.executeJavaScript("window.dispatchEvent(new Event('pointerleave'))")
    await sleep(900)
    await capture(win, 'preview-splash.png')
    if (HOLD) await sleep(6000) // 供屏幕级截图脚本捕获 splash

    await win.loadFile(path.resolve(__dirname, '..', 'renderer', 'error.html'), {
      query: { msg: 'dsh 进程已退出（code 1）。\n请退出应用后重新打开。' },
    })
    await sleep(2600) // 等警示图标描边 + 抖动 + 卡片入场完成
    await capture(win, 'preview-error.png')
    if (HOLD) await sleep(8000) // 供屏幕级截图脚本捕获 error
  } catch (err) {
    console.error('[shot] failed:', err)
    process.exitCode = 2
  }
  if (errors.length) console.error('[shot] PAGE_ERRORS:', errors.join(' | '))
  app.exit(process.exitCode || (errors.length ? 2 : 0))
})
