# 议题：11128「unapproved channel」的改动落点与验证路线图

状态：生效（工作测绘，不是决策记录；改动落地后应另写一条决策记录，本文件届时标归档或转写）
日期：2026-10-21
范围：只读测绘 `src/`、`docs/`、`tests/`、`scripts/`（未编辑任何源码/测试/文档），跑过本机 build / test / typecheck（会写 `lib/`，`lib/` 被 `.gitignore:8` 忽略）。
执行约束：未联网打上游、未读取或打印任何真实凭据；所有"上游行为"结论只引用仓库内既有证据，未在本轮复测。

---

## 0. 一句话结论

11128 已经被 `src/protocol/errors.ts` 映射成 `client`（即普通 400），**现状没有专门的诊断面**；chat/probe 的头全部由 `src/protocol/client.ts` 的私有函数拼装，仓库里**没有任何** `X-Device-Token` / `x-codebuddy-request` / `X-IDE-*` / `X-Private-Data` / `X-Conversation-*` / `Acp-Connection-Id` / trace 头的先例，`WorkBuddyCredential` 也**没有设备票据字段**——所以本改动的真正未知不在"往对象里加几个键"，而在"这些头的值从哪来、哪些是必需"。仓库里也**没有任何测试对整份 outbound 头做全等断言**：单纯追加头不会自动翻红；会红的是被逐字钉住的那几个值（UA / Authorization / `X-Refresh-Token` 缺失）以及（若给 `WorkBuddyCredential` 加必填字段）typecheck。

---

## 1. 构建与测试基线（本机实跑，2026-10-21 11:20 +08:00）

环境：Windows；`node v24.15.0`；`pnpm 11.21.0`；`dsh 0.2.1-rc.2`（与 `package.json` devDeps 的 `0.2.1-rc.2` 同源，**本轮没有** AGENTS「宿主版本与 devDeps 错位」问题）。

| 步骤 | 命令 | 结果 | 耗时 | 备注 |
|---|---|---|---|---|
| 构建 | `pnpm build` | **exit 0** | 墙钟 10.4s | 首次运行被 `verify-deps-before-run` 触发了依赖校验/安装（5.1s，输出 `Done in 5.1s using pnpm v11.21.0`），随后 tsdown 两段 `Build complete in 4034ms` / `4109ms` |
| 测试 | `pnpm test` | **exit 0** | 墙钟 8.3s；vitest 自报 `Duration 6.91s (transform 6.04s, import 23.18s, tests 9.13s)` | `Test Files 38 passed (38)`；`Tests 571 passed \| 11 skipped (582)` |
| 类型 | `pnpm typecheck`（补跑） | **exit 0** | 6.34s | 两个 tsconfig 都过 |

跳过分布（11 条，均为平台专属断言，不是缺陷）：`electron-discovery.spec.ts` 5、`auth.spec.ts` 3、`model-visibility.spec.ts` 1、`host-heartbeat.spec.ts` 1、`desktop-doctor.spec.ts` 1。

已知 flaky：`tests/catalog-lifecycle.spec.ts` 本轮 **11/11 通过（3709ms）**，没有撞 AGENTS 记录的 Windows `.workbuddy-host-heartbeat.json` EPERM 清理失败；重跑全量时仍应先看这条。

产物（build 后现查）：`lib/index.js` 103.33 kB、`lib/bin.js` 10.32 kB、`lib/heartbeat-DR6QsZ9h.js` 147.88 kB、`lib/index.d.ts` 89.00 kB、`lib/client.js` 123.93 kB。`git status --short` 为空，工作树没有源码改动。

覆盖率门槛（CI 的 Test 步带 `--coverage`，本轮未跑）：`lines/statements 70、functions/branches 60`，`include: src/**/*.{ts,tsx}`（`vitest.config.ts:56-64`）——新增头模块必须自带用例，否则会被门槛而不是被断言发现。

---

## 2. 头构造现状（谁在哪发什么）

### 2.1 入口与头构造函数对照

| 上游请求 | 入口（行） | 实际头从哪来 | `User-Agent` 来源 |
|---|---|---|---|
| `POST /v2/chat/completions`（chat） | `chatStream` `src/protocol/client.ts:587-626`；fetch 在 606-614 | `chatHeaders()` 345-361，外层再补 `Authorization`（610） | `chatUserAgent(await resolveChatIdentity(region))` 596-601；resolver 抛错时 `fallbackChatIdentity`（600） |
| `POST /v2/chat/completions`（probe） | `probeEffort` 994-1051；fetch 在 1029-1037 | 同一个 `chatHeaders()`（1032）+ `Authorization`（1033） | 同 chat，1004-1015 |
| `POST /v2/plugin/auth/token/refresh` | `refreshToken` 629-634 | `refreshHeaders()` 364-374（含 `X-Refresh-Token`、`X-Auth-Refresh-Source`） | 常量 `CLIENT_UA`（185） |
| `GET /v3/config`（目录） | `fetchModels` 683-705；fetch 692-705 | 内联头 692-700 | CN：`CLIENT_UA`；国际：`appUserAgent(appVersion.version)`（699） |
| `GET /console/enterprises/personal/models`（促销标签） | `private fetchPromoBadges` 747-764 | 内联头 752-759 | `CLIENT_UA` |
| `POST /v2/billing/meter/get-user-resource`（个人账单） | `fetchCredits` 805-838 | `billingHeaders()` 377-390 | **不发 UA** |
| `POST /v2/billing/meter/get-enterprise-user-usage`（企业账单） | `private fetchEnterpriseCredits` 897-903 | `billingHeaders()` | **不发 UA** |

