// Checks for the play policy. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOMB_DEADLINE_AUCTIONS,
  BOMB_MIN_REWARD,
  ENDGAME_AUCTIONS,
  MIN_REWARD,
  bestWordSet,
  choosePlay,
  minRewardFor,
  playPhase,
} from "./play.js";
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

test("playPhase and minRewardFor", () => {
  assert.equal(playPhase(MIDGAME, false), "bomb");
  assert.equal(playPhase(BOMB_DEADLINE_AUCTIONS, false), "bomb_late");
  assert.equal(playPhase(MIDGAME, true), "post_bomb");
  assert.equal(playPhase(ENDGAME_AUCTIONS, false), "endgame");
  assert.equal(minRewardFor("bomb"), BOMB_MIN_REWARD);
  assert.equal(minRewardFor("bomb_late"), MIN_REWARD);
  assert.equal(minRewardFor("post_bomb"), MIN_REWARD);
  assert.equal(minRewardFor("endgame"), 0);
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
      for (const letters of ["SCATTERX", "CATST", "CAT", "QAZIOE"]) {
        const plays = choosePlay({ rack: rack(letters), auctionsLeft, hasPlayedWord, index: small });
        assert.deepEqual(plays, [], `${letters} @${auctionsLeft} played=${hasPlayedWord}`);
      }
    }
  }
});

test("never plays a sub-30 word with the real wordlist, even on a cluttered rack", () => {
  const plays = choosePlay({ rack: rack("AEIOURSTLNDGAEIO"), auctionsLeft: MIDGAME, hasPlayedWord: true, index: realIndex });
  for (const w of plays) assert.ok(wordReward(w) >= MIN_REWARD, w);
});

test("first word needs a bomb (60+)", () => {
  assert.deepEqual(choosePlay({ rack: rack("HAZARDCAT"), auctionsLeft: MIDGAME, index: bombs }), []);
  assert.deepEqual(choosePlay({ rack: rack("JUKEBOXC"), auctionsLeft: MIDGAME, index: bombs }), ["JUKEBOX"]);
});

test("after the bomb, the same call keeps playing 30+ words", () => {
  const plays = choosePlay({ rack: rack("JUKEBOXHAZARDCAT"), auctionsLeft: MIDGAME, index: bombs });
  assert.deepEqual(plays, ["JUKEBOX", "HAZARD"]);
});

test("the bomb deadline relaxes the first word to MIN_REWARD", () => {
  const r = rack("HAZARDCAT");
  assert.deepEqual(choosePlay({ rack: r, auctionsLeft: BOMB_DEADLINE_AUCTIONS + 1, index: bombs }), []);
  assert.deepEqual(choosePlay({ rack: r, auctionsLeft: BOMB_DEADLINE_AUCTIONS, index: bombs }), ["HAZARD"]);
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
