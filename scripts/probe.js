// scripts/probe.js — 诊断 splash 渲染状态（一次性调试工具）
const { app, BrowserWindow } = require('electron')
const path = require('path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360, height: 860, show: true, backgroundColor: '#0f172a',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  })
  const errors = []
  win.webContents.on('console-message', (e) => {
    errors.push((e.level || 'log') + ': ' + e.message)
  })
  await win.loadFile(path.resolve(__dirname, '..', 'renderer', 'splash.html'))
  await sleep(4500)
  const diag = await win.webContents.executeJavaScript(`(async () => {
    // rAF 是否被调度：注入计数器跑 400ms
    let frames = 0
    const tick = () => { frames++; if (frames < 1000) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    await new Promise((r) => setTimeout(r, 400))
    const c = document.getElementById('whale')
    const g = c.getContext('2d')
    const px = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2], d[3]] }
    const cs = { w: c.width, h: c.height }
    const glass = document.querySelector('.glass')
    const brand = document.querySelector('.brand')
    return {
      rAFframes: frames,
      canvas: cs,
      canvasRect: c.getBoundingClientRect().toJSON(),
      pxCenter: px(cs.w >> 1, cs.h >> 1),
      pxWhaleHead: px(Math.floor(cs.w * 0.55), Math.floor(cs.h * 0.42)),
      glassOpacity: getComputedStyle(glass).opacity,
      brandFill: getComputedStyle(brand).webkitTextFillColor,
      brandClip: getComputedStyle(brand).webkitBackgroundClip,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      inner: innerWidth + 'x' + innerHeight,
      dpr: devicePixelRatio,
    }
  })()`)
  console.log('DIAG ' + JSON.stringify(diag, null, 1))
  console.log('CONSOLE ' + JSON.stringify(errors))
  const img = await win.webContents.capturePage()
  const png = img.toPNG()
  require('fs').writeFileSync(path.resolve(__dirname, '..', 'docs', 'art', 'probe-splash.png'), png)
  console.log('PNG ' + png.length)
  app.exit(0)
})
