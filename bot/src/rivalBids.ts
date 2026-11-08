// Highest-rival-bid model (S3-4): P(win | bid) and the expected Vickrey price.
//
// rivalBids.json (analysis/export_rival_bids.py) holds, per table type
// ("real": no simulated bot seated, "sim": at least one), letter and match
// phase, quantiles of X = the highest bid among the other five players,
// jittered by U(-1/2, 1/2) so that the CDF at an integer bid b is
// P(X < b) + P(X = b)/2 (ties share the win). Between quantiles the CDF is
// linear (uniform density inside each quantile band).
//
// For our bid b (Vickrey: the winner pays the highest rival bid, a lone
// bidder pays 1):
//   pWin(b)        = F(b)
//   expectedPay(b) = E[max(1, X) · 1{X < b}]            (coins, unconditional)
//   expectedPrice  = expectedPay(b) / pWin(b)          (E[price | win at b])
//
// In-match calibration (CALIBRATE): one multiplicative scale s on every
// rival bid, X → s·X, learnt from this match's closed auctions:
//   log s += CALIB_RATE · (u − 1/2),
// u = the observation's mid-rank in the predicted distribution: F(paid) when
// we won (paid is exactly the highest rival bid), (F(paid − 1/2) + 1) / 2
// when someone else won (we only know X ≥ paid). Unsold auctions and the
// final auction are skipped. s is clamped to [SCALE_MIN, SCALE_MAX].
//
// Pure apart from reading the JSON once at import.

import fs from "node:fs";
import path from "node:path";

export type TableType = "real" | "sim";

/** Learn a per-match scale on rival bids from observed prices. */
export const CALIBRATE = true;
/** Step size of the log-scale update per observed auction. */
export const CALIB_RATE = 0.05;
export const SCALE_MIN = 0.6;
export const SCALE_MAX = 1.6;

interface RivalCell {
  q: number[];
  n: number;
  nDirect: number;
  fallback?: boolean;
}

export interface RivalTable {
  generatedAt: string;
  fromDate: string;
  toDate: string;
  phases: [number, number][];
  probs: number[];
  sample: Record<TableType, { matches: number; ourMatches: number; auctions: number }>;
  tables: Record<TableType, Record<string, RivalCell[]>>;
}

/** One distribution: CDF knots (q[i], p[i]), q non-decreasing. */
export interface RivalDist {
  q: Float64Array;
  p: Float64Array;
}

const jsonPath = path.join(path.dirname(new URL(import.meta.url).pathname), "rivalBids.json");

/** The table, read once at import. */
export const RIVAL_BIDS: RivalTable = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

const PROBS = Float64Array.from(RIVAL_BIDS.probs);
const DISTS: Record<TableType, Map<string, RivalDist[]>> = { real: new Map(), sim: new Map() };
for (const t of ["real", "sim"] as TableType[]) {
  for (const [letter, cells] of Object.entries(RIVAL_BIDS.tables[t] ?? {}))
    DISTS[t].set(
      letter,
      cells.map((c) => ({ q: Float64Array.from(c.q), p: PROBS })),
    );
}
/** Used for a letter missing from the table (never in practice). */
const GENERIC: RivalDist = { q: Float64Array.from([0, 8, 12, 16, 25, 60]), p: Float64Array.from([0, 0.1, 0.5, 0.8, 0.95, 1]) };

/** 0-based phase bucket for a 1-based round (rounds past the last bucket use the last). */
export function phaseIndex(round: number): number {
  const ph = RIVAL_BIDS.phases;
  for (let i = 0; i < ph.length; i++) if (round <= ph[i][1]) return i;
  return ph.length - 1;
}

export const PHASE_COUNT = RIVAL_BIDS.phases.length;

export function rivalDist(letter: string, round: number, tableType: TableType): RivalDist {
  const cells = DISTS[tableType].get(letter.toUpperCase()) ?? DISTS.real.get(letter.toUpperCase());
  return cells ? cells[phaseIndex(round)] : GENERIC;
}

