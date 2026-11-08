// Checks for the play policy. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOMB_FLOOR_AUCTIONS,
  BOMB_FULL_AUCTIONS,
  BOMB_MIN_REWARD,
  ENDGAME_AUCTIONS,
  MIN_REWARD,
  bestWordSet,
  choosePlay,
  clampCutoff,
  playPhase,
  timeBar,
} from "./play.js";
import { TILE_SET } from "./pool.js";
import { firstWordCutoff, planValues, type TargetWord } from "./target.js";
import { WordIndex, wordReward, type Rack } from "./words.js";

const rack = (letters: string): Rack => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

const MIDGAME = 40;
const realIndex = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));

const small = new WordIndex(["CAT", "AT", "TACT", "SCATTER", "CATS", "QAZ", "QI", "ZOAE"]);
// JUKEBOX 81 (bomb), HAZARD 47 (30+), CAT 5.
const bombs = new WordIndex(["JUKEBOX", "HAZARD", "CAT", "AT"]);

test("reward fixtures", () => {
  assert.equal(wordReward("JUKEBOX"), 81);
  assert.equal(wordReward("HAZARD"), 47);
  assert.ok(wordReward("JUKEBOX") >= BOMB_MIN_REWARD);
  assert.ok(wordReward("HAZARD") >= MIN_REWARD && wordReward("HAZARD") < BOMB_MIN_REWARD);
});

test("playPhase", () => {
  assert.equal(playPhase(MIDGAME, false), "bomb");
  assert.equal(playPhase(ENDGAME_AUCTIONS + 1, false), "bomb");
  assert.equal(playPhase(MIDGAME, true), "post_bomb");
  assert.equal(playPhase(ENDGAME_AUCTIONS, false), "endgame");
});

test("holds a rack with only short words", () => {
  for (const hasPlayedWord of [false, true]) {
    const plays = choosePlay({ rack: rack("CATSTE"), auctionsLeft: MIDGAME, hasPlayedWord, index: small });
    assert.deepEqual(plays, []);
  }
});

test("never plays a sub-30 word outside the endgame (balance is not an input)", () => {
  // SCATTER is 7 letters but rewards 27; the old refill/long-word rules played it.
  assert.ok(wordReward("SCATTER") < MIN_REWARD);
  for (let auctionsLeft = 68; auctionsLeft > ENDGAME_AUCTIONS; auctionsLeft--) {
    for (const hasPlayedWord of [false, true]) {
      for (const letters of ["SCATTERX", "CATST", "CAT", "QAZIOE"]) for (const cutoff of [undefined, 0, 10]) {
        const plays = choosePlay({ rack: rack(letters), auctionsLeft, hasPlayedWord, cutoff, index: small });
        assert.deepEqual(plays, [], `${letters} @${auctionsLeft} played=${hasPlayedWord}`);
      }
    }
  }
});

test("never plays a sub-30 word with the real wordlist, even on a cluttered rack", () => {
  const plays = choosePlay({ rack: rack("AEIOURSTLNDGAEIO"), auctionsLeft: MIDGAME, hasPlayedWord: true, index: realIndex });
  for (const w of plays) assert.ok(wordReward(w) >= MIN_REWARD, w);
});

test("first word needs a bomb (60+) early", () => {
  assert.deepEqual(choosePlay({ rack: rack("HAZARDCAT"), auctionsLeft: 60, index: bombs }), []);
  assert.deepEqual(choosePlay({ rack: rack("JUKEBOXC"), auctionsLeft: 60, index: bombs }), ["JUKEBOX"]);
});

test("after the bomb, the same call keeps playing 30+ words", () => {
  const plays = choosePlay({ rack: rack("JUKEBOXHAZARDCAT"), auctionsLeft: MIDGAME, index: bombs });
  assert.deepEqual(plays, ["JUKEBOX", "HAZARD"]);
});