调用点（上游请求只有一个出口，改 chat 头不会漏路径）：`src/llm/shim.ts:312`（chat）、`src/probe/service.ts:156`（probe）、`src/index.ts:494` 与 `src/cli/bin.ts:65`（refresh）、`src/index.ts:1067`（目录）、`src/web/status.ts:218` 与 `src/cli/bin.ts:206`（账单）。

### 2.2 当前 chat / probe 实际发出的头（逐项）

`commonHeaders()`（328-336）：`Accept: application/json, text/plain, */*`、`X-Requested-With: XMLHttpRequest`、`Origin`/`Referer` = 区域站点（`originReferer()` 323-325：CN `https://www.codebuddy.cn`，国际 `https://www.workbuddy.ai`）、`User-Agent: CLI/2.63.2 CodeBuddy/2.63.2`。

`chatHeaders()`（345-361）在 common 之上覆盖/追加：`User-Agent`（桌面身份，可缺省回落到 CLI UA）、`Content-Type: application/json`、`X-User-Id` 或 `X-No-User-Id: 1`、`X-Enterprise-Id` 或 `X-No-Enterprise-Id: 1`、`X-Domain` 或 `X-No-Department-Info: 1`、`X-Product: SaaS`；`Authorization: Bearer <accessToken>` 由调用点补（610 / 1033）。**chat 绝不带 refresh token**（350 注释 + `tests/chat-identity-wire.spec.ts:73` 钉住 `X-Refresh-Token` 为 `undefined`）。

### 2.3 UA 的三条来源链

1. `CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'`（`client.ts:184-185`）：refresh、CN 目录、促销标签。
2. `chatUserAgent()`（`src/protocol/client-identity.ts:126-141`）：`WorkBuddy/<v> <WorkBuddy|WorkBuddy AI>/<v> [CLI/<v>]`，版本来自"已安装 App → 分区缓存 → 编译期常量"（`resolveChatIdentity` 181-207，fallback 217-219；缓存文件名 `CN_APP_VERSION_FILENAME` 53、`FALLBACK_CN_APP_VERSION` 43）。只用于 chat + probe（模块头 15-17 明确写了 scope）。
3. `appUserAgent()`（`src/protocol/app-version.ts:170-174`）：国际目录的 `WorkBuddyAI/<v>`（无空格形态，见 1-9 行注释），版本链在 `resolveAppVersion()` 131-161。

### 2.4 全仓证据：新头「零先例」

- `grep -E 'X-Device|Device-Token|codebuddy-request|X-IDE|Private-Data|Conversation-Id|Acp-Connection|traceparent|X-Client'` → **0 命中**（全仓，含 docs/tests/scripts）。
- `grep -E 'device|clientId|machineId|installId'` → 仅 `assets/AGENTS.md:60` 的 `devicePixelRatio`，与本改动无关。
- `WorkBuddyCredential` 只有 8 个字段：`accessToken / refreshToken / expiresAtMs / refreshExpiresAtMs? / domain / uid / enterpriseId? / nickname? / source`（`src/credential/store.ts:37-49`）。**没有设备票据/设备 id/客户端 id 字段。**
- 桌面凭据解析只取其中 6 个：`parseWorkBuddyAuth()`（`store.ts:273-313`）只读 `accessToken/refreshToken/expiresAt/refreshExpiresAt/domain/uid/enterpriseId/nickname`，其余字段**静默丢弃**；插件自留副本 `parseOwnDocument()`（321-357）是逐字段重建，同样只认这些。at-rest 加密层也只处理两个字段：`AUTH_FIELDS = ['accessToken','refreshToken']`（`src/credential/at-rest.ts:187`，类型 96-99）。
- 推论（本轮无法证伪）：若 `X-Device-Token` 必须来自桌面 App 的凭据/本地存储，**当前代码里根本没有它的来源**，这就不是"client.ts 加头"能闭环的；必须新增数据源（读桌面文档的更多字段 / App 本地存储 / 生成并持久化）。这是本改动的**第一未知**。

---

## 3. 11128 的现有认知

### 3.1 分类层怎么处理它

`src/protocol/errors.ts` 三张表都收 11128：

- `UPSTREAM_CODE_KINDS`（40-47）：`'11128': 'client'`（注释：非法渠道调用，例如 developer 角色）。
- `ENVELOPE_CODE_KINDS`（50-54）：`11128: 'client'`。
- `TEXT_MARKERS`（60-80）：`['11128','client']`，仅当既无机器码也无业务码时兜底。

