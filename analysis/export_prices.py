"""Export winning-bid percentiles per letter and phase to bot/src/prices.json (S2-1).

Usage: python3 -I analysis/export_prices.py [--db data/scrabble.db] [--out bot/src/prices.json]

Runs the derived-table section of analysis/analyze.sql, then its section 6 query.
Cells with fewer than MIN_N samples fall back to the letter's all-rounds numbers.
"""

import argparse
import datetime as dt
import json
import pathlib
import sqlite3

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIN_N = 30
PHASES = [("early", [1, 20]), ("mid", [21, 48]), ("late", [49, 67])]
SETUP_END = "-- ---------- 1. "
QUERY_START = "-- ---------- 6. "


def iso(us):
    return dt.datetime.fromtimestamp(us / 1e6, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "scrabble.db"))
    ap.add_argument("--out", default=str(ROOT / "bot" / "src" / "prices.json"))
    args = ap.parse_args()

    sql = (ROOT / "analysis" / "analyze.sql").read_text()
    conn = sqlite3.connect(args.db)
    conn.executescript(sql[: sql.index(SETUP_END)])
    rows = conn.execute(sql[sql.index(QUERY_START):]).fetchall()

    cells = {}
    for letter, phase, n, p25, p50, p75, p90 in rows:
        cells.setdefault(letter, {})[phase] = {"p25": p25, "p50": p50, "p75": p75, "p90": p90, "n": n}

    letters = {}
    for letter in sorted(cells):
        allc = cells[letter]["all"]
        letters[letter] = {}
        for name, _ in PHASES:
            c = cells[letter].get(name)
            if c is None or c["n"] < MIN_N:
                c = dict(allc, fallback=True)
            letters[letter][name] = c

    matches, auctions, lo, hi = conn.execute(
        """SELECT COUNT(DISTINCT a.match_id), SUM(a.winner_bot_id IS NOT NULL AND a.rnd <= 67),
                  MIN(m.created_at), MAX(m.created_at)
           FROM auc a JOIN recent2 USING (match_id) JOIN mreal m USING (match_id)
           JOIN match_state ms ON ms.id = a.match_id
           WHERE a.n_rounds = 68 AND ms.auction_type = 'vickrey'"""
    ).fetchone()
    out = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sample": {"matches": matches, "auctions": auctions, "fromDate": iso(lo), "toDate": iso(hi), "minN": MIN_N},
        "phases": [{"name": n, "rounds": r} for n, r in PHASES],
        "letters": letters,
    }
    pathlib.Path(args.out).write_text(json.dumps(out, indent=1) + "\n")
    fb = sum(c.get("fallback", False) for l in letters.values() for c in l.values())
    print(f"wrote {args.out}: {len(letters)} letters, {matches} matches, {auctions} sold auctions, {fb} fallback cells")


if __name__ == "__main__":
    main()
