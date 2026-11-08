// Checks for target-word valuation and the bomb bidding rules. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { completesBingo, completesSnowball, rawBid } from "./bid.js";
import { applyBudget, bombReserve, BOMB_RESERVE_PER_TILE, SPEND_DOWN_AUCTIONS } from "./budget.js";
import { BOMB_MIN_REWARD, MIN_REWARD } from "./play.js";
import { TILE_SET } from "./pool.js";
import {
  BOMB_MIN_LEN,
  HIGH_TILE_VALUE,
  RACK_FLOOR_POINTS,
  TARGET_TILE_SHARE,
  auctionTarget,
  ON_BLOCK_MIN_GAIN_POINTS,
  planValues,
  targetMissing,
  targetValues,
} from "./target.js";
import { valueOf } from "./value.js";
import { letterValue, WordIndex, type Rack } from "./words.js";

const index = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const rack = (letters: string): Rack => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
const pool = (rackLetters: string): Rack => {
  const p = new Map(TILE_SET);
  for (const c of rackLetters) p.set(c, Math.max(0, p.get(c)! - 1));
  return p;
};
const plan = (r: string, auctionsLeft: number, hasPlayedWord = false) =>
  planValues({ rack: rack(r), pool: pool(r), auctionsLeft, index, explain: true, hasPlayedWord });

test("an empty or tiny rack still gets non-zero letter values, before and after the bomb", () => {
  for (const [r, played] of [["", false], ["", true], ["E", true], ["QZ", false]] as const) {
    for (const auctionsLeft of [65, 40, 25, 10]) {
      const t = plan(r, auctionsLeft, played);
      for (const L of LETTERS) assert.ok(valueOf(t, L) >= RACK_FLOOR_POINTS, `${r}+${L} @${auctionsLeft}`);
      // And the bidder actually bids on a common letter.
      const b = rawBid({
        letter: "E",
        values: t,
        balance: 50,
        auctionsLeft,
        round: 69 - auctionsLeft,
        rack: rack(r),
        index,
        minReward: t.minReward,
        floor: t.floor,
      });
      assert.ok(b.amount > 0, `${r} @${auctionsLeft}: ${b.reason}`);
    }
  }
});

test("bomb target is a long 60+ word with a high-value tile, reachable from rack + pool", () => {
  const t = plan("JUKEBO", 50);
  assert.equal(t.phase, "bomb");
  assert.ok(t.target, "no target");
  const w = t.target!.word;
  assert.ok(w.length >= BOMB_MIN_LEN, w);
  assert.ok(t.target!.reward >= BOMB_MIN_REWARD, w);
  assert.ok([...w].some((c) => letterValue(c) >= HIGH_TILE_VALUE), w);
  assert.ok(index.isWord(w));
  assert.equal(targetMissing(t.target, rack("JUKEBO")).length, t.target!.missing);
});

test("target valuation favours letters in a reachable bomb word, filler included", () => {
  // HRETAI is three tiles (O, Z, E) from THEORIZE (60).
  const r = "HRETAI";
  const tt = targetValues({ rack: rack(r), pool: pool(r), auctionsLeft: 55, index, bomb: true });
  assert.ok(tt.target);
  const missing = targetMissing(tt.target, rack(r));
  console.log(`  ${r}: target ${tt.target!.word} (${tt.target!.reward}) missing ${missing}`);
  const inTarget = new Set(missing);
  const outside = [...LETTERS].filter((L) => !inTarget.has(L) && !tt.target!.word.includes(L));
  const v = (L: string) => tt.values[L.charCodeAt(0) - 65];
  const share = (tt.base * TARGET_TILE_SHARE) / tt.target!.missing;
  for (const L of inTarget) assert.ok(v(L) >= share - 1e-9 && v(L) > 0, `${L}=${v(L)}`);
  // On average a missing target letter beats a letter outside the target.
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(avg([...inTarget].map(v)) > avg(outside.map(v)), "target letters not favoured");
  // The target's high-value tile is the most valuable letter.
  const hi = [...inTarget].filter((c) => letterValue(c) >= HIGH_TILE_VALUE);
  assert.ok(hi.length > 0);
  const top = [...LETTERS].sort((a, b) => v(b) - v(a))[0];
  assert.ok(hi.includes(top), `top letter ${top}`);
});

test("filler letters of the target carry real value", () => {
  // AZOTEMIAS-type target from a vowel-light high-tile rack: common filler
  // letters needed by the target are worth more than a letter no target uses.
  const r = "ZTMS";
  const tt = targetValues({ rack: rack(r), pool: pool(r), auctionsLeft: 60, index, bomb: true });
  assert.ok(tt.target);
  const missing = targetMissing(tt.target, rack(r));
  const filler = [...missing].filter((c) => letterValue(c) <= 1);
  assert.ok(filler.length > 0, missing);
  for (const c of filler) assert.ok(tt.values[c.charCodeAt(0) - 65] >= 1, `${c} filler`);
});

