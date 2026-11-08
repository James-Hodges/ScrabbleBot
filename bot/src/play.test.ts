// Checks for the play policy. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENDGAME_AUCTIONS,
  LOW_BALANCE,
  bestWordSet,
  choosePlay,
} from "./play.js";
import { WordIndex, type Rack } from "./words.js";

const rack = (letters: string): Rack => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

const HEALTHY = 100;
const MIDGAME = 40;

const small = new WordIndex(["CAT", "AT", "TACT", "SCATTER", "CATS", "QAZ", "QI", "ZOAE"]);

test("holds a rack with only short words when balance is healthy", () => {
  const plays = choosePlay({
    rack: rack("CATSTE"),
    balance: HEALTHY,
    auctionsLeft: MIDGAME,
    index: small,
  });
  assert.deepEqual(plays, []);
});

test("plays a 7-letter word as soon as one is possible", () => {
  const plays = choosePlay({
    rack: rack("SCATTERX"),
    balance: HEALTHY,
    auctionsLeft: MIDGAME,
    index: small,
  });
  assert.deepEqual(plays, ["SCATTER"]);
});

test("low balance plays the best word of 4+ letters", () => {
  const plays = choosePlay({
    rack: rack("CATST"),
    balance: LOW_BALANCE - 1,
    auctionsLeft: MIDGAME,
    index: small,
  });
  // TACT (9) and CATS (9) tie on reward; either is a 4-letter refill.
  assert.equal(plays.length, 1);
  assert.equal(plays[0].length, 4);
});

test("low balance falls back to a short word when nothing longer fits", () => {
  const plays = choosePlay({
    rack: rack("CAT"),
    balance: 0,
    auctionsLeft: MIDGAME,
    index: small,
  });
  assert.deepEqual(plays, ["CAT"]);
});

test("endgame picks the best total-reward set, not the best single word", () => {
  // Greedy takes QAZ (21) and strands I, O, E. QI (11) + ZOAE (19) = 30.
  const plays = choosePlay({
    rack: rack("QAZIOE"),
    balance: HEALTHY,
    auctionsLeft: ENDGAME_AUCTIONS,
    index: small,
  });
  assert.deepEqual([...plays].sort(), ["QI", "ZOAE"]);
});

test("endgame on a 20-tile rack with the real wordlist is fast", () => {
  const index = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));
  const tiles = rack("AEEIIORSTNLDGUPMCAHS");
  const start = performance.now();
  const plays = bestWordSet(tiles, index);
  const ms = performance.now() - start;
  console.log(`endgame set search: ${ms.toFixed(1)} ms -> ${plays.join(" ")}`);
  assert.ok(plays.length > 0);
  // Every word is real, and together they fit in the rack.
  const left = new Map(tiles);
  for (const w of plays) {
    assert.ok(index.isWord(w), w);
    for (const c of w) {
      const n = (left.get(c) ?? 0) - 1;
      assert.ok(n >= 0, `over-used ${c} in ${plays.join(" ")}`);
      left.set(c, n);
    }
  }
  assert.ok(ms < 50, `endgame search took ${ms.toFixed(1)} ms`);
});

// ---- S1-6: nothing playable is left at the end ----

const realIndex = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));

/** Assert `plays` fit in `tiles`; return the leftover rack. */
function leftover(tiles: Rack, plays: string[]): Rack {
  const left = new Map(tiles);
  for (const w of plays) {
    assert.ok(realIndex.isWord(w), w);
    for (const c of w) {
      const n = (left.get(c) ?? 0) - 1;
      assert.ok(n >= 0, `over-used ${c} in ${plays.join(" ")}`);
      if (n > 0) left.set(c, n);
      else left.delete(c);
    }
  }
  return left;
}

const RACKS: [string, string][] = [
  ["8 mixed", "RETAINSX"],
  ["10 vowel-heavy", "AEIOUAEIRT"],
  ["12 consonant-heavy", "BCDFGHKLMNRS"],
  ["14 vowel-heavy", "AAEEIIOOUUSTNL"],
  ["16 consonant-heavy", "BCDFGHJKLMNPRSTA"],
  ["18 mixed", "AEEIORSTNLDGUPMCHQ"],
  ["20 mixed", "AEEIIORSTNLDGUPMCAHS"],
  ["20 vowel-heavy", "AAAEEEEIIIOOOUURSTNL"],
  ["20 consonant-heavy", "BBCCDDFGGHKLMMNPRSTE"],
];

for (const [name, letters] of RACKS) {
  test(`bestWordSet leaves no playable word: ${name}`, () => {
    const tiles = rack(letters);
    const start = performance.now();
    const plays = bestWordSet(tiles, realIndex);
    const ms = performance.now() - start;
    const left = leftover(tiles, plays);
    console.log(
      `${name}: ${ms.toFixed(1)} ms -> ${plays.join(" ")} | left ${[...left].map(([c, n]) => c.repeat(n)).join("")}`,
    );
    assert.equal(realIndex.best(left), null, `playable word left in ${[...left]}`);
    assert.ok(ms < 50, `set search took ${ms.toFixed(1)} ms`);
  });
}

test("choosePlay in the endgame uses up everything playable", () => {
  for (const auctionsLeft of [ENDGAME_AUCTIONS, 2, 1]) {
    for (const [, letters] of RACKS) {
      const tiles = rack(letters);
      const plays = choosePlay({ rack: tiles, balance: HEALTHY, auctionsLeft, index: realIndex });
      assert.equal(realIndex.best(leftover(tiles, plays)), null, letters);
    }
  }
});