判定顺序（120-141）：`extError.code`（结构化机器码）→ 信封 `code`（非 0）→ 文案兜底 → HTTP 状态兜底 `kindOfStatus()`（148-155，400 → `client`）。**本次上游返回 `{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`**：没有 `extError`，走第二张表 → `kind='client'`、`fromTextFallback:false`（126-130）——所以它已经"被正确分类"了，只是分类结果和普通坏请求一样。

下游表象：`shim` 把 `client` 映射成 **HTTP 400**（`src/llm/shim.ts:143-151` 的 `KIND_STATUS`，写出在 314-321），错误文案带 `kind` + 上游 http 状态。也就是说，加头失败/未加头时，用户看到的是"workbuddy upstream client (http 400)"，与 developer 角色、参数错误无法区分。

### 3.2 同一个码在仓库里有 4 种含义（都只写在注释里）

| 含义 | 位置 | 观测 |
|---|---|---|
| `developer` 角色被拒 | `client.ts:399-403`（`prepareChatBody` 文档）、`client.ts:428-437`（`normalizeDeveloperRole`） | CN；改写为 `system` 是既有修复 |
| 国际版首条消息不是 `system` | `client.ts:982-985`（`probeEffort` 文档）、`client.ts:1310-1317`（`prepareInternationalChatBody`） | 国际；两版同码不同义，注释 1316-1317 明说"不得按 code 单独分支" |
| 参数越界是 11133，不是 11128 | `errors.ts:45` | 对照，避免混淆 |
| **未批准渠道（本轮问题）** | 仓库内**没有**记录；只在 `errors.ts:43` 的"非法渠道调用"注释语义上相邻 | 与 developer 角色同码同文案不同因 |

`prepareChatBody()`（412-426）已经在共享层重写 `developer`→`system`，两 region 都过（且 `diff` 里 `chatStream` 602-603 国际版再过一层）。**因此本轮 11128 不是 developer 角色问题**，而是渠道/客户端身份问题——但代码注释（399-403）把"11128 = developer 角色"写成了唯一因果，属于**已过时的因果断言**，改动时应顺手订正（只改注释，不改行为）。

### 3.3 文档与测试面

- `docs/` 全文 **0 处** 11128 / unapproved；`docs/ARCHITECTURE.md` **没有"客户端身份"章节**。唯一的结构性提及是模块清单一行 `protocol/ 上游协议：chat / 目录 / 账单 / 错误分类 / 身份`（`ARCHITECTURE.md:15`）；兼容性契约一节（196-206）只讲 `off`/`thinkingLevelMap`/指纹键序，**不含请求头**。
- 阶段划分的唯一权威表述在 `src/protocol/client-identity.ts:1-20`：这是"upstream identity alignment 的 **phase 1**"，**只覆盖 chat 与 probe**，refresh/catalog/billing 保持旧头（15-17 行），目的是"把爆炸半径收在一个变量上，让 live 验证矩阵保持可读"。**留了什么：所有非 UA 的身份/渠道头**——也就是本轮要补的那一堆。
- live 验证面：`scripts/client-identity-live-matrix.mjs`（case 表 14-17；UA 69-76；旧头 baseline 214-253；SKIP 语义 255-271、346-355），`docs/PUBLISHING.md:14-30` 把它列为发版前真机必跑，并明确"SKIP 不是通过、别把 CN 五个 case 说成身份矩阵全过"。
- 离线测试对 11128 **零覆盖**：`grep 11128 tests/` 无命中；`tests/prepare.spec.ts:118-143` 的分类用例只覆盖 402/文案/401/429/404/5xx/400，没有一条钉 11128（机器码、信封码、文案三条路径都没测）。

---

## 4. 测试断言地图（改头会不会翻红）

### 4.1 逐字钉住 outbound 头的只有这几处

| 文件:行 | 钉住什么 | 新增头的风险 |
|---|---|---|
| `tests/chat-identity-wire.spec.ts:65` | CN chat UA `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` | 改 UA 形状/版本就红 |
| 同 67-72 | chat 的 `X-Requested-With`/`Origin`/`Referer`/`X-User-Id`/`X-Product`/`Authorization` 值 | 只追加头不红；改这些值会红 |
| 同 73 | chat **不得带** `X-Refresh-Token` | 若把 refresh 头合并进 chat 就红（这是安全红线） |
| 同 94/107/123/145-147/152-154 | chat/probe/fallback 的另外 5 个 UA 形态 | 改 UA 来源或 fallback 会红 |
| 同 165-168 | refresh 的 UA=`CLI/2.63.2 CodeBuddy/2.63.2`、`X-Auth-Refresh-Source`、`X-Refresh-Token`、`Origin` | 若给 refresh 也加新头**不会**红（没有全等断言），但违背 phase-1 的"不变路径"意图 |
| 同 185-187 / 208 / 222 | CN 目录 UA / 国际目录 UA / 账单无 UA | 改 UA 或给账单加 UA 会红 |
| `tests/upstream.spec.ts:487-488` | 企业账单 `X-Enterprise-Id` / `X-Tenant-Id` | 只追加头不红 |
| `tests/variants.spec.ts:479` | 国际目录 UA `WorkBuddyAI/5.5.2` | 改目录 UA 会红 |
| `tests/catalog-lifecycle.spec.ts:367 / 639 / 731` | 只从 fetch 的 `headers['Authorization']` 取 token 区分账号 | 新增头不影响 |
| `tests/credit-route / dual-routes / web-status / shim / probe-route` | 全部是**入站**本地路由的 Host/Origin/Authorization 断言 | 与 outbound 头无关（shim 不转发入站头，`shim.ts:294-322` 自己重建） |

