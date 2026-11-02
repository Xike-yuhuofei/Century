"""AI12 蒸馏证据审计：直接复算原始 /tmp 数据与原始权重。

回答四个问题：
1. `collect-plan-data.mjs --shards 4` 是否复用了种子（唯一世界数 vs 记录数）；
2. “按种子奇偶切分”是否等价于“按人数切分”（train 2/4 vs val 3/5）；
3. 原始 62.7% 是否能在世界簇层面复现，及其世界簇 bootstrap 区间；
4. 原始报告的 typeAcc=1.0 是否可信。

输入（历史证据，只读；不得覆盖）：
  /tmp/ai12-plan-s{0..3}.jsonl
  /tmp/ai12-plan-mlp16.json, /tmp/ai12-plan-linear.json
输出：
  training/reports/ai13/ai12-distillation-audit.json
"""
import glob, hashlib, json, os
import numpy as np

SHARD_GLOB = '/tmp/ai12-plan-s?.jsonl'
MLP = '/tmp/ai12-plan-mlp16.json'
LINEAR = '/tmp/ai12-plan-linear.json'
OUT = os.path.join(os.path.dirname(__file__), '..', 'ai12-distillation-audit.json')

records = []
for path in sorted(glob.glob(SHARD_GLOB)):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))

seeds = [r['seed'] for r in records]
unique = sorted(set(seeds))
per_seed = {s: sum(1 for r in records if r['seed'] == s) for s in unique}
by_seat_count = {n: sum(1 for r in records if r['seats'] == n) for n in (2, 3, 4, 5)}

# 奇偶 → 人数映射
parity = {
    'evenSeats': sorted(set(r['seats'] for r in records if r['seed'] % 2 == 0)),
    'oddSeats': sorted(set(r['seats'] for r in records if r['seed'] % 2 == 1)),
    'evenDecisions': sum(1 for r in records if r['seed'] % 2 == 0),
    'oddDecisions': sum(1 for r in records if r['seed'] % 2 == 1),
}


def score_model(model, rows):
    # 原始权重中有一个近常量特征的 scale≈4.7e-13，未裁剪会产生 1e13 量级输入与
    # 浮点溢出（原始训练/评估同样受影响）。审计复算统一裁剪到 [-10,10]，
    # 并在结果中披露该数值缺陷。
    X = np.clip((np.asarray(rows, dtype=np.float64) - np.asarray(model['mean'])) / np.asarray(model['scale']), -10, 10)
    if model['hidden'] > 0:
        W1 = np.asarray(model['weights1'])
        b1 = np.asarray(model['bias1'])
        w2 = np.asarray(model['weights2'])
        A = np.maximum(0, X @ W1 + b1)
        return A @ w2
    return X @ np.asarray(model['weights1'])


def eval_model(model, subset, top=12):
    # 复刻原始 train-plan-policy.py 的可选集合：label ∈ [0, top)
    groups = [r for r in subset if 0 <= r['label'] < top]
    correct = []
    base = []
    counts = []
    cluster = []
    for r in groups:
        sc = score_model(model, r['rows'])
        pred = int(np.argmax(sc))
        ok = pred == r['label']
        correct.append(ok)
        base.append(r['label'] == 0)
        counts.append(r['seats'])
        cluster.append((r['seed'], bool(ok), bool(r['label'] == 0)))
    acc = float(np.mean(correct)) if correct else None
    baseline = float(np.mean(base)) if base else None
    by_count = {
        str(n): {
            'n': int(sum(1 for c in counts if c == n)),
            'acc': float(np.mean([ok for ok, c in zip(correct, counts) if c == n])) if any(c == n for c in counts) else None,
            'greedy': float(np.mean([b for b, c in zip(base, counts) if c == n])) if any(c == n for c in counts) else None,
        }
        for n in (2, 3, 4, 5)
    }
    # 世界簇 bootstrap：按唯一 seed 重采样（同世界全部决策一起进出）
    world_sets = {}
    for seed, ok, b in cluster:
        world_sets.setdefault(seed, []).append((ok, b))
    worlds = list(world_sets.values())
    rng = np.random.default_rng(20261102)
    diffs = []
    for _ in range(2000):
        pick = rng.integers(0, len(worlds), len(worlds))
        oks = [w[0] for i in pick for w in worlds[i]]
        bs = [w[1] for i in pick for w in worlds[i]]
        diffs.append(float(np.mean(oks) - np.mean(bs)))
    lo, hi = (float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5)))
    return {
        'selectableN': len(groups),
        'acc': acc, 'greedy': baseline, 'delta': (acc - baseline) if (acc is not None and baseline is not None) else None,
        'byCount': by_count,
        'worldClusters': len(world_sets),
        'deltaClusterBootstrap95': [lo, hi],
    }


