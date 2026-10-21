# scripts/ — 文件索引

职责：见 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

脚本分两类：**离线**的（CI、发布门禁或改头后自检里跑）与**真机 / 一次性**的（托管 runner 上验不了的那一段）。

## 离线

| 脚本 | 做什么 | 何时跑 | 前提 |
|---|---|---|---|
| `check-release.mjs` | 发布态不变量：bundle patch、`files` 覆盖、宿主兼容范围与 peer 下限自洽、locale 键集、`NOTICE` | `pnpm run check:release`；发布流程 publish 前；CI 的 verify 步 | —— |
| `release-guard.mjs` | 判一次推送改没改产物，决定走不走发布 | 发布流程内 | stdin 收路径清单 |
| `check-declaration.mjs` | 只读 `package.json` 的声明区间 + 问 npm：声明的范围还罩不罩得住被跟的那条线 | [compat.yml](../.github/workflows/compat.yml) 的 declaration 作业（每周） | 能访问 registry |
| `compat-swap.mjs` | 把声明面换到某条线 / 某个版本前缀族，清锁清树重装，再回验实装版本 | compat.yml 的 swap 作业；本地复现巡检 | **会改写 `package.json`**（见 [AGENTS.md](AGENTS.md)） |
| `report-compat-failure.mjs` | 把巡检的红变成一条固定标题的跟踪 issue，同一处失败不重复刷 | compat.yml 的失败步骤 | `gh` 可用且有 `issues: write` |
| `verify-shim-hardening.mjs` | loopback shim 的加固面（六个原始 HTTP 请求各验一条） | 改 shim 后；CI 的 verify 步 | —— |
| `gateway-parity.mjs` | 插件 chat 请求与官方客户端抓包参考逐头对比（`missing` / `extra` / `value-mismatch` / `ok`，id 与 trace 按形态判） | 改 chat/probe 头后；`chatStream` 改完自查 | 先 `pnpm build`（读 `lib/index.js` 产物）；离线、默认伪凭据，`--real-credential` 才尝试读本机；四类差异见 [gateway-parity.md](gateway-parity.md) |

## 真机 / 一次性

这几条验的是**托管 runner 上验不了**的那一段，三条进 [docs/PUBLISHING.md](../docs/PUBLISHING.md) 的「发版前确认」。

| 脚本 | 做什么 | 何时跑 | 平台 | 前提 |
|---|---|---|---|---|
| `live-e2e.mjs` | 适配器 → pi-ai → shim → 真实上游的端到端，并读一次余额 | 发版前；改协议 / 适配器 / shim 后 | 任意 | 先 `build`；本机已登录；会花掉少量积分 |
| `client-identity-live-matrix.mjs` | 客户端身份矩阵（chat / tool / probe / baseline，各打各的判定） | 发版前；改 UA / 请求头 / 身份解析后 | 任意 | 先 `build`；凭据经 `WorkBuddyCredentialStore` 取（含 at-rest 解密） |
| `issue-48-forced-fallback-e2e.mjs` | 强制 fallback 的真发现链（真 `mdfind` / `plutil` / helper spawn） | 发版前 | **仅 macOS** | 先 `build`；本机 App 在标准位置 |

三条真机脚本的**平台前提会自己说**：跑不了的那条打 `SKIP …` 并 `exit 0`，不伪装成通过。
`client-identity-live-matrix.mjs` 里**未登录的产品**同样按 `SKIP` 记 —— 两个产品是各自独立的安装，
本机只登录一个是正常状态，结尾会列出跳过了哪些。

一条判据：**没跑过就不许在 Release notes 里声称验过**（尤其 macOS 自动发现，见 PUBLISHING 第 5 条）。

变更影响路由：改本目录 → 同步根 [AGENTS.md](../AGENTS.md) 的待办与活跃坑；设计变化写 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
