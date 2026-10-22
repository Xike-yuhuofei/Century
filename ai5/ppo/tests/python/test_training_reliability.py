"""AI5 训练可靠性测试（P1 整改验收）：对手池轮换、on-policy 边界、断点恢复。

运行：~/century-ai5-env/bin/python -m unittest ai5.ppo.tests.python.test_training_reliability -v
（最后一组为真实 Node worker 的端到端确定性测试，运行约 1-2 分钟。）
"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))

from ai5.ppo.env.vec_env import SeatSpec  # noqa: E402
from ai5.ppo.model.actor_critic import ActorCritic  # noqa: E402
from ai5.ppo.training.collector import (CollectorConfig, PolicyBundle,  # noqa: E402
                                        resolve_snapshot_seat)
from ai5.ppo.training.rollout import RolloutBuffer  # noqa: E402
from ai5.ppo.training.train_cli import (SnapshotPool, load_checkpoint,  # noqa: E402
                                        restore_rng, save_checkpoint)


class _FakeRequest:
    def __init__(self, game_id, seat, obs_dim=8, act_dim=6, n_cand=3):
        self.game_id = game_id
        self.seat = seat
        self.obs = np.zeros(obs_dim, dtype=np.float32)
        self.cand_mat = np.zeros((n_cand, act_dim), dtype=np.float32)
        self.n_candidates = n_cand
        self.enum_stats = {}
        self.turn_number = 1


class TestSnapshotPoolRotation(unittest.TestCase):
    """P1 任务 4：历史快照真实轮换（旧实现 "snap" 别名永远指向最新快照）。"""

    def test_rotate_covers_all_snapshots(self):
        ids = ["snap-init", "snap-000010", "snap-000020", "snap-000030"]
        picks = [resolve_snapshot_seat(ids, i, 2026, "rotate") for i in range(8)]
        # 轮转：4 个快照各出现 2 次，出场均匀（防止对手池退化为单一策略）。
        for sid in ids:
            self.assertEqual(picks.count(sid), 2, f"{sid} 出场次数不为 2：{picks}")

    def test_random_is_deterministic_and_within_pool(self):
        a = [resolve_snapshot_seat(["x", "y", "z"], i, 7, "random") for i in range(20)]
        b = [resolve_snapshot_seat(["x", "y", "z"], i, 7, "random") for i in range(20)]
        self.assertEqual(a, b)
        self.assertTrue(set(a) <= {"x", "y", "z"})

    def test_latest_matches_legacy_behavior(self):
        ids = ["snap-init", "snap-000010"]
        self.assertEqual(resolve_snapshot_seat(ids, 0, 1, "latest"), "snap-000010")

    def test_empty_pool_raises(self):
        with self.assertRaises(RuntimeError):
            resolve_snapshot_seat([], 0, 1, "rotate")

    def test_pool_push_evict_restore_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            model = ActorCritic(8, 6, hidden=(8,))
            bundle = PolicyBundle(model, torch.device("cpu"))
            pool = SnapshotPool(bundle, Path(td) / "snapshots", max_size=2)
            model2 = ActorCritic(8, 6, hidden=(8,))
            with torch.no_grad():
                for p in model2.parameters():
                    p.add_(1.0)
            pool.push_initial(model)
            pool.push_iteration(10, model2)
            self.assertEqual(pool.ids, ["snap-init", "snap-000010"])
            pool.push_iteration(20, model)  # 淘汰 snap-init（FIFO）
            self.assertEqual(pool.ids, ["snap-000010", "snap-000020"])
            self.assertNotIn("snap-init", bundle.snapshots, "淘汰快照必须同步移出 bundle")
            # 恢复：ids 顺序 = 插入序（时间序），轮转语义可复现。
            pool2 = SnapshotPool(bundle, Path(td) / "snapshots", max_size=2)
            pool2.restore({"snapshotIds": ["snap-000010", "snap-000020"]})
            self.assertEqual(pool2.ids, ["snap-000010", "snap-000020"])
            self.assertEqual(resolve_snapshot_seat(pool2.snapshot_ids(), 0, 1, "rotate"), "snap-000010")


class TestOnPolicyBoundary(unittest.TestCase):
    """P1 任务 3：跨迭代未完成对局的策略混染防御。"""

    def _finish(self, buf, game_id, seats, scores=(10, 0, 0, 0, 0)):
        buf.finish_game(game_id, seats, list(scores), None, 0, "finished", {"mode": "win_loss"}, "learner")

    def test_mixed_epoch_trajectory_discarded(self):
        buf = RolloutBuffer()
        seats = [SeatSpec.mlp("learner")] + [SeatSpec.node("champion")] * 4
        buf.policy_epoch = 1
        buf.add_decision(_FakeRequest(1, 0), "learner", 0, -1.0, 0.0)
        buf.policy_epoch = 2  # 模拟策略更新后同一对局仍在进行（排水边界被绕过）
        buf.add_decision(_FakeRequest(1, 0), "learner", 0, -1.0, 0.0)
        self._finish(buf, 1, seats)
        self.assertEqual(buf.compute_gae(), [], "混代轨迹必须整体丢弃，不得进入 PPO 更新")
        self.assertEqual(buf.stats["stale_discarded"], 2)

    def test_pure_epoch_trajectory_kept(self):
        buf = RolloutBuffer()
        seats = [SeatSpec.mlp("learner")] + [SeatSpec.node("champion")] * 4
        buf.policy_epoch = 3
        for i in range(3):
            buf.add_decision(_FakeRequest(1, 0), "learner", 0, -1.0, 0.0)
        self._finish(buf, 1, seats)
        trajs = buf.compute_gae()
        self.assertEqual(len(trajs), 1)
        self.assertEqual(buf.stats["stale_discarded"], 0)

    def test_snapshot_identity_never_enters_learner_buffer(self):
        """P1 任务 4：快照席位轨迹保留自身身份，绝不混入 learner 训练缓冲。"""
        buf = RolloutBuffer()
        seats = [SeatSpec.mlp("learner"), SeatSpec.mlp("snap-000010"), SeatSpec.mlp("snap-000020"),
                 SeatSpec.node("champion"), SeatSpec.node("neutral")]
        buf.add_decision(_FakeRequest(1, 0), "learner", 0, -1.0, 0.0)
        buf.add_decision(_FakeRequest(1, 1), "snap-000010", 0, -1.0, 0.0)
        buf.add_decision(_FakeRequest(1, 2), "snap-000020", 0, -1.0, 0.0)
        self._finish(buf, 1, seats)
        trajs = buf.compute_gae()
        self.assertEqual(len(trajs), 1, "只有 learner 轨迹进入缓冲")
        self.assertEqual(len(trajs[0]["actions"]), 1)


class TestAuxRewardChain(unittest.TestCase):
    """P1 任务 5：辅助奖励启用后的终局结算调用链（claimed 从协议回传）。"""

    def test_finish_game_full_uses_claimed(self):
        from ai5.ppo.training.rewards import auxiliary_reward
        buf = RolloutBuffer()
        seats = [SeatSpec.mlp("learner")] + [SeatSpec.node("champion")] * 4
        buf.policy_epoch = 1
        for _ in range(2):
            buf.add_decision(_FakeRequest(1, 0), "learner", 0, -1.0, 0.0)
        cfg = {"mode": "win_loss", "aux": {"golemProgress": 1.0, "threshold": 5}}
        final_states = [{"claimed": 3, "score": 10, "turns": 20}] + [{"claimed": 0}] * 4
        buf.finish_game_full(1, seats, [10, 0, 0, 0, 0], None, 0, "finished", cfg, "learner", final_states)
        t = buf.compute_gae()[0]
        # 终局奖励 1.0（第一名 win_loss）+ 辅助 min(1, 3/5) = 0.6。
        self.assertAlmostEqual(t["returns"][-1], 1.0 + auxiliary_reward(final_states[0], cfg["aux"]), places=6)

    def test_aux_enabled_requires_full_settlement(self):
        buf = RolloutBuffer()
        seats = [SeatSpec.mlp("learner")] + [SeatSpec.node("champion")] * 4
        buf.add_decision(_FakeRequest(1, 0), "learner", 0, -1.0, 0.0)
        with self.assertRaises(ValueError):
            buf.finish_game(1, seats, [10, 0, 0, 0, 0], None, 0, "finished",
                            {"mode": "win_loss", "aux": {"golemProgress": 0.5}}, "learner")


class TestCheckpointRngRoundTrip(unittest.TestCase):
    """P1 任务 3：随机源状态随检查点保存/恢复（randperm 序列逐位复现）。"""

    def test_torch_rng_restored_exactly(self):
        torch.manual_seed(123)
        with tempfile.TemporaryDirectory() as td:
            model = ActorCritic(8, 6, hidden=(8,))
            ppo_like_opt = torch.optim.Adam(model.parameters(), lr=1e-3)
            path = Path(td) / "c.pt"
            save_checkpoint(path, model, ppo_like_opt, {"iteration": 3})
            # 消耗 torch RNG（模拟 PPO update 的 randperm）。
            perm_a = torch.randperm(100)
            # 新进程式恢复：重新播种 + 加载检查点。
            torch.manual_seed(999)
            perm_wrong = torch.randperm(100)  # 未恢复时的序列
            payload = load_checkpoint(path, model, ppo_like_opt)
            self.assertTrue(restore_rng(payload))
            perm_b = torch.randperm(100)
            self.assertTrue(torch.equal(perm_a, perm_b), "恢复后 torch RNG 序列必须逐位一致")
            self.assertFalse(torch.equal(perm_a, perm_wrong))

    def test_legacy_checkpoint_without_rng_degrades_gracefully(self):
        torch.manual_seed(5)
        model = ActorCritic(8, 6, hidden=(8,))
        opt = torch.optim.Adam(model.parameters(), lr=1e-3)
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "legacy.pt"
            torch.save({"format": "ai5-ppo-checkpoint-v1", "modelState": model.state_dict(),
                        "optimizerState": opt.state_dict(), "iteration": 2}, path)
            payload = load_checkpoint(path, model, opt)
            self.assertFalse(restore_rng(payload), "旧格式（无 rng 字段）应返回 False 并降级")


class TestResumeDeterminismE2E(unittest.TestCase):
    """P1 任务 3 端到端验收：连续训练 vs 中断恢复——参数、行动序列、计数器逐位一致。

    真实 Node worker、真实引擎、真实冠军对手。CPU 设备、单 worker 保证确定性。
    """

    def test_resume_matches_continuous_run(self):
        venv_python = "/Users/xike/century-ai5-env/bin/python"
        if not Path(venv_python).exists():
            venv_python = sys.executable
        cfg = {
            "train": {"iterations": 4, "rolloutSteps": 24, "runSeed": 777001, "device": "cpu",
                      "checkpointEvery": 1, "logEvery": 1, "collectWallMaxS": 120},
            "env": {"workers": 1, "maxMoves": 800, "deadlineMs": 30000, "maxCandidates": 512,
                    "batchWaitMs": 2.0},
            "model": {"obsDim": 1419, "actDim": 84, "hidden": [16, 16], "activation": "relu"},
            "ppo": {"lr": 0.001, "epochs": 2, "minibatch": 64, "gamma": 0.999, "gaeLambda": 0.95,
                    "targetKl": 0.05},
            "reward": {"mode": "win_loss", "aux": {}},
            "seats": {"layout": ["learner", "node:champion", "node:champion", "node:champion", "node:champion"],
                      "snapshots": {"every": 0, "poolSize": 2}},
            "eval": {"every": 0, "games": 10},
        }
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            cfg_path = base / "cfg.json"
            cfg_path.write_text(json.dumps(cfg))
            run_continuous = base / "continuous"
            run_interrupted = base / "interrupted"

            def run(args):
                proc = subprocess.run(
                    [venv_python, "-m", "ai5.ppo.training.train_cli", "--config", str(cfg_path), *args],
                    cwd=str(REPO), capture_output=True, text=True, timeout=900)
                if proc.returncode != 0:
                    raise RuntimeError(f"train_cli 失败：{proc.stdout[-1500:]}\n{proc.stderr[-1500:]}")
                return proc

            # 连续 4 迭代。
            run(["--out", str(run_continuous)])
            # 2 迭代中断 → 恢复续 4 迭代。
            run(["--out", str(run_interrupted), "--iterations", "2"])
            run(["--out", str(run_interrupted), "--resume", str(run_interrupted / "last.pt")])

            summary_c = json.loads((run_continuous / "summary.json").read_text())
            summary_r = json.loads((run_interrupted / "summary.json").read_text())
            hash_c = summary_c["modelVersions"]["modelHash"]
            hash_r = summary_r["modelVersions"]["modelHash"]
            self.assertEqual(hash_c, hash_r,
                             "中断恢复后的最终模型必须与连续训练逐位一致")
            self.assertEqual(summary_c["totals"]["decisions"], summary_r["totals"]["decisions"])
            self.assertEqual(summary_c["totals"]["games"], summary_r["totals"]["games"])
            self.assertEqual(summary_c["totals"]["updates"], summary_r["totals"]["updates"], 4)
            # 行动序列一致性：逐迭代指标（除耗时/时间戳外）必须一致。
            metrics_c = [json.loads(l) for l in (run_continuous / "metrics.jsonl").read_text().splitlines()]
            metrics_r = [json.loads(l) for l in (run_interrupted / "metrics.jsonl").read_text().splitlines()]
            self.assertEqual(len(metrics_c), len(metrics_r))
            keys = ("iteration", "decisionsTotal", "gamesTotal", "samples", "entropy")
            for mc, mr in zip(metrics_c, metrics_r):
                for k in keys:
                    self.assertEqual(mc[k], mr[k],
                                     f"迭代 {mc['iteration']} 字段 {k} 不一致：{mc[k]} vs {mr[k]}")


if __name__ == "__main__":
    unittest.main()
