// Checks for the bid formula (S2-3). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COINS_PER_POINT,
  EARLY_BOOST,
  EARLY_MIN_VALUE,
  EARLY_ROUNDS,
  MIN_VALUE_POINTS,
  completesTarget,
  nearTarget,
  pctFor,
  playedLongWord,
  rawBid,
  targetBid,
  type RawBidContext,
} from "./bid.js";
import { TILE_SET } from "./pool.js";
import type { Pct } from "./prices.js";
import { letterValues } from "./value.js";
import { WordIndex, type Rack } from "./words.js";

const index = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const rack = (letters: string): Rack => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
/** Full tile set minus our rack and the open auction's letter. */
const pool = (rackLetters: string, open = ""): Rack => {
  const p = new Map(TILE_SET);
  for (const c of rackLetters + open) p.set(c, Math.max(0, p.get(c)! - 1));
  return p;
};

/** Flat fake price table: p25/50/75/90 = 8/12/16/22 for every letter. */
const FLAT: Record<Pct, number> = { 25: 8, 50: 12, 75: 16, 90: 22 };
const flat = (_l: string, _r: number, pct: Pct) => FLAT[pct];

const withValue = (letter: string, v: number): Float64Array => {
  const values = new Float64Array(26);
  values[letter.charCodeAt(0) - 65] = v;
  return values;
};
const ctx = (over: Partial<RawBidContext> & { value: number }): RawBidContext => ({
  letter: "E",
  values: withValue(over.letter ?? "E", over.value),
  balance: 100,
  auctionsLeft: 40,
  round: 29,
  prices: flat,
  ...over,
});

test("an unusable letter bids 0", () => {
  for (const v of [0, MIN_VALUE_POINTS / 2]) {
    const b = rawBid(ctx({ value: v }));
    assert.equal(b.amount, 0);
    assert.equal(b.reason, "no_value");
  }
  // A letter with no value in the table at all.
  assert.equal(rawBid({ ...ctx({ value: 9 }), letter: "Q" }).amount, 0);
});

test("ceiling below the market: bid the ceiling", () => {
  const b = rawBid(ctx({ value: 5 }));
  assert.equal(b.ceiling, 5 * COINS_PER_POINT);
  assert.equal(b.pct, 50);
  assert.equal(b.amount, Math.round(5 * COINS_PER_POINT));
  assert.equal(b.reason, "ceiling");
});

test("high value raises the percentile cap", () => {
  // Values are chosen by target ceiling, so retuning COINS_PER_POINT keeps
  // the same brackets. Ceiling 14 vs p50 12: just over the median, capped at p50.
  const mid = rawBid(ctx({ value: 14 / COINS_PER_POINT }));
  assert.equal(mid.pct, 50);
  assert.equal(mid.amount, 12);
  assert.equal(mid.reason, "market");
  // ceiling 28 ≥ 1.75 × 12: want it badly, cap at p90.
  const high = rawBid(ctx({ value: 28 / COINS_PER_POINT }));
  assert.equal(high.pct, 90);
  assert.equal(high.amount, 22);
  assert.equal(high.reason, "market");
});

test("a letter that completes a word now bids up to at least p75", () => {
  // Ceiling 18.2 (1.52 × p50) alone would give p75 too; completesWord keeps it there.
  const b = rawBid(ctx({ value: 18.2 / COINS_PER_POINT, completesWord: true }));
  assert.equal(b.pct, 75);
  assert.equal(b.amount, 16);
  assert.equal(pctFor(5, 12, true), 75);
  assert.equal(pctFor(40, 12, true), 90);
});

test("never above balance", () => {
  const b = rawBid(ctx({ value: 20, balance: 9 }));
  assert.equal(b.amount, 9);
  assert.equal(b.reason, "balance");
  assert.equal(rawBid(ctx({ value: 20, balance: 0 })).amount, 0);
  assert.equal(rawBid(ctx({ value: 20, balance: -3 })).amount, 0);
});

test("final auction bids 0 (every value is 0)", () => {
  const r = "RETAINS";
  const table = letterValues({ rack: rack(r), pool: pool(r, "E"), auctionsLeft: 1, index });
  for (const L of LETTERS) {
    const b = rawBid({ letter: L, values: table, balance: 100, auctionsLeft: 1, round: 68 });
    assert.equal(b.amount, 0, L);
  }
});

