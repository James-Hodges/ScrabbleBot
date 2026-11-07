// Word index: the dictionary precomputed once so "what can I spell with this
// rack?" is a fast scan over typed arrays instead of string work per word.
//
// Scoring matches the server exactly (integer math, rounded down).

import * as fs from "node:fs";

/** Letter -> count, the same shape strategy.ts uses for racks. */
export type Rack = Map<string, number>;

const A = 65; // "A".charCodeAt(0)

// Index 0..25 = A..Z.
const LETTER_VALUES: readonly number[] = (() => {
  const v = new Array<number>(26).fill(0);
  const set = (letters: string, n: number) => {
    for (const c of letters) v[c.charCodeAt(0) - A] = n;
  };
  set("AEIOULNSTR", 1);
  set("DG", 2);
  set("BCMP", 3);
  set("FHVWY", 4);
  set("K", 5);
  set("JX", 8);
  set("QZ", 10);
  return v;
})();

/** Point value of a single uppercase letter A-Z; 0 for anything else. */
export function letterValue(c: string): number {
  const i = c.charCodeAt(0) - A;
  return c.length === 1 && i >= 0 && i < 26 ? LETTER_VALUES[i] : 0;
}

/** Length multiplier as [numerator, denominator]. */
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

/** Sum of letter values (no multiplier). */
export function baseValue(word: string): number {
  let base = 0;
  for (const c of word) base += letterValue(c);
  return base;
}

/** Server reward: floor(base * num / denom). */
export function wordReward(word: string): number {
  const [num, denom] = lengthMultiplier(word.length);
  return Math.floor((baseValue(word) * num) / denom);
}

/** Precomputed data for one dictionary word. */
export interface WordEntry {
  readonly word: string;
  readonly length: number;
  readonly reward: number;
  /** Bit i set iff letter i (A=0) appears in the word. */
  readonly mask: number;
  /** Count of each letter A..Z. */
  readonly counts: Uint8Array;
}

export interface PlayableWord {
  word: string;
  reward: number;
}

export interface PlayableOptions {
  /** Minimum word length (default 2). */
  minLen?: number;
  /** Return at most this many results (after sorting). */
  limit?: number;
}

/** Rack as a 26-slot count vector. Non A-Z keys are ignored. */
export function rackCounts(rack: Rack): Uint8Array {
  const counts = new Uint8Array(26);
  for (const [letter, n] of rack) {
    const i = letter.toUpperCase().charCodeAt(0) - A;
    if (letter.length === 1 && i >= 0 && i < 26 && n > 0) {
      counts[i] = Math.min(255, counts[i] + n);
    }
  }
  return counts;
}

/** 26-bit mask of letters with a nonzero count. */
export function countsMask(counts: Uint8Array): number {
  let mask = 0;
  for (let i = 0; i < 26; i++) if (counts[i] > 0) mask |= 1 << i;
  return mask;
}

/** Order: reward desc, length desc, alphabetical. */
export function compareByReward(a: PlayableWord, b: PlayableWord): number {
  return (
    b.reward - a.reward ||
    b.word.length - a.word.length ||
    (a.word < b.word ? -1 : a.word > b.word ? 1 : 0)
  );
}

export class WordIndex {
  /** Per-word precomputed data, sorted by reward desc, length desc, alpha. */
  readonly entries: readonly WordEntry[];

  // Struct-of-arrays copies of the hot fields for the scan loop.
  private readonly masks: Int32Array;
  private readonly lengths: Uint8Array;
  private readonly rewards: Int32Array;
  /** counts for entry k live at [k*26, k*26+26). */
  private readonly flatCounts: Uint8Array;
  private readonly words: ReadonlySet<string>;

  /**
   * Build from a list of words. Words are trimmed and uppercased; anything
   * shorter than 2 letters, containing non A-Z characters, or duplicated is
   * dropped.
   */
  constructor(wordList: readonly string[]) {
    const seen = new Set<string>();
    const entries: WordEntry[] = [];
    for (const raw of wordList) {
      const word = raw.trim().toUpperCase();
      if (word.length < 2 || word.length > 255 || seen.has(word)) continue;
      const counts = new Uint8Array(26);
      let mask = 0;
      let ok = true;
      for (let j = 0; j < word.length; j++) {
        const i = word.charCodeAt(j) - A;
        if (i < 0 || i >= 26) {
          ok = false;
          break;
        }
        counts[i]++;
        mask |= 1 << i;
      }
      if (!ok) continue;
      seen.add(word);
      entries.push({ word, length: word.length, reward: wordReward(word), mask, counts });
    }
    // Pre-sorting means a scan yields results already in output order, and
    // best() can stop at the first hit.
    entries.sort(compareByReward);

    const n = entries.length;
    this.entries = entries;
    this.words = seen;
    this.masks = new Int32Array(n);
    this.lengths = new Uint8Array(n);
    this.rewards = new Int32Array(n);
    this.flatCounts = new Uint8Array(n * 26);
    for (let k = 0; k < n; k++) {
      const e = entries[k];
      this.masks[k] = e.mask;
      this.lengths[k] = e.length;
      this.rewards[k] = e.reward;
      this.flatCounts.set(e.counts, k * 26);
    }
  }

  /** Load a newline-separated wordlist file. */
  static fromFile(path: string | URL): WordIndex {
    return new WordIndex(fs.readFileSync(path, "utf8").split("\n"));
  }

  get size(): number {
    return this.entries.length;
  }

  isWord(word: string): boolean {
    return this.words.has(word.trim().toUpperCase());
  }

  /**
   * Indices into `entries` of every word spellable from `counts`, in entry
   * order (reward desc, length desc, alpha). Stops after `limit` hits.
   */
  private scan(counts: Uint8Array, minLen: number, limit: number): number[] {
    const out: number[] = [];
    if (limit <= 0) return out;
    let tiles = 0;
    for (let i = 0; i < 26; i++) tiles += counts[i];
    const notRack = ~countsMask(counts);
    const { masks, lengths, flatCounts } = this;
    const n = masks.length;
    outer: for (let k = 0; k < n; k++) {
      if ((masks[k] & notRack) !== 0) continue;
      const len = lengths[k];
      if (len > tiles || len < minLen) continue;
      const base = k * 26;
      for (let i = 0; i < 26; i++) {
        if (flatCounts[base + i] > counts[i]) continue outer;
      }
      out.push(k);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Every dictionary word spellable from the rack, sorted by reward desc,
   * then length desc, then alphabetical.
   */
  playable(rack: Rack, opts: PlayableOptions = {}): PlayableWord[] {
    const minLen = Math.max(2, opts.minLen ?? 2);
    const limit = opts.limit ?? Infinity;
    return this.scan(rackCounts(rack), minLen, limit).map((k) => ({
      word: this.entries[k].word,
      reward: this.rewards[k],
    }));
  }

  /** Highest-reward playable word (ties: longer, then alphabetical), or null. */
  best(rack: Rack, opts: { minLen?: number } = {}): PlayableWord | null {
    return this.playable(rack, { minLen: opts.minLen, limit: 1 })[0] ?? null;
  }
}
