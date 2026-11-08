// Play policy (S1-5): hold letters for long words.
//
// - A 7+ letter word earns ~3x per tile what a short word does, so play one
//   as soon as the rack can spell it.
// - Otherwise hold, unless we are short of coins to keep bidding, or it is
//   the endgame, when we play the highest-total-reward set of words.
//
// Pure: no I/O, no clock reads except the endgame search's time cap.

import { letterValue, rackCounts, type Rack, type WordIndex } from "./words.js";

/** Words at least this long are played as soon as possible. */
export const LONG_WORD_LEN = 7;
/** Below this balance we play a word to refill coins. */
export const LOW_BALANCE = 15;
/** Minimum length preferred for a coin-refill word (falls back to any word). */
export const REFILL_MIN_LEN = 4;
/** At or below this many auctions left (including the open one) it's the endgame. */
export const ENDGAME_AUCTIONS = 3;

/** Endgame set search limits. */
export const SET_MAX_WORDS = 4;
export const SET_BRANCHING = 12;
export const SET_TIME_CAP_MS = 25;

export interface PlayContext {
  rack: Rack;
  /** Our current coin balance. */
  balance: number;
  /** Auctions left in the match, including the currently open one. */
  auctionsLeft: number;
  index: WordIndex;
}

/** The word(s) to play now, in order. Empty means hold. */
export function choosePlay(ctx: PlayContext): string[] {
  const { index } = ctx;
  if (ctx.auctionsLeft <= ENDGAME_AUCTIONS) return bestWordSet(ctx.rack, index);

  const rack = new Map(ctx.rack);
  let balance = ctx.balance;
  const plays: string[] = [];

  // Long words first, as many as the rack allows.
  for (;;) {
    const long = index.best(rack, { minLen: LONG_WORD_LEN });
    if (!long) break;
    plays.push(long.word);
    balance += long.reward;
    removeWord(rack, long.word);
  }

  // Short of coins: one word to refill, preferring 4+ letters.
  if (balance < LOW_BALANCE) {
    const refill = index.best(rack, { minLen: REFILL_MIN_LEN }) ?? index.best(rack);
    if (refill) plays.push(refill.word);
  }

  return plays;
}

/**
 * The set of words (each using up its letters) with the highest total
 * reward, ordered by reward desc. Bounded DFS seeded with the greedy answer,
 * so a hit on the time cap still returns at least the greedy set, then
 * extended greedily so no playable word is left in the rack.
 */
export function bestWordSet(rack: Rack, index: WordIndex): string[] {
  // Every word spellable from a sub-rack is spellable from the full rack, so
  // this one scan is the complete candidate list for the whole search.
  const cands = index.playable(rack);
  if (cands.length === 0) return [];
  const words = cands.map((c) => c.word);
  const rewards = cands.map((c) => c.reward);
  const counts = cands.map((c) => wordCounts(c.word));
  const n = cands.length;

  const fits = (k: number, rc: Uint8Array): boolean => {
    const wc = counts[k];
    for (let i = 0; i < 26; i++) if (wc[i] > rc[i]) return false;
    return true;
  };
  const take = (k: number, rc: Uint8Array, sign: 1 | -1) => {
    const wc = counts[k];
    for (let i = 0; i < 26; i++) rc[i] -= sign * wc[i];
  };
  // Upper bound on what the remaining tiles could still earn: every tile
  // at the 3x multiplier.
  const values = new Array<number>(26);
  for (let i = 0; i < 26; i++) values[i] = letterValue(String.fromCharCode(65 + i));
  const bound = (rc: Uint8Array): number => {
    let s = 0;
    for (let i = 0; i < 26; i++) s += rc[i] * values[i];
    return s * 3;
  };

  const rc = rackCounts(rack);

  // Greedy: repeatedly take the best word that still fits.
  let bestTotal = 0;
  let bestPicks: number[] = [];
  {
    const g = rc.slice();
    for (let k = 0; k < n; k++) {
      while (fits(k, g)) {
        take(k, g, 1);
        bestPicks.push(k);
        bestTotal += rewards[k];
      }
    }
  }

  const deadline = performance.now() + SET_TIME_CAP_MS;
  let nodes = 0;
  let timedOut = false;
  const picks: number[] = [];
  const dfs = (start: number, total: number) => {
    if (total > bestTotal) {
      bestTotal = total;
      bestPicks = picks.slice();
    }
    if (picks.length >= SET_MAX_WORDS || timedOut) return;
    if (total + bound(rc) <= bestTotal) return;
    if ((++nodes & 255) === 0 && performance.now() > deadline) {
      timedOut = true;
      return;
    }
    let branches = 0;
    // Non-decreasing index order: each multiset of words is visited once.
    for (let k = start; k < n && branches < SET_BRANCHING; k++) {
      if (!fits(k, rc)) continue;
      branches++;
      take(k, rc, 1);
      picks.push(k);
      dfs(k, total + rewards[k]);
      picks.pop();
      take(k, rc, -1);
      if (timedOut) return;
    }
  };
  dfs(0, 0);

  // The DFS stops at SET_MAX_WORDS words (or the time cap), so its best set
  // can leave playable words behind. Extend it greedily, best reward first:
  // tiles only ever get used up, so a word that doesn't fit when the pass
  // reaches it never fits later, and the leftover has no playable word.
  for (const k of bestPicks) take(k, rc, 1);
  for (let k = 0; k < n; k++) {
    while (fits(k, rc)) {
      take(k, rc, 1);
      bestPicks.push(k);
    }
  }

  return bestPicks
    .slice()
    .sort((a, b) => a - b) // candidate order = reward desc
    .map((k) => words[k]);
}

function wordCounts(word: string): Uint8Array {
  const wc = new Uint8Array(26);
  for (let j = 0; j < word.length; j++) wc[word.charCodeAt(j) - 65]++;
  return wc;
}

/** Subtract `word`'s letters from `rack` in place. */
export function removeWord(rack: Rack, word: string): void {
  for (const c of word) {
    const left = (rack.get(c) ?? 0) - 1;
    if (left > 0) rack.set(c, left);
    else rack.delete(c);
  }
}