/** Build a distribution from explicit knots (tests). */
export function distFrom(q: number[], p: number[]): RivalDist {
  return { q: Float64Array.from(q), p: Float64Array.from(p) };
}

/** P(s·X < x) under the linear-between-knots CDF (right-continuous at point masses). */
export function cdf(d: RivalDist, x: number, scale = 1): number {
  const { q, p } = d;
  const n = q.length;
  const t = x / scale;
  if (t < q[0]) return 0;
  if (t >= q[n - 1]) return 1;
  // Last knot with q ≤ t (q is short: linear scan).
  let i = 0;
  while (i + 1 < n && q[i + 1] <= t) i++;
  const span = q[i + 1] - q[i];
  return span > 0 ? p[i] + ((p[i + 1] - p[i]) * (t - q[i])) / span : p[i + 1];
}

/** P(win | bid b): the highest rival bid is below b (ties count half). */
export function pWin(d: RivalDist, b: number, scale = 1): number {
  return b <= 0 ? 0 : cdf(d, b, scale);
}

/** ∫ max(1, x) dx over [a, c] (a ≤ c). */
function intMax1(a: number, c: number): number {
  if (c <= 1) return c - a;
  if (a >= 1) return (c * c - a * a) / 2;
  return 1 - a + (c * c - 1) / 2;
}

/** E[price · 1{win}] at bid b: Σ over rival maxima below b of max(1, x). */
export function expectedPay(d: RivalDist, b: number, scale = 1): number {
  if (b <= 0) return 0;
  const { q, p } = d;
  let total = 0;
  for (let i = 0; i + 1 < q.length; i++) {
    const a = q[i] * scale;
    if (a >= b) break;
    const c = q[i + 1] * scale;
    const m = p[i + 1] - p[i];
    if (m <= 0) continue;
    if (c <= a) {
      total += m * Math.max(1, a); // point mass
      continue;
    }
    const hi = Math.min(b, c);
    total += (m / (c - a)) * intMax1(a, hi);
  }
  return total;
}

/** E[price | win at b] (0 when we cannot win). */
export function expectedPrice(d: RivalDist, b: number, scale = 1): number {
  const w = pWin(d, b, scale);
  return w > 0 ? expectedPay(d, b, scale) / w : 0;
}

/** Median of the highest rival bid (logs, sim). */
export function rivalMedian(d: RivalDist, scale = 1): number {
  const { q, p } = d;
  for (let i = 0; i + 1 < q.length; i++) {
    if (p[i + 1] >= 0.5 && p[i + 1] > p[i]) return scale * (q[i] + ((q[i + 1] - q[i]) * (0.5 - p[i])) / (p[i + 1] - p[i]));
  }
  return scale * q[q.length - 1];
}

/** A closed auction as the calibration reads it (state.ts AuctionEvent fits). */
export interface ObservedAuction {
  seq: number;
  letter: string;
  winnerBotId: bigint | null;
  paid: number;
}

/** Final auction of a 68-auction match; its bids say nothing about the market. */
const LAST_ROUND = 68;

/**
 * The per-match scale on rival bids, replayed from this match's closed
 * auctions (oldest first). 1 when CALIBRATE is off or nothing is observed.
 */
export function matchScale(
  auctions: readonly ObservedAuction[],
  myBotId: bigint,
  tableType: TableType,
  rate = CALIBRATE ? CALIB_RATE : 0,
): number {
  if (rate <= 0) return 1;
  let logS = 0;
  for (const a of auctions) {
    if (a.winnerBotId === null || a.seq >= LAST_ROUND) continue;
    const s = Math.exp(logS);
    const d = rivalDist(a.letter, a.seq, tableType);
    const u =
      a.winnerBotId === myBotId ? cdf(d, a.paid, s) : (cdf(d, Math.max(0, a.paid - 0.5), s) + 1) / 2;
    logS += rate * (u - 0.5);
    logS = Math.min(Math.log(SCALE_MAX), Math.max(Math.log(SCALE_MIN), logS));
  }
  return Math.exp(logS);
}
