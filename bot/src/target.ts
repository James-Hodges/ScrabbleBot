// Target-word valuation (bomb rework): what one more copy of each letter is
// worth toward a long, high-reward word we could still build.
//
// value.ts only looks MAX_MISSING (2) tiles ahead, so with a small rack and
// a 60+ reward bar it values almost everything at 0. This module looks
// further: it scans a precomputed list of long candidate words and, for each,
// estimates how likely we are to complete it from rack + the unseen pool.
//
// Model, per candidate word w (one scan, all 26 letters at once):
//   need_i   = max(0, count_w(i) − rack_i)            tiles still to win
//   k        = Σ need_i                               (skip if > maxMissing)
//   P(w)     = Π_i tail(pool_i, need_i) × TILE_DISCOUNT^k
//              tail(p, m) = P(Binomial(p, f) ≥ m), f = TARGET_WIN_RATE × min(1, T/N)
//              (the same per-copy chance as value.ts, at a higher win rate
//              because we bid hard for target letters). TILE_DISCOUNT^k
//              stands for coins and contention: every extra tile we must win
//              costs money and can be lost, which gives common filler letters
//              that fit the word real value even when the pool has many copies.
//   EV(w)    = reward(w) × P(w)
//   V(rack)  = max_w EV(w);  V(rack + L) = max over w of EV with need_L − 1
//   value(L) = V(rack + L) − V(rack), and for each tile the best target
//              still needs at least base × TARGET_TILE_SHARE / k
//
// Candidates come from the phase:
//   bomb       8–10 letters, reward ≥ BOMB_MIN_REWARD, at least one tile worth ≥ HIGH_TILE_VALUE
//   otherwise  7–10 letters, reward ≥ MIN_REWARD
// The candidate lists are built once per WordIndex and cached.
//
// planValues() merges this with value.ts (max per letter) and a floor for
// small racks so letter values never collapse to 0 when the rack is empty.
//
// Pure and deterministic.

import { BOMB_MIN_REWARD, ENDGAME_AUCTIONS, MIN_REWARD, minRewardFor, playPhase, type PlayPhase } from "./play.js";
import { letterValues, type ValueContext, type ValueTable } from "./value.js";
import { letterValue, rackCounts, type Rack, type WordEntry, type WordIndex } from "./words.js";

/** A tile this valuable (F H V W Y K J X Q Z) makes a word a bomb candidate. */
export const HIGH_TILE_VALUE = 4;
/** Bomb candidate lengths. */
export const BOMB_MIN_LEN = 8;
export const BOMB_MAX_LEN = 10;
/** Post-bomb (and past the deadline) candidate lengths. */
export const POST_MIN_LEN = 7;
export const POST_MAX_LEN = 10;
/** Most tiles a candidate may still need (bomb / otherwise). */
export const BOMB_MAX_MISSING = 10;
export const POST_MAX_MISSING = 7;
/** Our win rate on letters we target (we bid hard for them). */
export const TARGET_WIN_RATE = 0.5;
/** EV multiplier per tile still to win (coins + contention). */
export const TILE_DISCOUNT = 0.85;
/**
 * Each tile the best target still needs is worth at least this share of the
 * target's EV split over its missing tiles (base × share / k). Gives common
 * filler letters of the target real value even when the pool has many copies.
 */
export const TARGET_TILE_SHARE = 1;
/** At or below this many rack tiles, every letter is worth at least RACK_FLOOR_POINTS. */
export const SMALL_RACK_TILES = 6;
/** Floor value (points) per letter when the rack is small. */
export const RACK_FLOOR_POINTS = 2;
/** Near the endgame, value.ts counts every word (it will be played in the endgame dump). */
export const VALUE_ENDGAME_LOOKAHEAD = 2;

const MAX_POOL = 16;

export interface TargetWord {
  word: string;
  reward: number;
  /** Tiles still needed beyond the rack. */
  missing: number;
  /** Estimated completion probability (incl. discount). */
  prob: number;
}

export interface TargetTable {
  /** value(L) in points, 0..25 = A..Z. */
  values: Float64Array;
  /** V(rack). */
  base: number;
  /** The best target for the rack itself, or null when none is reachable. */
  target: TargetWord | null;
}

/**
 * Candidates as flat arrays for a fast scan: word k's distinct letters are
 * letters[start[k] .. start[k+1]) with their counts in `counts`. Anagrams
 * (same multiset, so same reward) are kept once.
 */
interface CandidateSet {
  words: string[];
  rewards: Int32Array;
  start: Int32Array;
  letters: Uint8Array;
  counts: Uint8Array;
  maxMissing: number;
}

const candidateCache = new WeakMap<WordIndex, { bomb: CandidateSet; post: CandidateSet }>();

