// 冒烟测试入口：以 DSH_SMOKE=1 启动应用，继承 stdio 转发日志，超时兜底。
const { spawn } = require('child_process')
const electron = require('electron') // electron 包在纯 Node 环境中导出二进制路径

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, DSH_SMOKE: '1' },
})

const timer = setTimeout(() => {
  console.error('[smoke] 90 秒超时，强制结束')
  child.kill()
  process.exit(2)
}, 90000)

child.on('exit', (code) => {
  clearTimeout(timer)
  process.exit(code ?? 1)
})

child.on('error', (err) => {
  clearTimeout(timer)
  console.error('[smoke] 启动失败: ' + err.message)
  process.exit(3)
})
