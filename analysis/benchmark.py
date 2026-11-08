"""Compare our matches with the PLAN.md benchmark table (S3-1).

Two sources:

  python3 -I analysis/benchmark.py --bot NAME [--db data/scrabble.db] [--refresh]
      The public match history (built by pull_data.py). Works on any machine.
  python3 -I analysis/benchmark.py --logs logs/
      Our own S0-4 JSONL match logs. Adds bid timing, errors, budget reasons
      and the B-7 verdict, which only the logs have.

Filters (both sources): --since <ISO time | match id>, --last N.
DB only: --version N (by bot_version start times), --sample analysis
(ANALYSIS.md's sample: ended matches with 4+ real bots in the 3 days up to
the newest match in the DB, or up to --until).

Place = 1 + number of participants (sims included) with a higher final
score, so ties share the better place, as in analyze.sql.
Coins per tile = coins spent / tiles won over all matches (as analyze.sql).
Bought the last letter = we won the match's last auction (its letter can't be
played).

--json prints machine-readable output (for the S3-2 tuning log).
"""

import argparse
import difflib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))

# Benchmark and target values: copied from PLAN.md "Benchmarks" (which takes
# them from ANALYSIS.md §3 place-1 row and §5). Update both together.
# key: (label, first-place avg, LUCENT, Bron, target (op, value) or None, decimals)
BENCHMARKS = {
    "matches":      ("Matches",                   None, 542,  567,  (">=", 10), 0),
    "avg_place":    ("Average place",             None, 1.76, 1.86, ("<=", 2.0), 2),
    "win_pct":      ("Win %",                     None, 52,   37,   None, 0),
    "score":        ("Score per match",           161,  151,  144,  (">=", 160), 1),
    "tiles_won":    ("Tiles won per match",       24.4, 23.3, 23.8, (">=", 24), 1),
    "coins_per_tile": ("Coins per tile",          9.2,  9.5,  8.1,  ("<=", 10), 1),
    "w7":           ("7+ letter words per match", 3.2,  3.2,  3.2,  (">=", 3), 2),
    "coins_left":   ("Coins left at the end",     36,   28,   52,   ("<=", 10), 1),
    "last_letter":  ("Bought the last letter",    None, None, None, ("==", 0), 0),
}

# B-7 triggers, from PLAN.md "When to pick up B-7".
B7_DECIDE_MS = 100      # deciding a bid takes more than about 100 ms (we use p95)
B7_SINCE_OPEN_MS = 300  # bids sent more than about 300 ms after open (p95)
B7_MIN_MATCHES = 10
CLOSED_RE = re.compile(r"closed|expired|window", re.I)
EXPECTED_WORD_REJECT_RE = re.compile(r"match not running", re.I)


# ---------- shared helpers ----------

def place_of(my_score, all_scores):
    """1 + count of strictly higher scores: ties share the better place."""
    return 1 + sum(1 for s in all_scores if s > my_score)


def percentile(values, p):
    """Nearest-rank percentile: the value at rank ceil(p/100 * n)."""
    if not values:
        return None
    v = sorted(values)
    return v[max(1, math.ceil(p / 100 * len(v))) - 1]


def parse_since(text):
    """Return ('id', int) or ('time', epoch ms)."""
    if re.fullmatch(r"\d+", text):
        return ("id", int(text))
    t = text.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(t)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return ("time", dt.timestamp() * 1000)


def apply_filters(records, since=None, last=None):
    """records need match_id (int) and start_ms; returns sorted, filtered list."""
    out = sorted(records, key=lambda r: (r["start_ms"] or 0, r["match_id"]))
    if since:
        kind, val = since
        if kind == "id":
            out = [r for r in out if r["match_id"] >= val]
        else:
            out = [r for r in out if (r["start_ms"] or 0) >= val]
    if last:
        out = out[-last:]
    return out


def aggregate(records):
    """Per-match records -> the benchmark metrics."""
    n = len(records)
    if n == 0:
        return {"matches": 0}
    won = sum(r["won"] for r in records)
    spent = sum(r["spent"] for r in records)
    last = [r for r in records if r["last_won"]]
    return {
        "matches": n,
        "avg_place": sum(r["place"] for r in records) / n,
        "win_pct": 100 * sum(r["place"] == 1 for r in records) / n,
        "score": sum(r["score"] for r in records) / n,
        "tiles_won": won / n,
        "coins_per_tile": spent / won if won else None,
        "w7": sum(r["w7"] for r in records) / n,
        "coins_left": sum(r["balance"] for r in records) / n,
        "last_letter": len(last),
        "last_letter_paid": sum(r["last_paid"] or 0 for r in last),
        "first_match": records[0]["match_id"],
        "last_match": records[-1]["match_id"],
    }


