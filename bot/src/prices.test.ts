// Checks for the winning-bid table (S2-1). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PRICES, phaseForRound, priceFor } from "./prices.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const PHASES = ["early", "mid", "late"] as const;

test("all 26 letters have all three phases", () => {
  assert.deepEqual(Object.keys(PRICES.letters).sort(), LETTERS);
  for (const l of LETTERS) for (const p of PHASES) assert.ok(PRICES.letters[l][p], `${l} ${p}`);
});

test("percentiles are positive and non-decreasing", () => {
  for (const l of LETTERS)
    for (const p of PHASES) {
      const c = PRICES.letters[l][p];
      assert.ok(c.p25 > 0 && c.n > 0, `${l} ${p}`);
      assert.ok(c.p25 <= c.p50 && c.p50 <= c.p75 && c.p75 <= c.p90, `${l} ${p}`);
    }
});

test("phase boundaries", () => {
  assert.equal(phaseForRound(1), "early");
  assert.equal(phaseForRound(20), "early");
  assert.equal(phaseForRound(21), "mid");
  assert.equal(phaseForRound(48), "mid");
  assert.equal(phaseForRound(49), "late");
  assert.equal(phaseForRound(67), "late");
  assert.equal(phaseForRound(68), "late");
  assert.equal(phaseForRound(200), "late");
});

test("priceFor reads the right cell", () => {
  assert.equal(priceFor("z", 5, 90), PRICES.letters.Z.early.p90);
  assert.equal(priceFor("E", 30, 50), PRICES.letters.E.mid.p50);
  assert.equal(priceFor("E", 68, 25), PRICES.letters.E.late.p25);
  assert.throws(() => priceFor("?", 1, 50));
});
