// Experiment (branch experiment/high-value): "premium letters, big words".
//
// Hypothesis: win by owning the high-value letters and turning each into a
// big word (60+ points), even if we play only ~2 words a match. Auctions are
// Vickrey, so a huge bid on a premium letter mostly guarantees the win at
// the runner-up's price; it also keeps the letter from rivals.
//
// Bid rules (highValueBid, pure):
//   1. Final auction (or none left): 0, reason "skip". Its letter can never
//      be played (budget.ts S2-5).
//   2. PREMIUM letter (Z X J Q K) that is usable: bid
//        max(PREMIUM_SHARE × balance, p90 winning bid), capped at balance
//        and PREMIUM_MAX_BID. Reason "premium".
//      Usable = the WordIndex has a target word containing the letter, with
//      length ≥ TARGET_MIN_LEN or reward ≥ TARGET_MIN_REWARD, that rack +
//      letter is at most MAX_TARGET_MISSING tiles short of (and no more short
//      than the auctions still to come), with every missing tile still in the
//      unseen pool. Q also needs a U in the rack or unseen pool (Q_NEEDS_U).
//      Unusable premium letters fall through to the support rule (usually 0).
//      Once we hold MAX_PREMIUM_HELD premium letters, more of them are also
//      treated as support letters, so we don't sink every coin into a pile
//      of Z X J Q K we can't all use.
//   3. TIER2 letter (F H V W Y) whose best target rewards ≥ TARGET_MIN_REWARD
//      and is at most TIER2_MAX_MISSING short: max(TIER2_SHARE × balance,
//      p75), but never into the reserve. Reason "premium" (detail "tier2").
//   4. Support letter: one that raises the expected reward of our best target
//      word, among targets that use a premium letter we hold or reward
//      ≥ TARGET_MIN_REWARD. gain = score(rack + L) − score(rack), where a
//      target's score is reward × MISSING_DISCOUNT^missing. Bid
//        min(p50, gain × COINS_PER_POINT, balance − reserve).
//      Reason "support", or "reserve" when the reserve leaves nothing.
//   5. Anything else: 0, reason "skip".
//
// Reserve: RESERVE coins are kept back from support/tier-2 bids for the next
// premium letter, while a premium letter is still unseen; scaled linearly
// down to 0 over the last RESERVE_TAPER_AUCTIONS usable auctions.
//
// applyBudget (budget.ts) still runs after this (budgetHighValue): it zeroes
// the final auction and, in its spend-down window (last 14 auctions), may
// raise a bid toward its spend-down target. That raise could eat the reserve,
// so budgetHighValue clamps support/tier-2 bids back to balance − reserve
// (never below our own raw bid). Premium bids pass through untouched.
//
// Play rule (highValuePlay, pure): hold letters for big words. Play a word as
// soon as its reward ≥ BIG_WORD_REWARD or it has 7+ letters (best reward
// first, repeatedly); refill below play.ts LOW_BALANCE; endgame dump
// (bestWordSet) unchanged. A function of (rack, play phase) only, like
// choosePlay, so PlayGuard (playGuard.ts) stays valid.

import { COINS_PER_POINT } from "./bid.js";
import { applyBudget, type BudgetReason } from "./budget.js";
import {
  ENDGAME_AUCTIONS,
  LONG_WORD_LEN,
  LOW_BALANCE,
  REFILL_MIN_LEN,
  bestWordSet,
  choosePlay,
  removeWord,
  type PlayContext,
} from "./play.js";
import { priceFor, type Pct } from "./prices.js";
import { rackCounts, type Rack, type WordIndex } from "./words.js";

// ---- Tuning constants ----

/** Tier-1 premium letters. */
export const PREMIUM = "ZXJQK";
/** Share of our balance bid on a usable tier-1 premium letter. */
export const PREMIUM_SHARE = 0.75;
/** Hard cap on a premium bid (Infinity = share of balance only). */
export const PREMIUM_MAX_BID = Infinity;
/** Holding this many tier-1 letters, further ones are bid as support only. */
export const MAX_PREMIUM_HELD = 2;
/** Tier-2 premium letters. */
export const TIER2 = "FHVWY";
/** Share of our balance bid on a usable tier-2 letter (outside the reserve). */
export const TIER2_SHARE = 0.3;
/** A tier-2 letter's target may be at most this many tiles short. */
export const TIER2_MAX_MISSING = 3;
/** Q is usable only with a U in the rack or unseen pool. */
export const Q_NEEDS_U = true;

