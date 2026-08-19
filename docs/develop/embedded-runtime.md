# 内嵌 DeepSeek Harness 双运行时方案

## 目标与边界

DSH Desktop 0.4.0 的安装包同时携带 Linux x64 与 Windows x64 的 Node.js、
`@deepseek-ai/dsh` 及完整生产依赖。自动模式优先使用 WSL2；没有可用 WSL 时，
必须由用户明确选择是否改用 Windows 本机模式，也可以不在非 WSL 环境配置 dsh
并直接退出。

安装程序不会启用 WSL、重启系统、创建发行版、调用目标机 npm 安装全局包，或把
任何用户会话打进安装包。

## 不变量

- 安装包只包含可重建程序文件，不包含 `.dsh`、凭据、会话、附件、workspace、
  profile 或本地插件源码；
- WSL 模式固定使用 WSL 用户的 `~/.dsh`，Windows 本机模式固定使用
  `%USERPROFILE%\.dsh`；两者相互独立，不自动合并或迁移；
- 覆盖安装、升级、卸载和重装不得删除或重写任一 `.dsh`；
- WSL 运行时部署到
  `~/.local/share/dsh-desktop/runtimes/<runtime-id>`；Windows 运行时部署到
  `%LOCALAPPDATA%\DSH Desktop\runtimes\<runtime-id>`；
- 两个平台均按 runtime-id 并排部署，只有归档、Node 和 dsh 版本校验成功后才写
  ready 指纹并原子切换；
- 退出只清理当前桌面实例创建的 WSL 进程组或 Windows 进程树，不关闭发行版，
  不终止其他 dsh；
- 用户拒绝本机模式时，不保存偏好、不解压运行时、不创建 Windows `.dsh`。

## 运行时制品

两个平台共享 `runtime/pnpm-lock.yaml` 和同一组经过审核的构建脚本许可。当前固定
版本如下：

| 项目 | Linux x64 | Windows x64 |
|---|---|---|
| Node.js | `24.15.0` | `24.15.0` |
| Node 官方归档 SHA-256 | `472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6` | `cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62` |
| pnpm（仅构建） | `11.22.0` | `11.22.0` |
| `@deepseek-ai/dsh` | `0.1.0-rc.7` | `0.1.0-rc.7` |
| 归档 | `dsh-linux-x64.tar.gz` | `dsh-win32-x64.tar.gz` |
| 归档 SHA-256 | `0b8286b0e78757c511455a5cca35d5ce21723799806bedf63905ba856ce640db` | `769c72eca0ab4ca26c19b0695c4026adbff50cef76ba8fa9ef90088183e3a2b8` |

Linux 构建在 WSL 文件系统中执行。Windows 构建使用 pnpm 的 hoisted node linker，
生成不含符号链接或目录联接的依赖树，并保留安全硬链接；归档条目排序、时间戳、
gzip 时间均固定，因此相同输入得到相同字节。两个构建都会从归档重新启动 Node 与
dsh 做版本复验。

大型归档是 Git 忽略的派生构建物。electron-builder 通过 `extraResources` 把两个
归档、两个 manifest 与第三方声明复制到安装包资源目录。

## 环境选择流程

1. `DSH_RUNTIME_MODE=wsl|win32` 是开发和故障恢复用的显式覆盖；默认值为 `auto`；
2. 自动模式先用 `wsl.exe` 对指定发行版执行轻量 `/bin/sh` 探测，此阶段不读取
   `.dsh`、不部署归档；
3. 探测成功就使用 WSL；因此用户后来安装或修复 WSL 后，自动模式会恢复首选 WSL；
4. 探测失败时，若存在用户此前保存的 Windows 本机授权，则直接复用本机模式；
5. 没有授权时显示原生确认框，按钮固定为“使用 Windows 本机模式”和
   “暂不配置并退出”；关闭确认框等同第二项；
6. 同意后保存 `runtime-preference.json` 并准备本机运行时；拒绝则直接退出且不写
   文件。

## WSL 部署与进程生命周期

