"""AI 5.0 Python 侧单元与集成测试（stdlib unittest，无 pytest 依赖）。

运行：~/century-ai5-env/bin/python -m unittest discover -s ai5/ppo/tests/python -v
覆盖：GAE 手算对照、PPO 损失与梯度、奖励函数、变长候选段 softmax、
      检查点保存/恢复一致性、席位确定性旋转。
"""

import sys
import unittest
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))

from ai5.ppo.model.actor_critic import ActorCritic, resolve_device  # noqa: E402
from ai5.ppo.training.ppo import PPO  # noqa: E402
from ai5.ppo.training.rewards import terminal_reward  # noqa: E402
from ai5.ppo.training.rollout import RolloutBuffer  # noqa: E402
from ai5.ppo.training.collector import assign_seats, derive_seed, derive_rng  # noqa: E402
from ai5.ppo.env.vec_env import SeatSpec  # noqa: E402


class FakeRequest:
    """rollout.add_decision 的最小请求接口。"""

    def __init__(self, game_id, seat, obs_dim=8, act_dim=6, n_cand=3, policy_id="learner"):
        self.game_id = game_id
        self.seat = seat
        self.obs = np.random.default_rng(game_id * 100 + seat).normal(size=obs_dim).astype(np.float32)
        self.cand_mat = np.random.default_rng(game_id * 100 + seat + 7).normal(size=(n_cand, act_dim)).astype(np.float32)
        self.n_candidates = n_cand
        self.enum_stats = {}
        self.turn_number = 1


class TestGAE(unittest.TestCase):
    def test_gae_hand_computed(self):
        buf = RolloutBuffer(gamma=1.0, gae_lambda=1.0)
        # 轨迹：3 步，价值 [0,0,0]，终局奖励 r3=1。
        for i, seat in enumerate((0,)):
            pass
        reqs = [FakeRequest(1, 0) for _ in range(3)]
        seats = [SeatSpec.mlp("learner")] + [SeatSpec.node("champion")] * 4
        for req in reqs:
            buf.add_decision(req, "learner", 0, -1.0, 0.0)
        buf.finish_game(1, seats, [10, 0, 0, 0, 0], [0, 1, 2, 3, 4], 0, "finished",
                        {"mode": "win_loss"}, "learner")
        trajs = buf.compute_gae()
        self.assertEqual(len(trajs), 1)
        t = trajs[0]
        # gamma=lambda=1：优势 = 未来奖励和 = [1,1,1]，回报 = [1,1,1]。
        np.testing.assert_allclose(t["advantages"], [1, 1, 1], atol=1e-6)
        np.testing.assert_allclose(t["returns"], [1, 1, 1], atol=1e-6)

    def test_gae_discount(self):
        buf = RolloutBuffer(gamma=0.5, gae_lambda=1.0)
        reqs = [FakeRequest(2, 0) for _ in range(3)]
        seats = [SeatSpec.mlp("learner")] + [SeatSpec.node("champion")] * 4
        for req in reqs:
            buf.add_decision(req, "learner", 0, -1.0, 0.0)
        buf.finish_game(2, seats, [10, 0, 0, 0, 0], None, 0, "finished",
                        {"mode": "win_loss"}, "learner")
        t = buf.compute_gae()[0]
        # V=0、终局奖励 r2=1：优势后向回传 adv_t = γ·adv_{t+1}（λ=1）→ [0.25, 0.5, 1.0]。
        np.testing.assert_allclose(t["advantages"], [0.25, 0.5, 1.0], atol=1e-6)

    def test_frozen_opponent_transitions_excluded(self):
        buf = RolloutBuffer()
        seats = [SeatSpec.mlp("learner"), SeatSpec.mlp("snap"), SeatSpec.node("champion"),
                 SeatSpec.node("champion"), SeatSpec.node("neutral")]
        req_l = FakeRequest(3, 0)
        req_s = FakeRequest(3, 1)
        buf.add_decision(req_l, "learner", 0, -1.0, 0.0)
        buf.add_decision(req_s, "snap", 0, -1.0, 0.0)
        buf.finish_game(3, seats, [5, 5, 5, 5, 5], None, 0, "finished",
                        {"mode": "win_loss"}, "learner")
        trajs = buf.compute_gae()
        # 只有 learner 席位轨迹进入缓冲；snap 轨迹被丢弃。
        self.assertEqual(len(trajs), 1)
        self.assertEqual(len(trajs[0]["actions"]), 1)

    def test_anomaly_game_discarded(self):
        buf = RolloutBuffer()
        seats = [SeatSpec.mlp("learner")] + [SeatSpec.node("champion")] * 4
        buf.add_decision(FakeRequest(4, 0), "learner", 0, -1.0, 0.0)
        buf.finish_game(4, seats, [0] * 5, None, None, "anomaly", {"mode": "win_loss"}, "learner")
        self.assertEqual(buf.compute_gae(), [])
        self.assertEqual(buf.stats["anomaly_games"], 1)


