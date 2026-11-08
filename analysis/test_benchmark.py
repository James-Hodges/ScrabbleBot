"""Tests for benchmark.py. Run: python3 -I -m unittest discover -s analysis"""

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import benchmark as bm  # noqa: E402

TESTDATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata")


class Helpers(unittest.TestCase):
    def test_place_ties_share_better_place(self):
        scores = [80, 50, 50, 20]
        self.assertEqual(bm.place_of(80, scores), 1)
        self.assertEqual(bm.place_of(50, scores), 2)
        self.assertEqual(bm.place_of(20, scores), 4)

    def test_percentile_nearest_rank(self):
        self.assertEqual(bm.percentile([1, 2, 3, 4], 50), 2)
        self.assertEqual(bm.percentile([1, 2, 3, 4], 95), 4)
        self.assertIsNone(bm.percentile([], 50))

    def test_since_and_last(self):
        recs = [{"match_id": i, "start_ms": i * 1000} for i in (3, 1, 2)]
        self.assertEqual([r["match_id"] for r in bm.apply_filters(recs, ("id", 2))], [2, 3])
        self.assertEqual([r["match_id"] for r in bm.apply_filters(recs, last=1)], [3])
        t = bm.parse_since("1970-01-01T00:00:02Z")
        self.assertEqual(t, ("time", 2000))

    def test_b7_not_needed_when_fast(self):
        t = {"decide_ms": {"p95": 5}, "since_open_ms": {"p95": 50},
             "bid_errors_closed": 0, "word_rejected_unexpected": 0}
        v = bm.b7_verdict(t, 12)
        self.assertEqual(v["verdict"], "B-7 not needed")

    def test_b7_late_but_fast_is_network(self):
        t = {"decide_ms": {"p95": 5}, "since_open_ms": {"p95": 400},
             "bid_errors_closed": 0, "word_rejected_unexpected": 0}
        self.assertIn("network", bm.b7_verdict(t, 12)["verdict"])


class FromLogs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rep = bm.logs_report(TESTDATA)
        matches, _ = bm.read_logs(TESTDATA)
        cls.recs = {int(k): bm.log_match(k, v) for k, v in matches.items()}

    def test_per_match(self):
        a, b = self.recs[9001], self.recs[9002]
        self.assertEqual(a["place"], 2)  # 80, 50, 50: our 50 ties for 2nd
        self.assertEqual(b["place"], 1)
        self.assertEqual((a["won"], a["spent"], a["w7"]), (3, 17, 1))
        self.assertEqual((b["won"], b["spent"]), (1, 8))

    def test_last_letter_detection(self):
        a, b = self.recs[9001], self.recs[9002]
        self.assertTrue(a["last_won"])
        self.assertEqual(a["last_paid"], 2)
        self.assertTrue(a["bid_on_last"])
        self.assertFalse(b["last_won"])
        self.assertFalse(b["bid_on_last"])
        self.assertEqual(b["last_reason"], "last_auction")

    def test_aggregate(self):
        m = self.rep["metrics"]
        self.assertEqual(m["matches"], 2)
        self.assertAlmostEqual(m["avg_place"], 1.5)
        self.assertAlmostEqual(m["win_pct"], 50)
        self.assertAlmostEqual(m["coins_per_tile"], 25 / 4)  # spent / tiles won
        self.assertAlmostEqual(m["coins_left"], (30 + 92) / 2)
        self.assertEqual((m["last_letter"], m["last_letter_paid"]), (1, 2))
        self.assertEqual(self.rep["bad_lines"], 1)

    def test_timing_and_b7(self):
        t, v = self.rep["timing"], self.rep["b7"]
        self.assertEqual(t["decide_ms"]["max"], 150)
        self.assertEqual(t["since_open_ms"]["p95"], 350)
        self.assertEqual((t["bid_errors"], t["bid_errors_closed"]), (1, 1))
        self.assertEqual((t["word_rejected"], t["word_rejected_unexpected"]), (1, 0))
        self.assertEqual(t["budget_reasons"]["normal"], 3)
        self.assertEqual((t["bid_on_last"], t["last_auction_seen"]), (1, 2))
        self.assertTrue(v["slow"] and v["late"] and v["missed"])
        self.assertTrue(v["verdict"].startswith("pick up B-7"))
        self.assertIn("only 2 matches", v["verdict"])

    def test_cli_table_and_json(self):
        out = io.StringIO()
        with redirect_stdout(out):
            bm.main(["--logs", TESTDATA, "--last", "1"])
        self.assertIn("Coins per tile", out.getvalue())
        out = io.StringIO()
        with redirect_stdout(out):
            bm.main(["--logs", TESTDATA, "--since", "9002", "--json"])
        self.assertEqual(json.loads(out.getvalue())["metrics"]["matches"], 1)


if __name__ == "__main__":
    unittest.main()
