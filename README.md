# DSH Desktop

DeepSeek Harness 的 Windows 桌面版：Electron 原生窗口负责启动官方 `dsh web`，
并提供托盘、单实例、开机自启、NSIS 安装版与 portable 便携版。

从 0.4.0 起，安装包同时内嵌 Linux x64 与 Windows x64 的 Node.js 和完整 dsh
生产运行时。程序优先使用 WSL2；目标机没有可用 WSL 时，会让用户在以下两项中
明确选择：

1. 使用 Windows 本机模式；
2. 暂不配置并退出。

两种模式都不依赖目标机预装 Node、npm、pnpm 或全局 dsh。

> 界面本身是 DeepSeek Harness 官方 Web GUI。本项目只负责桌面化包装、运行时
> 分发和进程生命周期，不修改官方会话界面。

## 系统要求（v0.4.0）

- Windows 10/11 x64；
- 可用磁盘空间至少 500 MB；
- WSL2 与 `Ubuntu` 不再是硬性前置条件，但仍是默认和推荐执行环境。

安装程序不会启用 Windows 可选功能、重启系统、创建 Linux 发行版，也不会把
dsh 安装为 Windows 全局 npm 包。

## 数据与升级安全

WSL 与 Windows 本机模式使用彼此独立的数据和运行时目录：

| 模式 | dsh 用户数据 | 内嵌运行时 |
|---|---|---|
| WSL | `~/.dsh` | `~/.local/share/dsh-desktop/runtimes/<runtime-id>` |
| Windows 本机 | `%USERPROFILE%\.dsh` | `%LOCALAPPDATA%\DSH Desktop\runtimes\<runtime-id>` |

- 两个 `.dsh` 不会自动合并、复制或重写；切换模式时看到的是对应环境自己的会话、
  workspace、插件、profile、设置与凭据；
- 覆盖安装、升级、卸载和重装只处理桌面程序文件，不删除上述两个 `.dsh`；
- 新运行时按 runtime-id 部署，校验成功后原子切换，不原地覆盖用户数据；
- 用户确认 Windows 本机模式后，只保存一个小型运行模式偏好。以后仍无 WSL 时
  直接复用；若 WSL 恢复可用，自动模式仍优先使用 WSL；
- 用户选择“暂不配置并退出”或关闭确认框时，不创建模式偏好、不部署 Windows
  运行时，也不创建 `%USERPROFILE%\.dsh`。

## 启动流程

1. Electron 轻量探测指定的 WSL 发行版，不安装或部署任何内容；
2. WSL 可用时，读取 Linux manifest，校验归档并继续使用 `DSH_HOME=~/.dsh`；
3. WSL 不可用且没有既有授权时，显示只有“使用 Windows 本机模式”和
   “暂不配置并退出”两个选择的确认框；
4. 用户同意本机模式后，校验 Windows 归档大小与 SHA-256，在独立子进程中安全
   解压到临时目录，验证 Node/dsh 版本并写入 ready 指纹，再原子改名；
5. 使用所选环境的内嵌 Node 启动 `dsh web --port 0`，从 stdout 解析动态端口
   URL，在桌面窗口加载官方 Web UI；
6. 退出时只终止本实例创建的 WSL 进程组或 Windows 进程树。

首次部署期间显示启动页。后续启动通过 ready 指纹直接复用已校验运行时。

## 环境变量