function pack(list: WordEntry[], maxMissing: number): CandidateSet {
  const seen = new Set<string>();
  const keep: WordEntry[] = [];
  for (const e of list) {
    const key = e.counts.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(e);
  }
  const start = new Int32Array(keep.length + 1);
  const letters: number[] = [];
  const counts: number[] = [];
  keep.forEach((e, k) => {
    start[k] = letters.length;
    for (let i = 0; i < 26; i++) {
      if (e.counts[i] > 0) {
        letters.push(i);
        counts.push(e.counts[i]);
      }
    }
  });
  start[keep.length] = letters.length;
  return {
    words: keep.map((e) => e.word),
    rewards: Int32Array.from(keep, (e) => e.reward),
    start,
    letters: Uint8Array.from(letters),
    counts: Uint8Array.from(counts),
    maxMissing,
  };
}

/** Candidate lists for an index (built once, cached; ~50 ms the first time). */
export function candidates(index: WordIndex, bomb: boolean): CandidateSet {
  let c = candidateCache.get(index);
  if (!c) {
    const b: WordEntry[] = [];
    const p: WordEntry[] = [];
    for (const e of index.entries) {
      if (e.length >= POST_MIN_LEN && e.length <= POST_MAX_LEN && e.reward >= MIN_REWARD) p.push(e);
      if (e.length >= BOMB_MIN_LEN && e.length <= BOMB_MAX_LEN && e.reward >= BOMB_MIN_REWARD) {
        let hi = false;
        for (const ch of e.word) if (letterValue(ch) >= HIGH_TILE_VALUE) hi = true;
        if (hi) b.push(e);
      }
    }
    c = { bomb: pack(b, BOMB_MAX_MISSING), post: pack(p, POST_MAX_MISSING) };
    candidateCache.set(index, c);
  }
  return bomb ? c.bomb : c.post;
}

export interface TargetContext {
  rack: Rack;
  pool: Rack | Uint8Array;
  auctionsLeft: number;
  index: WordIndex;
  /** Bomb candidates (8–10 letters, 60+, high tile) vs post-bomb (7–10, 30+). */
  bomb: boolean;
  winRate?: number;
}

/** tail[p * (MAX_POOL+1) + m] = P(Bin(p, f) >= m). */
function tailTable(f: number): Float64Array {
  const W = MAX_POOL + 1;
  const t = new Float64Array(W * W);
  for (let p = 0; p <= MAX_POOL; p++) {
    // pmf of Bin(p, f)
    const pmf = new Float64Array(p + 1);
    pmf[0] = 1;
    for (let n = 1; n <= p; n++) {
      for (let j = n; j >= 1; j--) pmf[j] = pmf[j] * (1 - f) + pmf[j - 1] * f;
      pmf[0] *= 1 - f;
    }
    let acc = 0;
    for (let m = p; m >= 0; m--) {
      acc += pmf[m];
      t[p * W + m] = Math.min(1, acc);
    }
  }
  return t;
}