def check(value, target):
    if target is None or value is None:
        return ""
    op, t = target
    ok = {">=": value >= t, "<=": value <= t, "==": value == t}[op]
    return "✓" if ok else "✗"


def fmt(v, dec):
    if v is None:
        return "–"
    return f"{v:.{dec}f}"


def target_text(target):
    if target is None:
        return "–"
    op, t = target
    if op == "==" and t == 0:
        return "never"
    return f"{'≥' if op == '>=' else '≤'} {t:g}"


def table_rows(m):
    rows = []
    for key, (label, first, lucent, bron, target, dec) in BENCHMARKS.items():
        val = m.get(key)
        if key == "last_letter":
            ours = (f"{val} of {m['matches']} (paid {m['last_letter_paid']})"
                    if m.get("matches") else "–")
        else:
            ours = fmt(val, dec)
        lb = "–" if lucent is None else f"{lucent:g} / {bron:g}"
        rows.append([label, ours, "–" if first is None else f"{first:g}", lb,
                     target_text(target), check(val, target)])
    return rows


def print_table(header, rows):
    widths = [max(len(str(r[i])) for r in [header] + rows) for i in range(len(header))]
    line = lambda r: " | ".join(str(c).ljust(w) for c, w in zip(r, widths)).rstrip()
    print(line(header))
    print("-+-".join("-" * w for w in widths))
    for r in rows:
        print(line(r))


HEADER = ["Metric", "Ours", "First-place avg", "LUCENT / Bron", "Target", "✓/✗"]


# ---------- DB source ----------

def find_bot(conn, name):
    """Return (id, name) for a unique match, else print close matches and exit."""
    bots = conn.execute("SELECT id, name, is_simulated FROM bot").fetchall()
    exact = [b for b in bots if b[1] == name]
    if len(exact) != 1:
        exact = [b for b in bots if (b[1] or "").lower() == name.lower()]
    if len(exact) == 1:
        return exact[0][0], exact[0][1]
    names = [b[1] or "" for b in bots]
    close = [n for n in names if name.lower() in n.lower()]
    close += [n for n in difflib.get_close_matches(name, names, n=8, cutoff=0.5) if n not in close]
    why = "ambiguous" if exact else "not found"
    print(f"bot {name!r} {why}. Close matches:", file=sys.stderr)
    for n in close[:15] or ["(none)"]:
        print(f"  {n}", file=sys.stderr)
    sys.exit(2)


def version_window(conn, bot_id, version):
    """[start_us, end_us) for a bot version, from bot_version start times."""
    rows = conn.execute(
        "SELECT version, started_at FROM bot_version WHERE bot_id = ? ORDER BY version",
        (bot_id,)).fetchall()
    starts = dict(rows)
    if version not in starts and not (version == 1 and not rows):
        have = ", ".join(str(v) for v, _ in rows) or "none (version 1 only)"
        sys.exit(f"bot has no version {version}; versions in DB: {have}")
    start = starts.get(version, 0)
    later = [s for v, s in rows if v > version]
    return start, (min(later) if later else None)


def ensure_indexes(conn):
    for sql in ("CREATE INDEX IF NOT EXISTS ar_match ON auction_result(match_id, auction_id)",
                "CREATE INDEX IF NOT EXISTS wp_match ON word_play(match_id, bot_id)",
                "CREATE INDEX IF NOT EXISTS mp_match ON match_participant(match_id)"):
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            pass  # read-only DB: queries still work, just slower


