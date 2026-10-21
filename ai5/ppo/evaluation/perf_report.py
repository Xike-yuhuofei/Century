"""AI 5.0 性能评测（任务书 14 第四阶段 / 10）。

实测项：
1. torch 单次/批量前向耗时（MPS vs CPU）；
2. TS 单次决策推理耗时（导出模型，复用一致性 fixtures 或现场生成）；
3. 完整对局吞吐：全冠军布局 vs learner 混合布局（局/小时、决策/秒）；
4. 内存占用（Python + Node worker RSS）。
不能把纯 MLP 训练基准当作 PPO 端到端性能（任务书第十节）。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from ai5.ppo.env.vec_env import SeatSpec, VecEnv  # noqa: E402
from ai5.ppo.model.actor_critic import ActorCritic, resolve_device  # noqa: E402
from ai5.ppo.training.collector import Collector, CollectorConfig, PolicyBundle, LEARNER_POLICY  # noqa: E402
from ai5.ppo.training.rollout import RolloutBuffer  # noqa: E402

TS_LATENCY_SCRIPT = REPO / "ai5" / "ppo" / "tests" / "node" / "export-fixtures.mjs"


def bench_torch_forward(model: ActorCritic, device: torch.device) -> dict:
    out = {}
    for batch in (1, 64, 512):
        obs = torch.randn(batch, model.obs_dim, device=device)
        n_cand = 16
        cand = torch.randn(batch * n_cand, model.act_dim, device=device)
        seg = torch.arange(batch, device=device).repeat_interleave(n_cand)
        for _ in range(5):
            with torch.no_grad():
                model.evaluate(obs, cand, seg)
        if device.type == "mps":
            torch.mps.synchronize()
        t0 = time.perf_counter()
        reps = 50 if batch == 1 else 10
        for _ in range(reps):
            with torch.no_grad():
                model.evaluate(obs, cand, seg)
        if device.type == "mps":
            torch.mps.synchronize()
        out[f"forward_b{batch}_ms"] = round((time.perf_counter() - t0) / reps * 1000, 3)
    return out


def bench_ts_inference(checkpoint: Path) -> dict:
    import base64
    from ai5.ppo.evaluation.export_weights import export_checkpoint
    tmp = Path("/tmp") / f"ai5-perf-{time.time_ns()}.json"
    export_checkpoint(checkpoint, tmp)
    fixtures = Path("/tmp") / f"ai5-perf-fixtures-{time.time_ns()}.json"
    result = subprocess.run(
        ["node", str(TS_LATENCY_SCRIPT), str(tmp), str(fixtures), "25"],
        cwd=REPO, capture_output=True, text=True, timeout=180,
    )
    if result.returncode != 0:
        return {"error": result.stderr[-300:]}
    data = json.loads(fixtures.read_text())
    lat = [s["tsInferMs"] for s in data["states"]]
    tmp.unlink(missing_ok=True)
    fixtures.unlink(missing_ok=True)
    return {
        "tsSingleDecisionMs_mean": round(sum(lat) / len(lat), 3),
        "tsSingleDecisionMs_max": round(max(lat), 3),
    }


def bench_game_throughput(hidden, device, workers: int, wall_s: float) -> dict:
    results = {}
    for name, layout in (
        ("all_champion", [SeatSpec.node("champion")] * 5),
        ("learner_mixed", [SeatSpec.mlp(LEARNER_POLICY), SeatSpec.mlp(LEARNER_POLICY),
                           SeatSpec.node("champion"), SeatSpec.node("champion"), SeatSpec.node("neutral")]),
    ):
        model = ActorCritic(1419, 84, hidden=hidden).to(device)
        bundle = PolicyBundle(model, device)
        buffer = RolloutBuffer()
        env = VecEnv(workers=workers, seed_salt=42)
        try:
            col = Collector(env, bundle, buffer, run_seed=99, layout=layout,
                            cfg=CollectorConfig(workers=workers, batch_wait_ms=2.0))
            # 预热（JIT + 管道填充）。
            col.collect(target_learner_decisions=40 if name == "learner_mixed" else 1, max_wall_s=30)
            base_games = col.metrics["games"]
            t0 = time.perf_counter()
            col.collect(target_learner_decisions=10**9, max_wall_s=wall_s)
            dt = time.perf_counter() - t0
            games = col.metrics["games"] - base_games
            results[name] = {
                "games": games,
                "gamesPerHour": round(games / dt * 3600, 1),
                "wallS": round(dt, 1),
                "learnerDecisions": col.metrics["learner_decisions"],
            }
        finally:
            env.close()
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="AI 5.0 性能评测")
    parser.add_argument("--checkpoint", default=None, help="用于 TS 推理延迟的检查点")
    parser.add_argument("--wall-s", type=float, default=20, help="每种布局的吞吐采样时长")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    device = resolve_device("auto")
    model = ActorCritic(1419, 84, hidden=(256, 256, 256)).to(device)
    report = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "device": str(device),
        "torch": bench_torch_forward(model, device),
        "params": model.num_parameters(),
    }
    if args.checkpoint:
        report["tsInference"] = bench_ts_inference(Path(args.checkpoint))
    report["throughput"] = bench_game_throughput((256, 256, 256), device, args.workers, args.wall_s)
    report["throughputSmallNet"] = bench_game_throughput((128, 128), device, args.workers, max(8, args.wall_s / 2))
    # 内存快照（训练进程组之外的单实例量级）。
    report["pythonRssMb"] = round(int(subprocess.run(["ps", "-o", "rss=", "-p", str(__import__("os").getpid())],
                                                    capture_output=True, text=True).stdout.strip() or 0) / 1024, 1)
    out = Path(args.out) if args.out else REPO / "ai5" / "ppo" / "reports" / f"perf-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
