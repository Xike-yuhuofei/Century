# 任务 A2 预注册：双人模式 JS5 独立验证（第六阶段）

预注册时间：2026-10-24（实验启动前落盘，种子未消费）
分支：research/ai6-phase6-winrate-scaling @ fa85bf0

## 比较对象

- 候选：`joint-js5-frozen`（PR #30 晋级描述符，budgetMs=100）
- 基线：`legacy-js0`（历史束搜索冠军 ai5-readiness-efficiency，冻结快照）
- 版本身份由 version-registry 冻结快照决定（version-gate PASS 前置）

## 种子（全新，此前任何实验未消费）

- `AI6_PHASE6_2P_SUBBLOCK [1.37e9, 1.372e9)`：
  - classic 池：[1.37e9, 1.37e9+200)
  - diverse 池：[1.371e9, 1.371e9+200)
- 每池 200 种子 × A/B 双向（400 局/候选/池）；候选与基线共享种子（配对设计）。

## 对手池

- classic：pools.mjs classicPool（joint-js5-frozen + neutral-baseline + 3 风格变体）
- diverse：pools.mjs diversePool（+ ai4-struct-beam-rollout + random-legal）

## 端点与判定标准

- **主要终点（预注册）**：A+B 座位均衡合并单候选第一名率差（种子聚类配对
  bootstrap，2000 重抽样）——A1 显示 2p 下该估计量效率高于单方向；
- 次要终点：方向 A 单席位差、方向 B 差、平均分差；
- 多重检验：两池主终点 family=2 Bonferroni（CI 水平 97.5%）；
- **判定**：合并差 CI 下界 > 0 → JS5 双人显著优于旧冠军；CI 含 0 → 平价
  （保留双人旧冠军的选项不作预设置——本阶段不预先指定"双人必须使用旧冠军"）；
- 搜索预算：双方均 100ms（JS5）/ 天然预算（束搜索）。

## 问题清单（实验后回答）

1. JS5 是否确实优于原束搜索冠军（双人）？
2. 优势是否存在于不同座位（A/B 分解）与不同对手池？
3. 与 A1 历史数据合并分析的探索性结论（classic +11.5pp）是否复现？
4. （跨任务）增加搜索预算能否进一步扩大双人优势 → 见任务 B 预算矩阵 2p 行。

## 纪律

- 本预注册文件在实验启动前提交；种子区间由 seed_policy.mjs 断言保护；
- 结果无论正负均如实披露；异常局拒绝计入（compare.mjs 拒绝性校验）。