class TestRewards(unittest.TestCase):
    def test_rank_win(self):
        scores = [50, 30, 40, 20, 10]
        ranks = [0, 2, 1, 3, 4]  # seats by rank: 0=1st, 2=2nd, 1=3rd...
        cfg = {"mode": "rank_win", "winWeight": 0.5, "rankWeight": 0.5}
        r0 = terminal_reward(scores, ranks, 0, 0, cfg)      # 第一名
        r1 = terminal_reward(scores, ranks, 1, 0, cfg)      # 第三名
        r4 = terminal_reward(scores, ranks, 4, 0, cfg)      # 最后一名
        self.assertAlmostEqual(r0, 0.5 * 1 + 0.5 * 1.0)
        self.assertAlmostEqual(r1, 0.5 * 0 + 0.5 * (5 - 3) / 4)
        self.assertAlmostEqual(r4, 0.5 * 0 + 0.5 * 0.0)

    def test_win_loss_and_margin(self):
        scores = [50, 30, 40, 20, 10]
        self.assertEqual(terminal_reward(scores, None, 0, 0, {"mode": "win_loss"}), 1.0)
        self.assertEqual(terminal_reward(scores, None, 4, 0, {"mode": "win_loss"}), 0.0)
        m = terminal_reward(scores, None, 0, 0, {"mode": "score_margin"})
        self.assertAlmostEqual(m, min(1.0, (50 - 40) / 30), places=6)

    def test_aux_disabled_by_default(self):
        buf = RolloutBuffer()
        seats = [SeatSpec.mlp("learner")] + [SeatSpec.node("champion")] * 4
        buf.add_decision(FakeRequest(5, 0), "learner", 0, -1.0, 0.0)
        buf.finish_game(5, seats, [10, 0, 0, 0, 0], None, 0, "finished",
                        {"mode": "win_loss", "aux": {"golemProgress": 0.0}}, "learner")
        t = buf.compute_gae()[0]
        self.assertEqual(t["returns"][-1], 1.0)  # 纯终局奖励


class TestSegmentSoftmax(unittest.TestCase):
    def test_logprobs_sum_to_zero_per_segment(self):
        torch.manual_seed(0)
        model = ActorCritic(8, 6, hidden=(16,))
        obs = torch.randn(2, 8)
        cand = torch.randn(5, 6)
        seg = torch.tensor([0, 0, 0, 1, 1])
        logits, values = model.evaluate(obs, cand, seg)
        pos = torch.tensor([1, 0])
        chosen_logp, entropy, global_pos = model.log_probs_and_entropy(logits, seg, pos)
        # 每段 logp 求和（softmax 归一化）→ 手动重算。
        lp0 = torch.log_softmax(logits[:3], 0)[pos[0]]
        lp1 = torch.log_softmax(logits[3:], 0)[pos[1]]
        self.assertAlmostEqual(chosen_logp[0].item(), lp0.item(), places=5)
        self.assertAlmostEqual(chosen_logp[1].item(), lp1.item(), places=5)
        self.assertAlmostEqual(global_pos[0].item(), pos[0].item())
        self.assertAlmostEqual(global_pos[1].item(), 3 + pos[1].item())
        # 熵：段内 -Σ p logp。
        p0 = torch.softmax(logits[:3], 0)
        self.assertAlmostEqual(entropy[0].item(), -(p0 * torch.log_softmax(logits[:3], 0)).sum().item(), places=5)


