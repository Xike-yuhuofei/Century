"""v2：分人数层惩罚的回归测试（不运行真实对局）。"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from century_evaluator_ai9 import compute_combined_score, worst_stratum_penalty


class StratifiedScoreTest(unittest.TestCase):
    def test_no_strata_keeps_original_formula(self):
        score = compute_combined_score(0.10)
        self.assertAlmostEqual(score, 0.55)
        self.assertEqual(worst_stratum_penalty(None), (None, None, 0.0))

    def test_worst_negative_stratum_adds_penalty(self):
        strata = {
            '2': {'delta': 0.10},
            '3': {'delta': -0.20},
            '4': {'delta': 0.04},
            '5': {'delta': 0.0},
        }
        worst, delta, penalty = worst_stratum_penalty(strata)
        self.assertEqual(worst, 3)
        self.assertAlmostEqual(delta, -0.20)
        self.assertAlmostEqual(penalty, 0.04)
        self.assertAlmostEqual(compute_combined_score(0.10, by_player_count=strata), 0.51)

    def test_positive_strata_do_not_penalize(self):
        strata = {'2': {'delta': 0.2}, '3': {'delta': 0.1}}
        self.assertEqual(worst_stratum_penalty(strata)[2], 0.0)
        self.assertAlmostEqual(compute_combined_score(0.10, by_player_count=strata), 0.55)

    def test_invalid_entries_are_ignored(self):
        strata = {'2': {'delta': 'bad'}, '3': {'delta': None}, '4': {}}
        self.assertEqual(worst_stratum_penalty(strata), (None, None, 0.0))
        self.assertAlmostEqual(compute_combined_score(None, by_player_count=strata), 0.0)

    def test_other_penalties_still_apply(self):
        score = compute_combined_score(
            0.10,
            anomaly_rate=0.10,
            latency_excess=0.5,
            complexity_excess=0.5,
            by_player_count={'2': {'delta': -0.20}},
        )
        expected = 0.5 + 0.05 - 0.15 - 0.05 - 0.025 - 0.04
        self.assertAlmostEqual(score, expected)


if __name__ == '__main__':
    unittest.main()
