// Checks for the word index. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { WordIndex, letterValue, wordReward, type Rack } from "./words.js";

const rack = (letters: string): Rack => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

test("letterValue matches the server table", () => {
  for (const c of "AEIOULNSTR") assert.equal(letterValue(c), 1, c);
  for (const c of "DG") assert.equal(letterValue(c), 2, c);
  for (const c of "BCMP") assert.equal(letterValue(c), 3, c);
  for (const c of "FHVWY") assert.equal(letterValue(c), 4, c);
  assert.equal(letterValue("K"), 5);
  for (const c of "JX") assert.equal(letterValue(c), 8, c);
  for (const c of "QZ") assert.equal(letterValue(c), 10, c);
});

test("wordReward applies the length multiplier and rounds down", () => {
  assert.equal(wordReward("AT"), 2); // base 2, x1
  assert.equal(wordReward("CAT"), 5); // base 5, x1
  assert.equal(wordReward("TACT"), 9); // base 6, x1.5
  assert.equal(wordReward("BEAT"), 9); // base 6, x1.5
  assert.equal(wordReward("DATE"), 7); // base 5, x1.5 = 7.5 -> 7
  assert.equal(wordReward("QUAIL"), 28); // base 14, x2
  assert.equal(wordReward("DAISES"), 17); // base 7, x2.5 = 17.5 -> 17
  assert.equal(wordReward("QUAILED"), 51); // base 17, x3
  assert.equal(wordReward("STRAINED"), 27); // base 9, x3 (8 letters)
});

const small = new WordIndex([
  "AT", "TA", "CAT", "ACT", "TACT", "TAT", "ZA", "QI", "A", "AA", "CAT",
]);

test("playable finds every spellable word in reward/length/alpha order", () => {
  assert.deepEqual(small.playable(rack("TACT")), [
    { word: "TACT", reward: 9 },
    { word: "ACT", reward: 5 },
    { word: "CAT", reward: 5 },
    { word: "TAT", reward: 3 },
    { word: "AT", reward: 2 },
    { word: "TA", reward: 2 },
  ]);
});

test("playable respects repeated letters", () => {
  // One T: no TACT or TAT.
  assert.deepEqual(
    small.playable(rack("TAC")).map((p) => p.word),
    ["ACT", "CAT", "AT", "TA"],
  );
  assert.deepEqual(small.playable(rack("A")), []); // "A" too short, AA needs two
  assert.deepEqual(small.playable(rack("AA")).map((p) => p.word), ["AA"]);
});

test("playable honours minLen and limit", () => {
  assert.deepEqual(
    small.playable(rack("TACT"), { minLen: 3 }).map((p) => p.word),
    ["TACT", "ACT", "CAT", "TAT"],
  );
  assert.deepEqual(
    small.playable(rack("TACT"), { limit: 2 }).map((p) => p.word),
    ["TACT", "ACT"],
  );
});

test("empty rack or missing letters give nothing", () => {
  assert.deepEqual(small.playable(new Map()), []);
  assert.equal(small.best(new Map()), null);
  assert.equal(small.best(rack("XYV")), null);
  assert.equal(small.best(rack("Q")), null); // QI needs an I
});

test("best picks highest reward, not longest", () => {
  const idx = new WordIndex(["ZA", "TEAS", "EATS"]);
  // ZA = 11, TEAS/EATS = floor(4*1.5) = 6
  assert.deepEqual(idx.best(rack("ZAETS")), { word: "ZA", reward: 11 });
  assert.deepEqual(idx.best(rack("ZAETS"), { minLen: 3 }), { word: "EATS", reward: 6 });
  // QI and ZA tie at 11: alphabetical tiebreak.
  assert.deepEqual(small.best(rack("TACTZQI")), { word: "QI", reward: 11 });
});

test("isWord and input normalisation", () => {
  const idx = new WordIndex([" cat\r", "DOG", "X", "NO-PE"]);
  assert.ok(idx.isWord("CAT"));
  assert.ok(idx.isWord("cat"));
  assert.ok(idx.isWord("DOG"));
  assert.ok(!idx.isWord("X"));
  assert.ok(!idx.isWord("NO-PE"));
  assert.ok(!idx.isWord("COW"));
  assert.equal(idx.size, 2);
  const e = idx.entries.find((x) => x.word === "CAT")!;
  assert.equal(e.length, 3);
  assert.equal(e.reward, 5);
  assert.equal(e.mask, (1 << 0) | (1 << 2) | (1 << 19));
  assert.equal(e.counts[2], 1);
});

test("real wordlist: build once, best/playable well under 100 ms", () => {
  const t0 = performance.now();
  const idx = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));
  const build = performance.now() - t0;
  console.log(`WordIndex build: ${build.toFixed(1)} ms, ${idx.size} words`);
  assert.ok(idx.size > 170_000);
  assert.ok(idx.isWord("QUAILED"));

  const racks: [string, string][] = [
    ["7 tiles", "RETAINS"],
    ["15 tiles", "AEIOUSTRNLDGBCM"],
    ["20 tiles", "AEEIOUSTRNLDGBCMPHKZ"],
    ["20 tiles, few vowels", "BCDFGHJKLMNPQRSTVWXZ"],
  ];
  for (const [label, letters] of racks) {
    const r = rack(letters);
    let t = performance.now();
    const best = idx.best(r);
    const tBest = performance.now() - t;
    t = performance.now();
    const all = idx.playable(r);
    const tAll = performance.now() - t;
    console.log(
      `${label}: best=${best?.word}(${best?.reward}) in ${tBest.toFixed(2)} ms; ` +
        `playable=${all.length} words in ${tAll.toFixed(2)} ms`,
    );
    assert.ok(tBest < 100, `${label} best took ${tBest} ms`);
    assert.ok(tAll < 100, `${label} playable took ${tAll} ms`);
    // best() agrees with the head of playable() and is a max over it.
    assert.deepEqual(best, all[0] ?? null);
    for (const p of all) assert.ok(p.reward <= (best?.reward ?? 0));
  }
});
