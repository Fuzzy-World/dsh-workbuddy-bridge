# gateway-parity — 渠道身份对齐检查

## 为什么有

上游 `POST /v2/chat/completions` 会用 `400 {"code":11128,"msg":"Illegal API invocation from an
unapproved channel"}` 拒绝"未授权渠道"的调用：官方桌面客户端能过闸，插件过不去。补头不能靠记忆，
所以 `scripts/gateway-parity.mjs` 把插件**实际发出的 chat 请求**与一份官方客户端抓包参考逐头对比，
让"缺哪些头、多哪些头、哪些头值形态不对"变成一条可复跑的差分，改完代码立刻能自检。

## 怎么跑

```powershell
cd D:\33385\Desktop\PWN\workbuddy-bridge
pnpm build                                # 脚本读 lib/index.js 构建产物；改过 src/ 必须重建
node scripts/gateway-parity.mjs           # 人读
node scripts/gateway-parity.mjs --json    # stdout 只有一个 JSON 对象：{plugin,official,diff,summary}
```

- 默认用内置**伪凭据** + stub `fetch`，**不联网、不读本机登录态**，没登录的机器也能跑。
- `--real-credential`（或 `GATEWAY_PARITY_REAL_CREDENTIAL=1`）才尝试 `store.current()`，
  拿不到或抛错仍回退伪凭据；`Authorization` / `X-Device-Token` 始终脱敏，不落原文。
- 退出码：`0` 全 ok；`1` 存在 missing / extra / mismatch；`2` 构建产物或运行环境问题。
- lead 补头之前跑出来是一批 missing/extra，这是**预期基线**，不是脚本坏了。

## 四类差异

| 结论 | 含义 | 处置 |
|---|---|---|
| `missing` | 官方有、插件没发 | 补头（常量头进 `chatHeaders()`；请求级 id/trace 头在 `chatStream()` 里生成） |
| `extra` | 插件发了、官方没发 | 删头（官方明确不发 `Origin` / `Referer` / `X-No-Enterprise-Id`） |
| `value-mismatch` | 两边都有，但常量或形态不符 | 改值/改来源，逐条看 reason |
| `ok` | 头名（大小写不敏感）与形态都对齐 | 无需动作 |

id / trace / UA 按**形态**判（uuid、`<32hex>`、`<16hex>`、`v3:` 设备令牌、`WorkBuddy/<v> …`），
不按字面：每次请求的 id 都不同，字面比较只会制造假红。id 判定刻意宽松，合法 uuid 不会被误判。

## 怎么用它改 `src/protocol/client.ts`

1. 按 `missing` 分两类落地：常量头（`X-Agent-Intent`、`X-Agent-Purpose`、`X-Ide-*`、`X-Stainless-*`、
   `X-Codebuddy-Request`、`X-Private-Data`、`X-Agent-Type`）加进 `chatHeaders()`；每请求生成的
   id/trace 头（`X-Request-Id`、`X-Conversation-*`、`Acp-Connection-Id`、`traceparent`、`b3` 族）
   必须在 `chatStream()` 内按请求生成，不要塞进无状态头常量。`Content-Encoding: gzip` 还要求 body
   真正 gzip 压缩，是 body 层改动，不是加一个头。
2. 按 `extra` 收窄 chat 路径：`Origin` / `Referer` 从 `commonHeaders()` 派生且被 refresh/catalog/billing
   共用，改之前先确认那几条路径是否也需要删——别把 `commonHeaders` 一刀切。
3. 按 `value-mismatch` 改常量或改来源：`Accept` 官方只发 `application/json`；`Host` 来自 URL，
   它报 `copilot.tencent.com ≠ www.workbuddy.cn` 说明**基础域名**可能才是闸门，属于单独决策，
   加头解决不了；`X-User-Id` 在伪凭据下是 `uid-1`，属预期噪声（真实凭据为 uuid）。
4. 每次改完 `pnpm build` 再跑，直到 `parity: N ok / 0 missing / 0 extra / 0 mismatch`。

## 边界：全绿不等于放行

**`parity` 全绿只证明"插件发出的头集合与形态"和这一份抓包参考一致，不证明服务端闸门的判定逻辑。**
服务端还可能看 body 字段、URL host、账号/设备绑定、token 渠道、时序，或抓包里没体现的 HTTP/2 层字段
（如 `:authority`、伪头顺序、TLS 指纹）。它只能把"头不对齐"这个变量排除掉；若仍 `11128`，
下一个差分面是 URL host、`X-Device-Token` 的来源与 body，而不是继续堆头。
