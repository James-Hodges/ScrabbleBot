"""Tests for export_rival_bids.py. Run: python3 -I -m unittest discover -s analysis"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export_rival_bids as rb  # noqa: E402


class Pure(unittest.TestCase):
    def test_phase_of(self):
        self.assertEqual(rb.phase_of(1), 0)
        self.assertEqual(rb.phase_of(14), 0)
        self.assertEqual(rb.phase_of(15), 1)
        self.assertEqual(rb.phase_of(67), len(rb.PHASES) - 1)
        self.assertIsNone(rb.phase_of(68))

    def test_cdf_from_counts(self):
        self.assertEqual(rb.cdf_from_counts({0: 1, 2: 3}, 3), [0.25, 0.25, 1.0, 1.0])

    def test_mix_converts_six_to_five(self):
        # A max-of-6 CDF of 0.5^(6/5) at x becomes 0.5 for the max of 5.
        six = [0.5 ** 1.2, 1.0]
        mixed = rb.mix_cdfs([0.0, 0.0], 0, six, 10)
        self.assertAlmostEqual(mixed[0], 0.5)
        # Equal weights with a direct sample.
        mixed = rb.mix_cdfs([1.0, 1.0], 10, six, 10)
        self.assertAlmostEqual(mixed[0], 0.75)

    def test_jitter_quantile_is_tie_share_at_integers(self):
        # X uniform on {10, 12}: at b = 10, P(X < 10) + P(X = 10)/2 = 0.25.
        cdf = rb.cdf_from_counts({10: 1, 12: 1}, 12)
        self.assertAlmostEqual(rb.jitter_quantile(cdf, 0.25), 10.0)
        self.assertAlmostEqual(rb.jitter_quantile(cdf, 0.5), 10.5)
        self.assertAlmostEqual(rb.jitter_quantile(cdf, 0.75), 12.0)
        self.assertAlmostEqual(rb.jitter_quantile(cdf, 1.0), 12.5)
        # Clamped at 0 for mass at 0.
        cdf0 = rb.cdf_from_counts({0: 1, 5: 1}, 5)
        self.assertEqual(rb.jitter_quantile(cdf0, 0.0), 0.0)
        self.assertEqual(rb.jitter_quantile(cdf0, 0.25), 0.0)

    def test_quantiles_monotone(self):
        cdf = rb.cdf_from_counts({0: 2, 3: 5, 9: 10, 40: 1}, 40)
        q = rb.quantiles(cdf)
        self.assertEqual(len(q), len(rb.PROBS))
        self.assertTrue(all(a <= b for a, b in zip(q, q[1:])))

    def test_observation(self):
        self.assertEqual(rb.observation(None, 0, 0, True), ("direct", 0))
        self.assertEqual(rb.observation(None, 0, 0, False), ("six", 0))
        self.assertEqual(rb.observation(rb.OUR_BOT_ID, 7, 15, True), ("direct", 7))
        self.assertEqual(rb.observation(99, 7, 15, True), ("direct", 15))
        self.assertEqual(rb.observation(99, 7, 15, False), ("six", 15))
        self.assertIsNone(rb.observation(99, 7, None, False))


if __name__ == "__main__":
    unittest.main()