/** A target word: at least this long ... */
export const TARGET_MIN_LEN = 7;
/** ... or at least this reward (any length). */
export const TARGET_MIN_REWARD = 45;
/** A target may be at most this many tiles short of rack (+ letter). */
export const MAX_TARGET_MISSING = 4;
/** Target score = reward × this^missing (chance-ish of completing it). */
export const MISSING_DISCOUNT = 0.7;

/** Coins kept back from non-premium bids for the next premium letter. */
export const RESERVE = 30;
/** The reserve shrinks linearly to 0 over this many final usable auctions. */
export const RESERVE_TAPER_AUCTIONS = 20;

/** Play a word at once when it pays at least this ... */
export const BIG_WORD_REWARD = 45;
/** ... or has at least this many letters (play.ts LONG_WORD_LEN, 7). */
export const BIG_WORD_LEN = LONG_WORD_LEN;

// ---- Strategy switch ----

export type StrategyName = "highvalue" | "main";
/** Default on this branch. */
export const DEFAULT_STRATEGY: StrategyName = "highvalue";

/** STRATEGY env value → strategy. Unknown or unset → DEFAULT_STRATEGY. */
export function strategyFromEnv(value: string | undefined): StrategyName {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "main") return "main";
  if (v === "highvalue" || v === "high-value" || v === "high_value") return "highvalue";
  return DEFAULT_STRATEGY;
}

// ---- Targets ----

export interface TargetWord {
  word: string;
  reward: number;
  /** Tiles still needed beyond the rack (+ letter). */
  missing: number;
  /** reward × MISSING_DISCOUNT^missing. */
  score: number;
}

export interface TargetQuery {
  /** Tiles we would hold. */
  have: Uint8Array;
  /** Unseen copies still to be auctioned (or dealt to rivals). */
  pool: Uint8Array;
  /** The word must contain at least one letter of this 26-bit mask (0 = any). */
  requireMask: number;
  /** Words qualify by length ≥ minLen or reward ≥ minReward. */
  minLen: number;
  minReward: number;
  maxMissing: number;
}

const A = 65;
const idx = (c: string) => c.toUpperCase().charCodeAt(0) - A;
const maskOf = (letters: string) => {
  let m = 0;
  for (const c of letters) m |= 1 << idx(c);
  return m;
};

/**
 * The best target (highest score) in the index for the query, or null.
 * Entries are sorted by reward desc, so the scan stops once no later word
 * can beat the best score even with nothing missing.
 */
