// Budget layer (S2-4, S2-5): post-processes whatever decideBid returns.
//
// decideBid (strategy.ts) says how much a letter is worth to us. This file
// only decides how the match clock changes that:
//
//   S2-5  Never pay for the last letter. The server's closeAuction
//         (spacetimedb/src/game.ts in clockworklabs/scrabblebot) gives the
//         letter to the winner, then calls drawLetter, which returns
//         undefined when bagTotal === 0, and sets the match to Ended in the
//         same reducer. submitWord (spacetimedb/src/index.ts) then throws
//         "Match not running", so the last letter can never be played.
//         drawLetter decrements bagTotal before the auction opens, so the
//         open auction is the last when bagTotal === 0 (state.isLastAuction).
//
//   S2-4  Spend down. Leftover coins are worthless (STRATEGY.md §1,
//         ANALYSIS.md "What this means" 5). In the last SPEND_DOWN_AUCTIONS
//         auctions we raise bids on letters decideBid already wants, so we
//         finish with about TARGET_LEFTOVER coins or fewer.
//
// The rule, in the spend-down window (not the last auction, rawBid > 0):
//   spendable    = auctionsLeft − 1          (non-last auctions, incl. this one)
//   surplus      = balance − TARGET_LEFTOVER (coins we want gone)
//   expectedWins = max(1, ceil(spendable × WANT_SHARE))
//   floor        = surplus / expectedWins    (coins per remaining win)
//   market       = priceFor(letter, round, pct), pct rising as auctions run out
//   target       = min(floor, market)        (don't overpay while time remains)
//                  floor alone when spendable ≤ ALL_IN_AUCTIONS
//   amount       = max(rawBid, ceil(target)), capped so we keep
//                  MIN_RESERVE_PER_AUCTION for each later non-last auction
//                  (unless this is the second-to-last), and never above balance.
// Outside the window: rawBid capped at balance (tuning left to S3-2), and at
// balance − reserveCoins: before our first (bomb) word we keep enough coins to
// buy the target word's remaining letters, since we can no longer refill
// with small words (index.ts sets reserveCoins via bombReserve).

import { priceFor, type Pct } from "./prices.js";

/** Spend-down starts when this many auctions are left (incl. the open one): round 55 of 68. */
export const SPEND_DOWN_AUCTIONS = 14;
/** Coins we aim to finish with (or fewer). */
export const TARGET_LEFTOVER = 10;
/** Share of the remaining non-last auctions we expect decideBid to want (and win). */
export const WANT_SHARE = 0.5;
/** Coins kept back for each later non-last auction, so we can still bid. */
export const MIN_RESERVE_PER_AUCTION = 1;
/** With this many non-last auctions left (incl. this one), bid the floor without a market cap. */
export const ALL_IN_AUCTIONS = 2;
/** Before the bomb lands, coins kept back per target tile still to buy. */
export const BOMB_RESERVE_PER_TILE = 6;
/**
 * Spending discipline before the first word (bomb phase, outside spend-down).
 * Live (S-bomb v2): we spent 90–96 of 100 coins in the first 8–18 auctions,
 * mostly on non-target letters at p75/p90, paying 14–18 per tile vs ~9.
 */
/** Normal per-letter cap: at most this share of the current balance... */
export const BOMB_LETTER_SHARE = 0.3;
/** ...and at most this market percentile of the letter's winning bid. */
export const BOMB_MARKET_PCT: Pct = 75;
/** A target letter leaving at most this many tiles missing counts as near-complete. */
export const BOMB_NEAR_MISSING = 2;
/** Near-complete cap: at most this share of the current balance (rawBid's market cap still applies). */
export const BOMB_NEAR_SHARE = 0.5;
/** Coins kept unspent until the target is within BOMB_NEAR_MISSING tiles of complete. */
export const BOMB_KEEP_COINS = 25;
/**
 * The floor only binds once the rack has this many tiles (5 starting + ~5 won)
 * or from BOMB_FLOOR_ROUND on: before that there is nothing to finish yet, so
 * holding coins back only stalls the build (live 46593 froze at 38 coins).
 */
