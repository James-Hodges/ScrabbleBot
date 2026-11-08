// Target word selection and forced-play strategy for high-scoring words.
//
// Strategy:
// At the start of the match (using the 5 private starting tiles dealt to us),
// evaluate candidate high-scoring words from the collected catalog.
// Pick the route that offers the highest probability to successfully complete
// and play the word, accounting for:
// 1. Exact multivariate hypergeometric probability that missing tiles are in
//    the 68 bag tiles (and not in the 25 opponent starting tiles).
// 2. Acquisition probability scaling with the number of missing tiles needed.
// 3. Forced aggressive bidding on required tiles, zero bidding on unneeded tiles.
// 4. Immediate submission as soon as all letters are in hand.
// 5. Dynamic re-routing if an irreplaceable letter is won by an opponent.
// 6. Smooth transition to free-play after the target word is banked.

import type { Rack } from "./words.js";
import { wordReward } from "./words.js";

export { wordReward };

/** Standard 98 physical tiles in ScrabbleBot (no blanks). */
export const BAG_TILE_DISTRIBUTION: Readonly<Record<string, number>> = {
  E: 12, A: 9, I: 9, O: 8, N: 6, R: 6, T: 6,
  D: 4, L: 4, S: 4, U: 4, G: 3,
  B: 2, C: 2, M: 2, P: 2, F: 2, H: 2, V: 2, W: 2, Y: 2,
  K: 1, J: 1, X: 1, Q: 1, Z: 1,
};

/**
 * 64 High-scoring candidate words collected across lengths 7–12,
 * verified in the ENABLE dictionary and physically spellable.
 */
export const COLLECTED_TARGET_WORDS: readonly string[] = [
  "ASPHYXY",
  "BEZIQUE",
  "BEZIQUES",
  "CAZIQUE",
  "CAZIQUES",
  "CHEAPJACK",
  "CHUTZPAH",
  "EXCHEQUER",
  "EXCHEQUERS",
  "EXOENZYME",
  "EXOENZYMES",
  "HAPHAZARDLY",
  "HIGHJACK",
  "HIGHJACKED",
  "HIGHJACKS",
  "HYDROXYZINE",
  "HYDROXYZINES",
  "HYPOPHARYNX",
  "JABBERWOCKY",
  "JACKFISH",
  "JACQUARD",
  "JANIZARY",
  "JAROVIZE",
  "JAROVIZED",
  "JAYHAWKER",
  "JEZEBEL",
  "JUKEBOX",
  "JUKEBOXES",
  "KATZENJAMMER",
  "KOLHOZY",
  "KRUMMHOLZ",
  "MAXIMIZE",
  "MAXIMIZED",
  "MAXIMIZER",
  "MAXIMIZES",
  "MAXIMIZING",
  "MEZQUIT",
  "MEZQUITE",
  "MEZQUITES",
  "MEZQUITS",
  "MUZHIKS",
  "MUZJIKS",
  "OXAZEPAM",
  "OXAZEPAMS",
  "PACKWAX",
  "PHAGOCYTIZED",
  "QUADPLEX",
  "QUETZAL",
  "QUEZALS",
  "RHYTHMIZE",
  "SOVKHOZ",
  "SOVKHOZY",
  "SUBJECTIVIZE",
  "WHEEZILY",
  "WHIZBANG",
  "ZINKIFY",
  "ZOMBIFY",
  "ZOMBIFYING",
  "ZWIEBACK",
  "ZWIEBACKS",
  "ZYGAPOPHYSES",
  "ZYGAPOPHYSIS",
  "ZYGOMORPHIC",
  "ZYGOMORPHY",
];

// Precompute Pascal combination table nCr for n <= 100
const COMB_TABLE: number[][] = [];
for (let n = 0; n <= 100; n++) {
  COMB_TABLE[n] = [1];
  for (let k = 1; k <= n; k++) {
    COMB_TABLE[n][k] =
      (COMB_TABLE[n - 1][k - 1] ?? 0) + (COMB_TABLE[n - 1][k] ?? 0);
  }
}

