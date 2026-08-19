# 内嵌 DeepSeek Harness 运行时方案

## 目标与边界

DSH Desktop 的安装包同时携带 Linux x64 Node.js 与
`@deepseek-ai/dsh` 的完整生产依赖。目标机器不再需要自行安装 Node、npm 或
dsh；首次打开时，桌面程序把只读运行时原子部署到所选 WSL2 发行版，再启动
官方 `dsh web`。

当前桌面程序已经以 WSL2 为执行环境，因此 WSL2 与一个可用的 Ubuntu
发行版仍是系统前置条件。安装程序不会启用 Windows 可选功能、重启系统或
创建发行版。

## 不变量

- 安装包只包含可重建的程序文件，不包含任何 `~/.dsh`、凭据、会话、附件、
  workspace 或本地插件源码。
- `DSH_HOME` 继续固定为 WSL 用户的 `~/.dsh`。覆盖安装、升级和卸载桌面程序
  都不得删除或重写该目录。
- 内嵌运行时按版本部署到
  `~/.local/share/dsh-desktop/runtimes/<runtime-id>`，更新时并排安装新版本，
  不原地覆盖旧运行时。
- 用户已安装的 profile 与插件仍从 `~/.dsh/profiles` 加载；本地 link 插件的
  路径和用户配置不进入安装包。
- 启动和退出继续使用独立 Linux 进程组，只清理本桌面实例启动的 dsh，绝不
  关闭整个 WSL 发行版。

## 运行时制品

版本锁定文件记录：

- Node.js `24.15.0` Linux x64；官方归档 SHA-256：
  `472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6`；
- `@deepseek-ai/dsh` `0.1.0-rc.7`；
- 平台/架构：`linux-x64`。

构建脚本在 WSL 文件系统内完成干净安装，验证 Node 与 dsh 版本后，生成可重复
压缩的 `runtime/dsh-linux-x64.tar.gz` 以及带归档哈希的
`runtime/manifest.json`。大型归档是派生构建物，不提交 Git；打包命令会先校验
或生成它。NSIS 与 portable 制品都通过 electron-builder `extraResources`
携带这两个文件。

归档只保留运行所需的 Node 可执行文件、Node 许可证、dsh 及其生产依赖，不
包含 npm 缓存、构建临时目录或用户数据。

## 首次启动流程

1. Electron 读取并校验随包 manifest，解析当前安装形态下的归档路径。
2. 通过 `wsl.exe` 把 Windows 归档路径转换为 WSL 路径。
3. 若目标 runtime-id 已有与归档 SHA 匹配的 ready 标记，直接复用。
4. 否则先校验归档 SHA-256，再解压到同一父目录的临时目录；验证 Node、dsh
   脚本和版本后，以 rename 原子切换到最终目录。
5. 使用内嵌 Node 启动内嵌 dsh，并传入原有 `DSH_HOME=~/.dsh`。
6. 桌面窗口收到动态端口 URL 后加载官方 Web UI。

安装过程使用目录锁避免并发解压。失败时不碰 `~/.dsh`，并在错误页报告 WSL、
归档校验或部署阶段的具体原因。

## 兼容与调试覆盖

默认始终使用内嵌运行时，确保目标机器没有全局 dsh 时也能打开。保留
`DSH_WSL_DISTRO`、`DSH_WSL_HOME`、`DSH_WSL_CWD` 等现有覆盖；仅当
`DSH_WSL_NODE` 与 `DSH_WSL_DSH_SCRIPT` 同时给出时，才显式使用外部运行时，
便于开发和故障恢复。

## 验收证据

- 干净临时 runtime root 下能从安装包归档首次部署，日志中的 Node/dsh 路径
  必须位于 `dsh-desktop/runtimes/<runtime-id>`，不得回退到全局安装。
- 干净临时 `DSH_HOME` 能在无 npm 安装步骤的情况下加载 Web UI 并获得
  `window.__DSH_BOOT__`。
- 现有 `~/.dsh` 启动后，项目分组、历史会话和插件仍可读取。
- NSIS 安装版与 portable 均能完成上述启动；退出后没有 Electron、wsl.exe 或
  dsh 孤儿进程。
- 覆盖安装与卸载/重装前后，`~/.dsh` 的排除依赖目录摘要保持一致。