export function targetValues(ctx: TargetContext): TargetTable {
  const values = new Float64Array(26);
  const T = Math.max(0, Math.floor(ctx.auctionsLeft) - 2);
  const rack = rackCounts(ctx.rack);
  const pool = ctx.pool instanceof Uint8Array ? ctx.pool : rackCounts(ctx.pool);
  let N = 0;
  for (let i = 0; i < 26; i++) N += pool[i];
  const f = N > 0 && T > 0 ? (ctx.winRate ?? TARGET_WIN_RATE) * Math.min(1, T / N) : 0;
  if (f <= 0) return { values, base: 0, target: null };

  const W = MAX_POOL + 1;
  const tail = tailTable(f);
  const cs = candidates(ctx.index, ctx.bomb);
  const maxK = Math.min(cs.maxMissing, T);
  const discount = new Float64Array(maxK + 2);
  for (let k = 0; k < discount.length; k++) discount[k] = TILE_DISCOUNT ** k;

  // tl[i * W + m] = tail for letter i needing m more copies (0 if the pool lacks them).
  const tl = new Float64Array(26 * W);
  for (let i = 0; i < 26; i++) {
    const p = Math.min(MAX_POOL, pool[i]);
    for (let m = 0; m <= MAX_POOL; m++) tl[i * W + m] = m === 0 ? 1 : m > p ? 0 : tail[p * W + m];
  }

  let base = 0;
  let bestK = -1;
  let bestAt = -1;
  let bestProb = 0;
  const withL = new Float64Array(26);
  const { rewards, start, letters, counts } = cs;
  const n = rewards.length;
  const needL = new Uint8Array(26);
  const tOld = new Float64Array(26);
  const idx = new Uint8Array(26);

  for (let w = 0; w < n; w++) {
    let k = 0;
    let nIdx = 0;
    let prob = 1; // Π tail over the needed letters, skipping a single zero
    let zeros = 0; // letters whose tail is 0 (need more than the pool has)
    let zeroAt = -1;
    const end = start[w + 1];
    for (let j = start[w]; j < end; j++) {
      const i = letters[j];
      const m = counts[j] - rack[i];
      if (m <= 0) continue;
      k += m;
      idx[nIdx++] = i;
      needL[i] = m;
      const t = tl[i * W + m];
      tOld[i] = t;
      if (t === 0) {
        zeros++;
        zeroAt = i;
      } else prob *= t;
    }
    // rack + L needs k − 1; skip if even that is out of reach.
    if (k - 1 > maxK || zeros > 1) continue;
    const reward = rewards[w];

    if (zeros === 0 && k <= maxK) {
      const ev = reward * prob * discount[k];
      if (ev > base) {
        base = ev;
        bestAt = w;
        bestK = k;
        bestProb = prob * discount[k];
      }
    }
    // rack + L for each needed letter L.
    const dk = reward * discount[k - 1 < 0 ? 0 : k - 1];
    for (let q = 0; q < nIdx; q++) {
      const L = idx[q];
      if (zeros === 1 && L !== zeroAt) continue;
      const pL = (zeros === 1 ? prob : prob / tOld[L]) * tl[L * W + needL[L] - 1];
      const ev = dk * pL;
      if (ev > withL[L]) withL[L] = ev;
    }
  }

  for (let L = 0; L < 26; L++) values[L] = Math.max(0, withL[L] - base);
  if (bestAt >= 0 && bestK > 0) {
    const share = (base * TARGET_TILE_SHARE) / bestK;
    for (let j = start[bestAt]; j < start[bestAt + 1]; j++) {
      const L = letters[j];
      if (counts[j] > rack[L] && values[L] < share) values[L] = share;
    }
  }
  return {
    values,
    base,
    target:
      bestAt >= 0 ? { word: cs.words[bestAt], reward: rewards[bestAt], missing: bestK, prob: bestProb } : null,
  };
}

/** A value table that also says which phase and target it was built for. */
export interface PlanTable extends ValueTable {
  phase: PlayPhase;
  /** Smallest word reward that counts in this phase. */
  minReward: number;
  /** Per-letter floor applied (0 when the rack is not small). */
  floor: number;
  /** Long target word for the rack, if any. */
  target: TargetWord | null;
}

export interface PlanContext extends Omit<ValueContext, "minReward"> {
  hasPlayedWord: boolean;
}

/**
 * Letter values for the bidder: max of value.ts (near words that clear the
 * phase's reward bar) and targetValues (long words), with a floor on small
 * racks.
 */
export function planValues(ctx: PlanContext): PlanTable {
  const phase = playPhase(ctx.auctionsLeft, ctx.hasPlayedWord);
  const minReward = minRewardFor(phase);
  // Letters won just before the endgame get played in the endgame dump.
  const nearEnd = ctx.auctionsLeft <= ENDGAME_AUCTIONS + VALUE_ENDGAME_LOOKAHEAD;
  const table = letterValues({ ...ctx, minReward: nearEnd ? 0 : minReward });

  let target: TargetWord | null = null;
  let floor = 0;
  if (phase !== "endgame" && ctx.auctionsLeft > 1) {
    const tt = targetValues({
      rack: ctx.rack,
      pool: ctx.pool,
      auctionsLeft: ctx.auctionsLeft,
      index: ctx.index,
      bomb: minReward >= BOMB_MIN_REWARD,
    });
    // No bomb reachable: still value letters toward ordinary long words (the
    // deadline will relax the bar to MIN_REWARD).
    let tt2 = tt;
    if (!tt.target && minReward >= BOMB_MIN_REWARD)
      tt2 = targetValues({ rack: ctx.rack, pool: ctx.pool, auctionsLeft: ctx.auctionsLeft, index: ctx.index, bomb: false });
    target = tt2.target;
    for (let i = 0; i < 26; i++) if (tt2.values[i] > table.values[i]) table.values[i] = tt2.values[i];

    let tiles = 0;
    for (const [, n] of ctx.rack) tiles += n;
    if (tiles <= SMALL_RACK_TILES) {
      floor = RACK_FLOOR_POINTS;
      for (let i = 0; i < 26; i++) if (table.values[i] < floor) table.values[i] = floor;
    }
  }
  return { ...table, phase, minReward, floor, target };
}

/** Tiles of `target` not covered by `rack` ("" when no target). */
export function targetMissing(target: TargetWord | null, rack: Rack): string {
  if (!target) return "";
  const have = new Map(rack);
  let out = "";
  for (const c of target.word) {
    const n = have.get(c) ?? 0;
    if (n > 0) have.set(c, n - 1);
    else out += c;
  }
  return out;
}
