// Letter valuation (S2-2): what one more copy of each letter is worth to us.
//
// Model
// -----
// V(rack) = expected reward of the best word we end up able to spell, over
// the tiles we may still win:
//
//   * Each unseen copy of letter i (pool count p_i) is auctioned within our
//     horizon with chance T / N (T = usable auctions still to come, N = pool
//     size; the pool holds the bag plus opponents' hidden starting tiles, so
//     T / N = P(in bag) × P(drawn within T | in bag)), and we win it with
//     WIN_RATE. So we win each copy independently with f = WIN_RATE × min(1, T/N).
//   * We draw SCENARIOS fixed futures from a seeded generator: in each, which
//     unseen copies we win. In each future the reward is the best dictionary
//     word spellable from rack + winnings, among words missing at most
//     MAX_MISSING tiles from the rack (+ L). V = mean over futures.
//     Simulating futures (rather than multiplying per-word probabilities)
//     handles overlapping routes correctly: RETAINS and STAINER both need an S
//     and can't both count.
//   * value(L) = V(rack + L) − V(rack), with the same futures for every L
//     (common random numbers), so differences are low-noise and every letter
//     sees the same luck.
//
// One scan over the word index computes all 26 values: for each word we know
// its missing tiles for the rack, and adding L only changes the words that
// miss an L. Words are visited in reward order, so the first word a future
// can spell is its best; a future is then settled and skipped.
//
// Timing: T = auctionsLeft − 2. auctionsLeft counts the open auction (the
// letter we're valuing); the final auction's letter can never be played. So
// with auctionsLeft ≤ 1 every value is 0, and with auctionsLeft = 2 only
// immediately playable words count.
//
// Pure and deterministic (fixed seed).

import { rackCounts, type Rack, type WordIndex } from "./words.js";

/** Share of the letters we expect to win (~23 of 68 for a top bot). */
export const WIN_RATE = 0.35;
/** Target words may miss at most this many tiles from rack + L. */
export const MAX_MISSING = 2;
/** Simulated futures (multiple of 32). */
export const SCENARIOS = 256;
const SEED = 0x5c4ab1e;

const A = 65;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const WORDS = SCENARIOS / 32;
/** Missing-tile multiset codes: up to MAX_MISSING letters, base 27. */
const KEY_SPACE = 27 ** MAX_MISSING;

export interface ValueContext {
  rack: Rack;
  /** Unseen tiles per letter (`unseenPool(state).unseen`) or a 26-slot count vector. */
  pool: Rack | Uint8Array;
  /** Auctions left including the open one (as in MatchState). */
  auctionsLeft: number;
  index: WordIndex;
  /** Override WIN_RATE. */
  winRate?: number;
  /**
   * Set when `pool` still holds the copy being valued (e.g. precomputing the
   * table before the auction opens): rack + L then draws from one fewer L.
   * Leave unset with `unseenPool`, which already counts the open auction's
   * letter as seen.
   */
  poolIncludesLetter?: boolean;
  /** Fill `targets` with each letter's main target word. */
  explain?: boolean;
}

export interface Target {
  word: string;
  reward: number;
  /** Share of futures in which this is the best word for rack + L. */
  share: number;
}

export interface ValueTable {
  /** Expected gain in final word reward (points), index 0..25 = A..Z. */
  values: Float64Array;
  /** V(rack) without any added letter. */
  base: number;
  /** Usable auctions still to come after this one (T). */
  lettersToCome: number;
  /** Per-copy chance we win an unseen tile within the horizon (f). */
  perCopy: number;
  /** With `explain`: per letter, the word contributing most to V(rack + L). */
  targets?: (Target | null)[];
}

/** Value of `letter` from a table (0 for non A-Z). */
export function valueOf(table: ValueTable, letter: string): number {
  const i = letter.toUpperCase().charCodeAt(0) - A;
  return letter.length === 1 && i >= 0 && i < 26 ? table.values[i] : 0;
}

/** Letters sorted by value, highest first (for logs). */
export function topLetters(table: ValueTable, n = 5): { letter: string; value: number }[] {
  return [...LETTERS]
    .map((letter, i) => ({ letter, value: table.values[i] }))
    .sort((a, b) => b.value - a.value || (a.letter < b.letter ? -1 : 1))
    .slice(0, n);
}

/** One accumulator: V for the rack (index 26) or for rack + L. */
interface Acc {
  sum: number;
  /** Futures not yet settled (bitset). */
  open: Uint32Array;
  done: boolean;
  seen: Uint8Array;
  bestWord: string;
  bestReward: number;
  bestHits: number;
}

