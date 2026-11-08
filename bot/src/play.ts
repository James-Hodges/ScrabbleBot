// Play policy (S1-5, bomb rework): hold letters for big words.
//
// - Our first word of the match must be a "bomb": reward >= BOMB_MIN_REWARD
//   (typically 8-10 letters with a high-value tile). With BOMB_DEADLINE_AUCTIONS
//   or fewer auctions left the first-word bar drops to MIN_REWARD so we never
//   hold forever.
// - After the first word, play any word with reward >= MIN_REWARD.
// - Never play a word under MIN_REWARD outside the endgame. Being low on
//   coins is not a reason to play a small word (the old refill rule is gone).
// - Endgame (auctionsLeft <= ENDGAME_AUCTIONS): play the highest-total-reward
//   set of words, any size.
//
// The decision depends only on (rack, phase), where phase is
// playPhase(auctionsLeft, hasPlayedWord); playGuard.ts relies on that.
//
// Pure: no I/O, no clock reads except the endgame search's time cap.

import { letterValue, rackCounts, type Rack, type WordIndex } from "./words.js";

/** Outside the endgame, never play a word with a smaller reward. */
export const MIN_REWARD = 30;
/** Until our first word lands, it must reward at least this much. */
export const BOMB_MIN_REWARD = 60;
/** At or below this many auctions left (incl. the open one) the first word only needs MIN_REWARD. */
export const BOMB_DEADLINE_AUCTIONS = 20;
/** At or below this many auctions left (including the open one) it's the endgame. */
export const ENDGAME_AUCTIONS = 3;

/** Endgame set search limits. */
export const SET_MAX_WORDS = 4;
export const SET_BRANCHING = 12;
export const SET_TIME_CAP_MS = 25;

/**
 * - bomb: no word played yet, before the deadline (min reward BOMB_MIN_REWARD)
 * - bomb_late: no word played yet, past the deadline (min reward MIN_REWARD)
 * - post_bomb: we have played a word (min reward MIN_REWARD)
 * - endgame: play everything (bestWordSet)
 */
export type PlayPhase = "bomb" | "bomb_late" | "post_bomb" | "endgame";

export function playPhase(auctionsLeft: number, hasPlayedWord: boolean): PlayPhase {
  if (auctionsLeft <= ENDGAME_AUCTIONS) return "endgame";
  if (hasPlayedWord) return "post_bomb";
  return auctionsLeft <= BOMB_DEADLINE_AUCTIONS ? "bomb_late" : "bomb";
}

/** Smallest reward a word may have to be played in `phase` (0 in the endgame). */
export function minRewardFor(phase: PlayPhase): number {
  if (phase === "endgame") return 0;
  return phase === "bomb" ? BOMB_MIN_REWARD : MIN_REWARD;
}

export interface PlayContext {
  rack: Rack;
  /** Auctions left in the match, including the currently open one. */
  auctionsLeft: number;
  /** Whether we have already played a word this match (default false). */
  hasPlayedWord?: boolean;
  index: WordIndex;
}

/** The word(s) to play now, in order. Empty means hold. */
export function choosePlay(ctx: PlayContext): string[] {
  const { index } = ctx;
  let phase = playPhase(ctx.auctionsLeft, ctx.hasPlayedWord ?? false);
  if (phase === "endgame") return bestWordSet(ctx.rack, index);

  const rack = new Map(ctx.rack);
  const plays: string[] = [];
  // Highest-reward word first, as long as it clears the phase's bar. Once
  // one lands we are post-bomb, so later words only need MIN_REWARD.
  for (;;) {
    const best = index.best(rack);
    if (!best || best.reward < minRewardFor(phase)) break;
    plays.push(best.word);
    removeWord(rack, best.word);
    phase = "post_bomb";
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