test("timeBar is 60 early and slides linearly to 30", () => {
  assert.equal(timeBar(68), BOMB_MIN_REWARD);
  assert.equal(timeBar(BOMB_FULL_AUCTIONS), BOMB_MIN_REWARD);
  assert.equal(timeBar(BOMB_FLOOR_AUCTIONS), MIN_REWARD);
  assert.equal(timeBar(10), MIN_REWARD);
  const mid = (BOMB_FULL_AUCTIONS + BOMB_FLOOR_AUCTIONS) / 2;
  assert.equal(timeBar(mid), (BOMB_MIN_REWARD + MIN_REWARD) / 2);
  for (let a = 68; a > 4; a--) assert.ok(timeBar(a - 1) <= timeBar(a), `${a}`);
  assert.equal(clampCutoff(5), MIN_REWARD);
  assert.equal(clampCutoff(99), BOMB_MIN_REWARD);
});

test("the default cutoff slides the first word down with time", () => {
  const r = rack("HAZARDCAT"); // HAZARD = 47
  assert.deepEqual(choosePlay({ rack: r, auctionsLeft: 60, index: bombs }), []);
  // timeBar(40) = 48 > 47: still hold; timeBar(38) = 45.6: play.
  assert.deepEqual(choosePlay({ rack: r, auctionsLeft: 40, index: bombs }), []);
  assert.deepEqual(choosePlay({ rack: r, auctionsLeft: 38, index: bombs }), ["HAZARD"]);
  assert.deepEqual(choosePlay({ rack: r, auctionsLeft: BOMB_FLOOR_AUCTIONS, index: bombs }), ["HAZARD"]);
});

// ---- Sliding first-word cutoff (firstWordCutoff) ----

// HAZED = 36: a mid-size word in hand.
const hazed = new WordIndex(["HAZED", "CAT"]);
const strong: TargetWord = { word: "HAZARDOUS", reward: 66, missing: 4, prob: 0.5, complete: 0.95 };

test("rich with a likely 60+ target: cutoff 60 early, holds a 36-point word", () => {
  assert.equal(wordReward("HAZED"), 36);
  const c = firstWordCutoff({ auctionsLeft: 60, round: 9, balance: 100, rack: rack("HAZED"), target: strong });
  assert.equal(c.affordShare, 1);
  assert.equal(c.cutoff, BOMB_MIN_REWARD);
  assert.deepEqual(choosePlay({ rack: rack("HAZED"), auctionsLeft: 60, cutoff: c.cutoff, index: hazed }), []);
});

test("the cutoff slides down with time even with a strong target", () => {
  let prev = Infinity;
  for (const al of [60, 50, 45, 40, 35, 30, 25, 10]) {
    const c = firstWordCutoff({ auctionsLeft: al, round: 69 - al, balance: 100, rack: rack("HAZED"), target: strong });
    assert.ok(c.cutoff <= prev, `${al}`);
    assert.equal(c.cutoff, MIN_REWARD + (c.timeBar - MIN_REWARD) * c.affordShare);
    prev = c.cutoff;
  }
  assert.equal(prev, MIN_REWARD);
});

test("broke with a 36-point word mid-match: cutoff 30, plays it", () => {
  const c = firstWordCutoff({ auctionsLeft: 45, round: 24, balance: 3, rack: rack("HAZED"), target: strong });
  assert.equal(c.affordShare, 0);
  assert.equal(c.holdValue, 0);
  assert.equal(c.cutoff, MIN_REWARD);
  assert.deepEqual(choosePlay({ rack: rack("HAZED"), auctionsLeft: 45, cutoff: c.cutoff, index: hazed }), ["HAZED"]);
});

test("short of coins for the target scales holdValue by the affordable share", () => {
  const rich = firstWordCutoff({ auctionsLeft: 60, round: 9, balance: 100, rack: rack("HAZED"), target: strong });
  const poor = firstWordCutoff({ auctionsLeft: 60, round: 9, balance: Math.floor(rich.targetCost / 2), rack: rack("HAZED"), target: strong });
  assert.ok(rich.targetCost > 0);
  assert.ok(poor.affordShare > 0 && poor.affordShare <= 0.5);
  assert.ok(Math.abs(poor.holdValue - rich.holdValue * poor.affordShare) < 1e-9);
  // The cutoff interpolates between 30 and the time bar by the affordable share.
  assert.ok(Math.abs(poor.cutoff - (MIN_REWARD + (BOMB_MIN_REWARD - MIN_REWARD) * poor.affordShare)) < 1e-9);
  assert.ok(poor.cutoff > MIN_REWARD && poor.cutoff < rich.cutoff);
});