test("real racks give sensible bids (real price table)", () => {
  for (const [r, auctionsLeft] of [
    ["AEINRT", 50],
    ["QUIZEAL", 30],
  ] as const) {
    const round = 69 - auctionsLeft;
    const table = letterValues({ rack: rack(r), pool: pool(r), auctionsLeft, index, explain: true });
    console.log(`  ${r} @${auctionsLeft} left (round ${round}): letter value ceiling cap(pct) bid`);
    const rows = [...LETTERS].map((L) => {
      const b = rawBid({
        letter: L,
        values: table,
        balance: 100,
        auctionsLeft,
        round,
        completesWord: completesTarget(table, rack(r), L),
      });
      return { L, b };
    });
    for (const { L, b } of rows.filter((_, i) => i % 3 === 0 || "SXZE".includes(LETTERS[i]))) {
      console.log(
        `    ${L} ${b.value.toFixed(1).padStart(5)} ${b.ceiling.toFixed(1).padStart(5)} ${String(b.marketCap).padStart(3)}(p${b.pct}) ${String(b.amount).padStart(3)}`,
      );
    }
    for (const { L, b } of rows) {
      assert.ok(b.amount >= 0 && b.amount <= 100, L);
      assert.ok(b.amount <= Math.round(Math.min(b.ceiling, b.marketCap)), L);
      if (b.value < MIN_VALUE_POINTS) assert.equal(b.amount, 0, L);
    }
    // Something on a 6–7 tile rack is worth bidding on.
    assert.ok(rows.some(({ b }) => b.amount > 0), r);
  }
});

test("completesTarget spots a playable target word", () => {
  const r = "RETAIN";
  const table = letterValues({ rack: rack(r), pool: pool(r), auctionsLeft: 2, index, explain: true });
  // With 2 auctions left only playable words count, so any valued letter completes one.
  const valued = [...LETTERS].filter((_, i) => table.values[i] > 0);
  assert.ok(valued.length > 0);
  for (const L of valued) assert.equal(completesTarget(table, rack(r), L), true, L);
  // No explain: no targets.
  const plain = letterValues({ rack: rack(r), pool: pool(r), auctionsLeft: 2, index });
  assert.equal(completesTarget(plain, rack(r), valued[0]), false);
});

test("whole decision (letterValues + rawBid) is fast on a 20-tile rack", () => {
  const r = "AEEIORSTLNDGCMPBHUYK";
  assert.equal(r.length, 20);
  const times: number[] = [];
  for (const auctionsLeft of [60, 40, 20, 8, 3]) {
    const t0 = performance.now();
    const table = letterValues({ rack: rack(r), pool: pool(r, "S"), auctionsLeft, index, explain: true });
    rawBid({
      letter: "S",
      values: table,
      balance: 100,
      auctionsLeft,
      round: 69 - auctionsLeft,
      completesWord: completesTarget(table, rack(r), "S"),
    });
    times.push(performance.now() - t0);
  }
  console.log(`  20-tile decision: ${times.map((t) => t.toFixed(1)).join(", ")} ms`);
  assert.ok(Math.max(...times) < 50, `slowest ${Math.max(...times).toFixed(1)} ms`);
});

// S2-6: early coin snowball.

test("early boost: ceiling × EARLY_BOOST in round ≤ EARLY_ROUNDS without a long word", () => {
  for (const round of [1, EARLY_ROUNDS]) {
    const b = rawBid(ctx({ value: 4, round, haveLongWord: false }));
    assert.equal(b.boost, EARLY_BOOST);
    assert.equal(b.boostReason, "early");
    assert.equal(b.ceiling, 4 * COINS_PER_POINT * EARLY_BOOST);
    // 4 × 2.3 × 1.5 = 13.8 ≥ p50 12 but < 1.25 × 12: market-capped at p50.
    assert.equal(b.pct, 50);
    assert.equal(b.amount, 12);
    // Unboosted it would have been the 9-coin ceiling.
    assert.equal(rawBid(ctx({ value: 4, round })).amount, Math.round(4 * COINS_PER_POINT));
  }
});