**关键判断：全仓没有任何测试对 outbound 头对象做 `toEqual` / `Object.keys` 全等断言**（已 grep `Object.keys(.*headers`、`headers).toEqual`、`toMatchObject({ headers` 均无命中）。所以"新增头"本身不会把现有运行时用例打红；真正会红的是被钉死的**值**。

### 4.2 会翻红的具体清单（按触发条件）

1. **改 UA 形状/来源** → `tests/chat-identity-wire.spec.ts` 6 处 UA 断言（65/94/107/123/145-147/152-154）+ refresh/目录/账单 UA 断言（165/185-187/208/222）；`tests/variants.spec.ts:479`。
2. **chat 开始带 refresh 头** → `tests/chat-identity-wire.spec.ts:73`。
3. **Authorization 形态变化**（例如改 bearer 前缀/改 token 来源）→ `chat-identity-wire:72`、`catalog-lifecycle:367/639/731` 的账号区分逻辑可能跟着错。
4. **给 `WorkBuddyCredential` 加必填字段** → **typecheck 红**：仓库里带类型标注的凭据字面量只有 3 处（`tests/chat-identity-wire.spec.ts:14`、`tests/upstream.spec.ts:17`、`tests/variants.spec.ts:469`），另有大量 `accessToken:` 对象字面量作为函数实参（`auth.spec.ts`、`desktop-*`、`shim.spec.ts:66`、`reasoning-merge.spec.ts:41`、`variants.spec.ts:185/197/216/228`）会被 excess-property/缺字段检查扫到；JSON 字符串夹具（`credentialDocument()` 等）不受影响。
   - **重要细节**：`pnpm test` 走 vitest（vite transform），**不做类型检查**；`pnpm check`/CI 的 typecheck 才会红。所以"测试绿但 typecheck 红"是这次很容易踩的假绿。
   - 加**可选**字段（`deviceToken?: string`）则以上全部不红；但见 §6.3 的"自留副本会丢字段"陷阱。
5. **把 header 构建改成可能抛错/异步阻塞** → `chatStream` 的 UA 解析在 fetch 的 try 外（596-601），若新逻辑也这样抛，会把"发消息"变成硬失败；`chatStream`/`probeEffort` 的 fetch 在 try 内（605-614 / 1027-1037），抛错会被吃成 `transport error`（`kind:'server'`，status 0），用户看到 502——不是测试红，是行为回归。建议新构建器**永不抛**、失败降级为省略该头。
6. **覆盖率**：CI `--coverage` 门槛 70/70/60/60；新增 `src/protocol/gateway-headers.ts` 若只有间接覆盖，functions/branches 可能被拉低——新模块必须带直接单测。

---

## 5. 仓库纪律清单（只抄与本次改动有关的）

