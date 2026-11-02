"""AI13 rollout 自身策略蒸馏：纠正协议训练/评估（numpy，离线）。

相对 AI12 `train-plan-policy.py` 的纠正：
- 训练/开发/测试各用独立种子窗口，按世界（seed）整组隔离（同一种子的全部决策只落一边）；
- 支持 `--mode same`（同分布：train/dev/test 均含 2–5 人）与
  `--mode cross`（跨人数：默认 train/dev 2,4 人 → test 3,5 人）；
- 支持 `--features legacy`（原 54 维，对照 AI12）或 `rich`（结构化公开特征）；
- 同时评估两个标签：冠军 choosePlan 首步（labelPlan）与 JS5 实际行动（labelJs5），
  区分“复现规划器”与“复现真实策略”两个任务；
- 报告逐人数、贪心分歧子集、行动类型一致率，以及贪心基线（同一可选集合）。

用法：
  python3 train-plan-policy-v2.py --train '/tmp/ai13-train-*.jsonl' \
    --dev '/tmp/ai13-dev-*.jsonl' --test '/tmp/ai13-test-*.jsonl' \
    --mode same --features rich --out /tmp/ai13-plan-weights.json
"""
import argparse, glob, json
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--train', required=True)
ap.add_argument('--dev', required=True)
ap.add_argument('--test', required=True)
ap.add_argument('--mode', choices=['same', 'cross'], default='same')
ap.add_argument('--train-counts', default='2,4')
ap.add_argument('--test-counts', default='3,5')
ap.add_argument('--features', choices=['legacy', 'rich', 'all'], default='rich')
ap.add_argument('--label', choices=['plan', 'js5'], default='plan')
ap.add_argument('--hidden', type=int, default=16)
ap.add_argument('--l2', type=float, default=1e-3)
ap.add_argument('--epochs', type=int, default=400)
ap.add_argument('--lr', type=float, default=0.05)
ap.add_argument('--seed', type=int, default=0)
ap.add_argument('--top', type=int, default=12)
ap.add_argument('--out', required=True)
args = ap.parse_args()


def load(pattern):
    records = []
    meta = None
    for path in sorted(glob.glob(pattern)):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                if rec.get('meta'):
                    meta = rec
                    continue
                records.append(rec)
    assert records, f'no data: {pattern}'
    return meta, records


def select_indices(meta, mode):
    names = meta['featureNames']
    legacy = set(meta.get('legacyFeatureNames') or [])
    if mode == 'legacy':
        return [i for i, n in enumerate(names) if n in legacy]
    if mode == 'rich':
        return [i for i, n in enumerate(names) if n not in legacy]
    return list(range(len(names)))


def label_index(rec):
    return rec['labelPlan'] if args.label == 'plan' else rec['labelJs5']


def group_records(records, counts=None):
    out = []
    for rec in records:
        lab = label_index(rec)
        if lab is None or lab < 0 or lab >= len(rec['rows']):
            continue
        if counts is not None and rec['seats'] not in counts:
            continue
        out.append((rec['seed'], rec['seats'], lab, np.asarray(rec['rows'], dtype=np.float64), rec['rows']))
    return out


train_meta, train_records = load(args.train)
train_meta = train_meta or load(args.dev)[0]
train_counts = set(int(x) for x in args.train_counts.split(',')) if args.mode == 'cross' else None
test_counts = set(int(x) for x in args.test_counts.split(',')) if args.mode == 'cross' else None

train = group_records(train_records, train_counts)
dev = group_records(load(args.dev)[1], train_counts)
test = group_records(load(args.test)[1], test_counts)

# 推理侧候选集只含贪心价值前 TOP（标签在 TOP 之外则不可选）。
def selectable(groups):
    return [g for g in groups if g[2] < args.top]

train_sel = selectable(train)
dev_sel = selectable(dev)
test_sel = selectable(test)
train_all_count = len(train) + (0)
val_unselectable = len(test) - len(test_sel)

idx = select_indices(train_meta, args.features)
allX = np.vstack([g[3][:, idx] for g in train_sel])
mu = allX.mean(axis=0)
sd = np.maximum(allX.std(axis=0), 1e-2)

def norm(groups):
    return [(g[0], g[1], g[2], np.clip((g[3][:, idx] - mu) / sd, -10, 10), g[4]) for g in groups]

train_n = norm(train_sel)
dev_n = norm(dev_sel)
test_n = norm(test_sel)


def batch(groups):
    X = np.vstack([g[3] for g in groups])
    y = np.concatenate([np.full(g[3].shape[0], g[2]) for g in groups]).astype(int)
    starts = np.cumsum([0] + [g[3].shape[0] for g in groups])
    return X, y, starts


