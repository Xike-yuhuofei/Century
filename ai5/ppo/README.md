# Century AI 5.0 — MLP + PPO 自主强化学习系统

基于正式 TypeScript 游戏规则引擎的 MLP + PPO 强化学习 AI。设计、纪律与验收口径见仓库根任务书（AI5-MLP-PPO 训练任务）。

## 架构

```
ai5/ppo/
├── bridge/            # Node 侧（与正式游戏同一份引擎编译产物 web-v1/dist/js）
│   ├── env_worker.mjs     # 持久化对局宿主进程：引擎状态转移 + 非 MLP 席位 AI 4.0 决策 + MLP 决策点挂起
│   ├── action_enum.mjs    # 动态合法行动枚举（仅消费 AIObservation；支付顺序保留；剪枝如实上报）
│   ├── encode.mjs         # ai5-state-v1（1419 维）/ ai5-action-v1（84 维）编码协议
│   └── card_features.mjs  # 公开卡表特征
├── env/vec_env.py     # Python 侧：K 个 worker 进程编排、批量决策汇集
├── model/actor_critic.py  # MLP Actor-Critic（共享主干 + 双塔 masked softmax，变长候选）
├── training/
│   ├── collector.py       # 经验采集（确定性采样 rng、席位确定性旋转、流水线派发）
│   ├── rollout.py         # 逐策略归属轨迹 + GAE（冻结对手不进入 learner on-policy 缓冲）
│   ├── ppo.py             # Clipped Objective、价值 clip、熵、优势归一化、KL 早停、NaN 守卫
│   ├── rewards.py         # 终局奖励（rank_win 默认；辅助奖励默认全关）
│   └── train_cli.py       # 训练入口（断点恢复、快照对手池、JSONL 指标）
├── evaluation/
│   ├── arena.py           # 独立竞技评估（验证种子账本、座位旋转、Wilson CI）
│   ├── export_weights.py  # 权重导出（base64 f64LE + 字节级哈希）
│   └── perf_report.py     # 性能评测
├── inference/
│   ├── policy.mjs         # TS 离线推理（复用 bridge 编码器；OpenEvolve 三接口）
│   └── predict.py         # 纯 numpy 推理（无 torch）
├── configs/               # default / smoke / scenario-a / scenario-b
├── tests/node/            # 枚举合法性、信息公平性、编码、协议、复现性（node --test）
├── tests/python/          # GAE/PPO 数学、检查点、导出一致性（unittest）
└── reports/               # 训练指标、评估报告、种子账本
```

## 环境要求

- Node ≥ 20（先构建引擎：`cd web-v1 && npm install && npm run build`）
- Python 3.13 + PyTorch（MPS）：本机复用 `~/century-ai5-env`

## 快速开始

```bash
# 冒烟训练（分钟级）
python -m ai5.ppo.training.train_cli --smoke --out ai5/ppo/reports/smoke

# 标准训练（场景 C：learner×2 + 冠军×2 + 快照×1，4 worker）
python -m ai5.ppo.training.train_cli --config ai5/ppo/configs/default.json --out ai5/ppo/reports/run-xxx

# 断点恢复
python -m ai5.ppo.training.train_cli --config ... --resume .../last.pt --iterations 100

# 场景 A（纯自对战）/ 场景 B（对抗 AI 4.0 冠军）
python -m ai5.ppo.training.train_cli --config ai5/ppo/configs/scenario-a-selfplay.json --out ...
python -m ai5.ppo.training.train_cli --config ai5/ppo/configs/scenario-b-vs-champion.json --out ...

# 独立竞技评估（验证种子池 + 账本防重；对手：冠军/中立/未训练 MLP/混合）
python -m ai5.ppo.evaluation.arena --checkpoint ai5/ppo/reports/run-xxx/last.pt \
  --opponents champion,neutral,init --games-per-setup 40 --seed-pool validation

# 权重导出 + TS 推理（OpenEvolve 接口）
python -m ai5.ppo.evaluation.export_weights --checkpoint .../last.pt
node -e "import('./ai5/ppo/inference/policy.mjs').then(m => console.log(Object.keys(m)))"

# 性能评测
python -m ai5.ppo.evaluation.perf_report --checkpoint .../last.pt

# 测试
node --test "ai5/ppo/tests/node/*.test.mjs"
python -m unittest discover -s ai5/ppo/tests/python -v
```

## 信息公平性（不可妥协）

- 神经网络唯一输入 = `buildObservation()` 产物（公开信息，深度冻结）；
- `enumerateCandidates` 函数签名只接受观察，隐藏牌库在结构上不可达；
- 静态扫描 + 隐藏牌库顺序突变不变性测试强制（`tests/node/enum-fairness.test.mjs`）；
- 支付顺序差异保留为不同候选（引擎对 `payment[i]` 逐槽位加奖励，AI 4.0 的
  同组合折叠是其搜索近似，AI 5.0 不沿用）。

## 与 OpenEvolve 的融合接口（任务书 12）

| 接口 | 入口 | 说明 |
|---|---|---|
| 局面价值 | `policy.valueOfObservation(observation)` | 当前行动者视角期望终局奖励 ∈ [0,1] |
| 行动策略 | `policy.policyScores(observation, candidates)` | 每候选概率（masked softmax） |
| 模型版本 | `manifest` | 模型/编码/接口版本 + 权重 SHA-256 |

搜索侧改变深度/束宽/剪枝时可直接调用；融合后必须重新对抗验证。

## 已知边界（如实声明）

- 训练吞吐瓶颈在模拟侧（champion 决策 ~14ms/步），GPU 占空比极低（与 M4 基准一致）；
- 候选 >512 时触发确定性分层剪枝（只裁 acquire 支付排列），覆盖率随决策上报；
- 评估为贪心 argmax；训练为采样——二者差异在报告中如实标注。
