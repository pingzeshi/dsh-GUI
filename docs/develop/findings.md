# findings.md — DeepSeek Harness GUI 包装：环境调查发现

> 调查日期：本会话。所有路径均为实测结果。

## 1. 基础环境

| 项目 | 实测值 |
|---|---|
| OS | Windows（用户 `30745`） |
| Node | v24.15.0（`D:\nodejs\node.exe`，在 PATH 中） |
| npm | 11.12.1 |
| pnpm | 11.13.0 |
| git | 2.51.0.windows.1 |
| 工作目录 | `D:\DeepSeekHarness\quickStart`（**空目录**，无任何文件） |
| 父目录 | `D:\DeepSeekHarness` 下只有 `quickStart` |

## 2. DeepSeek Harness 安装形态

- DSH 发布为 npm 包 **`@deepseek-ai/dsh` v0.1.0-rc.6**（latest = next = 0.1.0-rc.6）。
- 仓库：`https://github.com/deepseek-ai/deepseek-harness`（目录 `apps/cli`）。
- 本机通过 npx 安装，位于：
  `D:\npm\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\`
- bin 入口：`dsh` → `lib/bin.js`。
- 包内含约 100+ 个 `@deepseek-ai/dsh-*` 子包（cordis 插件架构），全部 v0.1.0-rc.6。

## 3. CLI 命令面（`dsh --help` 实测）

```
dsh [options] [command] [args...]
  --profile <name>          启动 $DSH_HOME/profiles/<name> 下的 profile
  --patch <path>            额外 patch 覆盖层（可重复）
  --dump-config             打印组合后的 profile 树
  web                       boot web profile（= --profile web）
  plugin                    管理 profile 的插件（转发给 pnpm）
```

- `dsh --profile headless "任务"`：一次性运行、打印最终答案后退出。
- `dsh web --help` 实测：
  ```
  --host <host>              绑定地址
  --port <port>              监听端口；0 = 由 OS 分配空闲端口
  --trusted-host <authority> /api 浏览器信任围栏接受的额外来源
  ```
- 说明：`web`/`headless` profile 首次使用时自动初始化。

## 4. 现有 Web GUI（重要发现）

- **DSH 官方自带完整浏览器 GUI**，当前会话正运行于此：
  进程：`node D:\npm\npm-cache\_npx\1e7f6d9597241db0\node_modules\.bin\..\@deepseek-ai\dsh\lib\bin.js web`
  监听 `127.0.0.1:3080`（HTTP 200，返回 React SPA）。
- 前端：`@deepseek-ai/dsh-web-frontend`（Vite 构建的 React 18 SPA），
  `dist/` 共 89 个文件、约 4.41 MB（含 index.html、favicon、manifest）。
- 后端：`@deepseek-ai/dsh-host-webserver` 提供 HTTP 服务；
  `@deepseek-ai/dsh-api-gateway`（Typert 协议）提供 `/api` 端点，
  并有浏览器信任围栏（可用 `--trusted-host` 放宽）。
- web profile 描述中提到启动时会打印 **URL line**（可被外层进程解析到实际地址）。
- 结论：**"包装为 GUI"不需要重写 UI**，官方 web GUI 就是完整前端；
  包装工作 = 把 `dsh web` + 前端做成桌面应用体验（原生窗口 / 安装包 / 一键启动）。

## 5. 用户数据位置（DSH_HOME）

`DSH_HOME = C:\Users\30745\.dsh`，实测结构：

```
.dsh\
  profiles\            ← web profile 已初始化
    web\               （package.json / cordis.yml / cordis.patch.yml / pnpm-workspace.yaml / node_modules）
    node_modules\
  sessions\            ← 会话持久化
  storages\
  .credentials.yaml    ← 模型凭据
  settings.yaml        ← 全局设置（模型、权限、provider 等）
```

- settings.yaml 实测包含：provider 列表（opencode-go 等）、默认模型 deepseek-v4-pro、
  权限 preset `danger-full-access`、web 搜索限额等。
- 包装后的 GUI 会复用同一 DSH_HOME（会话/设置/凭据天然共享）。

## 6a. 美化专项：美术资源现状（本会话实测）

### 图标

| 文件 | 尺寸/格式 | 实测内容 | 用途 |
|---|---|---|---|
| `assets/icon.png` | 256×256 RGBA（5,092 B，filter 0） | 蓝色渐变圆角方块（主色 rgb(48,96,192)/rgb(64,112,208)，四角更亮）+ 白色 "DSH" 字形（白色像素 11.8%） | 窗口图标（main.ts:43）、electron-builder `win.icon`（安装包/快捷方式） |
| `assets/tray.png` | 32×32 RGBA（655 B，filter 0） | 同风格缩小版（无白色中心，符号极小） | 系统托盘图标（main.ts:161） |

- 两图均为前会话程序化生成的占位图：无阴影/高光/层次，托盘 16px 下辨识度存疑。
- 图标改动生效点：dev/smoke 直接读文件即时生效；安装包图标需 `npm run dist` 重新打包。

### 加载与错误页

- `renderer/splash.html`：纯内联 CSS（CSP `default-src 'none'; style-src 'unsafe-inline'`），渐变文字 "DSH" + 单圆环 spinner；无进入动画、无阶段感。
- `renderer/error.html`：静态卡片、无动画。**潜在 bug**：CSP `default-src 'none'` 会使 script-src 回退为 'none'，内联 `<script>`（读 URL query 写入 #msg）会被拦截 → 错误信息可能永远显示"未知错误"，待实测确认。
- 两者在 dsh 启动期间/失败时加载（main.ts:50 / main.ts:83），背景色 #0f172a 与窗口一致。

### 范围边界（关键结论）

- 桌面壳资源（本项目 renderer/ + assets/）完全可控，随安装包分发。
- **当前运行中的官方 web GUI（127.0.0.1:52161）的图标/加载动画位于 npm 包 `@deepseek-ai/dsh-web-frontend/dist` 内（node_modules），不属于本项目产物**；美化它需走 DSH_HOME profile patch 覆盖前端资源（独立路线，需另行调研验证）。
- 官方前端 dist 实测结构（npx 缓存副本）：`dist/favicon.svg`、`dist/manifest.webmanifest`、`dist/assets/index-*.css/js`。

## 6. 关键结论

1. 官方 GUI 已存在且功能完整（会话、模型选择、插件、设置、workspace、trajectory 等 UI 插件齐全）。
2. `dsh web` 支持 `--port 0` 自动选端口 + 打印 URL 行 → 桌面壳可可靠地接管。
   **实测输出格式（stdout）：`dsh web: http://127.0.0.1:57277`**（与已运行的 3080 实例共存无冲突）。
3. DSH 是纯 JS 插件栈（Node ≥ 24 本机可用），无原生编译依赖迹象。
4. 端口 3080 已被当前实例占用 → 包装版默认 `--port 0` 动态端口。
5. 工作目录为空，已从零搭建包装项目。
6. `where dsh` 命中 npx 缓存 shim：`D:\npm\npm-cache\_npx\1e7f6d9597241db0\node_modules\.bin\dsh.cmd`，
   shim 内真实脚本为 `..\@deepseek-ai\dsh\lib\bin.js`（可解析后直接 `node <bin.js>` 启动，便于干净 kill）。