| 变量 | 用途 |
|---|---|
| `DSH_RUNTIME_MODE` | `auto`（默认）、`wsl` 或 `win32`；后两项用于显式覆盖 |
| `DSH_NO_WSL_CHOICE` | 无交互测试/部署使用 `win32` 或 `exit` |
| `DSH_RUNTIME_PREFERENCE_PATH` | 覆盖运行模式偏好文件，主要用于隔离测试 |
| `DSH_WSL_DISTRO` | WSL 发行版名，默认 `Ubuntu` |
| `DSH_WSL_HOME` | 覆盖 WSL dsh 用户数据 HOME |
| `DSH_WSL_CWD` | 覆盖 WSL 启动工作目录 |
| `DSH_WSL_PATH` | 覆盖传给 WSL dsh 的 PATH |
| `DSH_WSL_RUNTIME_ROOT` | 覆盖 WSL 内嵌运行时根目录 |
| `DSH_WSL_NODE` + `DSH_WSL_DSH_SCRIPT` | 必须同时设置，显式使用 WSL 外部调试运行时 |
| `DSH_WIN_HOME` | 覆盖 Windows 本机 `DSH_HOME` |
| `DSH_WIN_CWD` | 覆盖 Windows 本机启动工作目录 |
| `DSH_WIN_RUNTIME_ROOT` | 覆盖 Windows 本机内嵌运行时根目录 |

WSL 路径变量必须是 Linux 绝对路径，Windows 路径变量必须是 Windows 绝对路径。
WSL 默认工作目录为 `/mnt/d/DeepSeekHarness`，不存在时回退到 WSL HOME；Windows
本机默认工作目录为 `%USERPROFILE%`。

## 开发

```powershell
npm install
npm run runtime:build    # 校验或生成 Linux + Windows 两个运行时归档
npm run runtime:verify   # 校验两个 manifest、大小与 SHA-256
npm run runtime:rebuild  # 强制干净重建，用于版本发布
npm run start            # 准备运行时、编译并启动
npm run start:dev        # 同上，额外输出 dsh 日志
npm run smoke            # 加载真实 Web UI，验证 window.__DSH_BOOT__ 后退出
```

仓库提交说明和项目文档统一使用中文；第三方许可证、命令、代码与专有名词除外。
每个可独立验收的任务应单独提交。完整协作约定见
[`AGENTS.md`](AGENTS.md)。

运行时版本分别固定在 `runtime/runtime-config.json` 和
`runtime/runtime-config-win32.json`，生产依赖统一固定在
`runtime/pnpm-lock.yaml`。生成的两个 `.tar.gz` 都是被 Git 忽略的派生构建物；
manifest 会提交，以便审计版本、大小和哈希。

## 打包

```powershell
npm run dist             # NSIS + portable → release/
npm run dist:portable    # 仅 portable
```

两个命令都会先执行 `runtime:build`。electron-builder 通过 `extraResources` 把
两个归档、两个 manifest 与第三方声明复制到安装包，不放入 app.asar。

- 未签名应用首次运行可能出现 Windows SmartScreen 提示；正式公开分发建议配置
  代码签名证书；
- `release/win-unpacked/resources/runtime` 可用于核对实际随包文件；
- 卸载程序只移除 Windows 应用文件，故意保留 WSL/Windows `.dsh`、已部署运行时
  和 Electron 用户状态。

## 目录结构

```text
src/main/main.ts                         窗口、运行模式选择、托盘与单实例
src/main/embedded-runtime.ts             两个平台 manifest 与归档定位/校验
src/main/dsh.ts                          WSL/Windows dsh 启停、URL 与进程清理
src/main/native-runtime.ts               Windows 运行时校验、锁与原子部署
src/main/extract-runtime.ts              独立安全解压子进程
runtime/                                 版本锁、pnpm lock、manifest、第三方声明
scripts/build-embedded-runtime.*         可重复 Linux 运行时构建器
scripts/build-embedded-runtime-win32.ps1 可重复 Windows 运行时构建器
renderer/splash.html                     首次部署/启动加载页
renderer/error.html                      运行时与启动错误引导页
```

详细设计与验收不变量见
[`docs/develop/embedded-runtime.md`](docs/develop/embedded-runtime.md)。0.3.0 的覆盖更新、
真实卸载/重装与历史会话 UI 验收记录见
[`docs/migration/2026-08-20-embedded-runtime-validation.md`](docs/migration/2026-08-20-embedded-runtime-validation.md)。