Xtr, ytr, ptr = batch(train_n)
Xva, yva, pva = batch(dev_n)
Xte, yte, pte = batch(test_n)
G = Xtr.shape[1]
H = args.hidden
rng = np.random.default_rng(args.seed)
if H > 0:
    W1 = rng.normal(0, 1 / np.sqrt(G), size=(G, H))
    b1 = np.zeros(H)
    w2 = rng.normal(0, 1 / np.sqrt(H), size=H)
    params = [W1, b1, w2]
else:
    params = [np.zeros(G)]


def scores_of(param, X):
    if H > 0:
        W1_, b1_, w2_ = param
        A = np.maximum(0, X @ W1_ + b1_)
        return A @ w2_, A
    return X @ param[0], None


def softmax_grad(scores, starts, y):
    out = np.zeros_like(scores)
    for gi in range(len(starts) - 1):
        a, b = starts[gi], starts[gi + 1]
        s = scores[a:b]
        s = s - s.max()
        e = np.exp(s)
        out[a:b] = e / e.sum()
        out[a + int(y[a])] -= 1.0
    return out


def accuracy(param, X, y, starts):
    sc, _ = scores_of(param, X)
    ok = 0
    for gi in range(len(starts) - 1):
        a, b = starts[gi], starts[gi + 1]
        if np.argmax(sc[a:b]) == int(y[a]):
            ok += 1
    return ok / max(1, len(starts) - 1)


def loss_fn(param, X, y, starts, l2):
    sc, _ = scores_of(param, X)
    total, n = 0.0, 0
    for gi in range(len(starts) - 1):
        a, b = starts[gi], starts[gi + 1]
        s = sc[a:b]
        s = s - s.max()
        e = np.exp(s)
        total += -(s[int(y[a])] - np.log(e.sum()))
        n += 1
    return total / max(1, n) + l2 * sum((p * p).sum() for p in param)


m = [np.zeros_like(p) for p in params]
v = [np.zeros_like(p) for p in params]
beta1, beta2, eps = 0.9, 0.999, 1e-8
t = 0
best = None
best_state = None
best_epoch = None
for ep in range(1, args.epochs + 1):
    t += 1
    sc, A = scores_of(params, Xtr)
    delta = softmax_grad(sc, ptr, ytr) / max(1, len(train_n))
    if H > 0:
        W1_, b1_, w2_ = params
        gW2 = A.T @ delta + 2 * args.l2 * w2_
        dA = delta[:, None] * w2_[None, :]
        dA[A <= 0] = 0
        gW1 = Xtr.T @ dA + 2 * args.l2 * W1_
        gb1 = dA.sum(axis=0)
        grads = [gW1, gb1, gW2]
    else:
        grads = [Xtr.T @ delta + 2 * args.l2 * params[0]]
    lr = args.lr * (0.5 ** (ep / 100))
    for i, (p, gr) in enumerate(zip(params, grads)):
        m[i] = beta1 * m[i] + (1 - beta1) * gr
        v[i] = beta2 * v[i] + (1 - beta2) * (gr * gr)
        mh = m[i] / (1 - beta1 ** t)
        vh = v[i] / (1 - beta2 ** t)
        p -= lr * mh / (np.sqrt(vh) + eps)
    if ep % 10 == 0 or ep == args.epochs:
        acc = accuracy(params, Xva, yva, pva)
        if best is None or acc > best:
            best = acc
            best_state = [p.copy() for p in params]
            best_epoch = ep

params = best_state
test_acc = accuracy(params, Xte, yte, pte)
train_acc = accuracy(params, Xtr, ytr, ptr)


def per_count_accuracy(groups):
    out = {}
    for seats in sorted(set(g[1] for g in groups)):
        sub = [g for g in groups if g[1] == seats]
        if not sub:
            continue
        X, y, p = batch(sub)
        out[seats] = {'n': len(sub), 'acc': accuracy(params, X, y, p)}
    return out


def greedy_baseline(groups):
    out = {}
    for seats in sorted(set(g[1] for g in groups)):
        sub = [g for g in groups if g[1] == seats]
        out[seats] = {'n': len(sub), 'acc': float(np.mean([g[2] == 0 for g in sub]))}
    total = float(np.mean([g[2] == 0 for g in groups])) if groups else None
    return {'byCount': out, 'overall': total}


def disagreement_subset(groups):
    # 仅贪心 top1 ≠ 标签的决策（检验模型是否真正学到“纠正贪心”的部分）。
    return [g for g in groups if g[2] != 0]