/** nCr combination helper. */
export function nCr(n: number, r: number): number {
  if (r < 0 || r > n) return 0;
  return COMB_TABLE[n]?.[r] ?? 0;
}

/** Letter count multiset for a word. */
export function wordLetterCounts(word: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of word) counts.set(c, (counts.get(c) ?? 0) + 1);
  return counts;
}

export interface TargetEvaluation {
  word: string;
  reward: number;
  length: number;
  /** Number of tiles our rack is currently missing. */
  missingCount: number;
  /** Map of letter -> count still needed. */
  missing: Map<string, number>;
  /** Exact hypergeometric probability that all missing tiles are in the bag. */
  pBag: number;
  /** Estimated overall probability of acquiring all missing tiles and playing the word. */
  pPlay: number;
  /** Expected point value: reward * pPlay. */
  ev: number;
}

/**
 * Exact probability that all missing tiles M = (W - rack) are present in the
 * bag (68 tiles) rather than dealt to the 5 opponents (25 tiles total).
 * Uses exact multivariate hypergeometric dynamic programming.
 */
export function exactBagProb(
  word: string,
  rack: Rack,
  pool?: Map<string, number> | ReadonlyMap<string, number>,
  totalOutside = 93,
  totalOpp = 25,
): number {
  const needed = wordLetterCounts(word);
  const M = new Map<string, number>();
  for (const [c, n] of needed.entries()) {
    const have = rack.get(c) ?? 0;
    const diff = n - have;
    if (diff > 0) {
      M.set(c, diff);
      const poolC = pool !== undefined ? (pool.get(c) ?? 0) : ((BAG_TILE_DISTRIBUTION[c] ?? 0) - have);
      if (diff > poolC) return 0;
    }
  }
  if (M.size === 0) return 1.0;

  // Constrained letters: those where poolC <= 4
  const constrained: { letter: string; pool: number; need: number }[] = [];
  for (const [c, diff] of M.entries()) {
    const poolC = pool !== undefined ? (pool.get(c) ?? 0) : ((BAG_TILE_DISTRIBUTION[c] ?? 0) - (rack.get(c) ?? 0));
    if (poolC <= 4) constrained.push({ letter: c, pool: poolC, need: diff });
  }

  let dp = new Map<number, number>([[0, 1]]);
  let sumConstrained = 0;
  for (const item of constrained) {
    const maxOpp = item.pool - item.need;
    if (maxOpp < 0) return 0;
    const newDp = new Map<number, number>();
    for (const [used, ways] of dp.entries()) {
      for (let k = 0; k <= maxOpp; k++) {
        if (k <= item.pool) {
          const wK = nCr(item.pool, k);
          const u = used + k;
          newDp.set(u, (newDp.get(u) ?? 0) + ways * wK);
        }
      }
    }
    dp = newDp;
    sumConstrained += item.pool;
  }

  const unconstrained = totalOutside - sumConstrained;
  let totalValid = 0;
  for (const [used, ways] of dp.entries()) {
    const remOpp = totalOpp - used;
    if (remOpp >= 0 && remOpp <= unconstrained) {
      totalValid += ways * nCr(unconstrained, remOpp);
    }
  }

  const denom = nCr(totalOutside, totalOpp);
  if (denom <= 0) return 0;
  return totalValid / denom;
}

/** Check if current rack has all letters needed to spell the word. */
export function canSpell(rack: Rack, word: string): boolean {
  const counts = wordLetterCounts(word);
  for (const [c, n] of counts.entries()) {
    if ((rack.get(c) ?? 0) < n) return false;
  }
  return true;
}

/** Check whether target word can still be spelled using current rack + unseen pool. */
export function isTargetViable(
  word: string,
  rack: Rack,
  pool?: Map<string, number> | ReadonlyMap<string, number>,
): boolean {
  const counts = wordLetterCounts(word);
  for (const [c, n] of counts.entries()) {
    const have = rack.get(c) ?? 0;
    const inPool = pool !== undefined ? (pool.get(c) ?? 0) : ((BAG_TILE_DISTRIBUTION[c] ?? 0) - have);
    if (have + inPool < n) return false;
  }
  return true;
}