test("early boost stops after EARLY_ROUNDS or once we've played a long word", () => {
  const late = rawBid(ctx({ value: 4, round: EARLY_ROUNDS + 1, haveLongWord: false, nearTarget: true }));
  assert.equal(late.boost, 1);
  assert.equal(late.boostReason, "late");
  assert.equal(late.pct, 50);
  assert.equal(late.amount, Math.round(4 * COINS_PER_POINT));
  const done = rawBid(ctx({ value: 4, round: 5, haveLongWord: true, nearTarget: true }));
  assert.equal(done.boost, 1);
  assert.equal(done.boostReason, "have_long_word");
  assert.equal(done.amount, Math.round(4 * COINS_PER_POINT));

  const me = 7n;
  assert.equal(playedLongWord([], me), false);
  assert.equal(playedLongWord([{ botId: me, word: "CAT" }, { botId: 8n, word: "RETAINS" }], me), false);
  assert.equal(playedLongWord([{ botId: me, word: "CAT" }, { botId: me, word: "TRAIN" }], me), true);
});

test("early boost leaves junk letters at 0 / unboosted", () => {
  const zero = rawBid(ctx({ value: MIN_VALUE_POINTS / 2, round: 3, haveLongWord: false, nearTarget: true }));
  assert.equal(zero.amount, 0);
  assert.equal(zero.reason, "no_value");
  const low = rawBid(ctx({ value: EARLY_MIN_VALUE - 0.5, round: 3, haveLongWord: false, nearTarget: true }));
  assert.equal(low.boost, 1);
  assert.equal(low.boostReason, "low_value");
  assert.equal(low.pct, 50);
  assert.equal(low.amount, Math.round((EARLY_MIN_VALUE - 0.5) * COINS_PER_POINT));
});

test("early near-target letter: percentile one step up", () => {
  // Boosted ceiling 13.8 alone gives p50; near target bumps to p75 (16).
  const b = rawBid(ctx({ value: 4, round: 10, haveLongWord: false, nearTarget: true }));
  assert.equal(b.boostReason, "early_near");
  assert.equal(b.pct, 75);
  assert.equal(b.amount, 14); // now the 13.8 ceiling binds, not the market
  // Already at p75 from the ceiling → p90.
  const hi = rawBid(ctx({ value: 20 / COINS_PER_POINT, round: 10, haveLongWord: false, nearTarget: true }));
  assert.equal(hi.pct, 90);
  assert.equal(hi.amount, 22);
  // Never above balance.
  assert.equal(rawBid(ctx({ value: 9, round: 1, haveLongWord: false, nearTarget: true, balance: 7 })).amount, 7);
});

test("defaults reproduce the pre-S2-6 result", () => {
  for (const round of [1, 10, 20, 29]) {
    for (const v of [0.2, 2, 4, 6, 10, 20]) {
      const old = rawBid(ctx({ value: v, round }));
      const viaUndefined = rawBid(ctx({ value: v, round, haveLongWord: undefined, nearTarget: true }));
      assert.equal(old.boost, 1);
      assert.equal(old.boostReason, "off");
      assert.equal(old.ceiling, v * COINS_PER_POINT);
      assert.deepEqual(viaUndefined, old);
    }
  }
});

test("nearTarget: 5+ letter target at most one tile short of rack + letter", () => {
  const table = {
    values: new Float64Array(26),
    base: 0,
    lettersToCome: 40,
    perCopy: 0.3,
    targets: new Array(26).fill(null),
  };
  table.targets[1] = { word: "TRAIN", reward: 10, share: 0.5 }; // B: rack TRAI + B, short N: near
  table.targets[13] = { word: "TRAIN", reward: 10, share: 0.5 }; // N: rack TRAI + N, complete
  table.targets[4] = { word: "TREATS", reward: 10, share: 0.5 }; // E: short T, S: not near
  table.targets[2] = { word: "CAT", reward: 3, share: 0.5 }; // too short
  const r = rack("TRAI");
  assert.equal(nearTarget(table, r, "B"), true);
  assert.equal(nearTarget(table, r, "N"), true);
  assert.equal(nearTarget(table, r, "E"), false);
  assert.equal(nearTarget(table, r, "C"), false);
  assert.equal(nearTarget(table, r, "Z"), false); // no target
});