1. Electron 读取 `manifest.json` 并校验归档大小；
2. WSL 使用 `wslpath` 定位 Windows 归档，校验 SHA-256；
3. 目录锁保护首次部署，归档解压到同级临时目录；
4. 内嵌 Node 和 dsh 版本通过后写 ready 指纹并 rename 到最终 runtime-id；
5. 使用 `DSH_HOME=~/.dsh` 启动独立 Linux 进程组；
6. 退出先向该进程组发送 TERM，超时后发送 KILL，最后只清理残留的 `wsl.exe`
   包装进程。

## Windows 本机部署与进程生命周期

1. Electron 读取 `manifest-win32-x64.json`，先核对归档字节数，再流式计算
   SHA-256；
2. 使用带 PID 和创建时间的排他锁保护首次部署。进程崩溃后可回收死锁，并清理
   中断遗留的同 runtime-id 临时目录；
3. 解压在 `ELECTRON_RUN_AS_NODE=1` 的独立子进程中执行，避免阻塞窗口；每个条目
   都拒绝绝对路径、`..` 路径穿越、符号链接和未知类型。只允许普通文件、目录，
   以及目标仍位于归档内部的安全硬链接；
4. 临时目录中的 `node.exe --version` 和 `dsh --version` 都通过后写 ready 指纹，
   再原子改名为最终 runtime-id；
5. 使用 `DSH_HOME=%USERPROFILE%\.dsh` 启动内嵌 Node 与 dsh，不修改系统 PATH，
   不安装全局 npm 包；
6. 退出通过已跟踪 PID 的 `taskkill /T /F` 清理本实例进程树；部署子进程也纳入同一
   生命周期。

ready 指纹格式统一为：

```text
<archive-sha256>|<node-version>|<dsh-version>
```

## 数据、更新与卸载

| 范围 | WSL 模式 | Windows 本机模式 |
|---|---|---|
| 用户数据 | `~/.dsh` | `%USERPROFILE%\.dsh` |
| 运行时缓存 | WSL 用户 Local Share | Windows LocalAppData |
| 模式偏好 | 不需要 | Electron userData 下的小型 JSON |

NSIS 与 portable 都只携带只读归档。应用升级会携带新的 runtime-id/归档；用户数据
路径不随应用版本变化。卸载程序只移除安装目录，不把 `.dsh`、运行时缓存或模式偏好
列为卸载目标。

必须特别说明：同一用户的 WSL `~/.dsh` 与 Windows `%USERPROFILE%\.dsh` 是两套
状态。Windows 本机模式不会自动看到 WSL 会话，反之亦然；这是数据隔离，不是会话
丢失。需要迁移时必须使用单独、可审计的数据迁移流程。

## 调试覆盖

- WSL：`DSH_WSL_DISTRO`、`DSH_WSL_HOME`、`DSH_WSL_CWD`、`DSH_WSL_PATH`、
  `DSH_WSL_RUNTIME_ROOT`；仅当 `DSH_WSL_NODE` 与 `DSH_WSL_DSH_SCRIPT` 同时
  给出时使用外部运行时；
- Windows：`DSH_WIN_HOME`、`DSH_WIN_CWD`、`DSH_WIN_RUNTIME_ROOT`；
- 模式：`DSH_RUNTIME_MODE`、`DSH_NO_WSL_CHOICE`、
  `DSH_RUNTIME_PREFERENCE_PATH`；
- `DSH_TEST_WSL_UNAVAILABLE=1` 只用于自动化测试，不应写入生产启动项。

## 验收要求

- WSL 可用时不显示确认框，日志和进程命令行必须指向 Linux 内嵌运行时；
- 模拟无 WSL 并选择退出时，进程正常结束，偏好、Windows 运行时和 `.dsh` 均不
  创建；
- 真实确认框必须只有两个预期按钮，关闭按钮等同退出；
- 干净 Windows runtime root 首次部署后，ready 指纹、Node/dsh 版本和 Web UI
  注入全部通过；第二次启动直接复用且没有临时目录、锁或孤儿进程；
- 两个归档 manifest 校验通过，NSIS、portable 与 `win-unpacked` 都实际携带两个
  制品；
- 覆盖安装和卸载/重装前后，WSL `.dsh`、Windows `.dsh` 与 Electron 用户状态的
  排除运行日志摘要保持一致；
- 正式 UI 中既有工作区分类、历史会话正文、profile 与本地插件仍能读取。
