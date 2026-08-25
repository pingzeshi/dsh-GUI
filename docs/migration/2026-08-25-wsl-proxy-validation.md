# DSH Desktop 0.4.2 WSL 环境代理修复验收记录

日期：2026-08-25（Asia/Shanghai）

## 故障表现

正式安装版在 WSL 模式发送“你好”后，18:59 显示：

```text
上下文注入 skill-catalog
已重试模型请求（2/2）
DeepSeek API request to https://api.deepseek.com failed
```

会话能够创建并进入模型请求阶段，但没有得到模型响应。

## 根因

本机 Windows 系统代理由 Clash Verge 提供：

- Windows 代理：`127.0.0.1:7897`；
- WSL：`networkingMode=mirrored`、`dnsTunneling=true`、`autoProxy=true`；
- WSL 中 `api.deepseek.com` 解析为 Clash fake-IP `198.18.0.53`；
- dsh 进程已继承 `HTTP_PROXY`、`HTTPS_PROXY`、小写变体及 `NO_PROXY`。

问题不在 DNS、API Key 或代理变量缺失，而在 Node 24 的行为：全局 `fetch()` 默认
不会自动读取环境代理。故障版 dsh 进程没有 `NODE_USE_ENV_PROXY`，因此模型请求
绕过 `127.0.0.1:7897`，最终连接超时。

内嵌包 `@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.7` 的实际请求代码直接调用：

```js
response = await fetch(`${connection.baseURL}/chat/completions`, {
  method: "POST",
  headers,
  body: payload,
  signal,
})
```

其 catch 分支抛出的正是
`DeepSeek API request to ${connection.baseURL} failed`，与 UI 证据完全对应。

## 修复

桌面版升级为 `0.4.2`，在三个入口统一启用 Node 环境代理：

1. WSL `/usr/bin/env` 参数加入 `NODE_USE_ENV_PROXY=1`；
2. `wsl.exe` 包装进程环境加入相同变量；
3. Windows 本机内嵌 Node 环境加入相同变量。

已有的大小写代理变量和 `NO_PROXY` 原样保留。没有代理变量时，该开关不会创建或
猜测代理地址。

新增 `scripts/test-proxy-env.js`，验证 WSL 环境赋值和 Windows 环境合并共用同一
开关，且不原地修改调用方环境对象。

## 网络 A/B 验证

所有请求都未读取或输出用户 API Key，只请求 DeepSeek API 根地址；HTTP 401 表示
TLS 和 HTTP 已连通但没有提供鉴权，正适合验证传输层。

| 场景 | 结果 |
|---|---|
| 故障版内嵌 Node，全局 `fetch()`，未启用环境代理 | 10,686ms 后 `UND_ERR_CONNECT_TIMEOUT` |
| 同一内嵌 Node，`NODE_USE_ENV_PROXY=1` | 125ms 返回 HTTP 401 |
| 0.4.2 编译后的 WSL 启动参数 | 明确包含 `NODE_USE_ENV_PROXY=1`，且位于 Node 命令之前 |
| 0.4.2 集成探针 | 300ms 返回 HTTP 401，进程内变量为 `1` |
| 正式安装版运行环境探针 | 122ms 返回 HTTP 401，退出码 0 |

正式安装版 dsh 进程环境实际包含：

```text
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
http_proxy=http://127.0.0.1:7897
https_proxy=http://127.0.0.1:7897
NO_PROXY=...
no_proxy=...
NODE_USE_ENV_PROXY=1
```

进程仍使用：

```text
cwd=/mnt/d/DeepSeekHarness
node=/home/pingzeshi/.local/share/dsh-desktop/runtimes/
  dsh-0.1.0-rc.7-node-24.15.0-linux-x64/bin/node
```

## 构建与制品

| 检查 | 结果 |
|---|---|
| `npm test` | `PROXY_ENV_TEST_OK` |
| `npm run smoke` | 启动阶段完整，最终 `SMOKE_OK` |
| `npm run dist` | NSIS、portable、win-unpacked 全部成功 |

| 制品 | 字节 | SHA-256 |
|---|---:|---|
| `release/DSH Desktop Setup 0.4.2.exe` | 271,629,282 | `4F3C7E0EE7E65BF4E18465D6B1622186D2A934DCE5474BF5BC493B5452F82D33` |
| `release/DSH Desktop-0.4.2-portable.exe` | 271,405,895 | `AC25314A7CD9DD24E28CBE0DA3CAC539FDAEB008AD6631A096E04E0B51A2BA11` |
| `release/win-unpacked/DSH Desktop.exe` | 225,533,440 | `738EAA962A0D1FB9491198BC2574B1159F8C39D15BB7C7C7163F3ACE5774B8E0` |
| `release/win-unpacked/resources/app.asar` | 2,909,579 | `A4C6FD7B8CE2A2C04922B61E80E101F124558D92C32FB3F5889FCF9D7D93F379` |

已安装主程序产品版本为 `0.4.2.0`；主程序与 `app.asar` 均和
`win-unpacked` 对应文件逐字节一致。

## 覆盖安装数据安全

在 0.4.1、smoke 和相关 WSL 进程全部停止后建立基线。0.4.2 安装器退出后、首次
启动前按相同算法复算，三项完全一致：

| 数据树 | 文件数 | 字节 | 逐文件聚合 SHA-256 |
|---|---:|---:|---|
| Windows `C:\Users\30745\.dsh` | 67 | 14,880,141 | `ED59C074B825048A05929DB29615BDD1A793DE9185777D153961A78586808994` |
| Electron userData | 4,165 | 256,199,540 | `43D6A49ED4150417976A0D45D6AFB8571E1EF2D359B69B0C12D1364299EFFAAB` |
| WSL `/home/pingzeshi/.dsh`（排除依赖目录） | 71 | 14,888,243 | `609DE516C0996DD4E628A1F0E8ED7258BEAD0D68E8776B82F83B850CC2C40BC4` |

安装前已有 24 个会话：根目录 4、`Everything` 7、`pluginConfigure` 6、
`quickStart` 7。覆盖安装没有新增、删除或改写会话。

正式启动后 dsh Web UI 按其既有行为在 `Everything` 创建一个新的空白会话，因此
目录总数变为 25；这是启动后的正常应用写入，不是安装器改动。原失败会话“你好”
仍在 `Everything` 下，18:59 的用户消息、上下文注入步骤及 2/2 重试状态均正常
载入。

## 验收边界

本轮通过无鉴权 HTTP 401 探针验证了与故障完全相同的 Node 全局 `fetch()` 网络
路径，没有读取 API Key，也没有自动替用户再次发送“你好”或消耗模型额度。正式
安装版已保持运行并停留在失败会话，用户可直接重试或发送下一条消息完成鉴权后的
端到端确认。

近 45 分钟内 DSH Desktop 的 Windows Application Error 和 Crashpad 新报告均为
0。Chromium 的 `WSALookupServiceBegin 10108` 枚举告警仍可能出现在 smoke 日志，
但不影响 WSL Node 代理连通性或 Web UI 启动。
