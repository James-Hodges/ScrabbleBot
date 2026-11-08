// Checks for the bid formula (S2-3). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COINS_PER_POINT,
  MIN_VALUE_POINTS,
  completesTarget,
  pctFor,
  rawBid,
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
  // ceiling 14 vs p50 12: just over the median, capped at p50.
  const mid = rawBid(ctx({ value: 10 }));
  assert.equal(mid.pct, 50);
  assert.equal(mid.amount, 12);
  assert.equal(mid.reason, "market");
  // ceiling 28 ≥ 1.75 × 12: want it badly, cap at p90.
  const high = rawBid(ctx({ value: 20 }));
  assert.equal(high.pct, 90);
  assert.equal(high.amount, 22);
  assert.equal(high.reason, "market");
});

test("a letter that completes a word now bids up to at least p75", () => {
  const b = rawBid(ctx({ value: 13, completesWord: true }));
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