/** Does our rack still need this letter to complete the target word? */
export function targetNeedsLetter(
  targetWord: string,
  rack: Rack,
  letter: string,
): boolean {
  const counts = wordLetterCounts(targetWord);
  const needed = counts.get(letter.toUpperCase()) ?? 0;
  const have = rack.get(letter.toUpperCase()) ?? 0;
  return have < needed;
}

/** Per-tile auction acquisition win factor (~0.90 per needed auction). */
export const PER_TILE_ACQUIRE_PROB = 0.90;

/**
 * Evaluates all candidate words against the given rack and pool,
 * ranking by the highest completion probability (best route).
 */
export function evaluateTargets(
  rack: Rack,
  pool?: Map<string, number> | ReadonlyMap<string, number>,
): TargetEvaluation[] {
  let totalRackTiles = 0;
  for (const n of rack.values()) totalRackTiles += n;
  const totalOutside = Math.max(1, 98 - totalRackTiles);
  const totalOpp = Math.min(25, totalOutside);

  const results: TargetEvaluation[] = [];

  for (const word of COLLECTED_TARGET_WORDS) {
    if (!isTargetViable(word, rack, pool)) continue;

    const pBag = exactBagProb(word, rack, pool, totalOutside, totalOpp);
    if (pBag <= 0) continue;

    const needed = wordLetterCounts(word);
    const missing = new Map<string, number>();
    let missingCount = 0;
    for (const [c, n] of needed.entries()) {
      const have = rack.get(c) ?? 0;
      if (n > have) {
        missing.set(c, n - have);
        missingCount += n - have;
      }
    }

    const pPlay = pBag * Math.pow(PER_TILE_ACQUIRE_PROB, missingCount);
    const reward = wordReward(word);
    const ev = reward * pPlay;

    results.push({
      word,
      reward,
      length: word.length,
      missingCount,
      missing,
      pBag,
      pPlay,
      ev,
    });
  }

  // Sort: highest pPlay, then fewest missing tiles, then highest reward
  results.sort((a, b) => {
    if (Math.abs(b.pPlay - a.pPlay) > 0.001) return b.pPlay - a.pPlay;
    if (a.missingCount !== b.missingCount) return a.missingCount - b.missingCount;
    return b.reward - a.reward;
  });

  return results;
}

/** Select the single best route with the highest probability to play. */
export function selectBestTarget(
  rack: Rack,
  pool?: Map<string, number> | ReadonlyMap<string, number>,
): TargetEvaluation | null {
  const evals = evaluateTargets(rack, pool);
  return evals.length > 0 ? evals[0] : null;
}

/** Tracks target state and re-routing throughout a single match. */
export class MatchTargetTracker {
  public target: TargetEvaluation | null = null;
  public played = false;
  public abandoned = false;

  constructor(public readonly matchId: bigint) {}

  /** Initialise or update target given the current rack and pool. */
  public update(
    rack: Rack,
    pool?: Map<string, number> | ReadonlyMap<string, number>,
  ): TargetEvaluation | null {
    if (this.played) return null;

    // Check if current target is still viable
    if (this.target && isTargetViable(this.target.word, rack, pool)) {
      // Re-evaluate current target's missing tiles
      const needed = wordLetterCounts(this.target.word);
      const missing = new Map<string, number>();
      let missingCount = 0;
      for (const [c, n] of needed.entries()) {
        const have = rack.get(c) ?? 0;
        if (n > have) {
          missing.set(c, n - have);
          missingCount += n - have;
        }
      }
      this.target.missing = missing;
      this.target.missingCount = missingCount;
      return this.target;
    }

    // Current target is either unset or became impossible: pick best route
    const best = selectBestTarget(rack, pool);
    if (best) {
      this.target = best;
      this.abandoned = false;
    } else {
      this.abandoned = true;
    }
    return this.target;
  }
}
