// Play policy (S1-5, bomb rework): hold letters for big words.
//
// - Our first word of the match must clear a sliding cutoff (firstWordCutoff
//   in target.ts): MIN_REWARD + (timeBar − MIN_REWARD) × affordShare.
//   timeBar starts at BOMB_MIN_REWARD and falls linearly to MIN_REWARD
//   between BOMB_FULL_AUCTIONS and BOMB_FLOOR_AUCTIONS auctions left;
//   affordShare is how much of the target's missing-tile cost our balance
//   covers. So a broke bot with a 30+ word in hand plays it (and refills
//   coins) instead of waiting.
// - After the first word, play any word with reward >= MIN_REWARD.
// - Never play a word under MIN_REWARD outside the endgame.
// - Endgame (auctionsLeft <= ENDGAME_AUCTIONS): play the highest-total-reward
//   set of words, any size.
//
// The decision depends on (rack, phase, cutoff); playGuard.ts keys on that.
//
// Pure: no I/O, no clock reads except the endgame search's time cap.

import { letterValue, rackCounts, type Rack, type WordIndex } from "./words.js";

/** Outside the endgame, never play a word with a smaller reward. */
export const MIN_REWARD = 30;
/** The first word's cutoff never exceeds this (a "bomb"). */
export const BOMB_MIN_REWARD = 60;
/**
 * timeBar is BOMB_MIN_REWARD at or above this many auctions left (round ~19
 * of 68): the first ~18 auctions are enough to build an 8-10 letter word from
 * 5 starting tiles when the letters come; in the live early-bomb matches it
 * landed by then.
 */
export const BOMB_FULL_AUCTIONS = 50;
/**
 * timeBar reaches MIN_REWARD at this many auctions left (round ~44): leaves
 * ~10 auctions before the spend-down window (14) to use the refilled coins on
 * further 30+ words, instead of the old 20-auction deadline.
 */
export const BOMB_FLOOR_AUCTIONS = 25;
/** At or below this many auctions left (including the open one) it's the endgame. */
export const ENDGAME_AUCTIONS = 3;

/** Endgame set search limits. */
export const SET_MAX_WORDS = 4;
export const SET_BRANCHING = 12;
export const SET_TIME_CAP_MS = 25;

/**
 * - bomb: no word played yet (min reward = the sliding cutoff)
 * - post_bomb: we have played a word (min reward MIN_REWARD)
 * - endgame: play everything (bestWordSet)
 */
export type PlayPhase = "bomb" | "post_bomb" | "endgame";

export function playPhase(auctionsLeft: number, hasPlayedWord: boolean): PlayPhase {
  if (auctionsLeft <= ENDGAME_AUCTIONS) return "endgame";
  return hasPlayedWord ? "post_bomb" : "bomb";
}

/** First-word bar from time alone: 60 early, linear down to 30 at BOMB_FLOOR_AUCTIONS. */
export function timeBar(auctionsLeft: number): number {
  if (auctionsLeft >= BOMB_FULL_AUCTIONS) return BOMB_MIN_REWARD;
  if (auctionsLeft <= BOMB_FLOOR_AUCTIONS) return MIN_REWARD;
  const t = (auctionsLeft - BOMB_FLOOR_AUCTIONS) / (BOMB_FULL_AUCTIONS - BOMB_FLOOR_AUCTIONS);
  return MIN_REWARD + t * (BOMB_MIN_REWARD - MIN_REWARD);
}

/** Clamp a first-word cutoff to [MIN_REWARD, BOMB_MIN_REWARD]. */
export function clampCutoff(cutoff: number): number {
  return Math.min(BOMB_MIN_REWARD, Math.max(MIN_REWARD, cutoff));
}

export interface PlayContext {
  rack: Rack;
  /** Auctions left in the match, including the currently open one. */
  auctionsLeft: number;
  /** Whether we have already played a word this match (default false). */
  hasPlayedWord?: boolean;
  /**
   * First-word cutoff (firstWordCutoff in target.ts). Default timeBar(auctionsLeft).
   * Always clamped to [MIN_REWARD, BOMB_MIN_REWARD].
   */
  cutoff?: number;
  index: WordIndex;
}

/** The word(s) to play now, in order. Empty means hold. */
export function choosePlay(ctx: PlayContext): string[] {
  const { index } = ctx;
  const phase = playPhase(ctx.auctionsLeft, ctx.hasPlayedWord ?? false);
  if (phase === "endgame") return bestWordSet(ctx.rack, index);

  let bar = phase === "bomb" ? clampCutoff(ctx.cutoff ?? timeBar(ctx.auctionsLeft)) : MIN_REWARD;
  const rack = new Map(ctx.rack);
  const plays: string[] = [];
  // Highest-reward word first, as long as it clears the bar. Once one lands
  // we are post-bomb, so later words only need MIN_REWARD.
  for (;;) {
    const best = index.best(rack);
    if (!best || best.reward < bar) break;
    plays.push(best.word);
    removeWord(rack, best.word);
    bar = MIN_REWARD;
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
  const n = cands.length;
  const words = new Array<string>(n);
  const rewards = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    words[i] = cands[i].word;
    rewards[i] = cands[i].reward;
  }

  // Lazy-allocate word count vectors on demand to eliminate 25,000+ GC allocations.
  const countCache = new Array<Uint8Array | undefined>(n);
  const getCounts = (k: number): Uint8Array => {
    let c = countCache[k];
    if (!c) {
      c = new Uint8Array(26);
      const w = words[k];
      for (let i = 0; i < w.length; i++) c[w.charCodeAt(i) - 65]++;
      countCache[k] = c;
    }
    return c;
  };

  const fits = (k: number, rc: Uint8Array): boolean => {
    const wc = getCounts(k);
    for (let i = 0; i < 26; i++) if (wc[i] > rc[i]) return false;
    return true;
  };
  const take = (k: number, rc: Uint8Array, sign: 1 | -1) => {
    const wc = getCounts(k);
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
    if ((++nodes & 63) === 0 && performance.now() > deadline) {
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
