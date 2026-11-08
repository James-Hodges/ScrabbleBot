// Experiment (branch experiment/high-value): "premium letters, big words".
//
// v2 (after 5 live v1 matches: support bids too small, reserve-0 bids after
// winning a premium letter, premium letters spent in short words):
//
//   * Target commitment (commitTargets). Once we hold a COMMIT_LETTERS letter
//     (tier 1), we keep up to TARGET_COUNT committed target words: 7+
//     letters, containing a held tier-1 letter, at most MAX_TARGET_MISSING
//     tiles short, ranked by expected reward er = reward × pComplete. Last
//     auction's targets are kept while still alive (er ≥ MIN_KEEP_ER); a new
//     word only displaces the weakest one if its er beats it by STICKY_FACTOR.
//   * Target bids (rule 2b below): a letter a committed target still needs
//     gets TARGET_SHARE × balance × urgency × serves × scarcity, at least the
//     letter's p90 when it's the target's last missing tile, p75 when it's
//     the second-last. No reserve while we hold a HIGH letter (tier 1 or 2). Letters no
//     committed target needs get 0 ("not_in_target").
//   * Waiting (highValuePlan): a big word is held back when a longer word
//     (≥ WAIT_MIN_LEN letters, ≤ WAIT_MAX_MISSING tiles short) is worth more:
//     reward_now < WAIT_FACTOR × pComplete × reward_longer, and more than
//     WAIT_MIN_AUCTIONS auctions remain. The refill word avoids HIGH letters
//     that a live committed target uses when another word exists.
//
// v1 rules below are unchanged except where noted (rule 2b, reserve, play).
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

// ---- v2 tuning constants ----

/** Holding any of these drops the reserve (tier 1 + tier 2). */
export const HIGH = PREMIUM + TIER2;
/**
 * Letters that trigger target commitment once held. Tier 1 only: committing
 * on tier 2 too (common W Y H F V) scored ~10 points/match less in the
 * simulation, since it zeroes most bids from the first auction.
 */
export const COMMIT_LETTERS = PREMIUM;
/** Committed target words kept at once. */
export const TARGET_COUNT = 3;
/** A new committed target needs at least this expected reward (points). */
export const MIN_COMMIT_ER = 8;
/** A committed target is dropped below this expected reward (hysteresis). */
export const MIN_KEEP_ER = 4;
/** A new word displaces a committed one only if its er is this many times higher. */
export const STICKY_FACTOR = 1.5;
/** Chance we win a target letter's auction when it comes up (we bid hard). */
export const TARGET_WIN_RATE = 0.5;
/** Share of balance bid on a letter a committed target needs (before scaling). */
export const TARGET_SHARE = 0.4;
/** Urgency by the target's missing tiles before this letter: 1 → last, 2 → second-last, more → far. */
export const URGENCY_LAST = 1;
export const URGENCY_SECOND = 0.75;
export const URGENCY_FAR = 0.5;
/** Each extra committed target the letter serves adds this much (× share). */
export const SERVE_BONUS = 0.25;
/** The letter is scarce (unseen copies ≤ copies needed): × this. */
export const SCARCITY_BONUS = 1.5;
/** Waiting: only while more than this many auctions remain. */
export const WAIT_MIN_AUCTIONS = 12;
/** Play now if reward_now ≥ WAIT_FACTOR × pComplete × reward_longer. */
export const WAIT_FACTOR = 0.8;
/** The longer word must have at least this many letters ... */
export const WAIT_MIN_LEN = 8;
/** ... and be at most this many tiles short of the rack. */
export const WAIT_MAX_MISSING = 2;

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

// ---- v2: committed targets ----

/**
 * Chance of winning every missing tile: for each letter, P(win ≥ need of the
 * pool's copies), each copy won independently with
 * f = winRate × min(1, horizon / poolSize) (as in value.ts). 0 when more
 * tiles are missing than auctions remain.
 */
