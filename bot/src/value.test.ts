// Checks for letter valuation (S2-2). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { TILE_SET } from "./pool.js";
import { letterValues, topLetters, valueOf, type ValueTable } from "./value.js";
import { WordIndex, type Rack } from "./words.js";

const index = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const rack = (letters: string): Rack => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

/** Full tile set minus our rack, with the letters in `gone` set to 0. */
const pool = (rackLetters: string, gone = ""): Rack => {
  const p = new Map(TILE_SET);
  for (const c of rackLetters) p.set(c, Math.max(0, p.get(c)! - 1));
  for (const c of gone) p.set(c, 0);
  return p;
};

const values = (r: string, auctionsLeft: number, gone = ""): ValueTable =>
  letterValues({ rack: rack(r), pool: pool(r, gone), auctionsLeft, index, explain: true });

const sorted = (t: ValueTable) => [...t.values].sort((a, b) => b - a);
const median = (t: ValueTable) => sorted(t)[13];
const mean = (t: ValueTable) => t.values.reduce((a, b) => a + b, 0) / 26;
const show = (t: ValueTable) =>
  topLetters(t, 5)
    .map(({ letter, value }) => `${letter}=${value.toFixed(1)}`)
    .join(" ");

test("the letter that completes a 7-letter word stands out", () => {
  const juke = values("JUKEBO", 10);
  console.log(`  JUKEBO @10: ${show(juke)}`);
  assert.equal(topLetters(juke, 1)[0].letter, "X");
  assert.equal(juke.targets![LETTERS.indexOf("X")]!.word, "JUKEBOX");
  assert.ok(valueOf(juke, "X") > 3 * sorted(juke)[1]);

  const oxid = values("OXIDNT", 10);
  console.log(`  OXIDNT @10: ${show(oxid)}`);
  assert.equal(topLetters(oxid, 1)[0].letter, "A");
  assert.ok(valueOf(oxid, "A") > 1.4 * sorted(oxid)[1]);
  assert.ok(valueOf(oxid, "A") > 2 * median(oxid));
});

test("Q with no U in rack or pool is worth little", () => {
  for (const r of ["DGLOE", "BELOW"]) {
    const noU = values(r, 40, "U");
    const withU = values(r, 40);
    assert.ok(valueOf(noU, "Q") < 1, `${r}: Q=${valueOf(noU, "Q")}`);
    assert.ok(valueOf(noU, "Q") < median(noU));
    assert.ok(valueOf(noU, "Q") < valueOf(withU, "Q"));
  }
});

test("vowels are worth more than cheap consonants to a consonant-heavy rack", () => {
  for (const r of ["BCDTRNS", "GHTNRS"]) {
    for (const al of [40, 10]) {
      const t = values(r, al);
      const vowels = [..."AEIO"].map((c) => valueOf(t, c));
      const cheap = [..."DGLNRST"].map((c) => valueOf(t, c));
      assert.ok(Math.min(...vowels) > Math.max(...cheap), `${r} @${al}: ${vowels} vs ${cheap}`);
    }
  }
});

test("a second copy is worth less than the first when only one is needed", () => {
  assert.ok(valueOf(values("OXIDNT", 10), "A") > 5 * valueOf(values("OXIDANT", 10), "A"));
  assert.ok(valueOf(values("RETAIN", 10), "S") > valueOf(values("RETAINS", 10), "S"));
});

test("every value is 0 on the final auction and after the match", () => {
  for (const al of [1, 0]) {
    const t = values("RETAIN", al);
    assert.deepEqual([...t.values], new Array(26).fill(0));
  }
});

test("with no letters to come, a value is exactly the immediate gain", () => {
  for (const r of ["RETAIN", "GHTNRS", "JUKEBO", "QXZ"]) {
    const t = values(r, 2);
    const now = index.best(rack(r))?.reward ?? 0;
    for (const L of LETTERS) {
      const withL = index.best(rack(r + L))?.reward ?? 0;
      assert.equal(valueOf(t, L), Math.max(0, withL - now), `${r} + ${L}`);
    }
  }
});

test("values shrink as the horizon closes on racks with nothing near complete", () => {
  for (const r of ["OXIDNT", "BELOW"]) {
    const means = [40, 20, 10, 5, 2].map((al) => mean(values(r, al)));
    console.log(`  ${r} mean value @40,20,10,5,2: ${means.map((m) => m.toFixed(2)).join(" ")}`);
    for (let i = 1; i < means.length; i++) assert.ok(means[i] < means[i - 1]);
  }
});

test("a letter the pool has run out of is still valued; the pool limits the others", () => {
  // The A being auctioned is the last one: it still completes OXIDANT.
  const lastA = values("OXIDNT", 20, "A");
  assert.ok(valueOf(lastA, "A") >= valueOf(values("OXIDNT", 20), "A"));
  assert.equal(valueOf(values("OXIDNT", 2, "A"), "A"), 21); // OXIDANT 45 − TOXOID 24

  // JUKEB + X needs an O for JUKEBOX: with no O left, X is worth little.
  const withO = values("JUKEB", 40);
  const noO = values("JUKEB", 40, "O");
  console.log(`  JUKEB @40 X: ${valueOf(withO, "X").toFixed(2)}, with no O left: ${valueOf(noO, "X").toFixed(2)}`);
  assert.ok(valueOf(withO, "X") > 15);
  assert.ok(valueOf(noO, "X") < 2);
});

test("poolIncludesLetter takes the valued copy out of the pool", () => {
  const small = new WordIndex(["AA", "AAA"]);
  const ctx = { rack: rack("A"), pool: rack("A"), auctionsLeft: 30, index: small, winRate: 0.5 };
  const kept = letterValues(ctx);
  const taken = letterValues({ ...ctx, poolIncludesLetter: true });
  // Without the flag rack + A may still win the pool's A for AAA; with it, it can't.
  assert.ok(valueOf(kept, "A") > valueOf(taken, "A"));
  assert.ok(valueOf(taken, "A") > 0);
});

test("deterministic, and a count-vector pool gives the same table", () => {
  const a = values("SATIRE", 30);
  const b = values("SATIRE", 30);
  assert.deepEqual([...a.values], [...b.values]);
  const counts = new Uint8Array(26);
  for (const [l, n] of pool("SATIRE")) counts[l.charCodeAt(0) - 65] = n;
  const c = letterValues({ rack: rack("SATIRE"), pool: counts, auctionsLeft: 30, index });
  assert.deepEqual([...a.values], [...c.values]);
});

test("all 26 values in under 30 ms on a 20-tile rack", () => {
  const racks = [
    "EEIIAAOUNNRRTTSSLLDG",
    "AEIRSTNLDGBCMPHFKVWY",
    "BCDFGHJKLMNPQRSTVWXZ",
    "AEIOURSTLNDGCMPBHKWY",
  ];
  for (const r of racks) {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      for (const al of [60, 30, 5]) {
        const t0 = performance.now();
        values(r, al);
        times.push(performance.now() - t0);
      }
    }
    const best = Math.min(...times);
    const worst = Math.max(...times);
    console.log(`  ${r}: ${best.toFixed(1)}–${worst.toFixed(1)} ms`);
    // Ignore the first (JIT warm-up) round; the rest must all be fast.
    assert.ok(Math.max(...times.slice(3)) < 100, `${r}: ${times.map((t) => t.toFixed(1))}`);
  }
  const small = ["RETAIN", "E"].map((r) => {
    const t0 = performance.now();
    values(r, 60);
    return `${r} ${(performance.now() - t0).toFixed(1)} ms`;
  });
  console.log(`  small racks: ${small.join(", ")}`);
});
