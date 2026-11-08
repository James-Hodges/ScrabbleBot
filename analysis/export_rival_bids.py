"""Export the highest-rival-bid distribution per letter, phase and table type (S3-4).

Usage: python3 -I analysis/export_rival_bids.py [--db PATH] [--out bot/src/rivalBids.json] [--days 3]

For λ bidding (bot/src/rivalBids.ts) we need, for the open letter, the
distribution of X = the highest bid among the OTHER five players. From the
archive (ended 6-player Vickrey matches, rounds 1-67, created in the last
--days days before the newest match):

  * Matches our bot (OUR_BOT_ID) played: X is observed directly.
      - another bot won   -> X = top_bid (auction_top_bid_archive, the winner's bid)
      - we won            -> X = paid (Vickrey: the price is the 2nd-highest bid,
                             i.e. the highest rival bid; a lone bidder pays 1)
      - nobody bid        -> X = 0 (unsold: the max bid was 0)
  * Other matches: top_bid is the max over all SIX players (0 when unsold).
    Assuming exchangeable bidders, P(max of 5 <= x) = P(max of 6 <= x)^(5/6),
    so those CDFs are converted before mixing with the direct ones (weighted
    by sample size).

Table type: "real" = no simulated bot seated, "sim" = at least one
(match_participant -> bot.is_simulated; bots deleted from the bot table are
real teams' bots, so they count as real).

Phases: PHASES below (5 buckets over rounds 1-67; the final auction's letter
is unusable and we always bid 0 on it, so round 68 is left out).

Bids are integers; ties share the win. We export quantiles of the jittered
variable X + U(-1/2, 1/2) (clamped at 0), whose CDF at an integer bid b is
P(X < b) + P(X = b)/2, the tie-share win probability. Linear interpolation
between the quantiles (rivalBids.ts) is then exact at the integers.

Cells with fewer than MIN_N observations fall back to the letter's all-phase
numbers for that table type (flagged "fallback").
"""

import argparse
import datetime as dt
import json
import pathlib
import sqlite3

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_DB = "/Users/james/Developer/ScrabbleBot/data/scrabble.db"
OUR_BOT_ID = 205
ROUNDS = 68
SEATS = 6
MIN_N = 60
# Inclusive round ranges.
PHASES = [(1, 14), (15, 28), (29, 41), (42, 54), (55, 67)]
# Every 5th percentile plus a finer upper tail (the top 5% spans a long range).
PROBS = [i / 20 for i in range(20)] + [0.975, 0.99, 0.995, 1.0]
TABLE_TYPES = ("real", "sim")


# ---------- pure helpers (unit-tested) ----------

def phase_of(rnd):
    """0-based phase bucket for a 1-based round, or None (round 68 / out of range)."""
    for i, (lo, hi) in enumerate(PHASES):
        if lo <= rnd <= hi:
            return i
    return None


def cdf_from_counts(counts, max_x):
    """counts: {x: n} for integer x >= 0. Returns [P(X <= x) for x in 0..max_x]."""
    total = sum(counts.values())
    out = []
    acc = 0
    for x in range(max_x + 1):
        acc += counts.get(x, 0)
        out.append(acc / total if total else 0.0)
    return out


def mix_cdfs(direct, n_direct, six, n_six, others=SEATS - 1, seats=SEATS):
    """Max-of-`others` CDF: direct samples mixed with max-of-`seats` samples converted by ^(others/seats)."""
    n = n_direct + n_six
    if n == 0:
        return [0.0] * len(direct)
    e = others / seats
    return [(n_direct * d + n_six * (s ** e if s > 0 else 0.0)) / n for d, s in zip(direct, six)]


def jitter_quantile(cdf, p):
    """Quantile of X + U(-1/2, 1/2), X integer with CDF `cdf` (P(X <= x)), clamped at 0."""
    prev = 0.0
    for x, f in enumerate(cdf):
        if f >= p and f > prev:
            t = x - 0.5 + (p - prev) / (f - prev)
            return max(0.0, t)
        prev = f
    return max(0.0, len(cdf) - 0.5)


def quantiles(cdf, probs=PROBS):
    return [round(jitter_quantile(cdf, p), 2) for p in probs]


# ---------- database ----------

def load(db_path, days):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    (newest,) = conn.execute("SELECT MAX(created_at) FROM match_state").fetchone()
    since = newest - days * 86400 * 1_000_000
    matches = {}
    for mid, sims, ours, n in conn.execute(
        """SELECT m.id, SUM(COALESCE(b.is_simulated, 0) = 1), SUM(mp.bot_id = ?), COUNT(*)
           FROM match_state m
           JOIN match_participant mp ON mp.match_id = m.id
           LEFT JOIN bot b ON b.id = mp.bot_id
           WHERE m.status = 'ended' AND m.auction_type = 'vickrey' AND m.created_at >= ?
           GROUP BY m.id""",
        (OUR_BOT_ID, since),
    ):
        if n == SEATS:
            matches[mid] = ("sim" if sims else "real", bool(ours))
    rows = conn.execute(
        """SELECT a.match_id, a.letter, a.winner_bot_id, a.paid, t.top_bid,
                  ROW_NUMBER() OVER (PARTITION BY a.match_id ORDER BY a.auction_id) AS rnd,
                  COUNT(*) OVER (PARTITION BY a.match_id) AS n_rounds
           FROM auction_result a
           JOIN match_state m ON m.id = a.match_id
           LEFT JOIN auction_top_bid_archive t ON t.auction_id = a.auction_id
           WHERE m.status = 'ended' AND m.auction_type = 'vickrey' AND m.created_at >= ?""",
        (since,),
    ).fetchall()
    lo_hi = conn.execute(
        "SELECT MIN(created_at), MAX(created_at) FROM match_state WHERE status = 'ended' AND created_at >= ?",
        (since,),
    ).fetchone()
    return matches, rows, lo_hi


