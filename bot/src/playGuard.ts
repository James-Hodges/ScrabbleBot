// Play guard (S1-6): decides when word play needs re-evaluating.
//
// `choosePlay` is a function of (rack, play key) only, where the play key is
// playKey(phase, cutoff):
// - endgame: `bestWordSet(rack)`;
// - post_bomb: the best words with reward >= MIN_REWARD;
// - bomb: the first word must clear the sliding cutoff (firstWordCutoff),
//   which moves with auctions left, balance, round and the pool. The key
//   carries the cutoff rounded to a whole coin, so any change in what the
//   cutoff depends on that moves it re-runs the decision, and an unchanged
//   cutoff does not.
// So an unchanged (rack, key) never needs a second look, and a key change on
// an unchanged rack does: the cutoff moving, our first word landing (it also
// changes the rack), or the endgame starting.
//
// Our own plays: submitting words W1..Wk from rack R0 passes through
// R1..Rk as each word lands. While the rack is R0..R(k-1), some of our words
// are still in flight, and any decision there would include them again, so
// those states are blocked under every key (a landing word pays coins and
// flips hasPlayedWord, both of which change the key). Rk, after the last word
// lands, is fresh.
//
// Pure: no I/O.

import { playPhase, type PlayPhase } from "./play.js";
import type { Rack } from "./words.js";

export { playPhase, type PlayPhase };

/** Guard key: the phase, plus the rounded cutoff in the bomb phase. */
export function playKey(phase: PlayPhase, cutoff?: number): string {
  return phase === "bomb" && cutoff !== undefined ? `bomb@${Math.round(cutoff)}` : phase;
}

/** Canonical rack key, e.g. "A2C1T1". */
export function rackKey(rack: Rack): string {
  return [...rack]
    .filter(([, n]) => n > 0)
    .map(([c, n]) => c + n)
    .sort()
    .join("");
}

const IN_FLIGHT = "*";

/** Per-match guard. */
export class PlayGuard {
  private readonly seen = new Set<string>();

  /** True if (rack, key) hasn't been decided and none of our words are in flight. */
  shouldEvaluate(rack: Rack, phase: string): boolean {
    const r = rackKey(rack);
    return !this.seen.has(`${r}|${IN_FLIGHT}`) && !this.seen.has(`${r}|${phase}`);
  }

  /**
   * Record the decision for (rack, phase). With words, also block every rack
   * state before the last word lands, in every phase.
   */
  record(rack: Rack, phase: string, words: readonly string[]): void {
    const left = new Map(rack);
    this.seen.add(`${rackKey(left)}|${phase}`);
    for (const word of words) {
      this.seen.add(`${rackKey(left)}|${IN_FLIGHT}`);
      for (const c of word) left.set(c, (left.get(c) ?? 0) - 1);
    }
  }
}
