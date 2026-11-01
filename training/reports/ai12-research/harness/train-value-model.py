"""AI12 学习型叶价值：逻辑回归训练与导出（numpy，离线）。

用法：python3 /tmp/ai12-train.py --glob '/tmp/ai12-value-shard-*.jsonl' --out /tmp/ai12-l5-weights.json
"""
import argparse, glob, json, math
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--glob', default='/tmp/ai12-value-shard-*.jsonl')
ap.add_argument('--out', default='/tmp/ai12-l5-weights.json')
ap.add_argument('--l2', type=float, default=1e-3)
ap.add_argument('--iters', type=int, default=3000)
args = ap.parse_args()

rows = []
for p in sorted(glob.glob(args.glob)):
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

keys = [k for k in rows[0].keys() if k not in ('label', 'seed', 'seatCount', 'focusSeat')]
X = np.array([[float(r[k]) for k in keys] for r in rows], dtype=np.float64)
y = np.array([float(r['label']) for r in rows], dtype=np.float64)
seeds = np.array([int(r['seed']) for r in rows])

# 训练/验证按种子奇偶切分（同一种子的全部样本只落在一边，避免泄漏）
train = (seeds % 2 == 0)
val = ~train
Xt, yt = X[train], y[train]
Xv, yv = X[val], y[val]

mu = Xt.mean(axis=0)
sd = Xt.std(axis=0)
sd[sd == 0] = 1.0
Zt = (Xt - mu) / sd
Zv = (Xv - mu) / sd
Zt = np.hstack([np.ones((Zt.shape[0], 1)), Zt])
Zv = np.hstack([np.ones((Zv.shape[0], 1)), Zv])

w = np.zeros(Zt.shape[1])
for it in range(args.iters):
    p = 1 / (1 + np.exp(-(Zt @ w)))
    g = (Zt.T @ (p - yt)) / len(yt) + args.l2 * np.r_[0.0, w[1:]]
    lr = 0.5 / (1 + it / 200)
    w -= lr * g

def logloss(X, y, w):
    z = X @ w
    p = 1 / (1 + np.exp(-z))
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())

def auc(X, y, w):
    s = X @ w
    pos = s[y == 1]
    neg = s[y == 0]
    # 采样近似 AUC（避免 O(n^2)）
    if len(pos) == 0 or len(neg) == 0:
        return float('nan')
    rng = np.random.default_rng(0)
    a = rng.choice(pos, size=min(2000, len(pos)), replace=False)
    b = rng.choice(neg, size=min(2000, len(neg)), replace=False)
    cmp = (a[:, None] > b[None, :]).mean() + 0.5 * (a[:, None] == b[None, :]).mean()
    return float(cmp)

out = {
    'schema': 'century-ai12-learned-leaf-value-v1',
    'features': keys,
    'mean': mu.tolist(),
    'scale': sd.tolist(),
    'weights': w.tolist(),
    'samples': int(len(rows)),
    'trainSamples': int(train.sum()),
    'valSamples': int(val.sum()),
    'valLogLoss': logloss(Zv, yv, w),
    'trainLogLoss': logloss(Zt, yt, w),
    'valAuc': auc(Zv, yv, w),
    'valBaseRate': float(yv.mean()),
}
with open(args.out, 'w') as f:
    json.dump(out, f, indent=2)
print(json.dumps({k: out[k] for k in ('samples', 'trainSamples', 'valSamples', 'valLogLoss', 'valAuc', 'valBaseRate')}, indent=2))
print('weights', {k: round(v, 3) for k, v in zip(['bias'] + keys, w.tolist())})