mlp = json.load(open(MLP))
linear = json.load(open(LINEAR))
val = [r for r in records if r['seed'] % 2 == 1 and r['label'] >= 0]
train = [r for r in records if r['seed'] % 2 == 0 and r['label'] >= 0]

# 原始 typeAcc 复算：原始实现使用归一化后的 row[19] == 1 判定，归一化后二元特征不再是 1。
def original_type_rule_ok(val_groups, model):
    ok = 0
    rows = 0
    for r in val_groups:
        sc = score_model(model, r['rows'])
        pred = int(np.argmax(sc))
        def t(row):
            if row[19] == 1: return 'play'
            if row[20] == 1: return 'acquire'
            if row[21] == 1: return 'claim'
            if row[22] == 1: return 'rest'
            return '?'
        # 原始实现把归一化行传给 t，二元特征归一化后恒不等于 1 → 两边都 '?'。
        X = (np.asarray(r['rows'], dtype=np.float64) - np.asarray(model['mean'])) / np.asarray(model['scale'])
        if t(X[pred]) == t(X[r['label']]):
            ok += 1
        rows += 1
    return ok / max(1, rows)


# 正确口径：用未归一化原始特征判类型（本次审计的修正）。
def corrected_type_ok(val_groups, model):
    ok = 0
    for r in val_groups:
        sc = score_model(model, r['rows'])
        pred = int(np.argmax(sc))
        def t(row):
            if row[19] == 1: return 'play'
            if row[20] == 1: return 'acquire'
            if row[21] == 1: return 'claim'
            if row[22] == 1: return 'rest'
            return '?'
        if t(np.asarray(r['rows'])[pred]) == t(np.asarray(r['rows'])[r['label']]):
            ok += 1
    return ok / max(1, len(val_groups))


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


result = {
    'schema': 'century-ai13-ai12-distill-audit-v1',
    'source': {
        'shards': [{path: p, 'sha256': sha256_of(p)} for p in sorted(glob.glob(SHARD_GLOB))],
        'mlp': {'path': MLP, 'sha256': sha256_of(MLP)},
        'linear': {'path': LINEAR, 'sha256': sha256_of(LINEAR)},
    },
    'dataAudit': {
        'gameRecords': len(records),
        'uniqueSeeds': len(unique),
        'recordsPerSeed': {'min': min(per_seed.values()), 'max': max(per_seed.values()),
                           'mean': float(np.mean(list(per_seed.values())))},
        'bySeatCount': by_seat_count,
        'paritySplit': parity,
        'shardSeedOverlap': 'all four shards share the same seed set'
            if all(set(json.loads(l)['seed'] for l in open(p)) == set(unique) for p in sorted(glob.glob(SHARD_GLOB))) else 'no',
        'note': 'seed = seedBase + seatCount*1000 + g 与 shard 无关；focusSeat=(g+shard)%seatCount 只换焦点席位。',
    },
    'splitAudit': {
        'trainSeatCounts': sorted(set(r['seats'] for r in train)),
        'valSeatCounts': sorted(set(r['seats'] for r in val)),
        'trainDecisions': len(train), 'valDecisions': len(val),
        'conclusion': 'seed 奇偶 == g 奇偶；g 偶→2/4 人、g 奇→3/5 人，因此“随机切分”实际是跨人数切分。',
    },
    'mlp16Recompute': {
        **eval_model(mlp, val),
        'originalReportedValAcc': mlp['valAcc'],
        'originalReportedValAccAll': mlp['valAccAllDecisions'],
        'originalReportedTypeAcc': mlp['valTypeAcc'],
        'originalTypeAccRuleReproduced': original_type_rule_ok(val, mlp),
        'correctedTypeAcc': corrected_type_ok(val, mlp),
    },
    'linearRecompute': {
        **eval_model(linear, val),
        'originalReportedValAcc': linear['valAcc'],
        'originalReportedTypeAcc': linear['valTypeAcc'],
        'correctedTypeAcc': corrected_type_ok(val, linear),
    },
}
with open(OUT, 'w') as f:
    json.dump(result, f, indent=2, ensure_ascii=False)
print(json.dumps(result, indent=2, ensure_ascii=False))
