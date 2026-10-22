"""AI5 种子政策测试（P0 可靠性整改）：双侧常量对齐、账本原子性、隔离验收。

运行：~/century-ai5-env/bin/python -m unittest ai5.ppo.tests.python.test_seed_policy -v
"""

import json
import re
import sys
import tempfile
import threading
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))

from ai5.lib import seed_policy as sp  # noqa: E402
from ai5.ppo.evaluation import arena  # noqa: E402


class TestSeedPolicyConstants(unittest.TestCase):
    def test_python_js_constants_aligned(self):
        """Python 与 JS 两侧的区间定义必须逐值一致（防漂移）。"""
        mjs = (REPO / "ai5" / "lib" / "seed_policy.mjs").read_text()

        def grab(name):
            m = re.search(rf"export const {name} = \[([0-9_]+), ([0-9_]+)\]", mjs)
            assert m, f"seed_policy.mjs 缺少 {name}"
            return (int(m.group(1).replace("_", "")), int(m.group(2).replace("_", "")))

        for name in ("AI4_EVO_BLOCK", "AI5_BLOCK", "OPENEVOLVE_STAGE2_BLOCK",
                     "OPENEVOLVE_STAGE3_BLOCK", "OPENEVOLVE_DEEP_VALIDATION_BLOCK",
                     "PPO_TRAINING_BLOCK", "AI5_EVAL_TRAINING_BLOCK",
                     "AI4_BENCHMARK_BLOCK", "VALIDATION_POOL_BLOCK"):
            self.assertEqual(getattr(sp, name), grab(name), f"{name} 两侧不一致")

    def test_blocks_disjoint(self):
        blocks = [sp.AI4_EVO_BLOCK, sp.OPENEVOLVE_STAGE2_BLOCK, sp.OPENEVOLVE_STAGE3_BLOCK,
                  sp.OPENEVOLVE_DEEP_VALIDATION_BLOCK, sp.PPO_TRAINING_BLOCK,
                  sp.AI5_EVAL_TRAINING_BLOCK, sp.AI4_BENCHMARK_BLOCK, sp.VALIDATION_POOL_BLOCK]
        for i, a in enumerate(blocks):
            for b in blocks[i + 1:]:
                self.assertTrue(a[1] <= b[0] or b[1] <= a[0], f"{a} 与 {b} 重叠")

    def test_engine_seed_limit(self):
        self.assertLess(sp.VALIDATION_POOL_BLOCK[1] - 1, 2**31)
        self.assertEqual(sp.ENGINE_SEED_MAX, 2**31 - 1)

    def test_generate_unique_seeds_and_disjoint(self):
        seeds = sp.generate_unique_seeds(100, sp.OPENEVOLVE_DEEP_VALIDATION_BLOCK, 300001000)
        self.assertEqual(len(set(seeds)), 100)
        sp.assert_disjoint(seeds, range(*sp.PPO_TRAINING_BLOCK), "测试")
        with self.assertRaises(AssertionError):
            sp.assert_disjoint(seeds, range(300001050, 300001060), "测试")
        with self.assertRaises(ValueError):
            sp.generate_unique_seeds(100, sp.OPENEVOLVE_DEEP_VALIDATION_BLOCK, 300001999)


class TestLedgerAtomicity(unittest.TestCase):
    """验证池账本分配的原子性与防重（flock）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self._old_ledger = arena.LEDGER_PATH
        self._old_ai4_state = arena.AI4_STATE_PATH
        self._old_scan_dirs = arena.AI4_LEDGER_SCAN_DIRS
        arena.LEDGER_PATH = tmp / "seed-ledger.json"
        arena.AI4_STATE_PATH = tmp / "nonexistent-ai4.json"      # 摆脱本机 AI4 状态
        arena.AI4_LEDGER_SCAN_DIRS = (tmp / "no-scan-a", tmp / "no-scan-b")  # 摆脱本机挑战账本

    def tearDown(self):
        arena.LEDGER_PATH = self._old_ledger
        arena.AI4_STATE_PATH = self._old_ai4_state
        arena.AI4_LEDGER_SCAN_DIRS = self._old_scan_dirs
        self._tmp.cleanup()

    def test_ai4_scattered_ledgers_collected(self):
        """P0 整改补充：AI4 分散在各挑战报告目录的 validation-ledger 必须被全量收集
        （此前只读 state.json，漏计正式挑战块 [941500092,941500152) 等）。"""
        scan = Path(self._tmp.name) / "scan"
        (scan / "challenge-x").mkdir(parents=True)
        (scan / "challenge-x" / "validation-ledger.json").write_text(json.dumps({
            "lastBase": 941500092,
            "history": [
                {"base": 941494000, "size": 6},
                {"base": 941500092, "size": 60},
                {"base": 900000000},  # 旧格式：无 size → 按步长 2000 保守估计
            ],
        }))
        old_scan = arena.AI4_LEDGER_SCAN_DIRS
        arena.AI4_LEDGER_SCAN_DIRS = (scan,)
        try:
            blocks = arena.load_ai4_ledger_blocks()
            # 防重：新验证分配不得与 AI4 已消费块重叠（扫描目录保持指向夹具账本）。
            base = arena.allocate_validation_block(10, "t:after-ai4")
        finally:
            arena.AI4_LEDGER_SCAN_DIRS = old_scan
        self.assertIn((941494000, 6), blocks)
        self.assertIn((941500092, 60), blocks)
        self.assertIn((900000000, arena.VALIDATION_STRIDE), blocks)
        self.assertIn((941500092, arena.VALIDATION_STRIDE), blocks)  # lastBase 兜底
        for b, s in blocks:
            self.assertFalse(b < base + 10 and base < b + s, f"分配 [{base},{base+10}) 与 AI4 块 [{b},{b+s}) 重叠")

    def test_sequential_allocation_disjoint(self):
        b1 = arena.allocate_validation_block(40, "t:1")
        b2 = arena.allocate_validation_block(40, "t:2")
        self.assertEqual(b1, sp.VALIDATION_POOL_BLOCK[0])
        self.assertGreaterEqual(b2, b1 + 40)
        ledger = json.loads(arena.LEDGER_PATH.read_text())
        self.assertEqual(ledger["challengeCount"], 2)

    def test_training_entries_do_not_advance_validation_cursor(self):
        arena.allocate_training_block(40, "eval-x")
        b = arena.allocate_validation_block(40, "t:3")
        self.assertEqual(b, sp.VALIDATION_POOL_BLOCK[0], "训练块不得拖动验证池游标")
        # 训练池新分配从 350M 起步（与 5M 旧约定、PPO 训练块隔离），且顺序续接。
        self.assertEqual(arena.allocate_training_block(40, "eval-y"), sp.AI5_EVAL_TRAINING_BLOCK[0] + 40)

    def test_concurrent_allocation_never_overlaps(self):
        """P0 验收：并发分配必须原子（旧实现裸读改写会分出重叠块）。"""
        results: list[int] = []
        errors: list[Exception] = []

        def worker():
            try:
                results.append(arena.allocate_validation_block(40, "concurrent"))
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertFalse(errors, f"并发分配异常：{errors}")
        self.assertEqual(len(set(results)), 8, f"并发分配出重叠块：{sorted(results)}")

    def test_exhaustion_guard(self):
        with self.assertRaises(RuntimeError):
            arena.allocate_validation_block(sp.VALIDATION_POOL_BLOCK[1] - sp.VALIDATION_POOL_BLOCK[0] + 1, "huge")


if __name__ == "__main__":
    unittest.main()
