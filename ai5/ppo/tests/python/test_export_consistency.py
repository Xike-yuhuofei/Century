"""导出与推理一致性测试（任务书 13.4 / 14.P6）。

链路：torch 检查点 → export_weights.py → JSON →
  a) TS 推理（inference/policy.mjs，f64，Node 子进程生成 fixtures）；
  b) 纯 numpy 推理（inference/predict.py，f64）；
  c) torch 前向（f32）。
断言：TS ≈ numpy（< 1e-9）、TS ≈ torch（< 1e-4）、概率归一化、贪心选择一致。
"""

import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))

from ai5.ppo.inference.predict import NumpyPolicy  # noqa: E402
from ai5.ppo.model.actor_critic import ActorCritic, resolve_device  # noqa: E402
from ai5.ppo.evaluation.export_weights import export_checkpoint  # noqa: E402

SMOKE_RUN = REPO / "ai5" / "ppo" / "reports" / "smoke-a"


def _ensure_checkpoint() -> Path:
    """优先复用冒烟运行的 init.pt；不存在则现场生成一个随机权重检查点。"""
    ckpt = SMOKE_RUN / "init.pt"
    if ckpt.exists():
        return ckpt
    tmp = Path(tempfile.mkdtemp()) / "init.pt"
    torch.manual_seed(0)
    model = ActorCritic(1419, 84, hidden=(64, 64))
    torch.save({"format": "ai5-ppo-checkpoint-v1", "modelState": model.state_dict(),
                "optimizerState": {}, "arch": model.arch_kwargs(), "iteration": -1,
                "modelHash": "test"}, tmp)
    return tmp


class TestExportConsistency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ckpt = _ensure_checkpoint()
        cls.tmp = Path(tempfile.mkdtemp())
        cls.model_json = cls.tmp / "model.json"
        cls.manifest = export_checkpoint(cls.ckpt, cls.model_json)
        # Node 子进程生成 fixtures（TS 推理）。
        cls.fixtures_path = cls.tmp / "fixtures.json"
        script = REPO / "ai5" / "ppo" / "tests" / "node" / "export-fixtures.mjs"
        result = subprocess.run(
            ["node", str(script), str(cls.model_json), str(cls.fixtures_path), "30"],
            cwd=REPO, capture_output=True, text=True, timeout=180,
        )
        if result.returncode != 0:
            raise RuntimeError(f"fixture 生成失败：{result.stderr[-800:]}")
        cls.fixtures = json.loads(cls.fixtures_path.read_text())

    def _states(self):
        for st in self.fixtures["states"]:
            obs = np.frombuffer(base64.b64decode(st["obsB64"]), dtype="<f4")
            cand = np.frombuffer(base64.b64decode(st["candB64"]), dtype="<f4").reshape(st["rows"], st["cols"])
            yield st, obs, cand

    def test_manifest_versions(self):
        m = self.manifest
        self.assertEqual(m["stateEncodingVersion"], "ai5-state-v1")
        self.assertEqual(m["actionEncodingVersion"], "ai5-action-v1")
        self.assertEqual(m["interfaceVersion"], "ai5-inference-v1")
        self.assertTrue(m["modelVersion"].startswith("ai5-mlp-"))

    def test_ts_vs_numpy_probs_bit_close(self):
        policy = NumpyPolicy(self.model_json)
        for st, obs, cand in self._states():
            probs_np = policy.policy_scores(obs, cand)
            probs_ts = np.array(st["probsTS"])
            self.assertLess(float(np.abs(probs_np - probs_ts).max()), 1e-9,
                            f"TS 与 numpy 概率不一致：{probs_ts} vs {probs_np}")
            self.assertAlmostEqual(probs_ts.sum(), 1.0, places=9)

    def test_ts_vs_numpy_value(self):
        policy = NumpyPolicy(self.model_json)
        for st, obs, _ in self._states():
            v_np = policy.value_of_obs(obs)
            self.assertAlmostEqual(v_np, st["valueTS"], places=9)

    def test_ts_vs_torch_f32(self):
        payload = torch.load(self.ckpt, map_location="cpu", weights_only=False)
        model = ActorCritic(**payload["arch"])
        model.load_state_dict(payload["modelState"])
        model.eval()
        policy = NumpyPolicy(self.model_json)
        worst = 0.0
        for st, obs, cand in self._states():
            with torch.no_grad():
                obs_t = torch.from_numpy(obs).unsqueeze(0)
                cand_t = torch.from_numpy(cand)
                seg = torch.zeros(cand.shape[0], dtype=torch.long)
                logits, _ = model.evaluate(obs_t, cand_t, seg)
                probs_torch = torch.softmax(logits, 0).numpy()
            probs_ts = np.array(st["probsTS"])
            worst = max(worst, float(np.abs(probs_torch - probs_ts).max()))
        self.assertLess(worst, 1e-4, f"TS(f64) 与 torch(f32) 最大偏差 {worst}")

    def test_greedy_choice_agrees(self):
        policy = NumpyPolicy(self.model_json)
        for st, obs, cand in self._states():
            probs_np = policy.policy_scores(obs, cand)
            self.assertEqual(int(np.argmax(probs_np)), int(np.argmax(st["probsTS"])))

    def test_single_decision_latency_recorded(self):
        # 只记录不硬断言（报告口径）；但必须为正数。
        for st in self.fixtures["states"]:
            self.assertGreater(st["tsInferMs"], 0)

    def test_hash_tamper_detection(self):
        parsed = json.loads(self.model_json.read_text())
        parsed["weights"]["trunk.0.weight"] = base64.b64encode(b"\x00" * 8).decode()
        bad_path = self.tmp / "bad.json"
        bad_path.write_text(json.dumps(parsed))
        with self.assertRaises(ValueError):
            NumpyPolicy(bad_path)


if __name__ == "__main__":
    unittest.main()
