# DSH Desktop

DeepSeek Harness 的桌面 GUI 包装：一个 Windows Electron 壳，负责在
WSL2 中拉起 Linux 原生 `dsh web`（官方完整浏览器界面）并放入原生窗口，
附带托盘、单实例、开机自启与 Windows 安装包分发。

> 界面本身是 DeepSeek Harness 官方 Web GUI（`@deepseek-ai/dsh` 的 web profile），
> 本项目只做桌面化包装，不修改官方 UI。

## 环境要求（v0.2.1 / WSL2）

- Windows 10/11 + WSL2（默认发行版名：`Ubuntu`）
- WSL2 内安装 Linux 原生 Node.js（本机实测 v24.15.0）与 dsh：
  `npm install -g @deepseek-ai/dsh`
- 本机迁移后的默认位置：Node/dsh 位于 `/home/pingzeshi/.local`，用户数据位于
  `/home/pingzeshi/.dsh`

应用启动时会探测 WSL HOME、Linux Node 与 dsh 脚本。可用以下 Windows 环境变量
覆盖探测结果（值均为 WSL 内路径）：`DSH_WSL_DISTRO`、`DSH_WSL_HOME`、
`DSH_WSL_NODE`、`DSH_WSL_DSH_SCRIPT`、`DSH_WSL_PATH`、`DSH_WSL_CWD`。
本机默认工作目录为 `/mnt/d/DeepSeekHarness`（目录不存在时回退到 WSL HOME），
以便迁移后的项目会话继续匹配原有工作区分组。

## 工作原理

1. 主进程通过 `wsl.exe` 定位并启动 Linux 原生
   `node <dsh>/lib/bin.js web --port 0`（动态端口，避免与已运行实例冲突）；
2. 从 stdout 解析 URL 行（实测格式：`dsh web: http://127.0.0.1:<port>`）；
3. 窗口从启动页切换到该地址（同源加载，通过 /api 信任围栏）；
4. dsh 运行在独立 Linux 进程组；托盘退出时只终止该进程组，不关闭整个 WSL
   发行版（`taskkill` 仅作为 `wsl.exe` 包装进程兜底）；
5. 复用 WSL 内同一 `DSH_HOME`（默认 `~/.dsh`），会话/设置/凭据与 WSL 命令行版共享。

## 开发

```bash
npm install
npm run start        # 编译并启动（开发模式加日志：npm run start:dev）
npm run smoke        # 冒烟测试：自动启动、验证 URL 可访问后退出（DSH_SMOKE=1）
```

冒烟模式成功标志：主进程日志输出 `SMOKE_OK`。

## 打包

```bash
npm run dist             # NSIS 安装版 + portable 便携版 → release/
npm run dist:portable    # 仅便携版
```

- 未签名应用首次运行会出现 Windows SmartScreen 提示，选择"仍要运行"即可；
- 图标位于 `assets/icon.png`（256×256，打包时自动转 .ico）与 `assets/tray.png`。

## 目录结构

```
src/main/main.ts      Electron 主进程：窗口/托盘/单实例/冒烟模式
src/main/dsh.ts       dsh 子进程定位、启动、URL 解析、停止
renderer/splash.html  启动加载页
renderer/error.html   dsh 缺失/崩溃时的引导页
scripts/smoke.js      冒烟测试入口
assets/               应用与托盘图标
```

## 已知限制与后续方向

- 错误页目前只给指引文本，无"一键重启 dsh"按钮（v1 取舍，后续可加 preload/IPC）；
- 未捆绑 WSL/Node/dsh，需要目标机器先准备 WSL2 运行环境；
- DSH 仍为 RC 版（本机为 0.1.0-rc.7），升级 dsh 后桌面壳无需改动（动态探测）。