def db_records(conn, bot_id, sample="all", until=None, version=None):
    """Per-match records for one bot from the public history."""
    ensure_indexes(conn)
    conn.execute("DROP TABLE IF EXISTS temp._bm")
    conn.execute("CREATE TEMP TABLE _bm (match_id INTEGER PRIMARY KEY, created_at INTEGER)")
    where, params = ["mp.bot_id = ?", "m.status = 'ended'"], [bot_id]
    if version is not None:
        lo, hi = version_window(conn, bot_id, version)
        where.append("m.created_at >= ?")
        params.append(lo)
        if hi is not None:
            where.append("m.created_at < ?")
            params.append(hi)
    if sample == "analysis":
        # ANALYSIS.md's sample: 4+ real bots, last 3 days up to the newest ended match.
        if until is None:
            until_us = conn.execute(
                "SELECT MAX(created_at) FROM match_state WHERE status = 'ended'").fetchone()[0]
        else:
            until_us = parse_since(until)[1] * 1000
        where += ["m.created_at >= ?", "m.created_at <= ?",
                  "(SELECT SUM(b.is_simulated = 0) FROM match_participant o JOIN bot b ON b.id = o.bot_id"
                  " WHERE o.match_id = m.id) >= 4"]
        params += [until_us - 3 * 86400 * 1_000_000, until_us]
    conn.execute(
        f"INSERT OR IGNORE INTO _bm SELECT m.id, m.created_at FROM match_participant mp "
        f"JOIN match_state m ON m.id = mp.match_id WHERE {' AND '.join(where)}", params)
    rows = conn.execute("""
        WITH lastid AS (
          SELECT match_id, MAX(auction_id) AS aid FROM auction_result
          WHERE match_id IN (SELECT match_id FROM _bm) GROUP BY match_id),
        la AS (
          SELECT a.match_id, a.winner_bot_id, a.paid FROM auction_result a
          JOIN lastid l ON a.auction_id = l.aid)
        SELECT mp.match_id, bm.created_at, mp.score, mp.balance,
          (SELECT COUNT(*) FROM match_participant o
             WHERE o.match_id = mp.match_id AND o.score > mp.score),
          (SELECT COUNT(*) FROM auction_result a
             WHERE a.match_id = mp.match_id AND a.winner_bot_id = mp.bot_id),
          (SELECT COALESCE(SUM(a.paid), 0) FROM auction_result a
             WHERE a.match_id = mp.match_id AND a.winner_bot_id = mp.bot_id),
          (SELECT COALESCE(SUM(LENGTH(w.word) >= 7), 0) FROM word_play w
             WHERE w.match_id = mp.match_id AND w.bot_id = mp.bot_id),
          la.winner_bot_id = mp.bot_id, la.paid
        FROM match_participant mp JOIN _bm bm USING (match_id)
        LEFT JOIN la ON la.match_id = mp.match_id
        WHERE mp.bot_id = ?
        GROUP BY mp.match_id""", (bot_id,)).fetchall()
    return [{
        "match_id": mid, "start_ms": created / 1000, "score": score, "balance": bal,
        "place": 1 + higher, "won": won, "spent": spent, "w7": w7,
        "last_won": bool(lw), "last_paid": lp if lw else 0,
    } for mid, created, score, bal, higher, won, spent, w7, lw, lp in rows]


# ---------- logs source ----------

def read_logs(path):
    """All JSONL events under a directory (or one file), grouped by matchId."""
    files = []
    if os.path.isfile(path):
        files = [path]
    else:
        for root, _, names in os.walk(path):
            files += [os.path.join(root, n) for n in names if n.endswith(".jsonl")]
    matches, bad = defaultdict(list), 0
    for f in sorted(files):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    bad += 1
                    continue
                if "matchId" in ev:
                    matches[str(ev["matchId"])].append(ev)
    return matches, bad


