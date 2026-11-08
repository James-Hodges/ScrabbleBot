// λ bid (S3-4): the bid that maximises expected surplus at the exchange rate λ.
//
//   U(b)   = P(win | b) · v − λ · E[pay · 1{win} | b]     (points)
//   amount = argmax_b U(b) over integers b in [0, balance] (lowest b on ties)
//
// v is the open letter's value in points (lambdaValue below), λ is from
// lambda.ts, P(win) and E[pay] from rivalBids.ts. Under Vickrey with a
// continuous CDF the optimum is the truthful bid v/λ; the integer search
// keeps it exact with the tie-share CDF and the balance cap, and would also
// shade bids under a first-price rule if we ever pass one in.
//
// Bid 0 on the final auction (its letter can't be played) and when
// v < MIN_VALUE_POINTS.
//
// What we kept from bid.ts (Ryan's overrides):
//   * completesBingo: if the letter completes a 7+ letter word (that clears
//     the phase's minimum reward) we couldn't spell before, v is at least
//     BINGO_VALUE_SHARE × that word's reward: the reward is immediate and
//     certain, which value.ts' averaged futures understate.
// Dropped (λ and the rival model now do their job): COINS_PER_POINT, the
// p50/p75/p90 market caps, the completes-word/snowball percentile floors,
// the vowel-ratio / high-synergy / duplicate bumps, applyBudget's spend-down
// and the bomb reserve (λ paces spending over the whole match instead).

import { MIN_VALUE_POINTS, completesBingo } from "./bid.js";
import { expectedPay, pWin, type RivalDist } from "./rivalBids.js";
import type { Rack, WordIndex } from "./words.js";

/** Share of a completed 7+ word's reward used as the letter's minimum value. */
export const BINGO_VALUE_SHARE = 0.9;

export interface LambdaValue {
  value: number;
  /** The table's value before the bingo override. */
  tableValue: number;
  bingo?: { word: string; reward: number };
}

/** The open letter's value for λ bidding: table value, raised for a bingo completer. */
export function lambdaValue(
  tableValue: number,
  rack: Rack | undefined,
  letter: string,
  index: WordIndex | undefined,
  minReward = 0,
): LambdaValue {
  const bingo = rack && index ? completesBingo(rack, letter, index, minReward) : null;
  if (bingo && BINGO_VALUE_SHARE * bingo.reward > tableValue)
    return { value: BINGO_VALUE_SHARE * bingo.reward, tableValue, bingo };
  return { value: tableValue, tableValue, bingo: bingo ?? undefined };
}

export type LambdaBidReason = "last_auction" | "no_value" | "no_balance" | "lambda" | "balance";

export interface LambdaBidContext {
  value: number;
  lambda: number;
  balance: number;
  isLastAuction: boolean;
  dist: RivalDist;
  /** In-match rival scale. Default 1. */
  scale?: number;
}

export interface LambdaBid {
  amount: number;
  /** P(win) at the chosen bid. */
  pWin: number;
  /** E[price | win] at the chosen bid (0 when amount is 0). */
  ePrice: number;
  /** v / λ, the unconstrained truthful bid (coins). */
  truthful: number;
  reason: LambdaBidReason;
}

export function lambdaBid(ctx: LambdaBidContext): LambdaBid {
  const balance = Math.max(0, Math.floor(ctx.balance));
  const v = ctx.value;
  const truthful = ctx.lambda > 0 ? v / ctx.lambda : Infinity;
  const none = (reason: LambdaBidReason): LambdaBid => ({ amount: 0, pWin: 0, ePrice: 0, truthful, reason });
  if (ctx.isLastAuction) return none("last_auction");
  if (!(v >= MIN_VALUE_POINTS)) return none("no_value");
  if (balance <= 0) return none("no_balance");

  const s = ctx.scale ?? 1;
  let best = 0;
  let bestU = 0;
  for (let b = 1; b <= balance; b++) {
    const u = pWin(ctx.dist, b, s) * v - ctx.lambda * expectedPay(ctx.dist, b, s);
    if (u > bestU + 1e-12) {
      bestU = u;
      best = b;
    }
  }
  if (best === 0) return none("lambda");
  const w = pWin(ctx.dist, best, s);
  return {
    amount: best,
    pWin: w,
    ePrice: w > 0 ? expectedPay(ctx.dist, best, s) / w : 0,
    truthful,
    reason: best === balance && truthful > balance ? "balance" : "lambda",
  };
}