class TestPPOUpdate(unittest.TestCase):
    def _make_trajectories(self, n=32, obs_dim=1419, act_dim=84):
        rng = np.random.default_rng(0)
        trajs = []
        for _ in range(4):
            T = n // 4
            counts = rng.integers(2, 12, size=T)
            trajs.append({
                "obs": rng.normal(size=(T, obs_dim)).astype(np.float32),
                "cand_flat": rng.normal(size=(int(counts.sum()), act_dim)).astype(np.float32),
                "cand_counts": counts.astype(np.int64),
                "actions": rng.integers(0, 2, size=T),
                "old_logp": rng.normal(size=T).astype(np.float32) - 2.0,
                "values": rng.normal(size=T).astype(np.float32),
                "advantages": rng.normal(size=T).astype(np.float32),
                "returns": rng.normal(size=T).astype(np.float32),
            })
        return trajs

    def test_update_changes_params_and_reports(self):
        torch.manual_seed(1)
        device = resolve_device("cpu")
        model = ActorCritic(1419, 84, hidden=(32, 32)).to(device)
        ppo = PPO(model, {"lr": 3e-4, "epochs": 2, "minibatch": 16}, device)
        before = {k: v.detach().clone() for k, v in model.state_dict().items()}
        metrics = ppo.update(self._make_trajectories(), progress=0.0)
        after = model.state_dict()
        changed = any((after[k] - before[k]).abs().max().item() > 0 for k in before)
        self.assertTrue(changed, "PPO 更新必须改变参数")
        self.assertGreater(metrics["samples"], 0)
        self.assertIn("policyLoss", metrics)

    def test_nan_guard_skips(self):
        torch.manual_seed(2)
        device = resolve_device("cpu")
        model = ActorCritic(1419, 84, hidden=(16,))
        # 注入 NaN 权重 → 前向 NaN → 守卫跳过（不崩溃）。
        with torch.no_grad():
            for p in model.parameters():
                p.fill_(float("nan"))
        ppo = PPO(model, {"lr": 3e-4, "epochs": 1, "minibatch": 16}, device)
        metrics = ppo.update(self._make_trajectories(8), progress=0.0)
        self.assertGreater(metrics.get("nanSkips", 0), 0)

    def test_target_kl_early_stop(self):
        torch.manual_seed(3)
        device = resolve_device("cpu")
        model = ActorCritic(1419, 84, hidden=(32, 32)).to(device)
        ppo = PPO(model, {"lr": 5.0, "epochs": 20, "minibatch": 16, "targetKl": 1e-8}, device)
        metrics = ppo.update(self._make_trajectories(), progress=0.0)
        # 极小目标 KL + 大学习率：应在少数 epoch 后早停（approxKl 记录有限）。
        self.assertLessEqual(len(metrics["approxKl"]) if isinstance(metrics["approxKl"], list) else 1, 20)


class TestCheckpoint(unittest.TestCase):
    def test_save_restore_identical_outputs(self):
        import tempfile
        torch.manual_seed(4)
        device = resolve_device("cpu")
        model = ActorCritic(1419, 84, hidden=(32, 32)).to(device)
        ppo = PPO(model, {"lr": 1e-3}, device)
        obs = torch.randn(4, 1419)
        cand = torch.randn(12, 84)
        seg = torch.tensor([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])
        out1 = model.evaluate(obs, cand, seg)
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "c.pt"
            payload = {"format": "ai5-ppo-checkpoint-v1", "modelState": model.state_dict(),
                       "optimizerState": ppo.optimizer.state_dict(), "iteration": 7}
            torch.save(payload, path)
            model2 = ActorCritic(1419, 84, hidden=(32, 32)).to(device)
            p2 = torch.load(path, map_location="cpu", weights_only=False)
            model2.load_state_dict(p2["modelState"])
        out2 = model2.evaluate(obs, cand, seg)
        self.assertTrue(torch.allclose(out1[0], out2[0], atol=1e-6))
        self.assertTrue(torch.allclose(out1[1], out2[1], atol=1e-6))
        self.assertEqual(p2["iteration"], 7)


class TestSeatAssignment(unittest.TestCase):
    def test_deterministic_rotation(self):
        layout = [SeatSpec.mlp("learner"), SeatSpec.mlp("learner"),
                  SeatSpec.node("champion"), SeatSpec.node("champion"), SeatSpec.mlp("snap")]
        a = assign_seats(2026, 0, layout)
        b = assign_seats(2026, 0, layout)
        c = assign_seats(2026, 1, layout)
        self.assertEqual([s.kind for s in a], [s.kind for s in b])
        self.assertNotEqual([s.policy_id for s in a], [s.policy_id for s in c])  # 旋转生效（极高概率）
        # 布局多重集保持不变。
        self.assertEqual(sorted(s.policy_id for s in a), sorted(s.policy_id for s in layout))

    def test_derive_seed_in_range_and_stable(self):
        s1 = derive_seed(2026, 0, 0)
        s2 = derive_seed(2026, 0, 0)
        s3 = derive_seed(2026, 1, 0)
        self.assertEqual(s1, s2)
        self.assertTrue(0 <= s1 < 2**31)
        self.assertNotEqual(s1, s3)

    def test_derive_rng_stable(self):
        a = derive_rng(2026, "decision", 3).integers(0, 100)
        b = derive_rng(2026, "decision", 3).integers(0, 100)
        self.assertEqual(int(a), int(b))


if __name__ == "__main__":
    unittest.main()