export function letterValues(ctx: ValueContext): ValueTable {
  const values = new Float64Array(26);
  if (ctx.auctionsLeft <= 1) {
    return {
      values,
      base: 0,
      lettersToCome: 0,
      perCopy: 0,
      targets: ctx.explain ? new Array<Target | null>(26).fill(null) : undefined,
    };
  }
  const T = Math.max(0, Math.floor(ctx.auctionsLeft) - 2);

  const rack = rackCounts(ctx.rack);
  const pool = ctx.pool instanceof Uint8Array ? ctx.pool : rackCounts(ctx.pool);
  let N = 0;
  for (let i = 0; i < 26; i++) N += pool[i];
  const winRate = ctx.winRate ?? WIN_RATE;
  const f = N > 0 && T > 0 ? winRate * Math.min(1, T / N) : 0;

  // With no letters to come only playable words count (rack + L misses none).
  const maxMissing = f > 0 ? MAX_MISSING : 0;
  const maxScan = maxMissing + 1; // missing tiles for the rack itself

  // have[i][m]: futures in which we win at least m copies of letter i.
  // haveL: the same for letter L as seen by rack + L.
  const have = futures(pool, f, maxMissing, 0);
  const haveL = ctx.poolIncludesLetter ? futures(pool, f, maxMissing, 1) : have;

  let rackTiles = 0;
  let rackMask = 0;
  for (let i = 0; i < 26; i++) {
    rackTiles += rack[i];
    if (rack[i] > 0) rackMask |= 1 << i;
  }

  const accs: Acc[] = Array.from({ length: 27 }, () => ({
    sum: 0,
    open: new Uint32Array(WORDS).fill(0xffffffff),
    done: false,
    seen: new Uint8Array(KEY_SPACE),
    bestWord: "",
    bestReward: 0,
    bestHits: 0,
  }));
  let live = 27;

  const sat = new Uint32Array(WORDS);
  const settle = (acc: Acc, key: number, word: string, reward: number) => {
    if (acc.done || acc.seen[key]) return;
    acc.seen[key] = 1; // later words with the same missing tiles reward less
    let hits = 0;
    let open = 0;
    const o = acc.open;
    for (let w = 0; w < WORDS; w++) {
      const hit = sat[w] & o[w];
      if (hit !== 0) {
        hits += popcount(hit);
        o[w] ^= hit;
      }
      open |= o[w];
    }
    if (hits === 0) return;
    acc.sum += reward * hits;
    if (hits > acc.bestHits) {
      acc.bestHits = hits;
      acc.bestWord = word;
      acc.bestReward = reward;
    }
    if (open === 0) {
      acc.done = true;
      live--;
    }
  };

  const notRack = ~rackMask;
  const missing = new Uint8Array(26);
  const missIdx: number[] = [];
  for (const e of ctx.index.entries) {
    if (live === 0) break;
    if (e.length > rackTiles + maxScan) continue;
    if (popcount(e.mask & notRack) > maxScan) continue;
    let k = 0;
    missIdx.length = 0;
    const c = e.counts;
    for (let i = 0; i < 26; i++) {
      const m = c[i] > rack[i] ? c[i] - rack[i] : 0;
      missing[i] = m;
      if (m > 0) {
        k += m;
        missIdx.push(i);
        if (k > maxScan) break;
      }
    }
    if (k > maxScan) continue;

    // rack + L for each letter L the word misses: one fewer L needed.
    let missMask = 0;
    for (const L of missIdx) {
      missMask |= 1 << L;
      missing[L]--;
      if (!accs[L].done && intersect(sat, have, haveL[L], missing, missIdx, L))
        settle(accs[L], encode(missing, missIdx), e.word, e.reward);
      missing[L]++;
    }
    // The rack itself, and rack + L for every other L: unchanged.
    if (k <= maxMissing && intersect(sat, have, null, missing, missIdx, -1)) {
      const key = encode(missing, missIdx);
      settle(accs[26], key, e.word, e.reward);
      for (let L = 0; L < 26; L++) if (!(missMask & (1 << L))) settle(accs[L], key, e.word, e.reward);
    }
  }

  const base = accs[26].sum / SCENARIOS;
  for (let L = 0; L < 26; L++) values[L] = Math.max(0, accs[L].sum / SCENARIOS - base);
  return {
    values,
    base,
    lettersToCome: T,
    perCopy: f,
    targets: ctx.explain
      ? accs.slice(0, 26).map((a) =>
          a.bestWord ? { word: a.bestWord, reward: a.bestReward, share: a.bestHits / SCENARIOS } : null,
        )
      : undefined,
  };
}

/**
 * sat = futures that have every missing tile (letter L read from `haveOfL`).
 * Returns false when no future does.
 */
function intersect(
  sat: Uint32Array,
  have: Uint32Array[][],
  haveOfL: Uint32Array[] | null,
  missing: Uint8Array,
  idx: number[],
  L: number,
): boolean {
  sat.fill(0xffffffff);
  for (const i of idx) {
    const m = missing[i];
    if (m === 0) continue;
    const b = (i === L && haveOfL ? haveOfL : have[i])[m];
    if (!b) return false; // needs more copies than we track: never in time
    let any = 0;
    for (let w = 0; w < WORDS; w++) any |= sat[w] &= b[w];
    if (any === 0) return false;
  }
  return true;
}

/**
 * For each letter, bitsets of the futures in which we win at least m copies
 * (m = 0..maxMissing), using `pool[i] − drop` copies. Each copy uses the same
 * random draw whatever f is, so a smaller f wins a subset of the copies.
 */
function futures(pool: Uint8Array, f: number, maxMissing: number, drop: number): Uint32Array[][] {
  const rand = mulberry32(SEED);
  const out: Uint32Array[][] = [];
  const won = new Uint8Array(SCENARIOS);
  for (let i = 0; i < 26; i++) {
    won.fill(0);
    const copies = Math.max(0, pool[i] - drop);
    // Always consume 12 draws per letter so letters don't shift each other's luck.
    for (let c = 0; c < 12; c++) {
      for (let s = 0; s < SCENARIOS; s++) {
        const u = rand();
        if (c < copies && u < f) won[s]++;
      }
    }
    const sets: Uint32Array[] = [];
    for (let m = 0; m <= maxMissing; m++) {
      const b = new Uint32Array(WORDS);
      for (let s = 0; s < SCENARIOS; s++) if (won[s] >= m) b[s >>> 5] |= 1 << (s & 31);
      sets.push(b);
    }
    out.push(sets);
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Order-free code for a missing multiset of ≤ MAX_MISSING tiles (idx ascending). */
function encode(missing: Uint8Array, idx: number[]): number {
  let code = 0;
  for (const i of idx) for (let n = missing[i]; n > 0; n--) code = code * 27 + (i + 1);
  return code;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
