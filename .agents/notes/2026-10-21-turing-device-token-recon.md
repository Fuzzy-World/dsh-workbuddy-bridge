# 备忘：插件可自 load `turing-sdk` 在本机内存里产出 `X-Device-Token`

状态：生效

## 事实

目标：判断 DSH 插件能否在运行时拿到可用的 `X-Device-Token`（上游 `POST /v2/chat/completions` 回
`400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`，官方客户端靠这个头过闸）。

### 结论：路径 1（直接 require 原生 addon）跑通

系统 Node 直接加载官方自带的 N-API addon，`configure` + `fetchDeviceToken` 在**内存里产出了 token**：

```
[1] isSupported= true loadError= null
[2] configure ok
[3] calling fetchDeviceToken...
[4] resolved in 115 ms; typeof= string
[5] TOKEN OK  prefix= v3:AAA  len= 1066  (按纪律只打印前 6 字符与长度)
```

产出：`v3:` 前缀、长度 1054–1066 浮动、全 printable ASCII、不含换行。**不需要** WorkBuddy 的 Electron，
不需要 App 配合，不改 App 任何文件，不写注册表。

### token 形态（只记录结构，不记录内容）

按 `#` 切分是 3 段，`v3:` 在最左：

| 段 | 内容 | 本次长度 | base64 解出 |
| --- | --- | --- | --- |
| 0 | `v3:` + 载荷 | 539（含 `v3:`） | 401 B 二进制 |
| 1 | 单字符标志位 | 1 | —— |
| 2 | 载荷 | 512 | 384 B 二进制 |

解出的两段都是二进制（无 `WorkBuddy` / `109144` 之类明文），长度随调用浮动 → 本地现算 + 随机量，
不是某种可复用的缓存密文。同进程连调两次也不相同（`same-in-process? false`）。

### 配置真值（三个参数从哪来）

`app.asar` 内的 Turing 服务取值链（`resolveConfiguration()` 反查，原文在 asar 单行 bundle 里）：

```
channelId       = env WORKBUDDY_TURING_CHANNEL_ID ?? config.turingSdk.channelId
productName     = applicationName ?? productName ?? electron.app.getName()
productVersion  = productVersion ?? electron.app.getVersion()
sdkVariant      = isOversea === true ? 'overseas' : 'domestic'
keychainStorageEnabled = electron.app.isPackaged   // 仅 darwin 分支才传给 configure
feature flag    = env WORKBUDDY_TURING_ENABLED ?? productFeatures.TuringDeviceToken !== false
```

真值来源与取值：

- `C:\Users\33385\.workbuddy\cache\acc-product-config-v3.json`（411,752 B）—— 环境变量 `ACC_PRODUCT_CONFIG_V3`
  的落盘副本，也是唯一带 `turingSdk` 的文件：
  `applicationName=WorkBuddy`、`productName=WorkBuddy`、`endpoint=https://www.workbuddy.cn`、
  **`config.turingSdk={"channelId":109144}`**；`isOversea` / `productVersion` / `productFeatures.TuringDeviceToken` 均未定义
  （后者未定义 → `!== false` → 功能开启）。
- `resources/app.asar` 内 `package.json`：`@genie/workbuddy-desktop 5.8.3`、`productName=WorkBuddy`
  → `app.getVersion()` 即 `5.8.3`；`WorkBuddy.exe` 的 FileVersion 也是 `5.8.3`。
- `resources/app.asar.unpacked/native/turing-sdk/build/Release/turing-sdk-variant.json`：`{"variant":"domestic"}`
  （与 `isOversea` 未定义一致）。

**`channelId` 不在 `resources/install-manifest.json`，也不在 `cli/product.json`（389 KB 那版也没有 turingSdk 键）**，
只在上述 product-config 缓存里 —— 这是最容易走空的一步。

### 差分与失败面（每条都实跑过）

