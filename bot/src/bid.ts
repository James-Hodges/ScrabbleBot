// Bid formula (S2-3): bid = min(value-based ceiling, market cap).
//
//   value     = letterValues(...)[letter]   expected points gained (value.ts, S2-2)
//   ceiling   = value × COINS_PER_POINT     the most a point of value is worth in coins
//   marketCap = priceFor(letter, round, pct) a winning bid from the table (prices.ts, S2-1)
//   amount    = min(ceiling, marketCap, balance), rounded; 0 when value < MIN_VALUE_POINTS
//
// Why: auctions are Vickrey, so we pay the second-highest bid and bidding
// up to our true value (the ceiling) is the base rule. The market cap stops
// us bidding far above what usually wins: past it we would mostly be paying
// more only against outlier bids. The percentile rises with how much we want
// the letter (ceiling relative to the median winning bid), and to at least
// p75 when the letter completes a word right now.
//
// The exchange rate: winners spend ~225 coins for ~161 points (ANALYSIS.md),
// ~0.7 points per coin, which suggested ~1.4 coins of bid per point. Live,
// 1.4 left the ceiling binding on 62 of 64 bids (match 45094: 8 tiles won,
// 6th of 6), because S2-2's early values (3-7 points) understate what a
// tile is worth over a whole match. S3-2 tuning step 1 raises it to 2.3 so
// a typical early value (~5 points) reaches the market median (~11-12).
//
// Pure. applyBudget (budget.ts) post-processes `amount` for the match clock;
// a 0 here stays 0 there.

import { priceFor, type Pct } from "./prices.js";
import type { ValueTable } from "./value.js";

/** Coins of bid per expected point of value. Tuned in S3-2 (was 1.4). */
export const COINS_PER_POINT = 2.3;
/** Below this many expected points a letter is unusable to us: bid 0. */
export const MIN_VALUE_POINTS = 0.5;
/** Default market percentile. */
export const BASE_PCT: Pct = 50;
/** ceiling ≥ this × p50 → want it a lot: cap at p75. */
export const WANT_P75_RATIO = 1.25;
/** ceiling ≥ this × p50 → want it badly: cap at p90. */
export const WANT_P90_RATIO = 1.75;
/** Percentile floor when the letter completes a word playable now. */
export const COMPLETES_WORD_PCT: Pct = 75;

export interface RawBidContext {
  letter: string;
  /** letterValues' table, or its `values` (index 0..25 = A..Z). */
  values: ValueTable | Float64Array;
  balance: number;
  /** Auctions left including the open one (for logs/tuning; value already folds it in). */
  auctionsLeft: number;
  /** 1-based round, picks the price phase. */
  round: number;
  /** Override the price lookup (tests, tuning). */
  prices?: (letter: string, round: number, pct: Pct) => number;
  /** The letter finishes a dictionary word with the current rack. */
  completesWord?: boolean;
}

export type RawBidReason =
  | "no_value" // value below MIN_VALUE_POINTS (incl. the final auction)
  | "no_balance"
  | "ceiling" // value-limited
  | "market" // capped by the price table
  | "balance"; // capped by our balance

export interface RawBid {
  amount: number;
  /** Expected points from value.ts. */
  value: number;
  /** value × COINS_PER_POINT (unrounded). */
  ceiling: number;
  /** Price-table cap at `pct` (Infinity when the letter has no price data). */
  marketCap: number;
  pct: Pct;
  reason: RawBidReason;
}

const A = 65;

function valueFor(values: ValueTable | Float64Array, letter: string): number {
  const arr = values instanceof Float64Array ? values : values.values;
  const i = letter.toUpperCase().charCodeAt(0) - A;
  return letter.length === 1 && i >= 0 && i < 26 ? arr[i] : 0;
}

/** Market percentile from how much we want the letter. */
export function pctFor(ceiling: number, p50: number, completesWord = false): Pct {
  let pct: Pct = BASE_PCT;
  if (ceiling >= WANT_P90_RATIO * p50) pct = 90;
  else if (ceiling >= WANT_P75_RATIO * p50) pct = 75;
  if (completesWord && pct < COMPLETES_WORD_PCT) pct = COMPLETES_WORD_PCT;
  return pct;
}

export function rawBid(ctx: RawBidContext): RawBid {
  const value = valueFor(ctx.values, ctx.letter);
  const ceiling = value * COINS_PER_POINT;
  const balance = Math.max(0, Math.floor(ctx.balance));
  const lookup = ctx.prices ?? priceFor;
  const price = (pct: Pct): number => {
    try {
      return lookup(ctx.letter, ctx.round, pct);
    } catch {
      return Infinity; // unknown letter: value alone decides
    }
  };

  if (!(value >= MIN_VALUE_POINTS)) {
    return { amount: 0, value, ceiling, marketCap: price(BASE_PCT), pct: BASE_PCT, reason: "no_value" };
  }
  const pct = pctFor(ceiling, price(50), ctx.completesWord);
  const marketCap = price(pct);
  if (balance <= 0) return { amount: 0, value, ceiling, marketCap, pct, reason: "no_balance" };

  let amount = Math.round(Math.min(ceiling, marketCap));
  let reason: RawBidReason = ceiling <= marketCap ? "ceiling" : "market";
  if (amount > balance) {
    amount = balance;
    reason = "balance";
  }
  return { amount: Math.max(0, amount), value, ceiling, marketCap, pct, reason };
}

/**
 * True when the letter's main target word (letterValues with `explain`) can
 * be spelled from rack + letter right now. False without targets.
 */
export function completesTarget(table: ValueTable, rack: Map<string, number>, letter: string): boolean {
  const i = letter.toUpperCase().charCodeAt(0) - A;
  const word = table.targets?.[i]?.word;
  if (!word) return false;
  const have = new Map(rack);
  have.set(letter, (have.get(letter) ?? 0) + 1);
  for (const c of word) {
    const n = have.get(c) ?? 0;
    if (n <= 0) return false;
    have.set(c, n - 1);
  }
  return true;
}
