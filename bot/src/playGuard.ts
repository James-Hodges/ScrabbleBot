// Play guard (S1-6): decides when word play needs re-evaluating.
//
// `choosePlay` is a function of (rack, phase) only, where phase is
// playPhase(auctionsLeft, hasPlayedWord) (play.ts):
// - endgame: `bestWordSet(rack)`;
// - otherwise the best words whose reward clears minRewardFor(phase):
//   BOMB_MIN_REWARD before our first word (until the deadline), MIN_REWARD
//   after it or past the deadline. Balance is not an input.
// So an unchanged (rack, phase) never needs a second look, and a phase
// change on an unchanged rack does: reaching the bomb deadline, our first
// word landing (it also changes the rack), or the endgame starting.
//
// Our own plays: submitting words W1..Wk from rack R0 passes through
// R1..Rk as each word lands. While the rack is R0..R(k-1), some of our words
// are still in flight, and any decision there would include them again, so
// those states are blocked in every phase (a landing word flips
// hasPlayedWord, which changes the phase). Rk, after the last word lands, is fresh.
//
// Pure: no I/O.

import { playPhase, type PlayPhase } from "./play.js";
import type { Rack } from "./words.js";

export { playPhase, type PlayPhase };

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

  /** True if (rack, phase) hasn't been decided and none of our words are in flight. */
  shouldEvaluate(rack: Rack, phase: PlayPhase): boolean {
    const r = rackKey(rack);
    return !this.seen.has(`${r}|${IN_FLIGHT}`) && !this.seen.has(`${r}|${phase}`);
  }

  /**
   * Record the decision for (rack, phase). With words, also block every rack
   * state before the last word lands, in every phase.
   */
  record(rack: Rack, phase: PlayPhase, words: readonly string[]): void {
    const left = new Map(rack);
    this.seen.add(`${rackKey(left)}|${phase}`);
    for (const word of words) {
      this.seen.add(`${rackKey(left)}|${IN_FLIGHT}`);
      for (const c of word) left.set(c, (left.get(c) ?? 0) - 1);
    }
  }
}