export const BOMB_FLOOR_MIN_RACK = 10;
export const BOMB_FLOOR_ROUND = 35;
/**
 * Below the floor we still bid up to this share of the balance on a letter,
 * so a far target never leaves us bidding 0 on everything (the old stuck state).
 */
export const BOMB_BELOW_FLOOR_SHARE = 0.15;
/** The bomb reserve never exceeds this share of our balance (so it can't starve us). */
export const BOMB_RESERVE_MAX_SHARE = 0.5;
/**
 * Market percentile by non-last auctions left: the first row whose
 * `minSpendable` is ≤ spendable wins. Higher percentiles as time runs out.
 */
export const MARKET_PCT_SCHEDULE: { minSpendable: number; pct: Pct }[] = [
  { minSpendable: 9, pct: 50 },
  { minSpendable: 5, pct: 75 },
  { minSpendable: 0, pct: 90 },
];

export interface BudgetContext {
  isLastAuction: boolean;
  /** Auctions left including the open one (MatchState.auctionsLeft). */
  auctionsLeft: number;
  round: number;
  myBalance: number;
  /** Letter on the open auction. */
  letter: string;
  /** Coins to keep back outside the spend-down window (see bombReserve). Default 0. */
  reserveCoins?: number;
  /** Set before our first word (bomb phase): enables the spending discipline. */
  bomb?: BombBidInput;
}

export interface BombBidInput {
  /** Target tiles still missing before this auction (targetMissing), "" with no target. */
  missing: string;
  /** The target clears the current first-word cutoff. */
  targetOk: boolean;
  /** This letter completes a word we would play now (e.g. rawBid's completes_bingo). */
  completes: boolean;
  /** Tiles in our rack now (gates the coin floor). Default: floor always armed. */
  rackTiles?: number;
}

/** Whether the open letter completes or nearly completes a qualifying target. */
export function bombNear(b: BombBidInput, letter: string): boolean {
  if (b.completes) return true;
  if (!b.targetOk || !b.missing.includes(letter.toUpperCase())) return false;
  return b.missing.length - 1 <= BOMB_NEAR_MISSING;
}

/**
 * Bomb-phase cap on one bid. Returns the amount and which rule bound it.
 *   near-complete letter: ≤ BOMB_NEAR_SHARE × balance            ("bomb_near")
 *   otherwise:            ≤ min(BOMB_LETTER_SHARE × balance, p75) ("bomb_cap")
 *   target further than BOMB_NEAR_MISSING tiles, once armed (rack ≥ BOMB_FLOOR_MIN_RACK
 *   tiles or round ≥ BOMB_FLOOR_ROUND): keep BOMB_KEEP_COINS ("bomb_floor"),
 *   but still allow BOMB_BELOW_FLOOR_SHARE × balance; never for a near-complete letter.
 */
export function bombCap(
  raw: number,
  balance: number,
  letter: string,
  round: number,
  b: BombBidInput,
): { amount: number; reason: "bomb_cap" | "bomb_floor" | "bomb_near" | null } {
  const near = bombNear(b, letter);
  let amount = raw;
  let reason: "bomb_cap" | "bomb_floor" | "bomb_near" | null = null;
  if (near) {
    const cap = Math.floor(balance * BOMB_NEAR_SHARE);
    if (amount > cap) {
      amount = cap;
      reason = "bomb_near";
    }
    return { amount, reason };
  }
  let market = Infinity;
  try {
    market = priceFor(letter, round, BOMB_MARKET_PCT);
  } catch {
    // no price data: share cap only
  }
  const cap = Math.floor(Math.min(balance * BOMB_LETTER_SHARE, market));
  if (amount > cap) {
    amount = cap;
    reason = "bomb_cap";
  }
  const far = !b.targetOk || b.missing.length > BOMB_NEAR_MISSING;
  const armed = (b.rackTiles ?? Infinity) >= BOMB_FLOOR_MIN_RACK || round >= BOMB_FLOOR_ROUND;
  if (far && armed && amount > balance - BOMB_KEEP_COINS) {
    amount = Math.min(amount, Math.max(balance - BOMB_KEEP_COINS, Math.floor(balance * BOMB_BELOW_FLOOR_SHARE)));
    reason = "bomb_floor";
  }
  return { amount, reason };
}