| 场景 | 结果 |
| --- | --- |
| 不 `configure` 直接 `fetchDeviceToken` | 抛 `Turing SDK is not configured` |
| 第二次 `configure` 换 `channelId` | 抛 `Turing SDK channelId cannot change after initialization`（**进程内一次性**） |
| 换 `productName` 再 configure | 成功（不锁） |
| `configure` 传第 4 参 `keychainStorageEnabled=true` | 成功（win32 分支本就只传 3 参，第 4 参无效） |
| 从 `%TEMP%` 作 cwd 跑 | 成功（DLL 依赖按 `.node` 同目录解析，与 cwd / PATH 无关） |
| 系统 Node v24.15.0（`napi: 10` / `modules: 137`） | 成功（N-API ABI 稳定，非 Electron 专属编译） |

### 路径 3 结论：磁盘上没有 token 缓存（证伪）

- 官方 SDK 侧：对 8 个落点根（安装目录下 turing-sdk、`%LOCALAPPDATA%\Tencent`、`%APPDATA%\Tencent`、
  `%ProgramData%\Tencent`、`~/.workbuddy/{security,credentials,storage,cache}`）在调用前后做 mtime 快照，
  共 2944 个文件：**created=0、modified=0**。
- `TuringShieldSDK.dll` 的 ASCII 串里没有 `AppData` / `Roaming` / `ProgramData` / `SOFTWARE` / `Registry`
  之类存储路径（只有 `.workbuddy\models.json`、`.codebuddy\models.json` 两条无关串和 PDB 路径）。
- App 侧：token 只活在主进程内存里。`DEFAULT_REFRESH_INTERVAL_MS=3e5`（5 分钟）后台刷新、
  `DEFAULT_REQUEST_TIMEOUT_MS=5e3`、失败重试 `30s` 起；`main.log` / `daemon.log` / `renderer.log` 里
  `X-Device-Token` 命中 **hits=0**（扫描脚本按正则只回前缀与长度，日志里根本没有该头）。
- 所以 `keychainStorageEnabled` 的语义是「macOS 上把这个 token 交给系统钥匙串」，**Windows 分支压根不传这个参数**，
  也就没有对应的落盘面；`~/.workbuddy` 全盘无 `v3:` 字面量是合理结果，不是加密存储。

### 路径 2 侦察：App 本地 IPC 通，但从插件侧拿成本更高

- 发现文件：`~/.workbuddy/wbipc/endpoint.json`
  → `{"endpoint":"\\\\.\\pipe\\wbipc-<16 hex>","ticket":"<43 字符 base64url>"}`（值为本机 IPC 鉴权票据，此处不抄全文）。
- 通道实名：`desktopHost:getTuringDeviceToken`。asar 里能看到 `ipcMain.handle(GET_TURING_DEVICE_TOKEN, async () => t.auth.getTuringDeviceToken())`，
  以及 `auth.getTuringDeviceToken` 的宿主实现（走 `invoke`）。
- 帧格式（`resources/wb-guest-sdk/wb.js`，guest↔host MessagePort 桥）：
  - 请求 `{type:'wb:invoke:request', requestId, channel:'desktopHost:getTuringDeviceToken', context, args}`
  - 响应 `{type:'wb:invoke:response', requestId, result|error}`
  - 握手 `{type:'wb:handshake:request', requestId, protocolVersion:'1.0'}`
  - 事件 `{type:'wb:event', event, payload}`
- 但 `wbipc` 命名管道自己是另一套 broker 协议：HMAC-SHA256 挑战应答（用 `ticket`）、
  `encodeTranscript(server|client, protocol, endpoint, clientNonce, serverNonce)`、帧编解码、
  `broker/GetPipe`、`broker/ListPipes`、`$/cancel`、密钥协商后的 channel 路由。
  外部直连要重写一整套握手，**收益只有「省掉 ~110 ms 本地计算」，不划算**。
- `wb.js` 全文没有 `auth` / `turing` 字样 → 公开的 `window.wb` API 面**不映射**这个通道；
  插件想走 IPC 得拿到底层 MessagePort（或 renderer/preload 里的 `ipcRenderer`），取决于插件运行在哪个上下文。

### 平台约束（复用时的硬条件）

1. **必须绝对路径 require** 安装目录下的 `index.cjs`（`resources/app.asar.unpacked/native/turing-sdk/`），
   `.node` 与 `TuringShieldSDK.dll` 在同一 `build/Release` 目录，靠 Windows 的
   `LOAD_WITH_ALTERED_SEARCH_PATH` 自动找到，不需要改 cwd / PATH / 复制 DLL。
