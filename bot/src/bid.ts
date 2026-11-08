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
// S2-6 early coin snowball: while round <= EARLY_ROUNDS and we have not yet
// played a 5+ letter word this match, letters worth >= EARLY_MIN_VALUE get
// their ceiling × EARLY_BOOST, and letters that leave their 5+ letter target
// word at most one tile short (nearTarget) also get the market percentile
// raised one step (p50→p75→p90). The first long word's reward (~40 coins)
// then funds the rest of the match. Off unless the caller passes
// haveLongWord: false, so old callers keep the old numbers.
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

/** Boost only up to and including this round. */
export const EARLY_ROUNDS = 20;
/** Early ceiling multiplier. */
export const EARLY_BOOST = 1.5;
/** Letters below this many points get no early boost (junk stays low/0). */
export const EARLY_MIN_VALUE = 3;
/** A "long" word: our first one of at least this length ends the boost. */
export const LONG_WORD_LEN = 5;

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
  /**
   * S2-6: we have already played a LONG_WORD_LEN+ word this match. Only an
   * explicit `false` turns the early boost on; undefined keeps it off.
   */
  haveLongWord?: boolean;
  /** S2-6: the letter leaves a 5+ letter target word at most one tile short (nearTarget()). */
  nearTarget?: boolean;
}

export type BoostReason =
  | "off" // caller gave no haveLongWord
  | "have_long_word"
  | "late" // round > EARLY_ROUNDS
  | "low_value" // value < EARLY_MIN_VALUE
  | "early" // ceiling × EARLY_BOOST
  | "early_near"; // ceiling × EARLY_BOOST and percentile +1 step

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
  /** value × COINS_PER_POINT × boost (unrounded). */
  ceiling: number;
  /** Price-table cap at `pct` (Infinity when the letter has no price data). */
  marketCap: number;
  pct: Pct;
  reason: RawBidReason;
  /** S2-6 ceiling multiplier (1 = none). */
  boost: number;
  boostReason: BoostReason;
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

/** One percentile step up (p90 stays p90). */
export function bumpPct(pct: Pct): Pct {
  return pct === 25 ? 50 : pct === 50 ? 75 : 90;
}

/** S2-6: whether the early boost applies, and why (not). */
export function earlyBoost(
  value: number,
  round: number,
  haveLongWord: boolean | undefined,
  nearTarget = false,
): { boost: number; boostReason: BoostReason } {
  if (haveLongWord === undefined) return { boost: 1, boostReason: "off" };
  if (haveLongWord) return { boost: 1, boostReason: "have_long_word" };
  if (round > EARLY_ROUNDS) return { boost: 1, boostReason: "late" };
  if (!(value >= EARLY_MIN_VALUE)) return { boost: 1, boostReason: "low_value" };
  return { boost: EARLY_BOOST, boostReason: nearTarget ? "early_near" : "early" };
}

export function rawBid(ctx: RawBidContext): RawBid {
  const value = valueFor(ctx.values, ctx.letter);
  const { boost, boostReason } = earlyBoost(value, ctx.round, ctx.haveLongWord, ctx.nearTarget);
  const ceiling = value * COINS_PER_POINT * boost;
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
    return {
      amount: 0,
      value,
      ceiling,
      marketCap: price(BASE_PCT),
      pct: BASE_PCT,
      reason: "no_value",
      boost,
      boostReason,
    };
  }
  let pct = pctFor(ceiling, price(50), ctx.completesWord);
  if (boostReason === "early_near") pct = bumpPct(pct);
  const marketCap = price(pct);
  if (balance <= 0) return { amount: 0, value, ceiling, marketCap, pct, reason: "no_balance", boost, boostReason };

  let amount = Math.round(Math.min(ceiling, marketCap));
  let reason: RawBidReason = ceiling <= marketCap ? "ceiling" : "market";
  if (amount > balance) {
    amount = balance;
    reason = "balance";
  }
  return { amount: Math.max(0, amount), value, ceiling, marketCap, pct, reason, boost, boostReason };
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

/**
 * S2-6: the letter's target word (letterValues with `explain`) has at least
 * LONG_WORD_LEN letters and rack + letter is at most one tile short of it.
 * False without targets.
 */
export function nearTarget(table: ValueTable, rack: Map<string, number>, letter: string): boolean {
  const i = letter.toUpperCase().charCodeAt(0) - A;
  const word = table.targets?.[i]?.word;
  if (!word || word.length < LONG_WORD_LEN) return false;
  const have = new Map(rack);
  have.set(letter, (have.get(letter) ?? 0) + 1);
  let missing = 0;
  for (const c of word) {
    const n = have.get(c) ?? 0;
    if (n <= 0) missing++;
    else have.set(c, n - 1);
  }
  return missing <= 1;
}

/** S2-6: we have played a LONG_WORD_LEN+ letter word in this match. */
export function playedLongWord(words: Iterable<{ botId: bigint; word: string }>, myBotId: bigint): boolean {
  for (const w of words) if (w.botId === myBotId && w.word.length >= LONG_WORD_LEN) return true;
  return false;
}