test("simulated early bids: boosted vs unboosted (real values and prices)", () => {
  // Deterministic LCG; random 5–8 tile racks from the tile set, rounds 1–20.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const bag: string[] = [];
  for (const [l, n] of TILE_SET) for (let i = 0; i < n; i++) bag.push(l);
  let n = 0, nBid = 0, sumOld = 0, sumNew = 0, boosted = 0, near = 0;
  for (let s = 0; s < 30; s++) {
    const size = 5 + Math.floor(rnd() * 4);
    let r = "";
    for (let i = 0; i < size; i++) r += bag[Math.floor(rnd() * bag.length)];
    const open = bag[Math.floor(rnd() * bag.length)];
    const round = 1 + Math.floor(rnd() * EARLY_ROUNDS);
    const auctionsLeft = 69 - round;
    const rk = rack(r);
    const table = letterValues({ rack: rk, pool: pool(r, open), auctionsLeft, index, explain: true });
    const base = { letter: open, values: table, balance: 100, auctionsLeft, round, completesWord: completesTarget(table, rk, open) };
    const old = rawBid(base);
    const nt = nearTarget(table, rk, open);
    const neu = rawBid({ ...base, haveLongWord: false, nearTarget: nt });
    assert.ok(neu.amount >= old.amount, `${r}+${open}`);
    n++;
    if (old.amount > 0 || neu.amount > 0) nBid++;
    sumOld += old.amount;
    sumNew += neu.amount;
    if (neu.boost > 1) boosted++;
    if (neu.boostReason === "early_near") near++;
  }
  console.log(
    `  early sim: ${n} auctions, ${nBid} bid, ${boosted} boosted (${near} near-target); ` +
      `avg bid ${(sumOld / n).toFixed(1)} → ${(sumNew / n).toFixed(1)} coins (+${(((sumNew - sumOld) / Math.max(1, sumOld)) * 100).toFixed(0)}%)`,
  );
});

test("targetBid: bids aggressively on needed tiles, 0 on unneeded tiles or final auction", () => {
  const ceisu = rack("CEISU");

  // Needed tile 'Z' for CAZIQUES: bids aggressively (p90 + 2)
  const bidZ = targetBid({
    letter: "Z",
    targetWord: "CAZIQUES",
    rack: ceisu,
    balance: 100,
    round: 5,
    auctionsLeft: 60,
  });
  assert.ok(bidZ.isTargetLetter, "Z is a needed target tile");
  assert.ok(bidZ.amount >= 50, `Expected aggressive bid for Z, got ${bidZ.amount}`);

  // Needed tile 'A' for CAZIQUES: bids aggressively (p90 + 2)
  const bidA = targetBid({
    letter: "A",
    targetWord: "CAZIQUES",
    rack: ceisu,
    balance: 100,
    round: 5,
    auctionsLeft: 60,
  });
  assert.ok(bidA.isTargetLetter, "A is a needed target tile");
  assert.ok(bidA.amount >= 20, `Expected aggressive bid for A, got ${bidA.amount}`);

  // Unneeded tile 'X' for CAZIQUES: bids 0!
  const bidX = targetBid({
    letter: "X",
    targetWord: "CAZIQUES",
    rack: ceisu,
    balance: 100,
    round: 5,
    auctionsLeft: 60,
  });
  assert.equal(bidX.isTargetLetter, false, "X is not needed for CAZIQUES");
  assert.equal(bidX.amount, 0, "Must bid 0 on unneeded tile");

  // Final auction (auctionsLeft = 1): bids 0 even for needed tile
  const bidLast = targetBid({
    letter: "Z",
    targetWord: "CAZIQUES",
    rack: ceisu,
    balance: 100,
    round: 68,
    auctionsLeft: 1,
  });
  assert.equal(bidLast.amount, 0, "Final auction must bid 0");

  // Balance cap: never bids above balance
  const bidLowBalance = targetBid({
    letter: "Z",
    targetWord: "CAZIQUES",
    rack: ceisu,
    balance: 15,
    round: 5,
    auctionsLeft: 60,
  });
  assert.equal(bidLowBalance.amount, 15, "Cannot exceed balance");
});
