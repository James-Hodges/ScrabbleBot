// Match logger (S0-4): one JSONL file per match, one line per event.
//
// Lines look like { t, ms, event, matchId, ...fields }. bigint values are
// written as numbers when they are safe integers, else as strings.
//
// The logger runs inside the 1-second auction window, so it writes with a
// synchronous write() on an already-open file descriptor (no promise or
// stream buffering to reason about) and it never throws: any I/O error is
// warned once and logging is switched off for that match.

import * as fs from "node:fs";
import * as path from "node:path";

export type Fields = Record<string, unknown>;

/** Default log directory: <repo root>/logs (git-ignored). */
export function defaultLogDir(): string {
  if (process.env.LOG_DIR) return process.env.LOG_DIR;
  const here = path.dirname(new URL(import.meta.url).pathname); // bot/src
  return path.join(here, "..", "..", "logs");
}

/** File name for a match log: <bot>-<matchId>-<YYYYMMDDTHHMMSSZ>.jsonl */
export function logFileName(
  botName: string,
  matchId: bigint | number | string,
  startMs: number,
): string {
  const safeBot = botName.replace(/[^A-Za-z0-9_.-]/g, "_") || "bot";
  const stamp = new Date(startMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return `${safeBot}-${matchId}-${stamp}.jsonl`;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value;
}

/** One JSONL line (with trailing newline). */
export function formatLine(
  event: string,
  matchId: bigint | number | string,
  fields: Fields,
  nowMs: number,
): string {
  return (
    JSON.stringify(
      { t: new Date(nowMs).toISOString(), ms: nowMs, event, matchId, ...fields },
      replacer,
    ) + "\n"
  );
}

/**
 * How long after the auction opened we sent the bid. Uses the server's
 * opensAt when we have it, else the time we first saw the auction.
 * Note: the "server" basis mixes server and local clocks, so it includes
 * any clock offset; compare with the "seen" basis (recvLagMs) to judge.
 */
export function sinceOpen(
  sendMs: number,
  serverOpenMs: number | undefined,
  firstSeenMs: number,
): { sinceOpenMs: number; openBasis: "server" | "seen" } {
  if (serverOpenMs !== undefined && Number.isFinite(serverOpenMs)) {
    return { sinceOpenMs: sendMs - serverOpenMs, openBasis: "server" };
  }
  return { sinceOpenMs: sendMs - firstSeenMs, openBasis: "seen" };
}

/** Rank participants by score (desc); ties share a place. */
export function placings<T extends { score: number }>(
  rows: T[],
): (T & { place: number })[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  let place = 0;
  let prev: number | undefined;
  return sorted.map((r, i) => {
    if (r.score !== prev) place = i + 1;
    prev = r.score;
    return { ...r, place };
  });
}

/** Per-match JSONL files under one directory. */
export class MatchLogs {
  private fds = new Map<string, number>();
  private paths = new Map<string, string>();
  private disabled = new Set<string>();

  constructor(
    readonly dir: string,
    readonly botName: string,
    private now: () => number = Date.now,
  ) {}

  /** Path of a match's log file (created on first event). */
  pathFor(matchId: bigint | number | string): string | undefined {
    return this.paths.get(String(matchId));
  }

  log(matchId: bigint | number | string, event: string, fields: Fields = {}) {
    const key = String(matchId);
    if (this.disabled.has(key)) return;
    try {
      const nowMs = this.now();
      let fd = this.fds.get(key);
      if (fd === undefined) {
        let p = this.paths.get(key);
        if (!p) {
          fs.mkdirSync(this.dir, { recursive: true });
          p = path.join(this.dir, logFileName(this.botName, matchId, nowMs));
          this.paths.set(key, p);
        }
        fd = fs.openSync(p, "a");
        this.fds.set(key, fd);
      }
      fs.writeSync(fd, formatLine(event, matchId, fields, nowMs));
    } catch (err) {
      this.disabled.add(key);
      console.warn(
        `[log] match ${key}: logging disabled: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Close a match's file. A later event reopens it in append mode. */
  close(matchId: bigint | number | string) {
    const key = String(matchId);
    const fd = this.fds.get(key);
    if (fd === undefined) return;
    this.fds.delete(key);
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  closeAll() {
    for (const key of [...this.fds.keys()]) this.close(key);
  }
}
