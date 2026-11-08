// Checks for the play guard. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ENDGAME_AUCTIONS, choosePlay, removeWord } from "./play.js";
import { PlayGuard, playKey, playPhase, rackKey } from "./playGuard.js";
import { WordIndex, type Rack } from "./words.js";

const rack = (letters: string): Rack => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

const small = new WordIndex(["CAT", "AT", "TACT", "SCATTER", "CATS", "QAZ", "QI", "ZOAE"]);

test("playPhase: endgame beats played-word state", () => {
  assert.equal(playPhase(ENDGAME_AUCTIONS, false), "endgame");
  assert.equal(playPhase(ENDGAME_AUCTIONS, true), "endgame");
  assert.equal(playPhase(ENDGAME_AUCTIONS + 1, true), "post_bomb");
  assert.equal(playPhase(ENDGAME_AUCTIONS + 1, false), "bomb");
});

test("playKey carries the rounded cutoff in the bomb phase only", () => {
  assert.equal(playKey("bomb", 47.4), "bomb@47");
  assert.equal(playKey("bomb", 47.6), "bomb@48");
  assert.equal(playKey("post_bomb", 47.6), "post_bomb");
  assert.equal(playKey("endgame"), "endgame");
});

test("rackKey ignores order and zero counts", () => {
  const a = new Map([["T", 1], ["A", 2], ["X", 0]]);
  assert.equal(rackKey(a), rackKey(rack("TAA")));
});

test("unchanged rack is skipped in the same phase, re-evaluated when the endgame starts", () => {
  const g = new PlayGuard();
  const r = rack("CATSTE");
  assert.ok(g.shouldEvaluate(r, "bomb"));
  // Midgame: nothing worth playing yet.
  const mid = choosePlay({ rack: r, auctionsLeft: 40, index: small });
  assert.deepEqual(mid, []);
  g.record(r, "bomb", mid);
  assert.equal(g.shouldEvaluate(r, "bomb"), false);
  // Round advances into the endgame; the rack is the same.
  const phase = playPhase(ENDGAME_AUCTIONS, false);
  assert.ok(g.shouldEvaluate(r, phase));
  const end = choosePlay({ rack: r, auctionsLeft: ENDGAME_AUCTIONS, index: small });
  assert.ok(end.length > 0);
  g.record(r, phase, end);
  assert.equal(g.shouldEvaluate(r, phase), false);
});

test("unchanged rack is re-evaluated when the cutoff moves and after our first word", () => {
  const g = new PlayGuard();
  const r = rack("CAT");
  g.record(r, playKey("bomb", 52.2), []);
  // Same rounded cutoff (balance or round changed without moving it): skip.
  assert.equal(g.shouldEvaluate(r, playKey("bomb", 51.8)), false);
  // Cutoff moved (time passed, or we got poorer): re-run.
  assert.ok(g.shouldEvaluate(r, playKey("bomb", 45)));
  assert.ok(g.shouldEvaluate(r, playKey("post_bomb")));
});

test("our own in-flight words are never resubmitted, in any phase", () => {
  const g = new PlayGuard();
  const r0 = rack("QAZIOE");
  const words = choosePlay({ rack: r0, auctionsLeft: 2, index: small });
  assert.equal(words.length, 2);
  g.record(r0, "endgame", words);
  // Every rack state before the last word lands is blocked, whatever the
  // phase (a landing word's reward can change the phase).
  const r = new Map(r0);
  for (let i = 0; i < words.length; i++) {
    for (const p of ["endgame", "bomb", "bomb@30", "bomb@60", "post_bomb"])
      assert.equal(g.shouldEvaluate(r, p), false, `${rackKey(r)} ${p}`);
    removeWord(r, words[i]);
  }
  // After the last word lands the rack is fresh (and has nothing left to play).
  assert.ok(g.shouldEvaluate(r, "endgame"));
  assert.deepEqual(choosePlay({ rack: r, auctionsLeft: 1, index: small }), []);
});

test("a letter won after our plays land is a new rack state", () => {
  const g = new PlayGuard();
  const r0 = rack("SCATTER");
  g.record(r0, "bomb", ["SCATTER"]);
  assert.equal(g.shouldEvaluate(r0, "bomb"), false);
  assert.ok(g.shouldEvaluate(rack("Q"), "bomb"));
});