def log_match(mid, events):
    """One match's events -> record (outcome metrics need match_end) + timing."""
    by = defaultdict(list)
    for ev in events:
        by[ev.get("event")].append(ev)
    start = by["match_start"][0] if by["match_start"] else {}
    start_ms = start.get("startedAtMs") or min((e.get("ms") or 0) for e in events)
    bids = by["bid_sent"] + by["bid_skipped"]
    rec = {
        "match_id": int(mid) if str(mid).isdigit() else mid,
        "start_ms": start_ms,
        "ended": bool(by["match_end"]),
        "decide_ms": [b["decideMs"] for b in bids if isinstance(b.get("decideMs"), (int, float))],
        "since_open_ms": [b["sinceOpenMs"] for b in by["bid_sent"]
                          if isinstance(b.get("sinceOpenMs"), (int, float))],
        "open_basis": Counter(b.get("openBasis") for b in by["bid_sent"]),
        "bid_errors": [e.get("error", "") for e in by["bid_error"]],
        "word_rejected": [e.get("error", "") for e in by["word_rejected"]],
        "budget_reasons": Counter(b.get("budgetReason") for b in bids if b.get("budgetReason")),
    }
    results = {e.get("auctionId"): e for e in by["auction_result"]}
    rec["won"] = sum(1 for e in results.values() if e.get("won"))
    rec["spent"] = sum(e.get("paid") or 0 for e in results.values() if e.get("won"))
    rec["w7"] = sum(1 for e in by["word_played"]
                    if e.get("mine") and len(e.get("word") or "") >= 7)
    # Last auction: the one seen with an empty bag, else the highest result id.
    last_id = next((e.get("auctionId") for e in by["auction_seen"] if e.get("bagTotal") == 0), None)
    if last_id is None and rec["ended"] and results:
        last_id = max(results, key=lambda k: (k is not None, k or 0))
    last_res = results.get(last_id) if last_id is not None else None
    rec["last_won"] = bool(last_res and last_res.get("won"))
    rec["last_paid"] = (last_res.get("paid") or 0) if rec["last_won"] else 0
    sent = [b for b in by["bid_sent"] if b.get("auctionId") == last_id and last_id is not None]
    any_bid = [b for b in bids if b.get("auctionId") == last_id and last_id is not None]
    rec["last_auction_known"] = last_id is not None
    rec["bid_on_last"] = bool(sent)
    rec["last_reason"] = any_bid[-1].get("budgetReason") if any_bid else None
    if rec["ended"]:
        end = by["match_end"][-1]
        standings = end.get("standings") or []
        me = next((s for s in standings if s.get("me")), None)
        if me is None and start.get("myBotId") is not None:
            me = next((s for s in standings if s.get("botId") == start.get("myBotId")), None)
        if me is None:
            rec["ended"] = False  # can't score a match we can't find ourselves in
        else:
            rec["bot"] = me.get("name")
            rec["score"] = me.get("score") or 0
            rec["balance"] = me.get("balance") or 0
            rec["place"] = place_of(rec["score"], [s.get("score") or 0 for s in standings])
    return rec


def timing_summary(recs):
    decide = [x for r in recs for x in r["decide_ms"]]
    since = [x for r in recs for x in r["since_open_ms"]]
    errors = [e for r in recs for e in r["bid_errors"]]
    rejected = [e for r in recs for e in r["word_rejected"]]
    reasons, basis = Counter(), Counter()
    for r in recs:
        reasons.update(r["budget_reasons"])
        basis.update(r["open_basis"])
    known = [r for r in recs if r["last_auction_known"]]
    stat = lambda v: {"n": len(v), "p50": percentile(v, 50), "p95": percentile(v, 95),
                      "max": max(v) if v else None}
    return {
        "decide_ms": stat(decide),
        "since_open_ms": stat(since),
        "open_basis": dict(basis),
        "bid_errors": len(errors),
        "bid_errors_closed": sum(1 for e in errors if CLOSED_RE.search(e)),
        "word_rejected": len(rejected),
        "word_rejected_unexpected": sum(1 for e in rejected if not EXPECTED_WORD_REJECT_RE.search(e)),
        "budget_reasons": dict(reasons.most_common()),
        "last_auction_seen": len(known),
        "bid_on_last": sum(r["bid_on_last"] for r in known),
        "last_reasons": dict(Counter(r["last_reason"] for r in known if r["last_reason"])),
    }


def b7_verdict(t, n_matches):
    """PLAN.md "When to pick up B-7": slow decisions, late bids, missed auctions."""
    d95, s95 = t["decide_ms"]["p95"], t["since_open_ms"]["p95"]
    slow = d95 is not None and d95 > B7_DECIDE_MS
    late = s95 is not None and s95 > B7_SINCE_OPEN_MS
    missed = t["bid_errors_closed"] > 0 or t["word_rejected_unexpected"] > 0
    reasons = []
    if slow:
        reasons.append(f"decide p95 {d95:.0f} ms > {B7_DECIDE_MS}")
    if late:
        reasons.append(f"sinceOpen p95 {s95:.0f} ms > {B7_SINCE_OPEN_MS}")
    if t["bid_errors_closed"]:
        reasons.append(f"{t['bid_errors_closed']} closed/expired bid errors")
    if t["word_rejected_unexpected"]:
        reasons.append(f"{t['word_rejected_unexpected']} words rejected (not 'Match not running')")
    if slow or missed:
        verdict = "pick up B-7"
    elif late:
        verdict = "late bids but fast decisions: network distance, run closer to the server"
    else:
        verdict = "B-7 not needed"
    if n_matches < B7_MIN_MATCHES:
        verdict += f" (only {n_matches} matches; PLAN wants {B7_MIN_MATCHES}+)"
    return {"verdict": verdict, "slow": slow, "late": late, "missed": missed, "reasons": reasons}