export function bestTarget(index: WordIndex, q: TargetQuery): TargetWord | null {
  let best: TargetWord | null = null;
  let haveTiles = 0;
  for (let i = 0; i < 26; i++) haveTiles += q.have[i];
  for (const e of index.entries) {
    if (best && e.reward <= best.score) break;
    // Reward-only query: nothing past the reward bar can qualify.
    if (q.minLen === Infinity && e.reward < q.minReward) break;
    if (q.requireMask !== 0 && (e.mask & q.requireMask) === 0) continue;
    if (e.length < q.minLen && e.reward < q.minReward) continue;
    if (e.length > haveTiles + q.maxMissing) continue;
    let missing = 0;
    let ok = true;
    const c = e.counts;
    for (let i = 0; i < 26; i++) {
      const need = c[i] - q.have[i];
      if (need <= 0) continue;
      if (need > q.pool[i]) {
        ok = false;
        break;
      }
      missing += need;
      if (missing > q.maxMissing) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const score = e.reward * MISSING_DISCOUNT ** missing;
    if (!best || score > best.score) best = { word: e.word, reward: e.reward, missing, score };
  }
  return best;
}

// ---- Bid ----

export type HighValueReason = "premium" | "support" | "reserve" | "skip";

export interface HighValueContext {
  letter: string;
  rack: Rack;
  /** Unseen tiles (unseenPool(state).unseen); excludes the open auction's letter. */
  pool: Rack;
  balance: number;
  /** Auctions left including the open one. */
  auctionsLeft: number;
  round: number;
  isLastAuction: boolean;
  index: WordIndex;
  /** Override the price lookup (tests, simulation). */
  prices?: (letter: string, round: number, pct: Pct) => number;
}

export interface HighValueBid {
  amount: number;
  reason: HighValueReason;
  /** Finer reason for logs, e.g. "tier1", "tier2", "unusable", "no_target". */
  detail: string;
  target?: TargetWord | null;
  /** Coins held back for the next premium letter. */
  reserve: number;
  /** Support: target score gained by the letter (points). */
  gain?: number;
}

/** Tier-1 premium letters in the rack. */
export function premiumHeld(rack: Rack): number {
  let n = 0;
  for (const c of PREMIUM) n += rack.get(c) ?? 0;
  return n;
}

/** Coins kept back for the next premium letter. */
export function reserveFor(pool: Rack, auctionsLeft: number): number {
  let unseenPremium = 0;
  for (const c of PREMIUM) unseenPremium += pool.get(c) ?? 0;
  if (unseenPremium === 0) return 0;
  const usable = Math.max(0, auctionsLeft - 2); // later auctions whose letter we could still play
  return Math.round(RESERVE * Math.min(1, usable / RESERVE_TAPER_AUCTIONS));
}

export function highValueBid(ctx: HighValueContext): HighValueBid {
  const letter = ctx.letter.toUpperCase();
  const balance = Math.max(0, Math.floor(ctx.balance));
  const reserve = reserveFor(ctx.pool, ctx.auctionsLeft);
  const skip = (detail: string, target?: TargetWord | null): HighValueBid => ({
    amount: 0,
    reason: "skip",
    detail,
    target,
    reserve,
  });
  if (ctx.isLastAuction || ctx.auctionsLeft <= 1) return skip("last_auction");
  if (letter.length !== 1 || idx(letter) < 0 || idx(letter) > 25) return skip("bad_letter");
  if (balance <= 0) return skip("no_balance");

  const lookup = ctx.prices ?? priceFor;
  const price = (pct: Pct): number => {
    try {
      return lookup(letter, ctx.round, pct);
    } catch {
      return 0;
    }
  };
  // Tiles we can still win after this auction (the final one is unplayable).
  const toCome = Math.max(0, ctx.auctionsLeft - 2);
  const pool = rackCounts(ctx.pool);
  const rack = rackCounts(ctx.rack);
  const withL = rack.slice();
  withL[idx(letter)]++;

  const isTier1 = PREMIUM.includes(letter);
  const isTier2 = TIER2.includes(letter);

  // Tier 1: premium share.
  if (isTier1 && premiumHeld(ctx.rack) < MAX_PREMIUM_HELD) {
    const uNeeded = Q_NEEDS_U && letter === "Q";
    const uAvailable = (ctx.rack.get("U") ?? 0) + (ctx.pool.get("U") ?? 0) > 0;
    const target =
      uNeeded && !uAvailable
        ? null
        : bestTarget(ctx.index, {
            have: withL,
            pool,
            requireMask: maskOf(letter),
            minLen: TARGET_MIN_LEN,
            minReward: TARGET_MIN_REWARD,
            maxMissing: Math.min(MAX_TARGET_MISSING, toCome),
          });
    if (target) {
      const want = Math.max(Math.ceil(PREMIUM_SHARE * balance), price(90));
      const amount = Math.min(balance, PREMIUM_MAX_BID, want);
      return { amount, reason: "premium", detail: "tier1", target, reserve };
    }
    // Unusable: fall through to support (normally 0).
  }

  // Tier 2: smaller share, kept out of the reserve.
  if (isTier2) {
    const target = bestTarget(ctx.index, {
      have: withL,
      pool,
      requireMask: maskOf(letter),
      minLen: Infinity, // reward decides
      minReward: TARGET_MIN_REWARD,
      maxMissing: Math.min(TIER2_MAX_MISSING, toCome),
    });
    if (target) {
      const want = Math.max(Math.ceil(TIER2_SHARE * balance), price(75));
      const room = balance - reserve;
      if (room <= 0) return { amount: 0, reason: "reserve", detail: "tier2", target, reserve };
      return { amount: Math.min(want, room), reason: "premium", detail: "tier2", target, reserve };
    }
  }

  // Support: the letter must raise the score of a big target.
  const held = premiumHeld(ctx.rack) > 0;
  let requireMask = 0;
  for (const c of PREMIUM) if ((ctx.rack.get(c) ?? 0) > 0) requireMask |= maskOf(c);
  const supportQuery = (have: Uint8Array, p: Uint8Array): TargetWord | null => {
    // Targets using a premium letter we hold, at the usual length/reward bar ...
    const premiumTarget = held
      ? bestTarget(ctx.index, {
          have,
          pool: p,
          requireMask,
          minLen: TARGET_MIN_LEN,
          minReward: TARGET_MIN_REWARD,
          maxMissing: Math.min(MAX_TARGET_MISSING, toCome),
        })
      : null;
    // ... or any target with reward ≥ TARGET_MIN_REWARD.
    const bigTarget = bestTarget(ctx.index, {
      have,
      pool: p,
      requireMask: 0,
      minLen: Infinity,
      minReward: TARGET_MIN_REWARD,
      maxMissing: Math.min(MAX_TARGET_MISSING, toCome),
    });
    if (!premiumTarget) return bigTarget;
    if (!bigTarget) return premiumTarget;
    return premiumTarget.score >= bigTarget.score ? premiumTarget : bigTarget;
  };
  // Without L the open auction's copy is still out there (pool + L), and
  // one more tile can come later than with L (toCome counts later auctions).
  const poolWithL = pool.slice();
  poolWithL[idx(letter)]++;
  const before = supportQuery(rack, poolWithL);
  const after = supportQuery(withL, pool);
  const gain = (after?.score ?? 0) - (before?.score ?? 0);
  if (!after || gain <= 0) return skip(isTier1 ? "unusable" : "no_target", after);

  const cap = Math.min(price(50), gain * COINS_PER_POINT);
  const room = balance - reserve;
  if (room <= 0) return { amount: 0, reason: "reserve", detail: "support", target: after, reserve, gain };
  const amount = Math.max(0, Math.min(Math.round(cap), room));
  if (amount <= 0) return { ...skip("tiny_gain", after), gain };
  return { amount, reason: "support", detail: held ? "held_premium" : "big_target", target: after, reserve, gain };
}

/** Budget context: what applyBudget needs (MatchState fields). */
export interface HighValueBudgetContext {
  isLastAuction: boolean;
  auctionsLeft: number;
  round: number;
  myBalance: number;
  letter: string;
}

/**
 * applyBudget after highValueBid. Premium bids pass through (applyBudget only
 * caps them at balance, or raises them in spend-down). Support/tier-2 bids
 * are clamped back to balance − reserve if spend-down raised them into it,
 * but never below the raw bid.
 */
export function budgetHighValue(
  bid: HighValueBid,
  ctx: HighValueBudgetContext,
): { amount: number; budgetReason: BudgetReason; clampedToReserve: boolean } {
  const { amount, reason } = applyBudget(bid.amount, ctx);
  const protectReserve = bid.reason === "support" || (bid.reason === "premium" && bid.detail === "tier2");
  if (protectReserve && amount > bid.amount) {
    const limit = Math.max(bid.amount, Math.floor(ctx.myBalance) - bid.reserve);
    if (amount > limit) return { amount: limit, budgetReason: reason, clampedToReserve: true };
  }
  return { amount, budgetReason: reason, clampedToReserve: false };
}

// ---- Play ----

/**
 * Hold letters for big words: play every word with reward ≥ BIG_WORD_REWARD
 * or length ≥ BIG_WORD_LEN at once (best reward first); otherwise refill
 * below LOW_BALANCE; endgame dump as in play.ts.
 */
export function highValuePlay(ctx: PlayContext): string[] {
  const { index } = ctx;
  if (ctx.auctionsLeft <= ENDGAME_AUCTIONS) return bestWordSet(ctx.rack, index);

  const rack = new Map(ctx.rack);
  let balance = ctx.balance;
  const plays: string[] = [];
  for (;;) {
    // playable() is sorted by reward desc: the first big one is the best.
    const big = index
      .playable(rack, { minLen: 2 })
      .find((w) => w.reward >= BIG_WORD_REWARD || w.word.length >= BIG_WORD_LEN);
    if (!big) break;
    plays.push(big.word);
    balance += big.reward;
    removeWord(rack, big.word);
  }
  if (balance < LOW_BALANCE) {
    const refill = index.best(rack, { minLen: REFILL_MIN_LEN }) ?? index.best(rack);
    if (refill) plays.push(refill.word);
  }
  return plays;
}

/** The play function for a strategy. */
export function playFor(strategy: StrategyName): (ctx: PlayContext) => string[] {
  return strategy === "highvalue" ? highValuePlay : choosePlay;
}