def observation(winner, paid, top_bid, ours):
    """(kind, x): kind 'direct' (max of the other 5) or 'six' (max of all 6); None to skip."""
    if winner is None:
        return ("direct" if ours else "six", 0)
    if ours and winner == OUR_BOT_ID:
        return ("direct", int(paid))
    if top_bid is None:
        return None
    return ("direct" if ours else "six", int(top_bid))


def build(matches, rows):
    # counts[type][letter][phase][kind] = {x: n}
    counts = {}
    used = set()
    for mid, letter, winner, paid, top_bid, rnd, n_rounds in rows:
        info = matches.get(mid)
        if info is None or n_rounds != ROUNDS:
            continue
        ph = phase_of(rnd)
        if ph is None:
            continue
        ttype, ours = info
        obs = observation(winner, paid, top_bid, ours)
        if obs is None:
            continue
        kind, x = obs
        cell = counts.setdefault(ttype, {}).setdefault(letter, {}).setdefault(ph, {"direct": {}, "six": {}})
        cell[kind][x] = cell[kind].get(x, 0) + 1
        used.add(mid)
    return counts, used


def cell_quantiles(direct, six):
    max_x = max(list(direct) + list(six) + [0])
    nd, ns = sum(direct.values()), sum(six.values())
    cdf = mix_cdfs(cdf_from_counts(direct, max_x), nd, cdf_from_counts(six, max_x), ns)
    return quantiles(cdf), nd, ns


def merge(dicts):
    out = {}
    for d in dicts:
        for x, n in d.items():
            out[x] = out.get(x, 0) + n
    return out


def export(counts):
    tables = {}
    for ttype in TABLE_TYPES:
        letters = {}
        for letter in sorted(counts.get(ttype, {})):
            phases = counts[ttype][letter]
            all_direct = merge(phases[p]["direct"] for p in phases)
            all_six = merge(phases[p]["six"] for p in phases)
            q_all, nd_all, ns_all = cell_quantiles(all_direct, all_six)
            cells = []
            for p in range(len(PHASES)):
                c = phases.get(p, {"direct": {}, "six": {}})
                n = sum(c["direct"].values()) + sum(c["six"].values())
                if n < MIN_N:
                    cells.append({"q": q_all, "n": n, "nDirect": nd_all, "fallback": True})
                else:
                    q, nd, _ = cell_quantiles(c["direct"], c["six"])
                    cells.append({"q": q, "n": n, "nDirect": nd})
            letters[letter] = cells
        tables[ttype] = letters
    return tables


def iso(us):
    return dt.datetime.fromtimestamp(us / 1e6, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db", nargs="?", default=DEFAULT_DB)
    ap.add_argument("--out", default=str(ROOT / "bot" / "src" / "rivalBids.json"))
    ap.add_argument("--days", type=float, default=3)
    args = ap.parse_args()

    matches, rows, (lo, hi) = load(args.db, args.days)
    counts, used = build(matches, rows)
    tables = export(counts)
    sample = {}
    for ttype in TABLE_TYPES:
        ms = [m for m in used if matches[m][0] == ttype]
        n_auctions = sum(c["n"] for cells in tables[ttype].values() for c in cells if not c.get("fallback"))
        sample[ttype] = {
            "matches": len(ms),
            "ourMatches": sum(1 for m in ms if matches[m][1]),
            "auctions": sum(
                sum(k.values()) for L in counts.get(ttype, {}).values() for c in L.values() for k in c.values()
            ),
            "auctionsInOwnCells": n_auctions,
        }
    out = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "auction_top_bid_archive (+ price paid on our wins), ended 6-player Vickrey matches",
        "fromDate": iso(lo),
        "toDate": iso(hi),
        "ourBotId": OUR_BOT_ID,
        "minN": MIN_N,
        "phases": [list(p) for p in PHASES],
        "probs": PROBS,
        "sample": sample,
        "tables": tables,
    }
    text = json.dumps(out, separators=(",", ":"))
    pathlib.Path(args.out).write_text(text + "\n")
    print(f"wrote {args.out} ({len(text) / 1024:.0f} KB)")
    for ttype, s in sample.items():
        print(f"  {ttype}: {s}")
    for ttype in TABLE_TYPES:
        t = tables[ttype]
        for L in ("E", "S", "Z"):
            if L in t:
                med = [c["q"][PROBS.index(0.5)] for c in t[L]]
                print(f"  {ttype} {L} median by phase: {med}")


if __name__ == "__main__":
    main()
