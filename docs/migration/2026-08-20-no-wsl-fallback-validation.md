# DSH Desktop 0.4.0 无 WSL 回退与覆盖更新验收记录

日期：2026-08-20（Asia/Shanghai）

## 结论

- 0.4.0 安装包同时内嵌 Linux x64 与 Windows x64 的 Node.js 24.15.0、
  `@deepseek-ai/dsh@0.1.0-rc.7` 完整生产依赖；目标机不需要预装 Node、npm、
  pnpm 或全局 dsh。
- 自动模式仍优先使用 WSL。没有可用 WSL 且用户从未授权本机模式时，正式安装版
  只显示“使用 Windows 本机模式”和“暂不配置并退出”两个选择；关闭对话框等同
  于退出。
- 选择退出后，不保存运行模式偏好、不部署 Windows 运行时、不创建或修改
  `%USERPROFILE%\.dsh`。选择本机模式后，才会部署内嵌 Windows 运行时，并将
  用户授权保存到 Electron userData。
- 已在原目录完成 0.3.0 → 0.4.0 直接覆盖更新。安装器退出后、首次启动前，WSL
  `.dsh`、Windows `.dsh` 和 Electron userData 三棵数据树的文件数、总字节与
  聚合 SHA-256 均与更新前完全一致。
- 正式安装版启动后，`pluginConfigure`、`Everything`、`quickStart` 和“未分组”
  仍分别存在；迁移前会话 `美化DeepSeek Harness界面方案` 的历史正文和
  `3 轮 · 143 步` 统计均正常载入。
- WSL 与 Windows 本机模式的 `.dsh` 故意相互独立。切换模式后看到另一套会话、
  workspace、插件、profile、设置与凭据属于数据隔离，不代表数据丢失，也不会
  发生隐式合并或迁移。

## 无 WSL 决策流程

| 条件 | 自动模式行为 | 是否写用户数据 |
|---|---|---|
| 指定 WSL 发行版可用 | 直接使用 WSL 内嵌运行时 | 继续使用 WSL `~/.dsh` |
| WSL 不可用，已有本机模式授权 | 直接使用 Windows 内嵌运行时 | 继续使用 `%USERPROFILE%\.dsh` |
| WSL 不可用，无既有授权 | 显示只有两个选择的原生确认框 | 显示确认框本身不写入偏好或 `.dsh` |
| 选择“使用 Windows 本机模式” | 保存授权并部署/复用 Windows 运行时 | 仅使用 Windows `.dsh` |
| 选择“暂不配置并退出”或关闭对话框 | 立即退出 | 不保存授权、不部署运行时、不创建 `.dsh` |

确认框会明确说明：Windows 本机模式使用安装包内置的 Node.js 与 dsh，不安装
全局 npm 包；Windows `%USERPROFILE%\.dsh` 与 WSL `~/.dsh` 相互独立。用户后来
安装或修复 WSL 后，`auto` 模式仍会恢复首选 WSL，不会被旧的本机模式授权锁定。

## 制品与运行时

| 制品 | 字节 | SHA-256 |
|---|---:|---|
| `release/DSH Desktop Setup 0.4.0.exe` | 271,627,957 | `11C8C635D1C664B763E511EC8EE55B74FAFE6A5820C6856E6C886CC1E6D28960` |
| `release/DSH Desktop-0.4.0-portable.exe` | 271,404,584 | `BA1DE7CAEE51C1B48F4BE1D2067C3DB3695B6EBAABDD635EE49AF3F8DF61ED1E` |
| `release/win-unpacked/DSH Desktop.exe` | 225,533,440 | `90C7711D06ED655372B39F699C267414531CC627D32AC68DFBC10F08881D1D60` |
| `runtime/dsh-linux-x64.tar.gz` | 91,971,661 | `0B8286B0E78757C511455A5CCA35D5CE21723799806BEDF63905BA856CE640DB` |
| `runtime/dsh-win32-x64.tar.gz` | 81,414,743 | `769C72ECA0AB4CA26C19B0695C4026ADBFF50CEF76BA8FA9EF90088183E3A2B8` |

两个 runtime-id 分别为：

```text
dsh-0.1.0-rc.7-node-24.15.0-linux-x64
dsh-0.1.0-rc.7-node-24.15.0-win32-x64
```

Windows 运行时使用 hoisted 依赖树，归档内没有 reparse point 或符号链接；对完整
32,506 个 `node_modules` 文件连续两次打包得到相同 SHA-256。桌面端校验归档大小
和哈希后，在独立 Electron-as-Node 子进程中解压；解压器拒绝绝对路径、`..`、
符号链接和未知条目类型，只接受安全的普通文件、目录及归档内部 hardlink。

部署使用锁、过期锁回收、残留临时目录清理、ready 指纹和临时目录原子改名。
中断恢复测试实际清理 1 个陈旧锁对应的临时目录，随后完成部署；最终临时片段为 0。

## 构建与形态验证

| 形态/场景 | 结果 |
|---|---|
| 源码 `runtime:verify`、TypeScript 构建 | Linux/Windows manifest、大小、SHA-256 与版本全部通过 |
| 开发版默认模式 | 检测到 Ubuntu，使用 WSL 内嵌运行时，`SMOKE_OK` |
| 开发版模拟无 WSL并选择退出 | 退出码 0；偏好文件不存在；未部署 Windows 运行时 |
| 开发版 Windows 首次部署 | 32,508 个运行时文件完成部署；Node/dsh/Web UI/`__DSH_BOOT__` 全部通过 |
| 开发版 Windows 缓存启动 | 复用 ready 运行时，11.1 秒完成；残留片段和进程均为 0 |
| `win-unpacked` WSL | 退出码 0，使用 Linux 内嵌运行时 |
| `win-unpacked` Windows | 首次部署与中断恢复通过，退出码 0，残留片段 0 |
| portable WSL | 干净隔离目录首次部署成功，ready 指纹、Web UI 与退出码通过 |
| portable Windows | 隔离 Windows `.dsh` 创建 5 个初始文件，Web UI 与退出码通过 |
| 已安装版 WSL | 使用 Linux 归档，`SMOKE_OK`，退出后相关进程 0 |
| 已安装版 Windows | 复用隔离运行时，隔离 `.dsh` 创建 5 个初始文件，`SMOKE_OK`，残留片段/进程 0 |

