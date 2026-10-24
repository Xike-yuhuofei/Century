# 预注册联赛结果摘要（prereg-15s-official）

- 执行：2026-10-25，人工批准后按 `prereg-plan-15s.json` 启动（`run-league.mjs --mode matrix --players 2,5 --seeds 15 --block prereg --joint official`）
- 规模：**1620 局 / 108 场，异常 0**，总耗时 5865s（97.8 分钟），种子 `[1403000000, 1403001620)` 与方案逐种子一致
- 口径：`--joint official`（冻结冠军 budgetMs=100 墙钟）；注册表指纹 `cf89c393…` 与引擎指纹 `a0da8883…` 全程一致（版本无漂移）
- 完整逐局数据：`league-report.json`（本目录）

## 核心结论

1. **JS5 冠军地位稳固**：对全部 8 个非 JS5 对手第一名率 ≥ 33.3%，其中 6/8 ≥ 50%；对 random-legal 100%（矩阵无席位泄漏伪影）。
2. **克制信号：引擎型策略（style-engine）**——JS5 对其仅 **33.3%**（Wilson 95% CI [0.192, 0.512]，n=30），是唯一把冠军压到显著低于 50% 区间的对手；与冒烟期信号一致。**第六阶段对手池应优先纳入 style-engine 方向**，OpenEvolve 搜索可沿"引擎型 + 权重/结构变异"轴扩展。
3. 次级威胁：style-rush 与 style-contest（JS5 均为 43.3–50.0%，CI 触及 0.5 以下）。
4. **联合搜索的增量价值**：JS5 对 style-balanced（同血统权重、无联合搜索）70.0% [0.521, 0.833]——联合搜索相对其束搜索基座有真实增益。
5. 泛化健康：JS5 对前任冠军 ai5-readiness 53.3%、对 ai4 世代 66.7%、对中立基线 63.3%。

## 附：JS5 视角完整矩阵行（对手视角见 league-report.json matrix 互补单元）

| 对手 | JS5 第一名率 | Wilson 95% CI | 场次 |
|---|---|---|---|
| style-balanced | 70.0% | [0.521, 0.833] | 30 |
| ai4-struct-beam-rollout | 66.7% | [0.488, 0.808] | 30 |
| neutral-baseline | 63.3% | [0.455, 0.781] | 30 |
| ai5-readiness-efficiency | 53.3% | [0.361, 0.698] | 30 |
| style-rush | 50.0% | [0.332, 0.668] | 30 |
| style-contest | 43.3% | [0.274, 0.608] | 30 |
| **style-engine** | **33.3%** | **[0.192, 0.512]** | 30 |
| random-legal | 100.0% | [0.884, 1.000] | 30 |

## 限制

- n=30/cell：结论级读数仅 style-engine 的克制信号（方向与冒烟一致）足以立项跟进；其余差异需扩样（30s 档方案已就绪）。
- 2p 头对头与 5p 有向场单元合并在矩阵 cell 内披露（bySeat/逐场分解见 JSON），按人数细分结论需查 JSON。
- 风格变体权重在本口径下真实生效（PR #39 修复前它们是 JS5 克隆——本结果运行于修复合并前的代码，但本联赛使用 training/adversarial 注册表，自始即 strip-adapter，不受该缺陷影响）。