/**
 * Coins to keep for the bomb target: BOMB_RESERVE_PER_TILE per tile still
 * missing, not counting the open letter when it is one of them, scaled by
 * affordShare (a target we can't afford isn't worth starving for; broke, no
 * reserve) and capped at BOMB_RESERVE_MAX_SHARE of the balance.
 */
export function bombReserve(missing: string, letter: string, balance = Infinity, affordShare = 1): number {
  const n = missing.length - (missing.includes(letter.toUpperCase()) ? 1 : 0);
  const raw = Math.max(0, n) * BOMB_RESERVE_PER_TILE * Math.max(0, Math.min(1, affordShare));
  return Math.floor(Math.min(raw, Math.max(0, balance) * BOMB_RESERVE_MAX_SHARE));
}

export type BudgetReason =
  | "last_auction"
  | "not_wanted"
  | "no_balance"
  | "normal"
  | "reserve"
  | "bomb_cap"
  | "bomb_floor"
  | "bomb_near"
  | "spend_down"
  | "spend_down_no_surplus";

export interface BudgetResult {
  amount: number;
  reason: BudgetReason;
  /** Coins per auction left (excluding the last). For logs. */
  pace: number;
  /** The raised target before caps, when in the spend-down window. */
  target?: number;
}

export function marketPctFor(spendable: number): Pct {
  for (const row of MARKET_PCT_SCHEDULE) if (spendable >= row.minSpendable) return row.pct;
  return 90;
}

/** Post-process decideBid's raw bid for the match clock. Pure. */
export function applyBudget(rawBid: number, ctx: BudgetContext): BudgetResult {
  const balance = Math.max(0, Math.floor(ctx.myBalance));
  const spendable = Math.max(1, ctx.auctionsLeft - 1);
  const pace = balance / spendable;

  if (ctx.isLastAuction) return { amount: 0, reason: "last_auction", pace };
  if (!(rawBid > 0)) return { amount: 0, reason: "not_wanted", pace };
  if (balance <= 0) return { amount: 0, reason: "no_balance", pace };

  const raw = Math.min(Math.floor(rawBid), balance);
  if (ctx.auctionsLeft > SPEND_DOWN_AUCTIONS) {
    let amount = raw;
    let reason: BudgetReason = "normal";
    if (ctx.bomb) {
      const c = bombCap(raw, balance, ctx.letter, ctx.round, ctx.bomb);
      amount = c.amount;
      if (c.reason) reason = c.reason;
    }
    const keep = Math.max(0, Math.floor(ctx.reserveCoins ?? 0));
    if (keep > 0 && amount > balance - keep) {
      amount = Math.max(0, balance - keep);
      reason = "reserve";
    }
    return { amount, reason, pace };
  }

  const surplus = balance - TARGET_LEFTOVER;
  if (surplus <= 0) return { amount: raw, reason: "spend_down_no_surplus", pace };

  const expectedWins = Math.max(1, Math.ceil(spendable * WANT_SHARE));
  const floor = surplus / expectedWins;
  let target = floor;
  if (spendable > ALL_IN_AUCTIONS) {
    let market = Infinity;
    try {
      market = priceFor(ctx.letter, ctx.round, marketPctFor(spendable));
    } catch {
      // Unknown letter: no market data, use the floor alone.
    }
    target = Math.min(floor, market);
  }

  // Keep a bid's worth for each later non-last auction, unless this is the second-to-last.
  const reserve = (spendable - 1) * MIN_RESERVE_PER_AUCTION;
  const cap = Math.max(raw, balance - reserve);
  const amount = Math.min(balance, cap, Math.max(raw, Math.ceil(target)));
  return { amount, reason: "spend_down", pace, target };
}