export function pComplete(
  need: Uint8Array,
  pool: Uint8Array,
  horizon: number,
  winRate = TARGET_WIN_RATE,
): number {
  let total = 0;
  let N = 0;
  for (let i = 0; i < 26; i++) {
    total += need[i];
    N += pool[i];
  }
  if (total === 0) return 1;
  if (total > horizon || N === 0 || horizon <= 0) return 0;
  const f = winRate * Math.min(1, horizon / N);
  let p = 1;
  for (let i = 0; i < 26; i++) {
    if (need[i] === 0) continue;
    p *= binomTail(pool[i], f, need[i]);
    if (p === 0) return 0;
  }
  return p;
}

/** P(X ≥ k), X ~ Binomial(n, f). */
function binomTail(n: number, f: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let below = 0;
  let c = 1; // C(n, j)
  for (let j = 0; j < k; j++) {
    below += c * f ** j * (1 - f) ** (n - j);
    c = (c * (n - j)) / (j + 1);
  }
  return Math.max(0, 1 - below);
}

export interface CommittedTarget {
  word: string;
  reward: number;
  /** Missing tiles beyond the rack, sorted (e.g. "EST"); "" = playable now. */
  missing: string;
  /** Chance to complete (pComplete). */
  p: number;
  /** Expected reward: reward × p. */
  er: number;
}

export interface CommitQuery {
  rack: Rack;
  /** Unseen copies we could still win (include the open auction's letter). */
  pool: Rack | Uint8Array;
  /** Tiles we can still win, including the open auction. */
  horizon: number;
  index: WordIndex;
  /** Last decision's committed words (kept while alive). */
  prev?: readonly string[];
}

