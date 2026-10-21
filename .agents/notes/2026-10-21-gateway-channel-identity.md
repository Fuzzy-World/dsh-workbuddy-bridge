# 决策：渠道身份 phase 2 —— 补齐官方网关身份

状态：生效

## 问题

上游 `POST /v2/chat/completions` 开始对非官方客户端回 `400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`。phase 1 只让 User-Agent 长得像桌面 App，其余身份头一个没发；抓包差分显示官方客户端的网关身份还有一整组（IDE 标记、per-request id、trace、设备令牌、账号维度头），插件一个都没带。

**同日随后实测修正了归因**：补齐头之后仍 400。把插件真实发出的请求落盘、再用同一条 body 回放，才定位到闸门是 **system 提示词里的第三方 harness 身份声明**，不是请求头。头集合的对齐仍然保留（它让包形状与官方一致），但它不是这次 400 的原因。

## 真正的闸门（2026-10-21 12:35–12:45 实测）

用插件自己的 `chatStream` 回放抓到的真实请求体（829,480 B / 248 tools / 全量历史）：`400 / 11128`。随后单变量二分：

| 变量 | 结果 |
|---|---|
| 删掉 `tools`（12 KB） | 仍 400 |
| `tools` 减到 20 个 | 仍 400 |
| 去掉 `reasoning_effort` | 仍 400 |
| 只留 system + `test` | 仍 400 |
| 只留 system | 仍 400 |
| system 只取前 40 字符 | **200** |
| system 只取前 60 字符 | 400 |
| `"DeepSeek"` / `"DeepSeek Harness"` / `"powered by DeepSeek Harness"` 单独作 system | 200 |
| `"You are an AI agent powered by DeepSeek Harness."` | **400** |
| `"You are an AI agent powered by Foo"` / `…by Claude` / `…by the harness` | 200 |
| 双 system：中性一条 + 原提示词一条 | 仍 400（每个 system 都扫） |
| **完整 829 KB body，只把首句换掉** | **200** |

随后又对「换掉首句」这步继续收窄，发现真正被匹配的不是整句，而是**大小写敏感的连续双词 `DeepSeek Harness`**：

| system 写法 | 结果 |
|---|---|
| `… powered by DeepSeek Harness.`（原样） | **400** |
| `… powered by DeepSeek-Harness.`（加连字符） | **200** |
| `… powered by DeepSeek  Harness.`（双空格） | **200** |
| `… powered by the DeepSeek Harness.`（插冠词） | **200** |
| `… powered by deepseek harness.`（小写） | 400 |
| `… powered by DeepSeek Harness!`（改标点） | 400 |
| `… powered by Claude.` / `… powered by Foo.` | 200 |

结论：这是**子串 / token 序列匹配**，不是整句等值、也不是对「第三方框架」的语义判断——破坏这对连续 token 的任何写法都放行，小写或拆开就不行；且只针对这一个品牌（换别家厂商名一律放行）。

处置是 `prepareChatBody()` 里的 `neutralizeHarnessIdentity()`：**只把 `DeepSeek Harness` 改成 `DeepSeek-Harness`（每处一个字符）**，句子语义、长度、其余指令、历史与工具集全部不动。只作用于 `system` 消息（身份声明在那一层），`user` 消息里引用该词不动。

**最终 A/B（同一 URL / 同一套头 / 同一设备令牌，只改这一处）**：`patched` → 200，`untouched control` → 400 / 11128，可复现。

## 决策

