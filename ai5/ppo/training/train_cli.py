"""AI 5.0 训练入口（任务书 10 / 11）：断点恢复、对手池、检查点、指标落盘。

命令示例：
  # 冒烟训练（分钟级，验证全链路）
  python -m ai5.ppo.training.train_cli --config ai5/ppo/configs/smoke.json --out ai5/ppo/reports/smoke
  # 标准训练
  python -m ai5.ppo.training.train_cli --config ai5/ppo/configs/default.json --out ai5/ppo/reports/run-XXXX
  # 断点恢复
  python -m ai5.ppo.training.train_cli --config ... --resume ai5/ppo/reports/run-XXXX/last.pt --iterations 100
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

# P3 确定性：CPU 小模型的浮点归约顺序受线程调度影响，会让同一数据的 PPO
# 更新产生末位差异并放大为不同采样。训练入口强制单线程 + 关闭 oneDNN。
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
torch.set_num_threads(1)
try:
    torch.backends.mkldnn.enabled = False
except Exception:
    pass

PPO_ROOT = Path(__file__).resolve().parent.parent          # ai5/ppo
REPO_ROOT = PPO_ROOT.parent.parent                          # 仓库根
sys.path.insert(0, str(REPO_ROOT))

from ai5.ppo.env.vec_env import SeatSpec, VecEnv            # noqa: E402
from ai5.ppo.model.actor_critic import ActorCritic, resolve_device  # noqa: E402
from ai5.ppo.training.collector import (Collector, CollectorConfig,  # noqa: E402
                                        PolicyBundle, derive_rng)
from ai5.ppo.training.ppo import PPO                        # noqa: E402
from ai5.ppo.training.rollout import RolloutBuffer          # noqa: E402

CHECKPOINT_FORMAT = "ai5-ppo-checkpoint-v1"
DEFAULT_CONFIG_PATH = PPO_ROOT / "configs" / "default.json"


def git_sha() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT,
                              capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return "unknown"


def model_hash(model: torch.nn.Module) -> str:
    buf = io_bytes = None
    import io
    bio = io.BytesIO()
    torch.save(model.state_dict(), bio)
    return hashlib.sha256(bio.getvalue()).hexdigest()


def build_layout(cfg: dict) -> list[SeatSpec]:
    """席位布局（任务书第九节三种场景）。layout 数组每项：
    "learner" | "snapshot"（占位，派发时解析为池内具体快照） | "node:变体"。"""
    layout = []
    for item in cfg["seats"]["layout"]:
        if item == "learner":
            layout.append(SeatSpec.mlp("learner"))
        elif item == "snapshot":
            layout.append(SeatSpec.mlp("snapshot"))
        elif item == "snap":
            raise ValueError('"snap" 别名已废除（P1 对手池整改）：请改用 "snapshot" 占位')
        elif item.startswith("node:"):
            layout.append(SeatSpec.node(item.split(":", 1)[1]))
        else:
            raise ValueError(f"未知席位类型：{item}")
    if not (2 <= len(layout) <= 5):
        raise ValueError("席位布局必须 2–5 席（引擎约束）")
    n_learner = sum(1 for s in layout if s.policy_id == "learner")
    if n_learner == 0:
        raise ValueError("布局必须至少含 1 个 learner 席位")
    return layout


def default_config() -> dict:
    return json.loads(DEFAULT_CONFIG_PATH.read_text())


def merge_config(base: dict, override: dict) -> dict:
    out = json.loads(json.dumps(base))  # deep copy
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge_config(out[k], v)
        else:
            out[k] = v
    return out


def save_checkpoint(path: Path, model, optimizer, state: dict) -> None:
    payload = {
        "format": CHECKPOINT_FORMAT,
        "modelState": model.state_dict(),
        "optimizerState": optimizer.state_dict(),
        "modelHash": model_hash(model),
        "arch": model.arch_kwargs(),
        "versions": {
            "stateEncoding": "ai5-state-v1",
            "actionEncoding": "ai5-action-v1",
            "interface": "ai5-inference-v1",
        },
        # P1 整改：检查点携带完整随机源状态（旧版缺失 → 恢复后 randperm 等派生
        # 序列与连续训练分叉，无法逐位续训复现）。
        "rng": {
            "python": random.getstate(),
            "numpy": np.random.get_state(),
            "torch": torch.get_rng_state(),
        },
        **state,
    }
    tmp = path.with_suffix(".tmp")
    torch.save(payload, tmp)
    tmp.replace(path)


def load_checkpoint(path: Path, model, optimizer=None) -> dict:
    payload = torch.load(path, map_location="cpu", weights_only=False)
    if payload.get("format") != CHECKPOINT_FORMAT:
        raise ValueError(f"非 AI5 检查点格式：{payload.get('format')}")
    model.load_state_dict(payload["modelState"])
    if optimizer is not None and payload.get("optimizerState"):
        optimizer.load_state_dict(payload["optimizerState"])
    return payload


def restore_rng(payload: dict) -> bool:
    """恢复全局随机源；旧格式检查点无 rng 字段时返回 False（降级为重新播种）。"""
    rng = payload.get("rng")
    if not rng:
        return False
    random.setstate(rng["python"])
    np.random.set_state(rng["numpy"])
    torch.set_rng_state(rng["torch"])
    return True


class SnapshotPool:
    """learner 历史快照池（FIFO），供混合对手池场景使用。

    P1 整改（对手池真实生效）：
    - 旧实现经通用别名 "snap" 把所有快照席位指向最新快照——历史快照池形同虚设，
      对手池退化为单一策略；
    - 现在席位布局声明 "snapshot" 占位，派发对局时由 Collector 通过
      resolve_snapshot_seat 按策略（rotate 轮转/random/latest）解析为池内具体
      快照 id（如 snap-000010）——保留快照策略身份，绝不混入 learner 缓冲
      （rollout 按 policy_id ≠ learner 过滤）；
    - 每轮不同快照的实际出场次数由 Collector.metrics["opponentAppearances"] 记录。
    """

    def __init__(self, bundle: PolicyBundle, out_dir: Path, max_size: int):
        self.bundle = bundle
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.max_size = max_size
        self.ids: list[str] = []

    def push(self, snap_id: str, model) -> str:
        path = self.out_dir / f"{snap_id}.pt"
        torch.save({"format": CHECKPOINT_FORMAT, "modelState": model.state_dict(),
                    "arch": model.arch_kwargs()}, path)
        self.bundle.add_snapshot(snap_id, model.state_dict())
        self.ids.append(snap_id)
        while len(self.ids) > self.max_size:
            old = self.ids.pop(0)
            self.bundle.snapshots.pop(old, None)
            (self.out_dir / f"{old}.pt").unlink(missing_ok=True)
        return snap_id

    def push_initial(self, model) -> str:
        """初始（未训练）快照：保证 snapshot 席位从第一迭代起有对手。"""
        return self.push("snap-init", model)

    def push_iteration(self, iteration: int, model) -> str:
        return self.push(f"snap-{iteration:06d}", model)

    def snapshot_ids(self) -> list[str]:
        """当前池内快照 id（插入序 = 时间序，供轮转解析）。"""
        return list(self.ids)

    def restore(self, run_meta: dict) -> None:
        for snap_id in run_meta.get("snapshotIds", []):
            path = self.out_dir / f"{snap_id}.pt"
            if path.exists():
                payload = torch.load(path, map_location="cpu", weights_only=False)
                self.bundle.add_snapshot(snap_id, payload["modelState"])
                if snap_id not in self.ids:
                    self.ids.append(snap_id)
            else:
                print(f"警告：快照文件缺失，跳过 {snap_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Century AI 5.0 PPO 训练")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    parser.add_argument("--out", default=None, help="运行输出目录（默认 reports/run-<时间戳>）")
    parser.add_argument("--resume", default=None, help="断点恢复：last.pt 路径")
    parser.add_argument("--iterations", type=int, default=None, help="覆盖配置的迭代数")
    parser.add_argument("--time-budget-min", type=float, default=None, help="墙钟预算（分钟），到点安全退出")
    parser.add_argument("--smoke", action="store_true", help="冒烟模式（短迭代、小网络）")
    args = parser.parse_args()

    cfg = merge_config(default_config(), json.loads(Path(args.config).read_text()))
    if args.smoke:
        cfg = merge_config(cfg, json.loads((PPO_ROOT / "configs" / "smoke.json").read_text()))
    if args.iterations is not None:
        cfg["train"]["iterations"] = args.iterations
    time_budget_min = args.time_budget_min if args.time_budget_min is not None else cfg["train"].get("timeBudgetMin", 0)

    run_dir = Path(args.out) if args.out else PPO_ROOT / "reports" / f"run-{time.strftime('%Y%m%d-%H%M%S')}"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2))

    # —— 复现性：全部随机源显式播种 ——
    run_seed = int(cfg["train"]["runSeed"])
    random.seed(run_seed)
    np.random.seed(run_seed % (2**31))
    torch.manual_seed(run_seed)
    device = resolve_device(cfg["train"].get("device", "auto"))

    model_cfg = cfg["model"]
    model = ActorCritic(
        obs_dim=int(model_cfg["obsDim"]), act_dim=int(model_cfg["actDim"]),
        hidden=model_cfg["hidden"], activation=model_cfg.get("activation", "relu"),
    ).to(device)
    ppo = PPO(model, cfg["ppo"], device)

    layout = build_layout(cfg)
    bundle = PolicyBundle(model, device)
    snapshot_cfg = cfg["seats"].get("snapshots", {})
    snap_pool = SnapshotPool(bundle, run_dir / "snapshots", int(snapshot_cfg.get("poolSize", 4)))

    iteration_start = 0
    totals = {"games": 0, "anomaly_games": 0, "decisions": 0, "pruned_decisions": 0, "updates": 0}
    resume_meta = None
    if args.resume:
        resume_meta = load_checkpoint(Path(args.resume), model, ppo.optimizer)
        iteration_start = int(resume_meta["iteration"]) + 1
        totals.update({k: int(resume_meta["totals"].get(k, 0)) for k in totals})
        if model_hash(model) != resume_meta.get("modelHash"):
            raise RuntimeError("恢复后模型哈希不一致——检查点损坏")
        rng_ok = restore_rng(resume_meta)
        print(f"已恢复迭代 {resume_meta['iteration']}（decisions={totals['decisions']}）"
              + ("" if rng_ok else "；警告：旧格式检查点无随机源状态，全局 RNG 重新播种"
                                    "（逐位续训确定性不保证，模型/优化器/计数器已恢复）"))

    env = VecEnv(
        workers=int(cfg["env"]["workers"]), max_moves=int(cfg["env"]["maxMoves"]),
        deadline_ms=int(cfg["env"]["deadlineMs"]), max_candidates=int(cfg["env"]["maxCandidates"]),
        seed_salt=run_seed,
    )
    buffer = RolloutBuffer(gamma=float(cfg["ppo"]["gamma"]), gae_lambda=float(cfg["ppo"]["gaeLambda"]))
    collector = Collector(
        env, bundle, buffer, run_seed=run_seed, layout=layout,
        cfg=CollectorConfig(workers=int(cfg["env"]["workers"]),
                            batch_wait_ms=float(cfg["env"].get("batchWaitMs", 4.0)),
                            max_candidates=int(cfg["env"]["maxCandidates"]),
                            snapshot_sampling=str(snapshot_cfg.get("sampling", "rotate"))),
        reward_cfg=cfg["reward"],
        snapshot_ids_provider=snap_pool.snapshot_ids,
    )
    if resume_meta:
        # P1 整改：快照池与计数器/累计指标恢复（旧版从未调用 restore，
        # 训练种子从头重放、对手池丢失历史快照）。
        snap_pool.restore(resume_meta)
        collector.restore_state(
            int(resume_meta.get("gameCounter", 0)), int(resume_meta.get("decisionCounter", 0)),
            metrics=resume_meta.get("collectorMetrics"), buffer_stats=resume_meta.get("bufferStats"),
        )

    metrics_path = run_dir / "metrics.jsonl"
    if iteration_start == 0:
        # 初始（未训练）检查点：作为独立竞技的"未训练 MLP 基线"。
        save_checkpoint(run_dir / "init.pt", model, ppo.optimizer, {
            "iteration": -1, "totals": totals, "runSeed": run_seed,
            "gitSha": git_sha(), "config": cfg,
        })
    if any(s.policy_id == "snapshot" for s in layout):
        # 初始快照（resume 时由 restore 提供历史池，不重复 push）。
        if not snap_pool.ids:
            snap_pool.push_initial(model)
        else:
            print(f"快照池已从检查点恢复：{snap_pool.ids}")

    iterations = int(cfg["train"]["iterations"])
    deadline = time.time() + time_budget_min * 60 if time_budget_min else None
    snapshot_every = int(snapshot_cfg.get("every", 0))
    log_every = max(1, int(cfg["train"].get("logEvery", 1)))

    print(f"开始训练：device={device} workers={cfg['env']['workers']} "
          f"模型={model_cfg['hidden']} 参数量={model.num_parameters():,} 布局={[s.kind + ':' + (s.variant or s.policy_id) for s in layout]}")

    prev_metrics = dict(collector.metrics)
    interrupted = False

    def write_last_checkpoint(it: int) -> None:
        """P1 整改：检查点只保存在排水后的迭代边界（collect 末尾已无在途对局），
        携带完整可恢复状态——模型/优化器/三套 RNG/计数器/快照池/累计统计。"""
        save_checkpoint(run_dir / "last.pt", model, ppo.optimizer, {
            "iteration": it, "totals": totals, "runSeed": run_seed,
            "gitSha": git_sha(), "config": cfg,
            "snapshotIds": list(snap_pool.ids),
            "gameCounter": collector.game_counter,
            "decisionCounter": collector.decision_counter,
            "collectorMetrics": {k: v for k, v in collector.metrics.items()},
            "bufferStats": dict(buffer.stats),
            "policyEpoch": buffer.policy_epoch,
        })

    for it in range(iteration_start, iterations):
        if deadline and time.time() > deadline:
            print(f"达到墙钟预算，安全退出于迭代 {it}")
            interrupted = True
            write_last_checkpoint(it - 1)  # 上一迭代边界即当前状态（本迭代未开始）
            break
        t0 = time.perf_counter()
        # P1 整改：策略世代递增 + 采集末尾排水（collect 内部实现）——
        # 保证本迭代更新批内每条轨迹都完全由当前策略采集。
        buffer.policy_epoch = it + 1
        collect_metrics = collector.collect(target_learner_decisions=int(cfg["train"]["rolloutSteps"]),
                                            max_wall_s=float(cfg["train"].get("collectWallMaxS", 900)))
        collect_s = time.perf_counter() - t0

        trajs = buffer.compute_gae()
        n_samples = sum(len(t["actions"]) for t in trajs)
        if os.environ.get("PPO_DEBUG_TRACE"):
            import hashlib
            h = hashlib.sha256()
            for t in trajs:
                for key in ("obs", "cand_flat", "cand_counts", "actions", "old_logp", "values"):
                    h.update(np.ascontiguousarray(t[key]).tobytes())
            print(f"PPO_TRACE it={it} traj_sha={h.hexdigest()} trajs={len(trajs)} samples={n_samples}", flush=True)
        update_metrics = ppo.update(trajs, progress=it / max(1, iterations)) if n_samples >= 8 else {"skipped": "few"}
        totals["updates"] += 1 if "skipped" not in update_metrics else 0

        # 快照入池。
        snapshot_id = None
        if snapshot_every and (it + 1) % snapshot_every == 0 and "snapshot" in [s.policy_id for s in layout]:
            snapshot_id = snap_pool.push_iteration(it, model)

        # 累计指标（差分）。
        for key in ("games", "anomaly_games", "decisions", "pruned_decisions"):
            src = {"games": "games", "anomaly_games": "anomaly_games", "decisions": "learner_decisions",
                   "pruned_decisions": "pruned_decisions"}[key]
            totals[key] = collector.metrics[src]
        decisions = collector.metrics["learner_decisions"]
        record = {
            "iteration": it, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "collectS": round(collect_s, 2),
            "decisionsTotal": decisions,
            "decisionsPerS": round((decisions - prev_metrics.get("learner_decisions", 0)) / max(1e-6, collect_s), 1),
            "gamesTotal": collector.metrics["games"],
            "anomalyRate": round(collector.metrics["anomaly_games"] / max(1, collector.metrics["games"]), 4),
            "samples": update_metrics.get("samples", n_samples),
            "policyLoss": update_metrics.get("policyLoss"),
            "valueLoss": update_metrics.get("valueLoss"),
            "entropy": update_metrics.get("entropy"),
            "approxKl": update_metrics.get("approxKl"),
            "clipFrac": update_metrics.get("clipFrac"),
            "gradNorm": update_metrics.get("gradNorm"),
            "nanSkips": update_metrics.get("nanSkips", 0),
            "updateMs": update_metrics.get("updateMs"),
            "lr": ppo.base_lr * ppo.lr_scale(it / max(1, iterations)),
            "nodeDecisionMs": round(collector.metrics["node_decision_ms_sum"] / max(1, collector.metrics["node_decision_count"]), 2),
            "mlpRoundtripMs": round(collector.metrics["mlp_roundtrip_ms_sum"] / max(1, collector.metrics["mlp_roundtrip_count"]), 2),
            "enumMeanFull": round(collector.metrics["enum_full_sum"] / max(1, collector.metrics["enum_decisions"]), 1),
            "enumMeanKept": round(collector.metrics["enum_kept_sum"] / max(1, collector.metrics["enum_decisions"]), 1),
            "enumPrunedFrac": round(collector.metrics["pruned_decisions"] / max(1, collector.metrics["enum_decisions"]), 4),
            "rssMb": round(env.rss_mb(), 1),
            "snapshot": snapshot_id,
            "staleDiscarded": collect_metrics.get("stale_discarded", 0),
            "opponentAppearances": collect_metrics.get("opponentAppearances", {}),
        }
        prev_metrics = dict(collector.metrics)
        with metrics_path.open("a") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        if (it + 1) % log_every == 0 or it == iterations - 1:
            print(json.dumps(record, ensure_ascii=False))
        if os.environ.get("PPO_DEBUG_TRACE"):
            print(f"PPO_TRACE it={it} model_sha={model_hash(model)}", flush=True)

        # 周期性断点（last.pt 覆盖写；best 由独立评估产出，绝不覆盖）。
        if (it + 1) % int(cfg["train"].get("checkpointEvery", 5)) == 0 or it == iterations - 1:
            write_last_checkpoint(it)

    env.close()
    summary = {
        "run": str(run_dir), "iterationsDone": totals["updates"], "interrupted": interrupted,
        "totals": totals, "gitSha": git_sha(), "runSeed": run_seed,
        "device": str(device), "params": model.num_parameters(),
        "config": cfg,
        "modelVersions": {"stateEncoding": "ai5-state-v1", "actionEncoding": "ai5-action-v1",
                          "interface": "ai5-inference-v1", "modelHash": model_hash(model)},
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print("训练结束：", run_dir / "summary.json")


if __name__ == "__main__":
    main()