type Entry = WordIndex["entries"][number];
const entryCache = new WeakMap<WordIndex, Map<string, Entry>>();
function entryFor(index: WordIndex, word: string): Entry | undefined {
  let m = entryCache.get(index);
  if (!m) {
    m = new Map(index.entries.map((e) => [e.word, e]));
    entryCache.set(index, m);
  }
  return m.get(word.toUpperCase());
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Letters of `set` (default HIGH) in the rack, as a 26-bit mask. */
export function heldHighMask(rack: Rack, set: string = HIGH): number {
  let m = 0;
  for (const c of set) if ((rack.get(c) ?? 0) > 0) m |= maskOf(c);
  return m;
}

/**
 * Committed targets (best er first): previous targets still alive, topped
 * up from the index; a new word displaces the weakest kept one only when its
 * er is ≥ STICKY_FACTOR × that one's. [] while we hold no COMMIT_LETTERS letter.
 */
export function commitTargets(q: CommitQuery): CommittedTarget[] {
  const heldMask = heldHighMask(q.rack, COMMIT_LETTERS);
  if (heldMask === 0) return [];
  const have = rackCounts(q.rack);
  const pool = q.pool instanceof Uint8Array ? q.pool : rackCounts(q.pool);
  const maxMissing = Math.max(0, Math.min(MAX_TARGET_MISSING, q.horizon));
  let haveTiles = 0;
  let rackMask = 0;
  for (let i = 0; i < 26; i++) {
    haveTiles += have[i];
    if (have[i] > 0) rackMask |= 1 << i;
  }
  const need = new Uint8Array(26);
  const evaluate = (e: Entry): CommittedTarget | null => {
    if ((e.mask & heldMask) === 0) return null;
    if (e.length < TARGET_MIN_LEN || e.length > haveTiles + maxMissing) return null;
    if (popcount(e.mask & ~rackMask) > maxMissing) return null;
    let missing = "";
    for (let i = 0; i < 26; i++) {
      const n = e.counts[i] > have[i] ? e.counts[i] - have[i] : 0;
      need[i] = n;
      if (n > pool[i]) return null;
      if (n > 0) {
        missing += String.fromCharCode(A + i).repeat(n);
        if (missing.length > maxMissing) return null;
      }
    }
    const p = pComplete(need, pool, q.horizon);
    if (p <= 0) return null;
    return { word: e.word, reward: e.reward, missing, p, er: e.reward * p };
  };

  const out: CommittedTarget[] = [];
  for (const w of q.prev ?? []) {
    const e = entryFor(q.index, w);
    const t = e && evaluate(e);
    if (t && t.er >= MIN_KEEP_ER && !out.some((o) => o.word === t.word)) out.push(t);
    if (out.length >= TARGET_COUNT) break;
  }

  // Best new candidates by er (entries are sorted by reward desc, er ≤ reward).
  const fresh: CommittedTarget[] = [];
  for (const e of q.index.entries) {
    if (e.reward < MIN_COMMIT_ER) break;
    if (fresh.length >= TARGET_COUNT && e.reward <= fresh[fresh.length - 1].er) break;
    const t = evaluate(e);
    if (!t || t.er < MIN_COMMIT_ER) continue;
    fresh.push(t);
    fresh.sort((a, b) => b.er - a.er);
    if (fresh.length > TARGET_COUNT) fresh.pop();
  }
  // Anchored targets use a tier-1 letter we hold (or we hold none): only
  // those are sticky (matters when COMMIT_LETTERS includes tier 2).
  let tier1Mask = 0;
  for (const c of PREMIUM) if ((q.rack.get(c) ?? 0) > 0) tier1Mask |= maskOf(c);
  const anchored = (t: CommittedTarget) => tier1Mask === 0 || (maskOf(t.word) & tier1Mask) !== 0;
  for (const t of fresh) {
    if (out.some((o) => o.word === t.word)) continue;
    if (out.length < TARGET_COUNT) {
      out.push(t);
      continue;
    }
    let slot = -1;
    for (let i = 0; i < out.length; i++) {
      const bar = anchored(out[i]) ? STICKY_FACTOR * out[i].er : out[i].er;
      if (t.er > bar && (slot < 0 || out[i].er < out[slot].er)) slot = i;
    }
    if (slot >= 0) out[slot] = t;
  }
  return out.sort((a, b) => b.er - a.er);
}

/** Log form of committed targets: "WORD-MISSING@p", top n. */
export function targetSummary(targets: readonly CommittedTarget[] | undefined, n = 3): string[] {
  return (targets ?? []).slice(0, n).map((t) => `${t.word}-${t.missing || "∅"}@${t.p.toFixed(2)}`);
}

// ---- Bid ----

export type HighValueReason = "premium" | "target" | "support" | "reserve" | "skip";

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
  /** v2: last decision's committed target words (kept while alive). */
  committed?: readonly string[];
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
  /** v2: committed targets for this rack (store and pass back as `committed`). */
  committed?: CommittedTarget[];
  /** v2: committed targets that still need this letter. */
  served?: string[];
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
  // v2: no reserve while we hold a HIGH letter (coins go to its targets).
  const holdsHigh = heldHighMask(ctx.rack) !== 0;
  const reserve = holdsHigh ? 0 : reserveFor(ctx.pool, ctx.auctionsLeft);
  let committed: CommittedTarget[] | undefined;
  const skip = (detail: string, target?: TargetWord | null): HighValueBid => ({
    amount: 0,
    reason: "skip",
    detail,
    target,
    reserve,
    committed,
  });
  if (ctx.isLastAuction || ctx.auctionsLeft <= 1) return skip("last_auction");
  if (letter.length !== 1 || idx(letter) < 0 || idx(letter) > 25) return skip("bad_letter");

  // v2: committed targets, with the open auction's copy back in the pool
  // (we may win it) and this auction plus the later playable ones to win in.
  const poolWithOpen = rackCounts(ctx.pool);
  poolWithOpen[idx(letter)]++;
  committed = commitTargets({
    rack: ctx.rack,
    pool: poolWithOpen,
    horizon: Math.max(0, ctx.auctionsLeft - 1),
    index: ctx.index,
    prev: ctx.committed,
  });
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
      return { amount, reason: "premium", detail: "tier1", target, reserve, committed };
    }
    // Unusable: fall through to the target/support rules (normally 0).
  }

  // v2 rule 2b: committed targets decide every other letter.
  if (committed.length > 0) {
    const served = committed.filter((t) => t.missing.includes(letter));
    if (served.length === 0) return { ...skip("not_in_target"), served: [] };
    const best = served[0]; // committed is sorted by er desc
    const m = best.missing.length;
    const urgency = m <= 1 ? URGENCY_LAST : m === 2 ? URGENCY_SECOND : URGENCY_FAR;
    let needed = 0;
    for (const t of served) {
      let n = 0;
      for (const c of t.missing) if (c === letter) n++;
      needed = Math.max(needed, n);
    }
    const scarce = poolWithOpen[idx(letter)] <= needed;
    const share =
      TARGET_SHARE *
      balance *
      urgency *
      (1 + SERVE_BONUS * (served.length - 1)) *
      (scarce ? SCARCITY_BONUS : 1);
    const floor =
      m <= 1 ? price(90) : m === 2 ? price(75) : Math.min(price(50), TARGET_SHARE * balance);
    const amount = Math.min(balance, Math.ceil(Math.max(floor, share)));
    return {
      amount,
      reason: "target",
      detail: m <= 1 ? "last" : m === 2 ? "second_last" : "far",
      target: { word: best.word, reward: best.reward, missing: m, score: best.er },
      reserve,
      committed,
      served: served.map((t) => t.word),
    };
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
      if (room <= 0) return { amount: 0, reason: "reserve", detail: "tier2", target, reserve, committed };
      return { amount: Math.min(want, room), reason: "premium", detail: "tier2", target, reserve, committed };
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
  if (room <= 0) return { amount: 0, reason: "reserve", detail: "support", target: after, reserve, gain, committed };
  const amount = Math.max(0, Math.min(Math.round(cap), room));
  if (amount <= 0) return { ...skip("tiny_gain", after), gain };
  return { amount, reason: "support", detail: held ? "held_premium" : "big_target", target: after, reserve, gain, committed };
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

export interface HighValuePlayContext extends PlayContext {
  /** Unseen tiles (unseenPool(state).unseen). Without it: no waiting, no refill protection (v1). */
  pool?: Rack;
  /** Last committed target words (stability), as from highValueBid. */
  committed?: readonly string[];
}

export interface WaitInfo {
  /** The big word we could play now but hold. */
  word: string;
  reward: number;
  /** The longer word we wait for, its missing tiles and chance to complete. */
  longer: string;
  longerReward: number;
  missing: string;
  p: number;
}

export interface HighValuePlan {
  words: string[];
  waited?: WaitInfo;
  /** Refill word chosen away from these protected HIGH letters. */
  protectedLetters: string;
  committed: CommittedTarget[];
}

/**
 * The best longer word to wait for instead of `now`: at least
 * max(WAIT_MIN_LEN, now.length + 1) letters, reward > now's, spellable from
 * the rack + ≤ WAIT_MAX_MISSING unseen tiles. Best reward × pComplete.
 */
export function longerWord(
  rack: Rack,
  now: { word: string; reward: number },
  pool: Uint8Array,
  horizon: number,
  index: WordIndex,
): { word: string; reward: number; missing: string; p: number; er: number } | null {
  const have = rackCounts(rack);
  let haveTiles = 0;
  let rackMask = 0;
  for (let i = 0; i < 26; i++) {
    haveTiles += have[i];
    if (have[i] > 0) rackMask |= 1 << i;
  }
  const minLen = Math.max(WAIT_MIN_LEN, now.word.length + 1);
  const need = new Uint8Array(26);
  let best: { word: string; reward: number; missing: string; p: number; er: number } | null = null;
  for (const e of index.entries) {
    if (e.reward <= now.reward) break;
    if (best && e.reward <= best.er) break;
    if (e.length < minLen || e.length > haveTiles + WAIT_MAX_MISSING) continue;
    if (popcount(e.mask & ~rackMask) > WAIT_MAX_MISSING) continue;
    let missing = "";
    let ok = true;
    for (let i = 0; i < 26; i++) {
      const n = e.counts[i] > have[i] ? e.counts[i] - have[i] : 0;
      need[i] = n;
      if (n > pool[i]) {
        ok = false;
        break;
      }
      if (n > 0) missing += String.fromCharCode(A + i).repeat(n);
    }
    if (!ok || missing.length === 0 || missing.length > WAIT_MAX_MISSING) continue;
    const p = pComplete(need, pool, horizon);
    const er = e.reward * p;
    if (p > 0 && (!best || er > best.er)) best = { word: e.word, reward: e.reward, missing, p, er };
  }
  return best;
}

/**
 * v2 play policy:
 *   - endgame (≤ ENDGAME_AUCTIONS left): bestWordSet, as before;
 *   - big words (reward ≥ BIG_WORD_REWARD or ≥ BIG_WORD_LEN letters), best
 *     first, unless a longer word is worth waiting for: with more than
 *     WAIT_MIN_AUCTIONS auctions left, hold when
 *     reward_now < WAIT_FACTOR × pComplete × reward_longer;
 *   - refill below LOW_BALANCE, preferring a word without the HIGH letters
 *     a live committed target uses.
 * Depends on (rack, balance phase, auctionsLeft, pool): index.ts keys the
 * play guard by auctionsLeft too.
 */
export function highValuePlan(ctx: HighValuePlayContext): HighValuePlan {
  const { index } = ctx;
  if (ctx.auctionsLeft <= ENDGAME_AUCTIONS) {
    return { words: bestWordSet(ctx.rack, index), protectedLetters: "", committed: [] };
  }
  const pool = ctx.pool ? rackCounts(ctx.pool) : null;
  // The open auction may still be ours; its letter isn't in the unseen pool.
  const horizon = Math.max(0, ctx.auctionsLeft - 1);
  const canWait = pool !== null && ctx.auctionsLeft > WAIT_MIN_AUCTIONS;

  const rack = new Map(ctx.rack);
  let balance = ctx.balance;
  const plays: string[] = [];
  let waited: WaitInfo | undefined;
  for (;;) {
    // playable() is sorted by reward desc: the first big one is the best.
    const big = index
      .playable(rack, { minLen: 2 })
      .find((w) => w.reward >= BIG_WORD_REWARD || w.word.length >= BIG_WORD_LEN);
    if (!big) break;
    if (canWait) {
      const longer = longerWord(rack, big, pool!, horizon, index);
      if (longer && big.reward < WAIT_FACTOR * longer.er) {
        waited = {
          word: big.word,
          reward: big.reward,
          longer: longer.word,
          longerReward: longer.reward,
          missing: longer.missing,
          p: longer.p,
        };
        break;
      }
    }
    plays.push(big.word);
    balance += big.reward;
    removeWord(rack, big.word);
  }

  const committed = pool
    ? commitTargets({ rack, pool, horizon, index, prev: ctx.committed })
    : [];
  let protectedLetters = "";
  for (const c of HIGH) {
    if ((rack.get(c) ?? 0) > 0 && committed.some((t) => t.missing.length > 0 && t.word.includes(c))) {
      protectedLetters += c;
    }
  }
  if (balance < LOW_BALANCE) {
    const free = (w: { word: string }) => ![...protectedLetters].some((c) => w.word.includes(c));
    const all = protectedLetters ? index.playable(rack, { minLen: 2 }) : [];
    const refill =
      all.find((w) => w.word.length >= REFILL_MIN_LEN && free(w)) ??
      all.find(free) ??
      index.best(rack, { minLen: REFILL_MIN_LEN }) ??
      index.best(rack);
    if (refill) plays.push(refill.word);
  }
  return { words: plays, waited, protectedLetters, committed };
}

/** The words to play now (highValuePlan's words). */
export function highValuePlay(ctx: HighValuePlayContext): string[] {
  return highValuePlan(ctx).words;
}

/** The play function for a strategy. */
export function playFor(strategy: StrategyName): (ctx: HighValuePlayContext) => string[] {
  return strategy === "highvalue" ? highValuePlay : choosePlay;
}