test("target valuation is fast (all phases, small and large racks)", () => {
  const cases: [string, number, boolean][] = [
    ["", 65, false],
    ["AEST", 60, false],
    ["QZXJ", 50, false],
    ["", 30, true],
    ["ERSTL", 30, true],
    ["AEIORSTNLDGUPMCHBYKW", 40, false],
  ];
  plan("", 60); // first call builds the candidate cache
  let worst = 0;
  for (const [r, al, played] of cases) {
    const t0 = performance.now();
    plan(r, al, played);
    worst = Math.max(worst, performance.now() - t0);
  }
  console.log(`  planValues worst: ${worst.toFixed(1)} ms`);
  assert.ok(worst < 60, `worst ${worst.toFixed(1)} ms`);
});

test("bingo/snowball completions below the phase's min reward don't count", () => {
  // TISANE + R makes a 7-letter word worth < 60.
  const bingo = completesBingo(rack("TISANE"), "R", index);
  assert.ok(bingo && bingo.reward < BOMB_MIN_REWARD);
  assert.equal(completesBingo(rack("TISANE"), "R", index, BOMB_MIN_REWARD), null);
  assert.equal(completesSnowball(rack("CARE"), "S", index, 25, 10, MIN_REWARD), null);
});

test("bomb reserve keeps coins for the target's remaining letters", () => {
  assert.equal(bombReserve("XES", "E"), 2 * BOMB_RESERVE_PER_TILE);
  assert.equal(bombReserve("XES", "Q"), 3 * BOMB_RESERVE_PER_TILE);
  assert.equal(bombReserve("", "Q"), 0);
  const ctx = { isLastAuction: false, auctionsLeft: 50, round: 19, myBalance: 30, letter: "Q" };
  assert.deepEqual(applyBudget(25, { ...ctx, reserveCoins: 18 }), { amount: 12, reason: "reserve", pace: 30 / 49 });
  assert.equal(applyBudget(25, ctx).amount, 25);
  // The spend-down window ignores the reserve.
  const late = { ...ctx, auctionsLeft: SPEND_DOWN_AUCTIONS, reserveCoins: 18 };
  assert.notEqual(applyBudget(25, late).reason, "reserve");
});

// The open letter is out of the unseen pool. With the last Z on the block the
// rack's own target forgets every Z word; the auction target must not.
const planOnBlock = (r: string, open: string, auctionsLeft: number) => {
  const p = pool(r);
  p.set(open, 0); // the last copy is the one on the block
  return planValues({ rack: rack(r), pool: p, auctionsLeft, index, explain: true, hasPlayedWord: false });
};

test("last Z on the block: the auction target keeps the Z and the reserve exempts it", () => {
  const r = "HYPNOTIES"; // HYPNOTIZES needs only the Z
  const t = planOnBlock(r, "Z", 40);
  assert.equal(t.phase, "bomb");
  assert.ok(!t.target || !t.target.word.includes("Z"), `rack target ${t.target?.word} should not need the gone Z`);
  const { target, source } = auctionTarget(t, "Z");
  assert.equal(source, "on_block");
  assert.ok(target && target.word.includes("Z") && target.reward >= BOMB_MIN_REWARD, target?.word);
  const missing = targetMissing(target, rack(r));
  assert.ok(missing.includes("Z"), missing);
  assert.equal(bombReserve(missing, "Z"), (missing.length - 1) * BOMB_RESERVE_PER_TILE);
  // Before the fix the reserve counted the rack target's tiles and not the Z.
  const old = targetMissing(t.target, rack(r));
  assert.ok(bombReserve(missing, "Z") <= bombReserve(old, "Z"), `${missing} vs ${old}`);
});

test("auction target is the rack's target when the open letter adds no EV", () => {
  const t = plan("JUKEBO", 50);
  assert.ok(t.target);
  for (const L of LETTERS) {
    const { target, source } = auctionTarget(t, L);
    const won = t.ifWon[L.charCodeAt(0) - 65];
    const ev = (x: typeof target) => (x ? x.reward * x.prob : 0);
    if (source === "rack") {
      assert.equal(target, t.target);
      assert.ok(!won || ev(won) < ev(t.target) + ON_BLOCK_MIN_GAIN_POINTS, L);
    } else {
      assert.equal(target, won);
      assert.ok(ev(target) >= ev(t.target) + ON_BLOCK_MIN_GAIN_POINTS, L);
      // The on-block target uses the letter beyond what the rack holds.
      assert.ok(targetMissing(target, rack("JUKEBO")).includes(L), `${L} ${target?.word}`);
      assert.equal(target!.missing, targetMissing(target, rack("JUKEBO")).length, `${L} ${target?.word}`);
    }
  }
  // No rack target and no candidates: rack source, null target.
  const empty = { target: null, ifWon: new Array(26).fill(null) };
  assert.deepEqual(auctionTarget(empty, "E"), { target: null, source: "rack" });
});
