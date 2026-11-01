"""AI12 rollout 自身策略蒸馏：决策组内 softmax 再排序（numpy，离线）。

输入：collect-plan-data.mjs 的 jsonl（每行一个决策，rows = 候选行动特征）。
模型：score(action) = w · (f − μ)/σ；在候选集内 softmax；训练集/验证集按种子奇偶切分
（同一种子的全部决策只落一边）。

用法：
  python3 train-plan-policy.py --glob '/tmp/ai12-plan-s*.jsonl' --out /tmp/ai12-plan-weights.json
"""
import argparse, glob, json
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--glob', default='/tmp/ai12-plan-s*.jsonl')
ap.add_argument('--out', default='/tmp/ai12-plan-weights.json')
ap.add_argument('--l2', type=float, default=1e-3)
ap.add_argument('--epochs', type=int, default=400)
ap.add_argument('--lr', type=float, default=0.05)
ap.add_argument('--hidden', type=int, default=0)
ap.add_argument('--top', type=int, default=12)
args = ap.parse_args()

groups = []
names = None
for path in sorted(glob.glob(args.glob)):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            rows = rec['rows']
            if names is None:
                names = [None] * len(rows[0])
            groups.append((rec['seed'], rec['label'], rec['labelRank'], np.asarray(rows, dtype=np.float64)))
assert groups, 'no data'
D = groups[0][3].shape[1]

train_all = [g for g in groups if g[0] % 2 == 0 and g[1] >= 0]
val_all = [g for g in groups if g[0] % 2 == 1 and g[1] >= 0]
# 推理侧候选集只含贪心价值前 TOP（无标签可注入）→ 标签在 TOP 之外的决策无法被选中。
train = [g for g in train_all if g[1] < args.top]
val = [g for g in val_all if g[1] < args.top]
val_unselectable = len(val_all) - len(val)
allX = np.vstack([g[3] for g in train])
mu = allX.mean(axis=0)
sd = allX.std(axis=0)
sd[sd == 0] = 1.0

def norm(g):
    return tuple((g[0], g[1], g[2], (g[3] - mu) / sd) for g in g)

train = norm(train)
val = norm(val)


def make_epoch_batch(groups_):
    # 拼接各组；记录组边界
    X = np.vstack([g[3] for g in groups_])
    y = np.concatenate([np.full(g[3].shape[0], g[1]) for g in groups_]).astype(int)
    starts = np.cumsum([0] + [g[3].shape[0] for g in groups_])
    return X, y, starts


Xtr, ytr, ptr = make_epoch_batch(train)
Xva, yva, pva = make_epoch_batch(val)
Gtr, Gva = len(train), len(val)
G = Xtr.shape[1]

H = args.hidden
rng = np.random.default_rng(0)
if H > 0:
    W1 = rng.normal(0, 1 / np.sqrt(G), size=(G, H))
    b1 = np.zeros(H)
    w2 = rng.normal(0, 1 / np.sqrt(H), size=H)
    params = [W1, b1, w2]
else:
    w = np.zeros(G)
    params = [w]

def scores_of(param, X):
    if H > 0:
        W1, b1, w2 = param
        A = np.maximum(0, X @ W1 + b1)
        return A @ w2, A
    return X @ param[0], None

def softmax_grad(scores, starts, y):
    # 返回每个样本的 (p - onehot(y)) 及其所属组
    out = np.zeros_like(scores)
    for gi in range(len(starts) - 1):
        a, b = starts[gi], starts[gi + 1]
        s = scores[a:b]
        s = s - s.max()
        e = np.exp(s)
        p = e / e.sum()
        lab = int(y[a])
        out[a:b] = p
        out[a + lab] -= 1.0
    return out

def accuracy(param, X, y, starts):
    sc, _ = scores_of(param, X)
    ok = 0
    for gi in range(len(starts) - 1):
        a, b = starts[gi], starts[gi + 1]
        if np.argmax(sc[a:b]) == int(y[a]):
            ok += 1
    return ok / (len(starts) - 1)

