# 默认档位：把选择器里的「Default」去掉

状态：生效

## 问题

模型选择器的推理档位下拉里恒有一项「Default」（`effort.providerDefault`，宿主 `dsh-client-ui-model-selection` 的词条）。
它读作"跟随上游"，但用户看到的是一道**没有信息量的选项**：既不知道会发什么值，也无法据此预判行为。
维护者要求去掉它，并把默认档位定为 `high`。

机制在宿主侧很明确（读实装包得出，非推断）：`effortChoices` 构造时先判断
`reasoning.defaultEffort === undefined`，**是则插入 Default 项**，然后才追加各档位。
所以「去掉 Default」= **每个能切档位的模型都上报一个默认档位**。

本仓当时已经把上游的 `defaultEffort` 解析进目录（`src/protocol/client.ts` 的 `resolveUpstreamReasoning`），
但适配层只把 `supportedEfforts` 翻译成 pi-ai 的 `thinkingLevelMap`，**默认档位没有往宿主转发**。
即：数据一直在手上，缺的是一步上报。

## 决策

新增 `src/probe/efforts.ts` 的 `resolveDefaultEffort(info, offered)`，与 `resolveEfforts()` 同级：

1. 上游 `reasoning.defaultEffort` 在档位集里 → 用它。
2. 否则 `high`（集合不含 `high` 时取集合首项）。

适配层在**两处**上报：`resolveModel()`（选择器读）与 `prepareCall()`（请求路径读），
都是把 `reasoning.defaultEffort` 覆盖进去。

## 替代方案

- **让宿主自己改**：那是宿主包的 UI 决策，本仓不该也无法从插件侧改它的词条与选项构造。
  且该行为对别的 provider 可能正是想要的（它们未必有 per-model 默认档位的概念）。
- **把默认档位写成路线级 profile 字段**（`dsh-llm-pi-ai` 的 `profile.reasoning`）：它**一个 provider 只能一个值**，
  而本仓的模型上游默认各不相同（`deepseek-v4.1-flash` 是 high、`space-bunny` 是 max）。
  用路线级字段会把它们拍平成一个值——**这正是必须走 per-model 上报的原因**。
- **只改 `resolveModel()`（选择器那侧）**：选择器不再显示 Default，但请求路径（`prepareCall()`）拿不到默认档位，
  于是"显示 High、实发别的值"——比留着 Default 更坏。两处都改是必须的，测试也按两处都断言。
- **`defaultEffort` 缺失时保留 Default**：用户明确否决——要求的是下拉里不出现 Default。
  代价（对一个上游没声明默认档位的模型替它选 `high`）已接受，理由写在下面。
- **兜底取集合首项而不是 `high`**：当集合含 `high` 时两者多数情况下不同（`['low','high','max']` 首项是 low）。
  用户要求的是 `high`，故 `high` 优先、集合首项只作为"集合里没有 high"时的保底。
- **不报默认、改在别处补 pi-ai 的行为**：去掉 Default 必须由宿主不再插入该项实现，绕不开上报这条路径。

## 影响

- **能切档位的模型**：选择器不再有 Default，改显示默认档位的名字与勾选（`deepseek-v4.1-flash` → High，`space-bunny` → Max）。
  省略档位的请求因此携带具体的 `reasoning_effort`，而不是"什么都不发、由上游决定"。
- **不能切档位的模型**：不报默认（`undefined`），选择器里仍然只有 Default——它们本来也没有别的档位。
- **上游声明与执行仍无一致性保证**（同 issue #49 的既有结论）：本改动只决定"发哪个拼写"，
  不保证上游照它执行。文档不因此声称默认档位"生效"。
- **`high` 兜底是替上游做的声明**：仅在"声明了档位集却没声明默认档位"或"声明的默认档位已不在集合里"时触发。
  今日两份 fallback 表里所有声明了档位集的行都同时声明了默认档位，触发不到；上游漂移出现这种行时才会走到。
- 判据：`tests/efforts.spec.ts` 的 `resolveDefaultEffort` 一节（含"默认档位必是集合成员"的不变式），
  `tests/reasoning-merge.spec.ts` 的「the default level the picker shows」一节（过真 seam，选择器与请求路径两侧都断言，
  并遍历整份 fallback roster 检查不变式）。
