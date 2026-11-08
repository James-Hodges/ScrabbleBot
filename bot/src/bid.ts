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
// ~0.7 points per coin, so one expected point is worth ~1.4 coins of bid.
//
// Pure. applyBudget (budget.ts) post-processes `amount` for the match clock;
// a 0 here stays 0 there.

import { priceFor, type Pct } from "./prices.js";
import type { ValueTable } from "./value.js";
import type { Rack, WordIndex } from "./words.js";

/**
 * Coins of bid per expected point of value. 2.3 tested best on main (S3-2:
 * average place 3.00 vs 6.0 at 1.4, 9 live matches; see PLAN.md tuning log).
 */
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
  /** Optional rack to perform exact leave and bingo checks. */
  rack?: Rack;
  /** Optional WordIndex to perform exact word-completion checks. */
  index?: WordIndex;
  /**
   * Smallest word reward we would play now (play.ts minRewardFor). Bingo and
   * snowball completions below it don't count. Default 0.
   */
  minReward?: number;
  /** Value never drops below this after the rack synergy adjustment (small-rack floor). Default 0. */
  floor?: number;
}

export type RawBidReason =
  | "no_value" // value below MIN_VALUE_POINTS (incl. the final auction)
  | "no_balance"
  | "ceiling" // value-limited
  | "market" // capped by the price table
  | "balance" // capped by our balance
  | "completes_bingo" // completes a 7+ letter word right now
  | "completes_snowball"; // completes an early 5+ letter word for cash

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
const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const HIGH_SYNERGY = new Set(["S", "E", "R", "T", "I", "N", "A"]);

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

/** Check if adding letter to rack completes a 7+ letter playable word not already spellable. */
export function completesBingo(
  rack: Rack,
  letter: string,
  index: WordIndex,
  minReward = 0,
): { word: string; reward: number } | null {
  const L = letter.toUpperCase();
  const next = new Map(rack);
  next.set(L, (next.get(L) ?? 0) + 1);
  const bestWith = index.best(next, { minLen: 7 });
  if (!bestWith || bestWith.reward < minReward) return null;
  const bestWithout = index.best(rack, { minLen: 7 });
  if (!bestWithout || bestWith.reward > bestWithout.reward) {
    return bestWith;
  }
  return null;
}

/** Check if adding letter to rack completes a 5+ letter word for early cash snowball. */
export function completesSnowball(
  rack: Rack,
  letter: string,
  index: WordIndex,
  balance: number,
  round: number,
  minReward = 0,
): { word: string; reward: number } | null {
  if (round > 25 && balance >= 35) return null;
  const bestWithout = index.best(rack, { minLen: 5 });
  if (bestWithout && balance >= 35) return null;

  const L = letter.toUpperCase();
  const next = new Map(rack);
  next.set(L, (next.get(L) ?? 0) + 1);
  const bestWith = index.best(next, { minLen: 5 });
  if (!bestWith || bestWith.reward < minReward) return null;
  if (!bestWithout || bestWith.reward > bestWithout.reward) {
    return bestWith;
  }
  return null;
}

export function rawBid(ctx: RawBidContext): RawBid {
  const balance = Math.max(0, Math.floor(ctx.balance));
  const lookup = ctx.prices ?? priceFor;
  const price = (pct: Pct): number => {
    try {
      return lookup(ctx.letter, ctx.round, pct);
    } catch {
      return Infinity;
    }
  };

  if (balance <= 0) {
    const value = valueFor(ctx.values, ctx.letter);
    return { amount: 0, value, ceiling: value * COINS_PER_POINT, marketCap: price(BASE_PCT), pct: BASE_PCT, reason: "no_balance" };
  }

  const bingo = ctx.rack && ctx.index ? completesBingo(ctx.rack, ctx.letter, ctx.index, ctx.minReward ?? 0) : null;
  const snowball = ctx.rack && ctx.index ? completesSnowball(ctx.rack, ctx.letter, ctx.index, balance, ctx.round, ctx.minReward ?? 0) : null;
  const isCompleter = Boolean(ctx.completesWord || bingo || snowball);

  let value = valueFor(ctx.values, ctx.letter);

  // If rack is available, adjust value for immediate rewards and synergy:
  if (ctx.rack) {
    const L = ctx.letter.toUpperCase();
    if (bingo) {
      value = Math.max(value, bingo.reward * 0.9);
    } else if (snowball) {
      value = Math.max(value, snowball.reward * 0.8);
    } else {
      let totalTiles = 0;
      let vowelCount = 0;
      for (const [ch, count] of ctx.rack) {
        totalTiles += count;
        if (VOWELS.has(ch)) vowelCount += count;
      }
      const isVowel = VOWELS.has(L);
      const vowelRatio = totalTiles > 0 ? vowelCount / totalTiles : 0.4;
      const copiesHave = ctx.rack.get(L) ?? 0;

      if (copiesHave >= 2 && value < 1.0 && (ctx.floor ?? 0) <= 0) {
        return { amount: 0, value: 0, ceiling: 0, marketCap: price(BASE_PCT), pct: BASE_PCT, reason: "no_value" };
      }

      let synergy = 0;
      if (copiesHave === 0 && HIGH_SYNERGY.has(L)) synergy += 3.5;
      if (isVowel) {
        if (vowelRatio < 0.30) synergy += 4.0;
        else if (vowelRatio > 0.50) synergy -= 3.0;
      } else {
        if (vowelRatio > 0.60) synergy += 4.0;
        else if (vowelRatio < 0.20) synergy -= 3.0;
      }
      if (copiesHave === 1 && !["E", "A", "I", "O", "R", "S", "T", "N"].includes(L)) {
        synergy -= 3.0;
      }
      value = Math.max(ctx.floor ?? 0, value + synergy);
    }
  }

  const ceiling = value * COINS_PER_POINT;

  if (!(value >= MIN_VALUE_POINTS)) {
    return { amount: 0, value, ceiling, marketCap: price(BASE_PCT), pct: BASE_PCT, reason: "no_value" };
  }

  const pct = pctFor(ceiling, price(50), isCompleter);
  const marketCap = price(pct);

  let amount = Math.round(Math.min(ceiling, marketCap));
  let reason: RawBidReason = ceiling <= marketCap ? "ceiling" : "market";

  if (bingo) {
    reason = "completes_bingo";
    amount = Math.max(amount, price(90));
  } else if (snowball) {
    reason = "completes_snowball";
    amount = Math.max(amount, price(75));
  }

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
