# DSH Desktop

DeepSeek Harness 的 Windows 桌面版：Electron 原生窗口负责在 WSL2 中启动官方
`dsh web`，并提供托盘、单实例、开机自启、NSIS 安装版与 portable 便携版。

从 0.3.0 起，安装包内嵌 Linux x64 Node.js 与完整 dsh 生产运行时。目标用户
不需要安装 Node、npm、pnpm 或全局 dsh；安装后首次打开会自动校验并部署运行时。

> 界面本身是 DeepSeek Harness 官方 Web GUI。本项目只负责桌面化包装、运行时
> 分发和进程生命周期，不修改官方会话界面。

## 系统要求（v0.3.0）

- Windows 10/11；
- WSL2 与一个可用的 `Ubuntu` 发行版；
- WSL 用户 HOME 可写，并预留至少 500 MB 空间。

WSL2/Ubuntu 仍是系统前置条件。安装程序不会启用 Windows 可选功能、重启系统
或自动创建 Linux 发行版。

## 数据与升级安全

- 内嵌程序部署到
  `~/.local/share/dsh-desktop/runtimes/<runtime-id>`；
- 会话、设置、凭据、附件、skills 与插件配置继续保存在 `~/.dsh`；
- 桌面程序升级时，新运行时按版本并排部署，不原地覆盖旧运行时；
- 覆盖安装或卸载桌面程序不会删除 `~/.dsh`，也不会把用户数据写进安装目录；
- 已有 profile 与本地 link 插件继续从 `~/.dsh/profiles` 加载。

## 启动流程

1. Electron 从开发目录或安装包 `resources/runtime` 读取 manifest；
2. WSL 校验归档 SHA-256，并在文件锁保护下解压到临时目录；
3. 验证内嵌 Node/dsh 版本后，通过 rename 原子切换到版本化运行时目录；
4. 使用内嵌 Node 启动 `dsh web --port 0`，同时保持
   `DSH_HOME=~/.dsh`；
5. 从 stdout 解析动态端口 URL，在桌面窗口加载官方 Web UI；
6. 退出时仅终止本实例的 Linux 进程组，不关闭整个 WSL 发行版。

运行时部署异步进行，首次校验/解压期间会显示启动页。后续启动通过 ready 标记
复用同一份已校验运行时。

## 环境变量

以下变量用于多发行版、测试或故障恢复；Linux 路径必须是 WSL 绝对路径：

| 变量 | 用途 |
|---|---|
| `DSH_WSL_DISTRO` | WSL 发行版名，默认 `Ubuntu` |
| `DSH_WSL_HOME` | 覆盖 dsh 用户数据 HOME |
| `DSH_WSL_CWD` | 覆盖启动工作目录 |
| `DSH_WSL_PATH` | 覆盖传给 dsh 的 PATH |
| `DSH_WSL_RUNTIME_ROOT` | 覆盖内嵌运行时缓存根目录，主要用于测试 |
| `DSH_WSL_NODE` + `DSH_WSL_DSH_SCRIPT` | 必须同时设置，显式使用外部调试运行时 |

默认工作目录为 `/mnt/d/DeepSeekHarness`；若该目录不存在，则回退到 WSL HOME。

## 开发

```powershell
npm install
npm run runtime:build    # 缓存有效时只校验；缺失时生成 Linux 运行时归档
npm run runtime:verify   # 校验 manifest、大小与 SHA-256
npm run runtime:rebuild  # 强制干净重建，用于版本发布
npm run start            # 准备运行时、编译并启动
npm run start:dev        # 同上，额外输出 dsh 日志
npm run smoke            # 加载真实 Web UI，验证 window.__DSH_BOOT__ 后退出
```

运行时版本固定在 `runtime/runtime-config.json`，Linux 依赖固定在
`runtime/pnpm-lock.yaml`。生成的 `runtime/dsh-linux-x64.tar.gz` 约 92 MB，属于
派生构建物并被 Git 忽略；manifest 会提交，以便审计版本、大小和哈希。

## 打包

```powershell
npm run dist             # NSIS + portable → release/
npm run dist:portable    # 仅 portable
```

两个命令都会先执行 `runtime:build`。electron-builder 通过 `extraResources` 把
归档、manifest 与第三方声明复制到安装包，不放入 app.asar。

- 未签名应用首次运行可能出现 Windows SmartScreen 提示；正式公开分发建议配置
  代码签名证书；
- `release/win-unpacked/resources/runtime` 可用于核对实际随包文件；
- 卸载程序只移除 Windows 应用文件，故意保留 WSL `~/.dsh` 与已部署运行时缓存。

## 目录结构

```text
src/main/main.ts                 Electron 窗口、托盘、单实例、smoke
src/main/embedded-runtime.ts     随包 manifest 与归档定位/校验
src/main/dsh.ts                  WSL 原子部署、dsh 启停、URL 与进程组管理
runtime/                         版本锁、pnpm lock、manifest、第三方声明
scripts/build-embedded-runtime.* 可重复 Linux 运行时构建器
renderer/splash.html             首次部署/启动加载页
renderer/error.html              WSL、归档与启动错误引导页
```

详细设计与验收不变量见
[`docs/develop/embedded-runtime.md`](docs/develop/embedded-runtime.md)。0.3.0 的覆盖更新、
真实卸载/重装与历史会话 UI 验收记录见
[`docs/migration/2026-08-20-embedded-runtime-validation.md`](docs/migration/2026-08-20-embedded-runtime-validation.md)。