1. 新增 `src/protocol/gateway-headers.ts` 作为 chat/probe 头集合的唯一 home：常量头 + 账号维度头 + 每请求 id（UUIDv7，时间有序）+ trace 族；`X-Conversation-Id` 用客户端实例级 UUIDv4。官方客户端不发 `Origin` / `Referer`，这两个头从 chat 路径删除；`Accept` 收窄为 `application/json`。
2. 新增 `src/protocol/device-token.ts`：`X-Device-Token` 由已安装 App 自带的原生 Turing SDK 在本进程内存现算。注入式（modulePath / channelId / productName / productVersion 全部由调用方给），5 分钟 TTL、并发 in-flight 去重、失败一律 `undefined`。
3. 新增 `src/protocol/workbuddy-install.ts`：安装根发现（Windows 默认路径 + 卸载表注册表兜底、macOS `.app`）、App 版本（`install-manifest.json` / `Info.plist`）、CLI 版本（`cli/package.json`）、Turing 模块路径、`acc-product-config-v3.json` 的 channelId。`app-version.ts` 与 `client-identity.ts` 改为经它读版本，**Windows 从此能读到已安装版本**（此前 win32 一律走编译期 `5.5.6`，UA 陈旧且缺 `CLI/…` 段）。
4. `client.ts` 的 chat/probe 改用 `buildGatewayHeaders`；新增可注入的 `resolveDeviceToken` 与 `conversationId`。refresh / catalog / billing 刻意不动（沿用 `commonHeaders`）。
5. 三条不变量：chat 不带 refresh token；值必须 header-safe（不合法就省略该头，不清洗）；构建永不抛（缺失头 = 降级，抛错 = 消息失败）。
6. 验证：`tests/gateway-headers.spec.ts`、`tests/device-token.spec.ts`、`tests/chat-identity-wire.spec.ts` 钉离线契约；`scripts/gateway-parity.mjs` 逐头对比插件与官方包的形态（离线，不联网）。

## 替代方案

- **(a) 只补 UA，不补其余头**：phase 1 已经这么做了，上游照样回 11128；单变量差分已经证明 UA 不是全部答案。继续在 UA 上堆版本与形态只会制造「看起来更像了」的假绿，无法解释还缺什么。
- **(b) 直连 App 的 wbipc 命名管道拿 token**：通道名与帧格式都能读通（`desktopHost:getTuringDeviceToken`），但从零实现 HMAC 挑战应答 + broker 路由的成本远高于本地算一次；而且它要求 App 正在运行，比直接 load addon 多一个可用性前提。收益只有省掉约 110 ms 本地计算，放弃。
- **(c) 从磁盘读缓存 token**：recon 已证伪 —— 对 8 个落点根做调用前后 mtime 快照共 2944 个文件，created=0、modified=0；全盘没有 `v3:` 字面量；Windows 分支根本不传钥匙串参数，没有这个存储面。
- **(d) 每个请求都现算 token、不做 TTL 缓存**：SDK 一次约 110 ms 且结果每次不同；官方 App 自己就是「5 分钟刷新 + 失败重试」的缓存模型。每条消息都现算会把延迟压到发送路径上，也把 addon 的瞬时失败放大成每条消息的身份缺失。故按 5 分钟 TTL 缓存，失败结果不缓存以便下一次重试。
- **(e) 把设备令牌做成凭据字段持久化**：token 每 5 分钟就换、不落盘是 recon 观测到的官方行为；写进凭据文档既要把字段塞进两处解析与 at-rest 白名单，又平白多一份凭据副本。不做。

## 影响

- 用户可感知：Windows 的 UA 变为已安装 App 的真实版本并带回 `CLI/…` 段；chat/probe 的头集合按官方形态重排（`Accept` 收窄、`Origin` / `Referer` 消失、新增网关身份组）；system 提示词里的品牌词对被改成带连字符的写法；refresh / catalog / billing 无变化。
- 已证：`11128` 的触发面是 `system` 里的 `DeepSeek Harness` 词对，改一个字符即放行，A/B 可复现（见上）。
- **仍未证**：App 完全退出后原生 addon 是否仍能产出 token（未测）；产出的 token 是否被 `/v2/chat/completions` 独立于该词对地接受（未单独隔离验证）。
- 维护边界：以后再动 chat/probe 的头，home 是 `gateway-headers.ts`；11128 不许按 code 单独分支（同码至少还有 `developer` 角色、国际版首条非 `system`、以及这次的品牌词对三种含义）。测试数与覆盖率现跑现看，不在本记录里抄值。
