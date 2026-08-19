# task_plan.md — 包装 DeepSeek Harness 为 GUI：详细方案

## 目标

把 `@deepseek-ai/dsh`（DeepSeek Harness）包装成一个**桌面 GUI 应用**：
双击图标 → 原生窗口打开 DSH 完整界面 → 无需命令行。
（调查确认：DSH 官方自带完整 Web GUI，包装重点在桌面化与分发，而非重写 UI。）

## 环境结论（已实测）

- Node v24 / npm 11 / pnpm 11 / git 2.51 齐备；工作目录 `D:\DeepSeekHarness\quickStart` 为空。
- DSH = `@deepseek-ai/dsh@0.1.0-rc.6`（npx 缓存安装，bin=`dsh`）。
- `dsh web` 提供完整 GUI（React SPA + /api 网关），支持 `--host/--port/--trusted-host`，`--port 0` 自动选端口并打印 URL。
- 用户数据在 `C:\Users\30745\.dsh`（sessions/settings/credentials），包装版可无缝复用。
- 3080 端口已被当前实例占用 → 包装版默认用 `--port 0`。

## 方案对比

| 方案 | 做法 | 产物大小 | 工作量 | 风险 | 评价 |
|---|---|---|---|---|---|
| **A. Electron 桌面壳（推荐）** | Electron 主进程拉起 `dsh web --port 0`，解析 URL 打开原生窗口；托盘/单实例/开机自启；electron-builder 打包 NSIS/便携版 | 约 90–120 MB 安装包 | 2–3 天 | 低（UI 全复用官方） | ✅ 最贴合"包装为 GUI"，生态成熟，中文文档多 |
| A2. Tauri 桌面壳 | 同样"拉起 dsh + 打开窗口"，用 Rust + WebView2 | 约 10 MB | 3–5 天 | 中（需 Rust 工具链、WebView2 兼容） | 轻量但开发链更重 |
| B. 自研 GUI 前端 | 新写前端，直接调 `/api`（Typert 网关）或 headless SDK | 视实现 | 2 周+ | 高（需重做会话/工具/设置全部 UI） | 仅当需要完全定制 UI 时选 |
| C. 一键启动器（MVP） | 便携 Node + dsh + .bat/脚本：启动 `dsh web` 并自动打开系统浏览器 | <100 KB | 半天 | 极低 | 不是真"应用"，但可作方案 A 的第一里程碑 |

**推荐：先做 C 验证链路 → 再交付 A（Electron）**；A2 作为轻量化后续；B 仅在用户要求深度定制 UI 时启动。

## 推荐方案 A 详细计划

### Phase 1 — 项目脚手架（约 0.5 天）
- 在 `D:\DeepSeekHarness\quickStart` 初始化 Electron + TypeScript 项目
  （electron-vite 或手写最小结构：main/preload/renderer）。
- 配置 `electron-builder`（appId、productName、win: nsis + portable 目标）。
- 目录结构：
  ```
  quickStart/
    package.json  tsconfig.json  electron-builder.yml
    src/main/       # 主进程：dsh 生命周期管理
    src/preload/    # 桥接（如需原生能力）
    src/renderer/   # 启动画面（加载中转页）
    assets/         # 图标 icon.ico / tray
  ```
- 验收：`npm run dev` 能打开空 Electron 窗口。

### Phase 2 — 核心封装：dsh 进程生命周期（约 0.5–1 天）
- 主进程 `spawn("dsh", ["web", "--port", "0"])`（Windows 下用 dsh.cmd shell:true 处理）。
- 解析 stdout 中的 **URL line** 得到实际地址（http://127.0.0.1:<port>）。
- 窗口加载该 URL（同源加载，天然通过 `/api` 浏览器信任围栏；必要时再加 `--trusted-host`）。
- 生命周期：窗口关闭 → 优雅终止 dsh 子进程；dsh 崩溃 → 显示错误页 + 重启按钮；
  主进程退出前清理子进程（任务栏无残留 node）。
- 备用路径（v2 优化）：改为进程内 `import { startup } from '@deepseek-ai/dsh-web-app/startup'`，
  省去外部 Node 依赖；Phase 2 先用子进程方案（最稳），验证后再切换。
- 验收：双击应用 → 窗口内出现完整 DSH 界面；关闭窗口后无残留进程。

### Phase 3 — 桌面体验（约 1 天）
- 单实例锁（重复启动聚焦已有窗口）。
- 系统托盘：显示/隐藏窗口、退出；关闭按钮最小化到托盘（可配置）。
- 启动加载页（DSH 启动约数秒，显示品牌 + 进度/日志）。
- 菜单：刷新、打开数据目录（DSH_HOME）、关于。
- 可选：开机自启（electron-builder + auto-launch 包）、深色/浅色主题随系统。
- 验收：托盘交互、单实例、启动页均正常。

### Phase 4 — 打包分发（约 1 天）
- 打包目标：Windows NSIS 安装版 + portable 便携版（electron-builder）。
- **Node 运行时策略（关键决策点）**：
  - 策略 1：要求用户已装 Node（当前机器满足），安装时检测，缺失则提示/跳转下载。
  - 策略 2：安装包内捆绑便携 Node（约 40 MB）与全局 dsh，完全免依赖。
  - 建议：Phase 4 先做策略 1；策略 2 作为"免依赖版"里程碑。
- 未签名应用会触发 SmartScreen 提示 → 提供"仍要运行"说明；正式发布再考虑代码签名证书。
- 验收：在干净 Windows 虚拟机/用户目录下安装后双击即可用。

