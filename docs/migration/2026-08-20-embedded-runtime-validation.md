# DSH Desktop 0.3.0 内嵌运行时与重装验收记录

日期：2026-08-20（Asia/Shanghai）

## 结论

- 0.3.0 安装包已经内嵌 Linux x64 Node 24.15.0 与
  `@deepseek-ai/dsh@0.1.0-rc.7`；目标 Windows 用户不再需要安装 Node、npm、
  pnpm 或全局 dsh。
- 已在原安装目录完成 0.2.1 → 0.3.0 覆盖更新；随后实际卸载 0.3.0 并重新
  安装 0.3.0。最终系统保留的是已安装的 0.3.0。
- 覆盖更新、卸载、重装三个阶段在首次启动前均没有改动 WSL `~/.dsh`、Windows
  `.dsh` 或 Electron userData。
- 覆盖更新后和卸载重装后分别打开正式安装版，工作区分类与迁移前历史正文均能
  正常读取。相对安装前备份，67 个 WSL 非依赖文件中只有运行时日志
  `super-injector/self-heal.log` 正常追加，其余 66 个会话、设置、凭据、索引、
  skills 与 profile 元数据逐文件未变。
- 两次正式启动均确认 dsh 进程来自版本化内嵌运行时目录，没有回退到 WSL 全局
  dsh。最终 Windows DSH Desktop 与 WSL dsh 孤儿进程均为 0。

## 制品

| 制品 | 字节 | SHA-256 |
|---|---:|---|
| `release/DSH Desktop Setup 0.3.0.exe` | 190,689,752 | `4A67628522DA3AF1025B5B991E4AC620CF903818AFBD3E07179965CAF44B289C` |
| `release/DSH Desktop-0.3.0-portable.exe` | 190,466,320 | `D8450A910279FA5F5536B8031111560C8A3F56156FE8A32972E90075920ADF5E` |
| `runtime/dsh-linux-x64.tar.gz` | 91,971,661 | `0B8286B0E78757C511455A5CCA35D5CE21723799806BEDF63905BA856CE640DB` |

安装后的 `D:\deepseekGUI\DSH Desktop\DSH Desktop.exe` 文件版本为 `0.3.0`、
产品版本为 `0.3.0.0`，SHA-256 为
`AE79F63D31D10038DEC00485B3CE002743773F70E26DC03154E8B8335E039B80`。
安装目录内运行时归档的字节数和 SHA-256 与构建源归档完全一致。

## 构建与便携版验证

- 运行时归档连续两次强制构建得到相同字节数和 SHA-256。
- 解包验证 Node `v24.15.0`、dsh `0.1.0-rc.7`、32,011 个文件、断链 0、
  构建机 HOME/临时路径泄漏 0。
- 干净临时 `DSH_HOME` 启动 Web UI 并获得 `window.__DSH_BOOT__`。
- `win-unpacked` 冒烟测试 exit 0；portable 在干净 runtime root 与干净 HOME
  首次部署后 exit 0，ready 标记为
  `0b8286b0...640db|24.15.0|0.1.0-rc.7`，退出后 dsh 进程 0。
- 错误归档 SHA 会被拒绝；部署中断后 provision 进程与临时目录均为 0。

## 覆盖更新验证

更新前当前时点备份保存于：

`D:\DeepSeekHarness\migration-backups\embedded-runtime-validation-20260820-020156`

其中 WSL 核心归档 SHA-256 为
`18E1531FDAE1A826EC5D8993A83FCC68B06308197680CF25AC82D48FD5E06A1F`。

使用 0.3.0 NSIS 对已安装的 0.2.1 静默覆盖，安装器 exit 0，安装目录仍为
`D:\deepseekGUI\DSH Desktop`，卸载注册项更新为 `DSH Desktop 0.3.0`。首次启动前
用同一算法比较备份和当前树，三项全部一致：

