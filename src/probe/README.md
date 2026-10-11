# src/probe/ — 文件索引

职责：见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)

- probe.ts —— 探测协议本身：基线 → 哨兵 → 逐档扫描，纯函数
- service.ts —— 串行队列、同意闸门、观测到可用性的桥接
- store.ts —— 观测存档：按账号隔离、指纹失效、14 天 TTL
- efforts.ts —— **单一真源** `resolveEfforts()`：一个模型当前能不能切档位、档位从哪来、还值不值得探测。
  adapter 的 `thinkingLevelMap` 与状态文档的灯泡都读它；两处各写一份判据曾导致「选择器有档位、composer 没控件」。
  同文件还有 `resolveDefaultEffort()`：能否切档位的模型默认挂在哪一档（上游声明优先，否则 `high`）——
  宿主据此去掉选择器里的「Default」项，判据见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 的「默认档位」

变更影响路由：改本目录 → 同步根 [AGENTS.md](../../AGENTS.md) 的待办与活跃坑；设计变化写 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