### Phase 5 — 验证与收尾（约 0.5 天）
- 冒烟测试：首启初始化、会话创建、设置持久化（DSH_HOME 复用）、端口冲突（3080 被占时自动换端口）。
- README + 版本号 + 变更记录；发布到 GitHub Releases（或内部分发）。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 3080 被现有实例占用 | 一律 `--port 0` 动态端口，从 URL line 读取真实地址 |
| `/api` 信任围栏拒绝桌面壳 | 加载打印出的同源 URL（默认即通过）；异常时加 `--trusted-host` |
| dsh 不在 PATH（新机器） | 安装检测 + 引导，或捆绑便携 Node+dsh（Phase 4 策略 2） |
| Electron 自带 Node 与 DSH 版本要求不一致 | 子进程方案用系统 Node 启动 dsh，天然规避；进程内方案需实测 |
| 打包体积大 / SmartScreen | portable 版 + 说明文档；后续可切 Tauri（方案 A2）轻量化 |
| DSH 升级（0.1.0-rc.6 为 RC 版） | 锁版本 + 升级开关；启动时检查 `dsh --version` 并提示更新 |

## 里程碑

1. M0（已完成）：环境调查 + 方案确认
2. M1（已完成）：Electron 壳 + `dsh web` 生命周期打通，冒烟测试全绿（页面加载 + __DSH_BOOT__ 注入）
3. M2（已完成）：托盘/单实例/关闭最小化/开机自启/启动页/错误引导页
4. M3（已完成）：NSIS + portable 安装包构建成功
5. M4（已完成）：三种形态验收通过（unpacked / portable / NSIS 静默安装→运行→卸载），退出码 0、无孤儿进程、安装目录清理干净

## Phase 6 — GUI 美化（图标 + 加载/错误动画）

> 状态：实施中（已确认方向：官方黑鲸图标 + 粒子鲸鱼开场页 + 液态玻璃文字，参考 deepseek.com/harness）。

### 设计语言

- 主色 DeepSeek 蓝 `#4D6BFE`，渐变 `#8FB0FF → #3D5AFE → #37C7FF`；深色底 slate-900 `#0F172A`（与窗口背景一致）。
- 动效原则：进入动画单次（400–900ms，ease-out/spring）；循环动画无限（呼吸/扫光/辉光）；尊重 `prefers-reduced-motion`。

### 6.1 图标（assets/）✅ 已实施（会话 3b 修订）

- 官方鲸鱼矢量 vendored 至 `scripts/whale.svg`（来源 dsh-web-frontend favicon.svg）。
- `scripts/gen-art.js`（零依赖，可重复生成）：icon.png 512（**官方纯黑鲸鱼 + 透明底**，无容器/装饰）、tray.png 16（蓝鲸，深色任务栏可读）、tray-32.png 32（2x）。
- main.ts 托盘多分辨率（1x=16、2x=32）。

### 6.2 启动页动画（renderer/splash.html）✅ 已实施（会话 3b 修订）

1. 粒子鲸鱼：1982 点（941 轮廓/1041 内部），指数收敛组装（约 2.5s）+ 呼吸微动 + 鼠标斥力散开/弹回。
2. **液态玻璃字符品牌**："DeepSeek-Harness" 每个符号独立玻璃化——上亮下透冷色渐变 + 1px 玻璃描边 + 投影蓝晕 + 逐字符扫光 + 错峰入场 + 悬浮微动 + hover 指针反应；**无玻璃容器**，文字后置极光色斑供折射（参考 iOS Liquid Glass 材质语言）。
3. 状态行：三跳点 + 三阶段文案轮播（启动→初始化→连接）。
4. 纯本地资源（点云内联），CSP 仅放宽 `script-src 'unsafe-inline'`。

### 6.3 错误页动画（renderer/error.html）✅ 已实施

1. 鲸鱼品牌标 + 警示三角描边绘制 + 红色辉光呼吸 + 一次抖动。
2. 玻璃卡片入场。
3. **CSP bug 已修复**：`script-src 'unsafe-inline'`，#msg 正常显示（原 default-src 'none' 拦截内联 script）。

### 6.4 验证 ✅ 已完成

- [x] `npm run build`（tsc）通过。
- [x] `npm run smoke` exit 0（启动链路未破坏）。
- [x] 视觉取证：DOM/canvas 诊断 + 屏幕级截图（docs/art/screen-splash.png / screen-error.png），鲸鱼轮廓/玻璃卡片/渐变文字/错误页动画全部确认。
- [x] 图标像素自检：黑鲸居中、眼睛孔洞、圆角透明、托盘蓝鲸。
- [ ] 安装包图标待 `npm run dist` 重新打包后生效（用户确认后执行）。

## 决策记录

- 2026-XX-XX：确认"包装"= 桌面化官方 Web GUI（方案 A 推荐），不重写 UI；MVP 可用方案 C 快速验证链路。
- 用户确认：方案 A（Electron 桌面壳）+ 运行时策略 1（要求已装 Node）。
- 实施中决策：dsh 定位顺序 = `DSH_BIN` > PATH 的 .cmd shim（展开 %dp0% 解析真实 bin.js，直接 `node <bin.js>` 启动便于干净 kill）> npx 缓存扫描 > shell 回退（整树 taskkill）；冒烟验收标准 = 页面加载 + `window.__DSH_BOOT__` 注入 + 零 error 级页面消息。