1. **顺序固定**：`tsc --noEmit` → tsdown（重建 `lib/`）→ `vitest run`；先测后建会因 `tests/version.spec.ts` 断言产物版本而红（根 `AGENTS.md:37-40`）。
2. **`pnpm` 脚本不可达时**用直接路径：`node node_modules/tsdown/dist/run.mjs`、`node node_modules/vitest/vitest.mjs run`（`AGENTS.md:40`）。
3. **`off` 的 strip 挂在两版共用的 `prepareChatBody()`，不要挪回 region 分支**（`AGENTS.md:79-87`，`ARCHITECTURE.md:205`）。这次要在 `chatStream` 里加头，**最容易顺手改到 body 归一化**——保持 `prepareChatBody` 在两 region 都过的结构不动。
4. **浏览器产物里不能出现 `process` 字面量，注释也不行**（`AGENTS.md:100-103`，红线执行体 `tests/redlines.spec.ts:251-287`）。新头模块必须**只被宿主半边引用**；`src/client/**` 目前只 import `src/shared/paths.ts`（已核），不要把 `protocol/*` 拉进浏览器图。
5. **测试断言里不许出现 locale 相关字面量**（`AGENTS.md:136-139`，2026-09-25 CI 实踩）。新头的断言一律用 ASCII/正则/固定常量，不要断言 `Intl` 产物。
6. **已知 flaky**：`tests/catalog-lifecycle.spec.ts` 的 Windows EPERM（`AGENTS.md:74-77`）——全量重跑时先排除它，别把自己的改动当成回归。
7. **宿主版本先对一下**：改代码前 `dsh --version` vs `package.json` devDeps（`AGENTS.md:88-99`）；本轮二者都是 `0.2.1-rc.2`，同源。
8. **`lib/` 不跟踪但 link 装法直接读它**：改源码后必须 `pnpm build` 再跑真机脚本（`AGENTS.md:16-19`、`PUBLISHING.md:107-110`）。
9. **文档同步**：一条事实一个 home（`AGENTS.md:165-172`）；改根 `README.md` 必同改 `README_en.md`（169）；docs 活文档随代码走、同一次改动内同步 `ARCHITECTURE.md` 与 `PUBLISHING.md`（`docs/AGENTS.md`）；决策写 `.agents/notes/`（骨架 `问题/决策/替代方案/影响`，状态行第 3 行、必写替代方案，`.agents/notes/AGENTS.md`），**不建索引**。
10. **记录层不追改**：`docs/archive/` 冻结；结论变了新写 notes，不改 archive（`docs/AGENTS.md`）。
11. **改动外文档要跑链接校验**（根 `AGENTS.md:41`；本仓不自带脚本，需用维护者 skill 目录那份，**本轮无法执行**，见 §8）。
12. **真机脚本纪律**：输出只到控制台、不落盘；不许把凭据写进 `~/.dsh/`；平台跑不了打 `SKIP …` 并 `exit 0`；没跑过不许在 Release notes 里声称验过（`scripts/AGENTS.md`、`PUBLISHING.md:24-30`）。
13. **tsconfig 严格项**（`tsconfig.json`）：`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`noUnusedLocals/Parameters`、`noImplicitReturns`、`noFallthroughCasesInSwitch` 全开——新模块的"可选头"要用条件展开（`...(x === undefined ? {} : { H: x })`，现有代码就是这个写法，如 `client.ts:348/351-357`），不能用 `H: undefined`。

---

## 6. 建议改动面

### 6.1 先补的"数据源研究"（本改动的 blocking unknowns）

| 头 | 仓库现状 | 需要确认 | 若无解的影响 |
|---|---|---|---|
| `X-Device-Token` | 无字段、无解析（`store.ts:38-49/273-313`） | 值来自桌面 auth 文档的哪个键（明文或加密字段）、还是 App 本地存储 | 必须扩 `WorkBuddyCredential` + 两处解析 + at-rest 字段白名单；否则无法发 |
| `x-codebuddy-request` | 零命中 | 是常量标记、JSON、还是每请求签名（内容格式） | 格式错=等于没加 |
| `X-IDE-*` | 零命中 | 具体头名与值（IDE 名/版本？） | 同上是整组头，需逐项确认 |
| `X-Private-Data` | 零命中 | 布尔/枚举/序列化内容 | 猜错可能反而被判非法 |
| `X-Conversation-*` | 零命中 | 会话 id 从哪来（见下） | `chatStream` 只有 `credential/body/signal`（587-591），shim 也只传 `prepared` body（`shim.ts:312`）；DSH 的 sessionId 不在链路上 |
| `Acp-Connection-Id` | 零命中 | 只校验存在/格式，还是要与真实 ACP 连接对应 | 若需真实连接，现有架构无来源 → 需新增 plumbing 或放弃 |
| trace（`traceparent` 等） | 零命中 | 是否必需、是否接受随机 W3C 格式 | 可本地生成，风险最低 |

**建议的确定方式（不在本轮做，因为禁止联网）**：在 `scripts/client-identity-live-matrix.mjs` 的既有 harness 上加"单头差分"case——控制组用旧头集合，实验组每次只加一个头，记 200/400+code；先确定最少必需集，再谈实现。不要一次把整组头盲塞（无法归因，且可能引入新的 11128 文案）。

### 6.2 最小改动文件清单（推荐路线）

| # | 文件 | 改什么 | 依据/风险 |
|---|---|---|---|
| 1 | `src/protocol/gateway-headers.ts`（**新增，推荐**） | 唯一的 chat/probe 头构建器：输入 `credential + ChatIdentity + region + 可注入的 per-request id/clock`，输出 `Record<string,string>`；导出 `validGatewayHeaderValue()`（同 `validAppVersion`/`validCliVersion` 的 CR/LF/空格防线，`app-version.ts:48-57`、`client-identity.ts:63-72`） | 见 §6.3 理由 |
| 2 | `src/protocol/client.ts` | `chatHeaders()` 改为调用 1（或直接删掉、由 1 取代）；`chatStream`/`probeEffort` 传同一组参数；**确保 probe 与 chat 仍共用同一个函数**（现状 345 注释即此约定）；订正 399-403 的 11128 因果注释 | 只动头构造与注释，不动 `prepareChatBody`/`prepareInternationalChatBody`（AGENTS 活跃坑） |
| 3 | `src/protocol/client.ts` 的 `WorkBuddyUpstreamClientOptions`（536-545） | 加一个可注入的 header/identity 解析 seam（测试用），默认走真实实现 | 现有测试全部靠 `resolveChatIdentity` 注入；新 seam 沿用同一模式，避免测试读真盘 |
| 4 | `src/credential/store.ts` | **仅当** device token 来自桌面 auth 文档：`WorkBuddyCredential` 加**可选**字段；`parseWorkBuddyAuth()`（273-313）与 `parseOwnDocument()`（321-357）**两处都要加**，`refreshNow()` 的 spread（591-603）才会保住它 | `parseOwnDocument` 是逐字段重建；只改第一处 = 刷新一次后字段丢失（store.ts:333-338 的注释记录的就是这个历史坑） |
| 5 | `src/credential/at-rest.ts` | **仅当**设备票据也是加密字段：`AUTH_FIELDS`（187）与 `WrappedAuthField['field']`（96-99）扩字段 | 不扩则该字段在加密文档里读不出 |
| 6 | `tests/gateway-headers.spec.ts`（**新增**） | 见 §6.4 | 覆盖率与行为都要它 |
| 7 | `tests/chat-identity-wire.spec.ts` | 保持"unchanged paths"回归钉：给 refresh/catalog/billing 增加"新头 `toBeUndefined()`"断言；chat/probe 增加新头存在性断言；顶注释（1-12 行）"byte-for-byte"措辞同步 | 现在这些路径只是"没断言"，不是"钉住" |
| 8 | `tests/prepare.spec.ts` | 在 `describe('classifyUpstreamError')`（118-143）补 11128 三条路径：`extError.code='11128'`、`{"code":11128,...}`、纯文案 `11128`；用 `classifyUpstreamFailure` 断言 `fromTextFallback` | 目前 11128 零测试 |
| 9 | `src/protocol/README.md` | 文件索引加 `gateway-headers.ts` | 子树文档层规则 |
| 10 | `docs/ARCHITECTURE.md` | 新增"客户端身份与渠道头"小节（phase 1 = UA/仅 chat+probe；phase 2 = 渠道头；不变量：refresh/catalog/billing 不漂、chat 不带 refresh token、头值必须 header-safe、构建失败降级） | 目前**没有**这章；phase 表述只在代码注释里 |
| 11 | `docs/PUBLISHING.md` | 若 live matrix 增加 case：更新"发版前确认"第 5 条的 case 口径（14-30） | 与 14-30 的 SKIP/不许夸大规则一致 |
| 12 | `scripts/client-identity-live-matrix.mjs` | 增加单头差分 case 与"本次用了哪套头"的打印（不含 token 值） | 唯一真机验证 harness（`scripts/README.md:25`） |
| 13 | 根 `AGENTS.md` | 活跃坑补一条："11128 至少四种含义，不许按 code 分支；chat 头集合只有一个 home" | 跨模块、致命坑，按作用域分流规则（171） |
| 14 | `.agents/notes/2026-10-21-*.md` | 落地后写决策记录（问题/决策/替代方案/影响） | 记"为什么只加这些头、为什么降级而不抛" |

**不需要动**：`src/llm/shim.ts`（不转发入站头，chat 头全在 client 侧重建）、`src/llm/adapter.ts`（只决定模型/effort 字段）、`src/protocol/errors.ts`（11128 已映射为 `client`，功能上无需改；最多改 43 行注释）、`src/variants.ts`（除非头需要 product 常量而 `regionOf(domain)` 不够——现 client 只拿 credential，不拿 variant；若要用 variant，需要给 `WorkBuddyUpstreamClient` 加构造参数，影响 `index.ts:489`、`cli/bin.ts`、live matrix `:50/:69` 三处）。

### 6.3 为什么建议抽 `src/protocol/gateway-headers.ts`

支持：
- **一处事实源**：现在发 chat 头的只有 `chatHeaders()`，但它已经承载 10 个头 + 区域差异；再加 6-8 个（含生成/校验）会让 `client.ts`（1401 行）继续膨胀，而 `client.ts` 同时管 body 归一化、目录解析、账单解析——职责已经过载。
- **可测性**：新头需要"每请求唯一 id / trace / 时间戳"之类生成器；抽成纯函数 + 注入 seam 后，单测可以断言唯一性、字符集、确定性，而不必每次都 stub `fetch` 再反解 `init.headers`。
- **安全边界集中**：header-safe 校验、`X-Refresh-Token` 永不入 chat、device token 永不进日志/状态文档，这些不变量放在一个模块里用一条注释 + 一组测试守住，比散在 `client.ts` 的展开表达式里可靠。
- **不污染浏览器图**：放在 `src/protocol/` 且只被宿主侧 import，浏览器红线（`redlines.spec.ts:251-287`）不受影响；`src/client/**` 现在只 import `src/shared/paths.ts`。
- **覆盖率**：独立文件可以做到近 100% 行/分支覆盖，抵消新增代码对 70/70/60/60 门槛的压力。

反对/替代：
- 若最终确认"必需头全是常量、无每请求随机、无新数据源"，那么直接改 `chatHeaders()` 更小（改 1 个文件 + 1 个测试文件）。**决策条件**：是否需要 per-request id / 新凭据字段 / 异步来源。三者任一为是 → 抽模块；全否 → 内联。
- 不建议放到 `src/llm/`（那是"接入 DSH"层，头是上游协议事实），也不建议放 `src/shared/`（可能被浏览器半边引用，红线风险）。

影响面：`client.ts` 的 import；`tests/chat-identity-wire.spec.ts` 的注入方式；`src/index.ts` 的公开导出（**建议不导出**，测试直接 import 源文件即可，减少 API 面）；`src/protocol/README.md`；`docs/ARCHITECTURE.md`；覆盖率。

### 6.4 应该新增/改的测试（具体断言）

**新文件 `tests/gateway-headers.spec.ts`**（纯函数级，stub 时间/随机）：
1. CN/global 各一组：既有头（`Accept/X-Requested-With/Origin/Referer/User-Agent/Content-Type/X-User-Id|X-No-User-Id/X-Enterprise-Id|X-No-Enterprise-Id/X-Domain|X-No-Department-Info/X-Product`）逐项等于现状值（把 `chat-identity-wire` 的现状钉搬进来，作为"不许漂"的第一层）。
2. 新头在"数据齐备"时存在且值符合预期；在"数据缺失"时**键不存在**（不是空串、不是 `undefined`）。
3. header-safe：值含 `\r`/`\n`/空格/非 ASCII 控制字符时被拒绝或省略（`expect(() => ...)` 或 `expect(headers['X-...']).toBeUndefined()`），并给一条反向控制（合法值必须通过）。
4. 每请求唯一性：连续两次构建，`traceparent`/请求 id/连接 id 不相同；格式用正则钉（如 `^00-[0-9a-f]{32}-[0-9a-f]{16}-01$`），**不要**断言具体值。
5. 构建器**永不抛**：注入一个会抛的 reader 时返回不含该头的集合（或退化集合），不 reject。
6. 安全：构建结果里不允许出现 `X-Refresh-Token`/`refreshToken` 的值（即使 credential 携带）。

**`tests/chat-identity-wire.spec.ts`**：
7. 保留现有 6 处 UA 钉；
8. chat/probe 各加：新头集合存在性 + `X-Refresh-Token` 仍 `undefined`；
9. "unchanged paths" 三条各加：`expect(headers['X-Device-Token']).toBeUndefined()` 等（把 phase-1 的 scope 从"注释约定"升级为"断言钉住"）；
10. 顶注释（1-12 行）从"byte-for-byte"改为"phase 1 头逐字；phase 2 只扩展 chat/probe"。

**`tests/prepare.spec.ts`**：
11. `classifyUpstreamFailure(400, '{"extError":{"code":"11128","message":"x"}}')` → `{kind:'client', code:'11128', fromTextFallback:false}`；
12. `classifyUpstreamFailure(400, '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}')` → `{kind:'client', envelopeCode:11128, fromTextFallback:false}`；
13. 纯文案 `'11128 Illegal API invocation from an unapproved channel'` → `fromTextFallback:true`（证明兜底路径仍在）。

**可选**：`tests/upstream.spec.ts` 或 `chat-identity-wire` 加一条"probe 与 chat 头集合完全相同"（对同一 credential/trace seed 构建两次，比较除 `Authorization` 外的键集）——防两套头漂移（`client.ts:345-361` 的既定意图）。

### 6.5 文档同步清单（与改动同一次提交）

- `docs/ARCHITECTURE.md`：新小节 + 兼容性契约补两条（"chat 头集合只有一处构建"、"refresh/catalog/billing 不参与"）。
- `docs/PUBLISHING.md`：真机脚本第 5 条 case 口径（若改 matrix）。
- `src/protocol/README.md`、`tests/README.md`（若新增 spec 文件，按 tests/README 的列表风格加一行）。
- 根 `AGENTS.md` 活跃坑一条。
- 决策记录一条（问题/决策/替代方案/影响）；**本文件**在其落地后标 `状态：已归档` 或并入决策记录。
- 根 `README.md`/`README_en.md`：本次是内部协议修复、无新配置项/新入口，**按 `PUBLISHING.md:69-73` 的版本语义不触发门面双改**；Release notes 里写"用户可感知的语义变化"即可。

---

## 7. 验证路线（建议顺序）

**P0 离线（每次改动都跑，顺序固定）**
1. `pnpm typecheck`（两个 tsconfig；本改动最容易在这里红，因为测试不做类型检查）。
2. `pnpm build`（重建 `lib/`；真机脚本读它）。
3. `pnpm test`（全量 38 文件；`catalog-lifecycle` 撞 EPERM 就重跑）。
4. CI 口径补一次 `pnpm exec vitest run --coverage`（70/70/60/60；新模块要带覆盖）。

**P1 真机差分（必须在本机、有登录态；本轮约束下不能做）**
5. `node scripts/client-identity-live-matrix.mjs` 现有 case 先跑一遍，确认控制组（旧头）仍然 PASS（2026-10-03 的记录是 CN 五个 case PASS、intl SKIP，见该脚本头 1-23 与 `docs/PUBLISHING.md:24-30`）。
6. 加"单头差分"case：control = 旧头集合；每个实验组只加一个候选头；判定 = HTTP 200 且首个 SSE 事件可解析（沿用脚本的 strict 判据：answer 要 `finish=stop` 且有内容，tool 要 `finish=tool_calls` 且有调用，`scripts/client-identity-live-matrix.mjs:133-154`）。
7. 找出最少必需集后，整套头再跑一次；仍然 FAIL 时记录原始 `http`/`status`/`finish`，**不要**打印任何 token。
8. 注意脚本会真实消耗积分（`probe`/chat），一次只跑改动相关 case（脚本支持按 case id 过滤，255-271）。

**P2 回归与安全**
9. `scripts/live-e2e.mjs`（适配器→pi-ai→shim→真实上游，`PUBLISHING.md:17`）。
10. 确认 11128 若仍出现，shim 的表现是 400 + `client`（`shim.ts:143-151`），日志里没有 device token；错误 message 只截断上游 body（`client.ts:619`），不会回显我方头。
11. 确认状态文档/浏览器半不得到 device token：`src/web/status.ts` 的输出形状没有透传 credential 全字段（本改动不要往 `WorkBuddyAuthStatus` 加字段）。
12. 再跑一次全量（EPERM 复现概率）；`git status` 只应有预期文件（`lib/` 被忽略）。

**P3 发布**
13. 按 `PUBLISHING.md:5-30` 做发版前确认；Release notes 写清"身份矩阵跑了哪些 case、跳过了什么"，不许把 CN 五 case 说成全矩阵。

---

## 8. 本轮无法完成/未验证的边界

- **未联网打上游**（硬约束）：所以"哪个头必需、`x-codebuddy-request`/`X-Private-Data` 的格式、`Acp-Connection-Id` 是否要与真实连接对应"全部是**未验证的开放问题**，本文件只把它们标成 blocking unknowns，没有给结论。
- **未读取任何真实凭据**：`X-Device-Token` 的真实来源未确认；只从代码结构证明"当前代码没有这个来源"。
- **未改任何源码/测试/文档**（除本文件）：§6 是建议，不是已实施。
- **链接校验未跑**：本仓不自带 `check-markdown-links.py`（根 `AGENTS.md:41`），本轮没有维护者 skill 目录可用；本文件内部链接都用了仓内相对路径，但未做自动校验。
- 本轮未跑 `--coverage`，所以不知道新模块加入后的精确覆盖率缺口，只确认了门槛值。

---

## 9. 出处索引（按主题）

- 头构造：`src/protocol/client.ts:184-185, 328-336, 345-361, 364-374, 377-390, 587-626, 629-634, 683-705, 747-764, 805-838, 897-903, 994-1051`
- 身份/UA：`src/protocol/client-identity.ts:1-20, 43, 53, 55-61, 126-141, 181-207, 217-219`；`src/protocol/app-version.ts:32, 55-57, 131-161, 170-174`
- 11128：`src/protocol/errors.ts:40-47, 50-54, 60-80, 120-141, 148-155`；`src/protocol/client.ts:399-403, 428-437, 982-985, 1310-1317`；`src/llm/shim.ts:143-151, 294-322`
- 凭据形状：`src/credential/store.ts:37-49, 273-313, 321-357, 582-603`；`src/credential/at-rest.ts:96-99, 187`
- 调用点：`src/index.ts:489-495, 1067`；`src/llm/shim.ts:312`；`src/probe/service.ts:153-157`；`src/web/status.ts:218`；`src/cli/bin.ts:65, 206`
- 测试钉：`tests/chat-identity-wire.spec.ts:1-12, 65, 67-73, 94, 107, 123, 145-147, 152-154, 159-168, 185-187, 190-208, 211-222`；`tests/upstream.spec.ts:17, 455, 475-491, 1083`；`tests/variants.spec.ts:455-479`；`tests/catalog-lifecycle.spec.ts:367, 639, 731`；`tests/prepare.spec.ts:118-143`
- 配置/门槛：`vitest.config.ts:56-64`；`tsconfig.json`（strict 各项）；`package.json` scripts
- 文档/规则：`AGENTS.md:16-19, 36-42, 74-77, 79-87, 100-107, 136-139, 163-172`；`docs/AGENTS.md`；`docs/ARCHITECTURE.md:15, 196-206`；`docs/PUBLISHING.md:5-30, 67-73, 107-110`；`.agents/notes/AGENTS.md`；`.agents/notes/README.md`；`scripts/README.md:25`；`scripts/AGENTS.md`
- 真机 harness：`scripts/client-identity-live-matrix.mjs:1-23, 49-76, 133-154, 214-271, 346-355`
