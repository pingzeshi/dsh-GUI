# DSH WSL2 迁移与桌面版 0.2.1 验收记录

日期：2026-08-19（Asia/Shanghai）

## 结论

- DeepSeek Harness 已迁移至 WSL2 Ubuntu 的 Linux 原生运行时。
- WSL2 中安装的 dsh 为 npm `latest`：`@deepseek-ai/dsh@0.1.0-rc.7`。
- 桌面源码已由 Windows npm shim 改为通过 `wsl.exe` 启动 WSL2 dsh。
- 原桌面版 0.1.0 已实际卸载，桌面版已覆盖更新至 0.2.1 并安装到原目录。
- 卸载后与重装后首次启动前，WSL dsh 状态和 Electron 用户数据均逐文件零变化。
- 重装后首次启动只追加了 `super-injector/self-heal.log`；66 个关键状态文件全部未变。
- 已修复首次迁移遗漏的 Windows → WSL 会话项目路径映射；三个既有工作区及历史正文均已在正式安装版界面复验。
- 21/21 个会话、32,585 个 Zstd 事件帧和 40,900 条 JSONL 历史记录均可解压解析；事件帧在修复时逐字节保持不变。

## 环境盘点

### Windows

| 项目 | 值 |
|---|---|
| 系统 | Windows 11 家庭版中文版，build 26200，x64 |
| CPU / 内存 | AMD Ryzen 7 7840HS，16 逻辑处理器，13.7 GiB |
| Node / npm | v24.15.0 / 11.12.1 |
| 原 Windows dsh | 0.1.0-rc.6，`D:\npm\npm-global`（保留作回退，不再供桌面版使用） |
| 桌面版 | 0.2.1，`D:\deepseekGUI\DSH Desktop` |

### WSL2

| 项目 | 值 |
|---|---|
| WSL 包 | 2.6.3.0 |
| 发行版 | Ubuntu 24.04.4 LTS，WSL version 2 |
| Kernel / 架构 | 6.6.87.2-microsoft-standard-WSL2 / x86_64 |
| WSL 内存 | 6.6 GiB |
| 根文件系统 | 1007 GiB，总可用约 952 GiB |
| Linux Node / npm | v24.15.0 / 11.12.1 |
| pnpm | 11.22.0 |
| dsh | 0.1.0-rc.7 |
| dsh 运行时 | `/home/pingzeshi/.local` |
| DSH_HOME | `/home/pingzeshi/.dsh` |

`.wslconfig` 请求 mirrored networking；本机 WSL 启动时提示回退 NAT，并提示 localhost
代理未镜像。该提示不阻塞本应用：Windows 对 WSL dsh 的 `127.0.0.1` 实测 HTTP 200，
且页面包含 `window.__DSH_BOOT__`。

## 数据迁移

Windows 主数据源：`C:\Users\30745\.dsh`

迁移策略：

1. 复制会话、附件、技能、凭据、设置、profile 元数据和存储数据。
2. 不复制 Windows `node_modules` / `.pnpm`，避免 junction 和 Windows 原生模块污染 Linux。
3. 在 WSL2 内用 pnpm 重新建立 Linux 依赖。
4. 将两个本地插件链接改写为 Linux 挂载路径：
   - `@dsh-external/dsh-super-injector` → `/mnt/d/DeepSeekHarness/dsh-routing-suite/injector-release/package`
   - `dsh-qwen-mm` → `/mnt/d/DeepSeekHarness/pluginConfigure/dsh-qwen-mm`
5. 将 anchored-standard preset 的 Bash 路径从 Windows Git Bash 改为 `/bin/bash`。

初次复制验证：67/67 文件，缺失 0，SHA-256 不匹配 0；迁入 21 个会话目录。

WSL 原有的早期 `.dsh` 只有默认 profile、没有会话或凭据，已保留为：
`/home/pingzeshi/.dsh.pre-windows-migration-20260819-210401`。

## 会话分类故障及无损修复

0.2.0 首次迁移时，复制了会话和工作区文件，却遗漏了其中用于关联项目的路径键：

- 21 个 `session.jsonl.zstd` 头仍为 `D:\...`；
- `storages/workspace.json` 的 3 个工作区路径仍为 `D:\...`；
- `storages/session_projcache.json` 的 18 个 `identity.cwd` 仍为 `D:\...`。

WSL 中 dsh 使用 `/mnt/d/...` 作为当前目录和项目键，因此旧键无法匹配，表现为项目会话
进入“未分组”，并且旧会话恢复失败。修复脚本
`scripts/migrate-wsl-session-paths.mjs` 执行了以下原子迁移：

1. 将 21 个会话头中的 Windows 路径映射为 `/mnt/d/...`，并按新项目键重建目录；
2. 只重压首个 header frame，后续 32,585 个事件帧原字节复制并校验 SHA-256；
3. 同步改写 workspace 和 projection cache 的结构化路径字段，不改写会话正文；
4. 逐帧解压并 JSON 解析 40,900 条历史记录；
5. 原会话目录和两个原索引文件完整保留到
   `/home/pingzeshi/.dsh-path-backup-20260819T135705Z`。

修复后分组恢复为：`pluginConfigure` 6 个、`Everything` 4 个、`quickStart` 7 个；
另有 4 个 cwd 为 `D:\DeepSeekHarness` 的根目录会话在迁移前就不属于上述三个
workspace，因此继续位于“未分组”，这不是本次迁移造成的新丢失。

## 桌面源码改动

- `src/main/dsh.ts`
  - 探测 WSL 发行版、HOME、Linux Node 和 dsh 脚本；
  - 通过 `wsl.exe` + Linux 原生 Node 启动 `dsh web --port 0`；
  - 使用 `setsid` 创建独立 Linux 进程组；
  - 退出时按 PID/PGID 发送 TERM/KILL，不使用 `wsl --terminate`；
  - 支持 `DSH_WSL_*` 环境变量覆盖。