| 数据树 | 文件数 | 字节 | 聚合 SHA-256 |
|---|---:|---:|---|
| WSL `/home/pingzeshi/.dsh`（排除依赖目录） | 67 | 14,855,951 | `3EC89E9098922B27AFE2E7E84E94111AE49D97EF73A7B1781137BB92182E19D4` |
| Windows `C:\Users\30745\.dsh`（排除依赖目录） | 67 | 14,880,141 | `F8D78C46732FE993C4404A19278E4B7A5CEB3D07041F43281371D13D11680EEC` |
| Electron `C:\Users\30745\AppData\Roaming\DSH Desktop` | 2,176 | 134,618,278 | `EABA9D2AEC6194B33939509191FFC83243D06C967160148F4A919AB6E78F8685` |

正式安装版启动后，WSL 进程命令行实际使用：

```text
/home/pingzeshi/.local/share/dsh-desktop/runtimes/
  dsh-0.1.0-rc.7-node-24.15.0-linux-x64/bin/node
/home/pingzeshi/.local/share/dsh-desktop/runtimes/
  dsh-0.1.0-rc.7-node-24.15.0-linux-x64/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0
```

ready 标记完整值为：

```text
0b8286b0e78757c511455a5cca35d5ce21723799806bedf63905ba856ce640db|24.15.0|0.1.0-rc.7
```

## 工作区、会话与插件 UI 验证

`workspace.json` 保留三个工作区及全部成员：

| 工作区 | 路径 | 存储的会话数 |
|---|---|---:|
| `pluginConfigure` | `/mnt/d/DeepSeekHarness/pluginConfigure` | 6 |
| `Everything` | `/mnt/d/DeepSeekHarness/Everything` | 4 |
| `quickStart` | `/mnt/d/DeepSeekHarness/quickStart` | 7 |

此外根目录项目键下仍有 4 个会话。`archivedSessionIds` 原样保留 6 个归档会话，
因此默认侧边栏只显示未归档项；一个空白根会话也不会显示。这是已有用户状态，
不是安装造成的分类丢失。

覆盖更新后的正式 UI 和卸载重装后的正式 UI 均看到
`pluginConfigure`、`Everything`、`quickStart`、`未分组`。两次都打开了迁移前的
`美化DeepSeek Harness界面方案`，标题、正文、`3 轮 · 143 步`统计和历史产物
链接均正常载入，证明会话正文没有失效。

profile 符号链接仍为 512 个，链接清单 SHA-256 为
`903421468bf7c82522611492335b2bbb64bff5f02e74b422ecc4bfe1b493b68e`。
两个本地插件目标保持：

- `@dsh-external/dsh-super-injector` →
  `/mnt/d/DeepSeekHarness/dsh-routing-suite/injector-release/package`
- `dsh-qwen-mm` → `/mnt/d/DeepSeekHarness/pluginConfigure/dsh-qwen-mm`

## 真实卸载与重装验证

首次正式 UI 验收并退出后，冻结了用于卸载/重装的第二份基线：

| 数据树 | 文件数 | 字节 | 聚合 SHA-256 |
|---|---:|---:|---|
| WSL `.dsh` | 67 | 14,856,076 | `EE2CA0AAAB2AA39AE60D4C653B7DB211EE94341BF73A16762866A9AEE7BD4673` |
| Windows `.dsh` | 67 | 14,880,141 | `F8D78C46732FE993C4404A19278E4B7A5CEB3D07041F43281371D13D11680EEC` |
| Electron userData | 2,251 | 138,993,308 | `92C0995F7CC472C6304FF091760216A61117D5C73E97B2AA036F3A56899577F1` |

实际流程：

1. 调用注册表记录的精确卸载程序，exit 0；安装目录和卸载注册项均消失。
2. 立即比较三棵数据树，文件数、字节数、聚合 SHA-256 全部与第二份基线相同。
3. 用同一 0.3.0 安装器重装到原目录，exit 0；首次启动前再次比较，三项仍全部相同。
4. 运行重装后的正式应用，再次打开同一历史会话；分类和正文正常。
5. 相对覆盖更新前备份逐文件复核 WSL 核心状态：缺失 0、新增 0，仅
   `super-injector/self-heal.log` 追加；其余 66 文件不变。
6. 退出后 Windows DSH Desktop 进程 0、WSL dsh 进程 0。

结论：桌面应用文件、WSL 运行时缓存和 `DSH_HOME=~/.dsh` 已正确分离。覆盖更新、
卸载和重装不会删除或重分类现有会话，也不会覆盖插件、profile、设置或凭据。