Windows 本机的首次部署、缓存复用和已安装版测试全部使用临时 runtime root、
`DSH_HOME` 与工作目录，没有读写真实 `%USERPROFILE%\.dsh`。

## 正式安装版无 WSL 双选验证

在 `D:\deepseekGUI\DSH Desktop\DSH Desktop.exe` 上用测试开关模拟 WSL 不可用，
通过 Windows 原生辅助功能树和屏幕截图核对确认框：

- 标题：`未检测到可用的 WSL`；
- 主问题：`是否改用 Windows 本机环境配置 dsh？`；
- 按钮 1：`使用 Windows 本机模式`；
- 按钮 2：`暂不配置并退出`；
- 没有第三个安装、迁移或强制继续选项；
- 说明文字包含两套 `.dsh` 相互独立以及退出不会配置 dsh 的提示。

本次点击“暂不配置并退出”后，进程正常结束；隔离的
`runtime-preference.json` 不存在，相关 Electron、Node、WSL 进程数为 0。第一项的
实际 Windows 启动链路另以安装版隔离冒烟测试覆盖，得到 `SMOKE_OK`。

## 0.3.0 → 0.4.0 直接覆盖更新

更新前安装路径为 `D:\deepseekGUI\DSH Desktop`，主程序版本为 0.3.0，SHA-256 为
`AE79F63D31D10038DEC00485B3CE002743773F70E26DC03154E8B8335E039B80`。
使用 0.4.0 NSIS 安装器对原目录静默覆盖，安装器退出码为 0。

更新后：

- 卸载注册项为 `DSH Desktop 0.4.0`；
- 主程序文件版本/产品版本为 `0.4.0` / `0.4.0.0`；
- 已安装主程序 SHA-256 为
  `90C7711D06ED655372B39F699C267414531CC627D32AC68DFBC10F08881D1D60`，与
  `win-unpacked` 主程序逐字节一致；
- 安装目录中的 Linux/Windows 运行时归档与构建源归档大小、哈希一致。

安装前与安装器退出后、首次启动前使用同一树摘要算法比较，三项完全一致：

| 数据树 | 文件数 | 字节 | 聚合 SHA-256 |
|---|---:|---:|---|
| WSL `/home/pingzeshi/.dsh`（排除依赖目录） | 67 | 14,856,951 | `EA9875D118C0BEB3F0083D69DB08E7F0AEB3582BABD72B8780F08735130FF605` |
| Windows `C:\Users\30745\.dsh`（排除依赖目录） | 67 | 14,880,141 | `B930EABAC962C259FAA8E686DF55DD74E8FDCF3E5AA0E680B3C339AA6050F761` |
| Electron `C:\Users\30745\AppData\Roaming\DSH Desktop` | 3,129 | 195,225,959 | `26A28AFE0C7005C5E00210A54CCBB37E07CBD5D32A2C494BB3CE74FC052A3888` |

这一步发生在 0.4.0 第一次启动之前，因此排除了 Web UI 缓存、自愈日志等正常运行
时写入，直接证明覆盖安装本身没有删除、重写或重新分类既有数据。

## 会话、项目分类与插件状态验证

0.4.0 正式安装版默认自动选择 WSL，进程命令行实际指向：

```text
/home/pingzeshi/.local/share/dsh-desktop/runtimes/
  dsh-0.1.0-rc.7-node-24.15.0-linux-x64/bin/node
/home/pingzeshi/.local/share/dsh-desktop/runtimes/
  dsh-0.1.0-rc.7-node-24.15.0-linux-x64/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0
```

正式 UI 辅助功能树和截图实际显示四个顶层分类：

- `pluginConfigure`；
- `Everything`；
- `quickStart`；
- `未分组`。

展开 `quickStart` 后仍看到 `迁移deepseek-harness到wsl环境`、
`美化DeepSeek Harness界面方案` 和 `打包deepseek-harness为GUI`。打开
`美化DeepSeek Harness界面方案` 后，标题、历史正文、历史产物链接、
`3 轮 · 143 步`、上下文与 token 统计全部载入，证明会话历史没有失效，项目会话
也没有被整体归入“未分组”。

启动验证后，Windows `.dsh` 仍为 67 个文件、14,880,141 字节，和安装前完全
相同。WSL `.dsh` 仍为 67 个文件，总字节增加 250；变动来自既有
`super-injector/self-heal.log` 的正常追加。Electron userData 的缓存文件会在正常
启动后变化，因此数据不变性以“安装器退出后、首次启动前”的三树摘要为准。

## 验收边界

本轮按“先更新、直接在本机安装最新版本”的要求完成 0.3.0 → 0.4.0 覆盖更新，
没有再次卸载当前 0.4.0。0.3.0 的真实卸载/重装、首次启动前数据零变化以及两次
正式 UI 验收记录见
[`2026-08-20-embedded-runtime-validation.md`](2026-08-20-embedded-runtime-validation.md)。
0.4.0 沿用相同的 NSIS 数据边界，并新增了 Windows 本机运行时；本轮已通过直接
覆盖更新、安装版双模式冒烟和正式历史 UI 验证覆盖用户选择的验收路径。