def logs_report(path, bot=None, since=None, last=None):
    matches, bad = read_logs(path)
    recs = [log_match(mid, evs) for mid, evs in matches.items()]
    if bot:
        recs = [r for r in recs if r.get("bot") is None or (r.get("bot") or "").lower() == bot.lower()]
    recs = apply_filters(recs, since, last)
    ended = [r for r in recs if r["ended"]]
    t = timing_summary(recs)
    return {
        "source": "logs", "path": path, "bad_lines": bad,
        "matches_in_logs": len(recs), "incomplete_matches": len(recs) - len(ended),
        "metrics": aggregate(ended), "timing": t, "b7": b7_verdict(t, len(recs)),
    }


# ---------- main ----------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", help="SQLite DB from pull_data.py (default data/scrabble.db)")
    ap.add_argument("--logs", help="directory of S0-4 JSONL logs (or one file)")
    ap.add_argument("--bot", help="our bot's name (required for --db; optional filter for --logs)")
    ap.add_argument("--refresh", action="store_true", help="run pull_data.py first (resumable)")
    ap.add_argument("--since", help="ISO time or match id (inclusive)")
    ap.add_argument("--last", type=int, help="only the last N matches")
    ap.add_argument("--version", type=int, help="DB only: bot version N (from bot_version)")
    ap.add_argument("--sample", choices=["all", "analysis"], default="all",
                    help="DB only: 'analysis' = ANALYSIS.md's 3-day, 4+ real-bot sample")
    ap.add_argument("--until", help="DB only, with --sample analysis: end of the 3-day window (ISO)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    a = ap.parse_args(argv)
    since = parse_since(a.since) if a.since else None

    if a.logs:
        rep = logs_report(a.logs, a.bot, since, a.last)
    else:
        db = a.db or "data/scrabble.db"
        if a.refresh:
            subprocess.run([sys.executable, "-I", os.path.join(HERE, "pull_data.py"), "--db", db],
                           check=True)
        if not os.path.exists(db):
            sys.exit(f"{db} not found: run analysis/pull_data.py, pass --refresh, or use --logs")
        if not a.bot:
            sys.exit("--bot NAME is required with --db")
        conn = sqlite3.connect(db)
        bot_id, bot_name = find_bot(conn, a.bot)
        recs = db_records(conn, bot_id, a.sample, a.until, a.version)
        recs = apply_filters(recs, since, a.last)
        rep = {"source": "db", "path": db, "bot": bot_name, "bot_id": bot_id,
               "sample": a.sample, "version": a.version, "metrics": aggregate(recs)}
    rep["filters"] = {"since": a.since, "last": a.last}

    if a.json:
        print(json.dumps(rep, indent=2, default=str))
        return 0
    m = rep["metrics"]
    who = rep.get("bot") or a.bot or "all bots in logs"
    print(f"{who} — {rep['source']} {rep['path']}"
          + (f", sample={rep['sample']}" if rep.get("sample") else "")
          + (f", version={rep['version']}" if rep.get("version") else "")
          + (f", matches {m['first_match']}..{m['last_match']}" if m.get("matches") else ""))
    if not m.get("matches"):
        print("no finished matches match the filters")
    else:
        print_table(HEADER, table_rows(m))
    if rep["source"] == "logs":
        t, b = rep["timing"], rep["b7"]
        print(f"\nLogs: {rep['matches_in_logs']} matches ({rep['incomplete_matches']} without match_end),"
              f" {rep['bad_lines']} bad lines")
        for k, label in (("decide_ms", "decideMs"), ("since_open_ms", "sinceOpenMs")):
            s = t[k]
            print(f"{label:12} n={s['n']} p50={fmt(s['p50'], 1)} p95={fmt(s['p95'], 1)} max={fmt(s['max'], 1)}")
        print(f"openBasis    {t['open_basis']}")
        print(f"bid_error    {t['bid_errors']} ({t['bid_errors_closed']} closed/expired)")
        print(f"word_rejected {t['word_rejected']} ({t['word_rejected_unexpected']} not 'Match not running')")
        print(f"budgetReason {t['budget_reasons']}")
        print(f"last auction bid on in {t['bid_on_last']} of {t['last_auction_seen']} matches;"
              f" reasons {t['last_reasons']}")
        print(f"B-7: {b['verdict']}" + (f" [{'; '.join(b['reasons'])}]" if b["reasons"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