def loss_fn(param, X, y, starts, l2):
    sc, _ = scores_of(param, X)
    total = 0.0
    n = 0
    for gi in range(len(starts) - 1):
        a, b = starts[gi], starts[gi + 1]
        s = sc[a:b]
        s = s - s.max()
        e = np.exp(s)
        total += -(s[int(y[a])] - np.log(e.sum()))
        n += 1
    reg = l2 * sum((p * p).sum() for p in param)
    return total / n + reg

# Adam
m = [np.zeros_like(p) for p in params]
v = [np.zeros_like(p) for p in params]
beta1, beta2, eps = 0.9, 0.999, 1e-8
t = 0
best = None
best_state = None
for ep in range(1, args.epochs + 1):
    t += 1
    sc, A = scores_of(params, Xtr)
    delta = softmax_grad(sc, ptr, ytr) / Gtr  # 组平均
    if H > 0:
        W1, b1, w2 = params
        gW2 = A.T @ delta + 2 * args.l2 * w2
        dA = delta[:, None] * w2[None, :]
        dA[A <= 0] = 0
        gW1 = Xtr.T @ dA + 2 * args.l2 * W1
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
    if ep % 25 == 0 or ep == args.epochs:
        acc = accuracy(params, Xva, yva, pva)
        lv = loss_fn(params, Xva, yva, pva, args.l2)
        if best is None or acc > best:
            best = acc
            best_state = [p.copy() for p in params]
        print(json.dumps({'epoch': ep, 'valAcc': round(acc, 4), 'valLoss': round(lv, 4)}))

params = best_state
val_acc = accuracy(params, Xva, yva, pva)
train_acc = accuracy(params, Xtr, ytr, ptr)

# 条件一致率：仅贪心 top1 ≠ 标签的决策
sub = [(g[3], g[1], g[2]) for g in val if g[2] != 0]
cond = None
if sub:
    Xs = np.vstack([s[0] for s in sub])
    ys = np.concatenate([np.full(s[0].shape[0], s[1]) for s in sub]).astype(int)
    ps = np.cumsum([0] + [s[0].shape[0] for s in sub])
    cond = accuracy(params, Xs, ys, ps)
# 标签类型一致率（模型选择行动的类型是否正确）
def type_acc(param, groups_):
    ok = 0
    for g in groups_:
        X, lab = g[3], g[1]
        sc, _ = scores_of(param, X)
        pred = int(np.argmax(sc[:X.shape[0]]))
        def t(row):
            if row[19] == 1: return 'play'
            if row[20] == 1: return 'acquire'
            if row[21] == 1: return 'claim'
            if row[22] == 1: return 'rest'
            return '?'
        if t(X[pred]) == t(X[lab]):
            ok += 1
    return ok / len(groups_)

type_acc_val = type_acc(params, val)
out = {
    'schema': 'century-ai12-plan-distill-v1',
    'features': len(names) if names else D,
    'mean': mu.tolist(),
    'scale': sd.tolist(),
    'hidden': H,
    'weights1': params[0].tolist() if H > 0 else params[0].tolist(),
    'bias1': params[1].tolist() if H > 0 else None,
    'weights2': params[2].tolist() if H > 0 else None,
    'trainDecisions': Gtr,
    'valDecisions': Gva,
    'trainAcc': train_acc,
    'valAcc': val_acc,
    'valAccAllDecisions': val_acc * len(val) / max(1, len(val_all)),
    'valUnselectable': val_unselectable,
    'valTopRate': len(val) / max(1, len(val_all)),
    'valAccOnGreedyDisagreements': cond,
    'valTypeAcc': type_acc_val,
    'valLabelRate': float(np.mean([g[1] == 0 for g in val])),
}
with open(args.out, 'w') as f:
    json.dump(out, f, indent=2)
print(json.dumps({k: out[k] for k in ('features', 'trainDecisions', 'valDecisions', 'trainAcc', 'valAcc', 'valAccOnGreedyDisagreements', 'valTypeAcc', 'valLabelRate')}, indent=2))
