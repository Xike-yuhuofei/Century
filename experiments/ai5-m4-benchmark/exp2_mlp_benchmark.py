#!/usr/bin/env python3
"""AI 5.0 小型 MLP 训练基准（任务二）：CPU 与 MPS 对比。

架构（隐藏层 × 单元）：2×128、3×256、4×256；输入 256 维状态向量、输出 128 维动作 logits
（与 Century 离散动作空间的策略网络量级一致）。
测量口径：预热后重复测量，MPS 每个测量窗口末尾同步；分别报告前向、完整训练步（前向+反向+优化器）
吞吐，以及逐相位分解（前向/反向/优化器步）。不编造数据，全部实测。

运行：~/century-ai5-env/bin/python exp2_mlp_benchmark.py
"""

import json
import resource
import statistics
import sys
import time
from pathlib import Path

import torch

RESULTS_DIR = Path(__file__).resolve().parent / "results"

ARCHS = {
    "2x128": [128, 128],
    "3x256": [256, 256, 256],
    "4x256": [256, 256, 256, 256],
}
BATCH_SIZES = [64, 128, 256, 512]
IN_FEATURES = 256
OUT_FEATURES = 128
WARMUP_ITERS = 10
MEASURE_ITERS = 30
REPEATS = 3
PHASE_ITERS = 10


def build_model(hidden: list[int], device: torch.device) -> torch.nn.Module:
    layers: list[torch.nn.Module] = []
    prev = IN_FEATURES
    for h in hidden:
        layers += [torch.nn.Linear(prev, h), torch.nn.ReLU()]
        prev = h
    layers.append(torch.nn.Linear(prev, OUT_FEATURES))
    torch.manual_seed(42)
    return torch.nn.Sequential(*layers).to(device)


def sync(device: torch.device) -> None:
    if device.type == "mps":
        torch.mps.synchronize()


def timed_window(fn, iters: int, device: torch.device) -> float:
    """测量一个窗口的平均单次耗时（ms）。窗口末尾统一同步。"""
    sync(device)
    t0 = time.perf_counter()
    for _ in range(iters):
        fn()
    sync(device)
    return (time.perf_counter() - t0) / iters * 1000


def phase_breakdown(model, opt, x, device: torch.device) -> dict:
    """逐相位测量：每次迭代内部在前向/反向/优化器步之间同步。
    含逐相位同步开销，仅用于相对占比参考，绝对值以窗口口径为准。"""
    fwd_ts, bwd_ts, opt_ts = [], [], []
    target = torch.zeros(x.shape[0], OUT_FEATURES, device=device)
    for _ in range(PHASE_ITERS):
        sync(device); t0 = time.perf_counter()
        out = model(x)
        loss = torch.nn.functional.mse_loss(out, target)
        sync(device); fwd_ts.append(time.perf_counter() - t0)

        opt.zero_grad(set_to_none=True)
        sync(device); t0 = time.perf_counter()
        loss.backward()
        sync(device); bwd_ts.append(time.perf_counter() - t0)

        t0 = time.perf_counter()
        opt.step()
        sync(device); opt_ts.append(time.perf_counter() - t0)
    return {
        "fwd_ms": statistics.mean(fwd_ts) * 1000,
        "bwd_ms": statistics.mean(bwd_ts) * 1000,
        "opt_ms": statistics.mean(opt_ts) * 1000,
    }


def bench_one(arch_name: str, hidden: list[int], batch: int, device: torch.device) -> dict:
    model = build_model(hidden, device)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4)
    torch.manual_seed(42)
    x = torch.randn(batch, IN_FEATURES, device=device)
    target = torch.zeros(batch, OUT_FEATURES, device=device)

    def train_step():
        out = model(x)
        loss = torch.nn.functional.mse_loss(out, target)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()

    # 预热
    for _ in range(WARMUP_ITERS):
        train_step()
    sync(device)

    fwd_ms_all, step_ms_all, breakdowns = [], [], []
    mps_before = torch.mps.driver_allocated_memory() if device.type == "mps" else 0
    for _ in range(REPEATS):
        # 前向窗口（无优化器步）
        model.eval()
        fwd_ms_all.append(timed_window(lambda: model(x), MEASURE_ITERS, device))
        model.train()
        # 完整训练步窗口
        step_ms_all.append(timed_window(train_step, MEASURE_ITERS, device))
        # 逐相位分解
        breakdowns.append(phase_breakdown(model, opt, x, device))
    mps_after = torch.mps.driver_allocated_memory() if device.type == "mps" else 0

    def ms_stats(v): return {"mean": round(statistics.mean(v), 3), "stdev": round(statistics.stdev(v), 3) if len(v) > 1 else 0.0}

    fwd_mean = statistics.mean(fwd_ms_all)
    step_mean = statistics.mean(step_ms_all)
    return {
        "arch": arch_name,
        "batch": batch,
        "device": device.type,
        "forward_ms": ms_stats(fwd_ms_all),
        "train_step_ms": ms_stats(step_ms_all),
        "derived_backward_ms": round(step_mean - fwd_mean, 3),
        "train_throughput_samples_per_s": round(batch / (step_mean / 1000), 0),
        "phase_breakdown_mean_ms": {k: round(statistics.mean(b[k] for b in breakdowns), 3) for k in ("fwd_ms", "bwd_ms", "opt_ms")},
        "mps_driver_mem_mb": {"before": round(mps_before / 1e6, 1), "after": round(mps_after / 1e6, 1)},
    }


def main() -> None:
    assert torch.backends.mps.is_available(), "MPS 不可用，无法进行对比"
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    total = len(ARCHS) * len(BATCH_SIZES) * 2
    done = 0
    rss0 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    for arch_name, hidden in ARCHS.items():
        for batch in BATCH_SIZES:
            for device in (torch.device("cpu"), torch.device("mps")):
                r = bench_one(arch_name, hidden, batch, device)
                results.append(r)
                done += 1
                print(f"[{done}/{total}] {arch_name} batch={batch:>3} {r['device']:>3}: "
                      f"fwd {r['forward_ms']['mean']:.2f}ms, step {r['train_step_ms']['mean']:.2f}ms, "
                      f"{r['train_throughput_samples_per_s']:.0f} samples/s")
    rss1 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS 上 ru_maxrss 单位为字节，Linux 为 KB；统一换算为 MB
    peak_rss_mb = max(rss0, rss1) / (1024 * 1024) if sys.platform == "darwin" else max(rss0, rss1) / 1024

    summary = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "torch": torch.__version__,
        "protocol": {
            "warmup_iters": WARMUP_ITERS, "measure_iters": MEASURE_ITERS, "repeats": REPEATS,
            "sync": "每个测量窗口末尾 torch.mps.synchronize()；窗口内不同步以反映真实吞吐",
            "loss": "MSE（回归式训练步）；优化器 AdamW lr=3e-4",
        },
        "host_peak_rss_mb": round(peak_rss_mb, 1),
        "results": results,
    }
    out = RESULTS_DIR / "mlp_benchmark.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"结果已写入: {out}")


if __name__ == "__main__":
    main()