- 默认工作目录使用 `/mnt/d/DeepSeekHarness`（不存在时回退 WSL HOME），避免后续再次生成不匹配的 home 项目上下文。
- `package.json` / `package-lock.json`：版本升至 0.2.1。
- `README.md` / `renderer/error.html`：更新为 WSL2 安装与排障说明。

## 构建与运行验收

| 验收项 | 结果 |
|---|---|
| TypeScript build | 通过 |
| 开发态 Electron smoke | exit 0，`SMOKE_OK` |
| unpacked 0.2.0 smoke | exit 0 |
| portable 0.2.0 smoke | exit 0 |
| 已安装 0.2.0 smoke | exit 0 |
| 开发态 0.2.1 smoke | exit 0，`SMOKE_OK` |
| 已安装 0.2.1 界面 | 三个工作区均恢复；迁移前历史会话标题和正文可打开 |
| Windows → WSL localhost | HTTP 200，`__DSH_BOOT__` 存在 |
| 进程清理 | 退出后 URL 不可达，无 dsh / wsl.exe 孤儿进程 |
| Web profile 组合 | core web + super-injector + dsh-qwen-mm 均被识别 |

## 卸载/重装数据验证

卸载前基线：

- WSL dsh 状态：67 文件，21 个会话目录。
- Electron userData：1215 文件。

实际操作：

1. 静默卸载桌面版 0.1.0，exit 0；安装目录、注册表和快捷方式均清理。
2. 比较状态：WSL 67/67、Electron 1215/1215，缺失/修改/新增均为 0。
3. 静默安装桌面版 0.2.0 到原目录，exit 0。
4. 首次启动前再次比较：两套状态仍全部为 0 变化。
5. 运行已安装版 smoke，exit 0。
6. 运行后比较：
   - WSL：缺失 0、新增 0，仅 `super-injector/self-heal.log` 正常追加；
   - 关键状态：66 文件修改 0（会话、附件、技能、设置、凭据、profile、插件、workspace）；
   - Electron：缺失 0；17 个缓存索引更新、74 个缓存条目新增，均为正常运行缓存。
7. Windows 原 `.dsh` 仍保持 67/67 文件零变化，证明 0.2.0 使用的是 WSL 数据。

结论：桌面程序的卸载、重装和首次运行不会删除或覆盖现有会话、插件、凭据及设置。

## 0.2.1 覆盖更新数据验证

在 0.2.1 安装前和安装成功后、首次启动前，对三套数据做了完整树摘要（相对路径、
长度和逐文件 SHA-256 再聚合）。三套结果均完全一致：

| 数据树 | 文件数 | 字节数 | 安装前/后聚合 SHA-256 |
|---|---:|---:|---|
| WSL `/home/pingzeshi/.dsh`（排除依赖目录） | 67 | 14,854,951 | `DFF433DD124FF7B58E241FE34A6FF1CDECC6A6F05F350ACDEA2E5A1740E0CC1C` |
| Windows `C:\Users\30745\.dsh`（排除依赖目录） | 67 | 14,880,141 | `2FF8B645756DA9E8755D2E6A0A2919FCB8B1ECA2A9CFF7615C4445820195E3EF` |
| Electron `C:\Users\30745\AppData\Roaming\DSH Desktop` | 1513 | 95,299,889 | `B6A736B0B84D3BD06081BA13779A908CAA77622395C37DB252343A504F10F4A2` |

安装器 exit 0，正式安装文件版本为 `0.2.1.0`。随后从正式安装目录启动，实际展开
三个工作区并打开迁移前会话，历史正文正常显示；退出后 Windows 桌面进程与 WSL
`dsh web` 进程均为 0。

## 产物

| 产物 | SHA-256 |
|---|---|
| `release/DSH Desktop Setup 0.2.0.exe` | `444201EE27DDBB0E3C3B01D5626A76140F73272FE6C0BEDE37355006B236B4B4` |
| `release/DSH Desktop-0.2.0-portable.exe` | `CDECEDE936C6936B09EC31984F69D7E22C2E6A11BBE5CA0BC53D189F0F2716C4` |
| `release/win-unpacked/DSH Desktop.exe` | `3EAD9625ADDE7ECDA17124DB6971DAA79863606A7CD74C9259CA64F6FF5F52A9` |
| `release/DSH Desktop Setup 0.2.1.exe` | `2590E62C5F54F7B7CB020ED4DF298576BF68562672AF354E8F4937F5F23C517C` |
| `release/DSH Desktop-0.2.1-portable.exe` | `CCB45F3D6BE05C534BA8D359394319F8FEFB63AB121F18B8409DF38138A8B3CB` |

## 备份与回退

迁移前备份：
`D:\DeepSeekHarness\migration-backups\pre-wsl-20260819-210401`

其中包含：

- Windows `.dsh` 状态副本与 SHA-256 manifest；
- Electron userData 副本与 manifest；
- WSL 原有 `.dsh` 的 tar.gz 归档；
- 卸载前 WSL/Electron 基线 manifest。

如需回退，先退出桌面程序，再使用上述备份；不要覆盖仍在运行的 dsh 状态目录。

会话分类故障修复前的额外快照：
`D:\DeepSeekHarness\migration-backups\classification-regression-20260819-214948`

路径修复的原位回滚副本：
`/home/pingzeshi/.dsh-path-backup-20260819T135705Z`

后者保留的是含 Windows 路径键的故障态，仅用于审计或精确回滚，不应作为 WSL
日常运行数据重新启用。当前修复态才是推荐状态。