def subset_accuracy(groups):
    if not groups:
        return None
    X, y, p = batch(groups)
    return accuracy(params, X, y, p)


def cluster_delta(groups):
    """世界簇 bootstrap：同一种子的全部决策一起重采样（AI12 审计的核心口径）。"""
    if not groups:
        return None
    worlds = {}
    for g in groups:
        sc, _ = scores_of(params, g[3])
        ok = int(np.argmax(sc)) == g[2]
        worlds.setdefault(g[0], []).append((bool(ok), bool(g[2] == 0)))
    clusters = list(worlds.values())
    rng = np.random.default_rng(20261102)
    diffs = []
    for _ in range(2000):
        pick = rng.integers(0, len(clusters), len(clusters))
        oks = [w[0] for i in pick for w in clusters[i]]
        bs = [w[1] for i in pick for w in clusters[i]]
        diffs.append(float(np.mean(oks) - np.mean(bs)))
    return {
        'worldClusters': len(clusters),
        'delta95': [float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))],
        'deltaMean': float(np.mean(diffs)),
    }


def type_of(row, full_names):
    def at(name):
        return row[full_names.index(name)]
    if at('isPlay') == 1: return 'play'
    if at('isAcquire') == 1: return 'acquire'
    if at('isClaim') == 1: return 'claim'
    if at('isRest') == 1: return 'rest'
    return '?'


def type_accuracy(groups, full_names):
    ok = 0
    for g in groups:
        sc, _ = scores_of(params, g[3])
        pred = int(np.argmax(sc))
        raw = g[4]
        if type_of(raw[pred], full_names) == type_of(raw[g[2]], full_names):
            ok += 1
    return ok / max(1, len(groups))


def type_oracle(groups, full_names):
    # 已知正确行动类型：类型内取贪心价值最高（value10 的原始列）→ 精确一致率上限。
    ok = 0
    value_i = full_names.index('value10')
    for g in groups:
        rows = g[4]
        lab = g[2]
        lt = type_of(rows[lab], full_names)
        cand = [i for i, r in enumerate(rows) if type_of(r, full_names) == lt]
        best = max(cand, key=lambda i: rows[i][value_i]) if cand else lab
        if best == lab:
            ok += 1
    return ok / max(1, len(groups))


full_names = train_meta['featureNames']
out = {
    'schema': 'century-ai13-plan-distill-v2',
    'protocol': {
        'mode': args.mode,
        'features': args.features,
        'label': args.label,
        'trainCounts': sorted(train_counts) if train_counts else [2, 3, 4, 5],
        'testCounts': sorted(test_counts) if test_counts else [2, 3, 4, 5],
        'split': 'world-group isolated; independent train/dev/test seed windows',
        'featureCount': len(idx),
        'hidden': H,
        'bestEpoch': best_epoch,
        'top': args.top,
    },
    'counts': {
        'trainDecisions': len(train), 'trainSelectable': len(train_sel),
        'devDecisions': len(dev), 'devSelectable': len(dev_sel),
        'testDecisions': len(test), 'testSelectable': len(test_sel),
        'testUnselectable': val_unselectable,
        'uniqueTrainSeeds': len(set(g[0] for g in train)),
        'uniqueTestSeeds': len(set(g[0] for g in test)),
    },
    'trainAcc': train_acc, 'devAcc': best, 'testAccSelectable': test_acc,
    'testAccByCount': per_count_accuracy(test_n),
    'greedyBaseline': greedy_baseline(test_n),
    'testAccOnGreedyDisagreements': subset_accuracy(disagreement_subset(test_n)),
    'testDisagreementsN': len(disagreement_subset(test_n)),
    'testTypeAcc': type_accuracy(test_n, full_names),
    'testTypeOracle': type_oracle(test_n, full_names),
    'testDeltaClusterBootstrap': cluster_delta(test_n),
    'testAccAllDecisions': test_acc * len(test_sel) / max(1, len(test)),
    'mean': mu.tolist(), 'scale': sd.tolist(),
    'featureIndex': idx,
    'weights1': params[0].tolist() if H > 0 else params[0].tolist(),
    'bias1': params[1].tolist() if H > 0 else None,
    'weights2': params[2].tolist() if H > 0 else None,
}
with open(args.out, 'w') as f:
    json.dump(out, f, indent=2)
print(json.dumps({k: out[k] for k in (
    'protocol', 'counts', 'trainAcc', 'devAcc', 'testAccSelectable', 'testAccByCount',
    'greedyBaseline', 'testAccOnGreedyDisagreements', 'testDisagreementsN',
    'testTypeAcc', 'testTypeOracle', 'testAccAllDecisions')}, indent=2, ensure_ascii=False))