2. **`channelId=109144` 只对 domestic 版成立**；换版本/换区服要重读 product-config 缓存，别硬编码。
3. **`configure` 进程内一次性**：`channelId` 定死后不可改，配错只能新进程重来。建议进程内做模块级单例。
4. **win32 上 `keychainStorageEnabled` 无意义**（只有 darwin 传第 4 参）→ 插件不必关心钥匙串。
5. 只要**读**安装目录 + 读 `~/.workbuddy/cache/acc-product-config-v3.json`；不写 App 任何文件、不结束 App 进程、不写注册表。
6. token 属凭据：只允许前缀 + 长度入日志/笔记，**任何情况下不落盘全文**。

### 未验证（明确留白，别当成已证）

- **App 完全退出后是否仍能产出**：本次约束禁止结束 App 进程，未测。SDK 是自包含原生库、
  调用不带 App 参与（我们的 Node 进程与 App 无 IPC），倾向可用，但**未证**。
- **token 是否被上游接受**：按分工属 lead，本轮不联网、不打 `/v2/chat/completions`。
- **SDK 内部是否有网络上报**：未抓包；仅观察到 115 ms 本地产出、无磁盘写。
- 官方本体是否还有别的 device token 形态（如 `v3:AAAAA…` 更长变体）随版本变化，未跨版本比对。

## 替代方案

- **从 `install-manifest.json` / `cli/product.json` 找 `channelId`**：试过，都不含 `turingSdk`；
  真值藏在 userdata 的 product-config 落盘副本里。下次找常量先想「运行期注入的配置缓存」。
- **用 WorkBuddy 自带 Electron（`ELECTRON_RUN_AS_NODE=1`）兜底**：准备了，但系统 Node 24 一次就成功，
  未启用。留着当 Node ABI 出问题时的退路。
- **直连 `wbipc` 命名管道拿 App 已算好的 token**：协议能读通（握手/帧/通道名都在），
  但要从零实现 HMAC 挑战应答 + broker 路由，收益仅是省掉本地 110 ms，**放弃**。
- **写盘找 token（keychain 语义）**：前后快照 + 全盘字面量双重证伪，Windows 分支根本没这个存储面。
- **renderer/preload 注入**：是路径 2 的变体，需要 App 内上下文，且比原生 SDK 多一层协议；作为最后退路，未实施。

## 处置

最小可用调用序列（Node，路径按本机实况；工程化时建议模块级单例）：

```js
const path = require('node:path');
const sdk = require(path.join(
  'E:\\Users\\33385\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\native\\turing-sdk',
  'index.cjs',
));

if (!sdk.isSupported()) throw new Error('turing sdk unavailable: ' + sdk.getLoadError());

// 进程内一次性；109144 = domestic 版，来自 ~/.workbuddy/cache/acc-product-config-v3.json
sdk.configure(109144, 'WorkBuddy', '5.8.3');

const token = await sdk.fetchDeviceToken({
  usingCachedMessage: true,
  includesOutdatedMessage: true,
  includesDeviceInfo: true,
  timeoutMs: 10000,
});

// token 形如 "v3:..."，长度 ~1054–1066，直接作为 X-Device-Token 头
// 纪律：日志只允许 token.slice(0,6) + token.length
```

工程化注意：

- 调用结果用 `Promise`（N-API async），别当同步返回值用；超时自己兜一层。
- token 每次调用都变，但**不建议每个请求都现算**：App 本体是「5 分钟刷新一次 + 失败 30 s 重试」的缓存模型，
  插件照抄这个节奏即可（这也是它的设计意图）。
- 先探测 `isSupported()`/`getLoadError()`，把失败面摊到启动期，别等到发请求才炸。

## 影响

- 插件侧不再需要「让用户跑官方客户端」或「抓 App 流量」；`X-Device-Token` 变成一条本机可自产的输入，
  上游 11128 这个卡点的前置条件解除。
- 只剩两条待闭环：lead 侧验证该 token 是否真被 `/v2/chat/completions` 接受；以及 App 未运行时可用性的补测
  （需要允许结束一次 App 的窗口）。
- 本轮临时脚本全部在 `%TEMP%` 下、跑完删除；除本文件外未写入任何位置，token 全文未落盘、未打印。
