import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTED_TARGET_WORDS,
  wordReward,
  nCr,
  exactBagProb,
  canSpell,
  isTargetViable,
  targetNeedsLetter,
  evaluateTargets,
  selectBestTarget,
  MatchTargetTracker,
} from "./target.js";
import { WordIndex } from "./words.js";

function makeRack(str: string): Map<string, number> {
  const r = new Map<string, number>();
  for (const c of str.toUpperCase()) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
}

test("all collected target words exist in dictionary and have valid rewards", () => {
  const index = WordIndex.fromFile(
    new URL("../data/wordlist.txt", import.meta.url),
  );
  assert.equal(COLLECTED_TARGET_WORDS.length, 64);
  for (const w of COLLECTED_TARGET_WORDS) {
    assert.ok(index.isWord(w), `Word '${w}' must be in dictionary`);
    const r = wordReward(w);
    assert.ok(r >= 75, `Word '${w}' must have reward >= 75 (got ${r})`);
  }
});

test("nCr combinations table is correct", () => {
  assert.equal(nCr(5, 0), 1);
  assert.equal(nCr(5, 1), 5);
  assert.equal(nCr(5, 2), 10);
  assert.equal(nCr(5, 5), 1);
  assert.equal(nCr(5, 6), 0);
  assert.equal(nCr(93, 25), 3.0070757922164273e22);
});

test("exactBagProb handles simple and constrained cases", () => {
  // If no tiles are missing, probability is 1.0
  const rackAll = makeRack("CAZIQUES");
  assert.equal(exactBagProb("CAZIQUES", rackAll), 1.0);

  // Hand CEISU needs A:1 Q:1 Z:1
  const rackCEISU = makeRack("CEISU");
  const p = exactBagProb("CAZIQUES", rackCEISU);
  assert.ok(p > 0.50 && p < 0.55, `p was ${p}`);

  // Hand with impossible letter count
  const rackZ = makeRack("Z");
  // Only 1 Z in bag, so if opponent had it or word needs 2 Zs when only 1 exists:
  assert.equal(exactBagProb("ZZZ", rackZ), 0.0);
});

test("canSpell accurately detects complete words", () => {
  const r1 = makeRack("CAZIQUES");
  assert.equal(canSpell(r1, "CAZIQUES"), true);
  assert.equal(canSpell(r1, "CAZIQUE"), true);

  const r2 = makeRack("CAZIQUE");
  assert.equal(canSpell(r2, "CAZIQUES"), false);
  assert.equal(canSpell(r2, "CAZIQUE"), true);

  const r3 = makeRack("JUKEBOX");
  assert.equal(canSpell(r3, "JUKEBOX"), true);
  assert.equal(canSpell(r3, "JUKEBOXES"), false);
});

test("targetNeedsLetter checks if specific letter is missing", () => {
  const r = makeRack("CEISU");
  assert.equal(targetNeedsLetter("CAZIQUES", r, "A"), true);
  assert.equal(targetNeedsLetter("CAZIQUES", r, "Q"), true);
  assert.equal(targetNeedsLetter("CAZIQUES", r, "Z"), true);
  assert.equal(targetNeedsLetter("CAZIQUES", r, "C"), false);
  assert.equal(targetNeedsLetter("CAZIQUES", r, "E"), false);
  assert.equal(targetNeedsLetter("CAZIQUES", r, "X"), false);
});

test("selectBestTarget picks optimal high-probability route from starting 5 tiles", () => {
  // Hand CEISU should pick CAZIQUES (needs 3: A, Q, Z; reward 84)
  const ceisu = makeRack("CEISU");
  const bestCEISU = selectBestTarget(ceisu);
  assert.ok(bestCEISU !== null);
  assert.ok(
    bestCEISU.word === "CAZIQUES" || bestCEISU.word === "CAZIQUE",
    `Expected CAZIQUES or CAZIQUE, got ${bestCEISU.word}`,
  );
  assert.equal(bestCEISU.missingCount, 3);
  assert.ok(bestCEISU.pPlay > 0.35);

  // Hand BEHJU should pick JUKEBOX or JEZEBEL
  const behju = makeRack("BEHJU");
  const bestBEHJU = selectBestTarget(behju);
  assert.ok(bestBEHJU !== null);
  assert.ok(
    ["JUKEBOX", "JEZEBEL", "BEJEEZUS", "JAMBEAUX"].includes(bestBEHJU.word),
    `Got ${bestBEHJU.word}`,
  );
  assert.ok(bestBEHJU.missingCount <= 4);

  // Hand RETIN should pick MEZQUIT (needs 4: M, Q, U, Z)
  const retin = makeRack("RETIN");
  const bestRETIN = selectBestTarget(retin);
  assert.ok(bestRETIN !== null);
  assert.ok(bestRETIN.missingCount <= 5);
});

test("isTargetViable and dynamic re-routing when a tile is exhausted", () => {
  const rack = makeRack("CEISU");
  // Pool where Z is exhausted (0 Z left), but all other letters remain available
  const poolNoZ = new Map<string, number>();
  for (let c = 65; c <= 90; c++) {
    const char = String.fromCharCode(c);
    poolNoZ.set(char, char === "Z" ? 0 : 5);
  }

  assert.equal(isTargetViable("CAZIQUES", rack, poolNoZ), false);

  // Tracker picks target, then re-routes when Z is gone
  const tracker = new MatchTargetTracker(100n);
  const initial = tracker.update(rack);
  assert.ok(initial !== null);
  assert.ok(initial.word.includes("Z"));

  // Now Z is gone in the pool
  const rerouted = tracker.update(rack, poolNoZ);
  assert.ok(rerouted !== null);
  // Re-routed target must not require Z!
  assert.equal(rerouted.word.includes("Z"), false, `Rerouted word '${rerouted.word}' cannot require Z`);
});
