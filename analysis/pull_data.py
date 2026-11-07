"""Download the public ScrabbleBot match history into a local SQLite file.

Usage: python3 analysis/pull_data.py [--db data/scrabble.db]

Uses SpacetimeDB's HTTP SQL endpoint with a throwaway anonymous identity.
Big tables are fetched in ID ranges so no single request is huge. Re-running
resumes each paged table from the highest ID already saved.
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.request

HOST = "https://maincloud.spacetimedb.com"
DB = "scrabblebot"
CHUNK = 50_000

# table -> (id column for paging, or None to fetch whole table)
TABLES = {
    "bot": None,
    "team": None,
    "bot_stats": None,
    "bot_version": None,
    "match_state": "id",
    "match_participant": "id",
    "word_play": "id",
    "auction_result": "auction_id",
    "auction_top_bid_archive": "auction_id",
}


def new_token() -> str:
    req = urllib.request.Request(f"{HOST}/v1/identity", method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["token"]


def sql(token: str, query: str):
    for attempt in range(5):
        req = urllib.request.Request(
            f"{HOST}/v1/database/{DB}/sql",
            data=query.encode(),
            method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read().decode()
            result = json.loads(body)[0]
            return result["schema"]["elements"], result["rows"]
        except Exception as e:  # network hiccup or rate limit: back off and retry
            wait = 2 ** attempt
            print(f"  retry in {wait}s after error: {e}", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"query failed: {query}")


def column_info(elements):
    """Return (name, kind) for each column, where kind tells us how to flatten it."""
    cols = []
    for el in elements:
        name = el["name"]["some"]
        t = el["algebraic_type"]
        if "Product" in t:
            kind = "timestamp"
        elif "Sum" in t:
            variants = [v["name"]["some"] for v in t["Sum"]["variants"]]
            inner = t["Sum"]["variants"][0]["algebraic_type"]
            if variants == ["some", "none"]:
                kind = "opt_timestamp" if "Product" in inner else "opt"
            else:
                kind = ("enum", variants)
        else:
            kind = "plain"
        cols.append((name, kind))
    return cols


def flatten(value, kind):
    if kind == "plain":
        return value
    if kind == "timestamp":
        return value[0]
    if kind in ("opt", "opt_timestamp"):
        tag, inner = value
        if tag != 0:
            return None
        return inner[0] if kind == "opt_timestamp" else inner
    _, variants = kind
    return variants[value[0]]


def save(conn, table, cols, rows):
    names = [c for c, _ in cols]
    conn.execute(
        f"CREATE TABLE IF NOT EXISTS {table} ({', '.join(names)})"
    )
    flat = [[flatten(v, k) for v, (_, k) in zip(row, cols)] for row in rows]
    conn.executemany(
        f"INSERT INTO {table} VALUES ({', '.join('?' * len(names))})", flat
    )
    conn.commit()


def count(token, table):
    _, rows = sql(token, f"SELECT COUNT(*) AS n FROM {table}")
    return rows[0][0]


def pull_whole(conn, token, table):
    conn.execute(f"DROP TABLE IF EXISTS {table}")
    elements, rows = sql(token, f"SELECT * FROM {table}")
    save(conn, table, column_info(elements), rows)
    print(f"{table}: {len(rows)} rows")


def pull_paged(conn, token, table, key):
    total = count(token, table)
    try:
        start = conn.execute(f"SELECT MAX({key}) FROM {table}").fetchone()[0] or 0
        have = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    except sqlite3.OperationalError:
        start, have = 0, 0
    empty_streak = 0
    while have < total and empty_streak < 5:
        hi = start + CHUNK
        elements, rows = sql(
            token, f"SELECT * FROM {table} WHERE {key} > {start} AND {key} <= {hi}"
        )
        if rows:
            save(conn, table, column_info(elements), rows)
            have += len(rows)
            empty_streak = 0
        else:
            empty_streak += 1
        start = hi
        print(f"{table}: {have}/{total}", end="\r", flush=True)
        time.sleep(0.2)  # be gentle with the shared server
    print(f"{table}: {have}/{total} rows")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/scrabble.db")
    args = ap.parse_args()
    conn = sqlite3.connect(args.db)
    token = new_token()
    for table, key in TABLES.items():
        if key is None:
            pull_whole(conn, token, table)
        else:
            pull_paged(conn, token, table, key)
    conn.close()


if __name__ == "__main__":
    main()