test("rich and early with a low-probability target: cutoff still 60", () => {
  const longShot: TargetWord = { word: "HAZARDOUS", reward: 66, missing: 4, prob: 0.05, complete: 0.1 };
  const c = firstWordCutoff({ auctionsLeft: 60, round: 9, balance: 100, rack: rack("HAZED"), target: longShot });
  assert.ok(c.holdValue < MIN_REWARD, `holdValue ${c.holdValue}`);
  assert.equal(c.cutoff, BOMB_MIN_REWARD);
});

test("no target: pure time bar, whatever the balance", () => {
  for (const balance of [100, 3]) {
    const c = firstWordCutoff({ auctionsLeft: 60, round: 9, balance, rack: rack("HAZED"), target: null });
    assert.equal(c.affordShare, 1);
    assert.equal(c.cutoff, BOMB_MIN_REWARD);
    const late = firstWordCutoff({ auctionsLeft: 40, round: 29, balance, rack: rack("HAZED"), target: null });
    assert.equal(late.cutoff, timeBar(40));
  }
});

test("cutoff never leaves [30, 60] across time, balance and targets", () => {
  for (const al of [68, 55, 45, 35, 25, 10, 4])
    for (const balance of [0, 3, 10, 40, 200])
      for (const target of [null, strong, { ...strong, reward: 120, complete: 1 }]) {
        const c = firstWordCutoff({ auctionsLeft: al, round: 69 - al, balance, rack: rack("HAZED"), target });
        assert.ok(c.cutoff >= MIN_REWARD && c.cutoff <= BOMB_MIN_REWARD, `${al} ${balance}`);
      }
});

test("planValues end to end: rich holds HAZARD for HAZARDOUS early, broke plays it", () => {
  const r = "HAZARDOU";
  const pool = new Map(TILE_SET);
  for (const c of r) pool.set(c, pool.get(c)! - 1);
  const plan = (auctionsLeft: number, balance: number) =>
    planValues({ rack: rack(r), pool, auctionsLeft, index: realIndex, hasPlayedWord: false, balance, round: 69 - auctionsLeft });
  const rich = plan(60, 100);
  assert.equal(rich.target?.word, "HAZARDOUS");
  assert.ok(rich.cut!.cutoff > wordReward("HAZARD"), `cutoff ${rich.cut!.cutoff}`);
  assert.equal(rich.minReward, Math.round(rich.cut!.cutoff));
  assert.deepEqual(choosePlay({ rack: rack(r), auctionsLeft: 60, cutoff: Math.round(rich.cut!.cutoff), index: realIndex }), []);
  const broke = plan(40, 3);
  assert.equal(broke.cut!.cutoff, MIN_REWARD);
  const plays = choosePlay({ rack: rack(r), auctionsLeft: 40, cutoff: broke.cut!.cutoff, index: realIndex });
  assert.equal(plays.length, 1);
  assert.ok(wordReward(plays[0]) >= MIN_REWARD);
});

test("post-bomb plays 30+ words only", () => {
  assert.deepEqual(choosePlay({ rack: rack("HAZARDCAT"), auctionsLeft: MIDGAME, hasPlayedWord: true, index: bombs }), ["HAZARD"]);
  assert.deepEqual(choosePlay({ rack: rack("CATAT"), auctionsLeft: MIDGAME, hasPlayedWord: true, index: bombs }), []);
});

test("endgame still plays everything", () => {
  const plays = choosePlay({ rack: rack("HAZARDCAT"), auctionsLeft: ENDGAME_AUCTIONS, index: bombs });
  assert.deepEqual([...plays].sort(), ["CAT", "HAZARD"]);
});

test("endgame picks the best total-reward set, not the best single word", () => {
  // Greedy takes QAZ (21) and strands I, O, E. QI (11) + ZOAE (19) = 30.
  const plays = choosePlay({
    rack: rack("QAZIOE"),
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
  assert.ok(ms < 100, `endgame search took ${ms.toFixed(1)} ms`);
});

// ---- S1-6: nothing playable is left at the end ----


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
      const plays = choosePlay({ rack: tiles, auctionsLeft, index: realIndex });
      assert.equal(realIndex.best(leftover(tiles, plays)), null, letters);
    }
  }
});
