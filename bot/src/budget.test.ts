// Checks for the budget layer (S2-4, S2-5). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyBudget,
  BOMB_BELOW_FLOOR_SHARE,
  BOMB_FLOOR_MIN_RACK,
  BOMB_FLOOR_ROUND,
  BOMB_KEEP_COINS,
  BOMB_LETTER_SHARE,
  BOMB_MARKET_PCT,
  BOMB_NEAR_SHARE,
  bombCap,
  SPEND_DOWN_AUCTIONS,
  TARGET_LEFTOVER,
  type BombBidInput,
  type BudgetContext,
} from "./budget.js";
import { priceFor } from "./prices.js";

const TOTAL = 68;

/** Context for a 68-auction match with `left` auctions left (incl. the open one). */
function ctx(left: number, balance: number, letter = "E"): BudgetContext {
  return {
    isLastAuction: left === 1,
    auctionsLeft: left,
    round: TOTAL - left + 1,
    myBalance: balance,
    letter,
  };
}

test("last auction bids 0 even with a big raw bid", () => {
  const r = applyBudget(50, ctx(1, 100));
  assert.equal(r.amount, 0);
  assert.equal(r.reason, "last_auction");
});

test("a raw bid of 0 stays 0, even with coins to burn", () => {
  for (const left of [60, 14, 5, 2]) {
    const r = applyBudget(0, ctx(left, 90));
    assert.equal(r.amount, 0);
    assert.equal(r.reason, "not_wanted");
  }
});

test("early game: raw bid unchanged, capped at balance", () => {
  assert.deepEqual(
    [applyBudget(12, ctx(60, 100)).amount, applyBudget(12, ctx(60, 7)).amount],
    [12, 7],
  );
  assert.equal(applyBudget(12, ctx(SPEND_DOWN_AUCTIONS + 1, 100)).reason, "normal");
});

test("spend-down raises bids when the surplus is large", () => {
  const r = applyBudget(5, ctx(8, 80));
  assert.equal(r.reason, "spend_down");
  assert.ok(r.amount > 5, `got ${r.amount}`);
});

test("spend-down doesn't raise bids when balance is near the target", () => {
  for (const bal of [TARGET_LEFTOVER, TARGET_LEFTOVER + 1]) {
    const r = applyBudget(5, ctx(8, bal));
    assert.ok(r.amount <= 5, `balance ${bal} got ${r.amount}`);
  }
});

test("never above balance", () => {
  for (let left = 2; left <= 20; left++)
    for (const bal of [0, 1, 3, 15, 40, 120])
      for (const raw of [1, 10, 200]) {
        const r = applyBudget(raw, ctx(left, bal, "Z"));
        assert.ok(r.amount <= bal && r.amount >= 0, `left ${left} bal ${bal} raw ${raw}: ${r.amount}`);
      }
});

test("simulated tail finishes with ≤ 10 coins and skips the last auction", () => {
  const letters = "EARLINOTSDGCMBEA".split("");
  for (const offset of [0, 1]) {
    let balance = 80;
    const log: string[] = [];
    for (let left = 14; left >= 1; left--) {
      const i = 14 - left;
      const letter = letters[i];
      const wants = (i + offset) % 2 === 0;
      const c = ctx(left, balance, letter);
      const { amount } = applyBudget(wants ? 10 : 0, c);
      if (left === 1) assert.equal(amount, 0, "bid on the last auction");
      if (amount > 0 && amount >= priceFor(letter, c.round, 50)) {
        balance -= amount;
        log.push(`${letter}@${amount}`);
      }
    }
    assert.ok(balance <= TARGET_LEFTOVER, `offset ${offset}: left ${balance}, won ${log.join(" ")}`);
  }
});

// ---- Bomb-phase spending discipline ----

const early = { isLastAuction: false, auctionsLeft: 60, round: 9, myBalance: 100 };
const far: BombBidInput = { missing: "OZEXS", targetOk: true, completes: false };

test("bomb phase: an early 100-coin balance never bids above the per-letter cap", () => {
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const cap = Math.floor(Math.min(100 * BOMB_LETTER_SHARE, priceFor(letter, 9, BOMB_MARKET_PCT)));
    for (const raw of [5, 20, 40, 90]) {
      const r = applyBudget(raw, { ...early, letter, bomb: far });
      assert.ok(r.amount <= cap, `${letter} raw ${raw} -> ${r.amount} > ${cap}`);
      if (raw > cap) assert.equal(r.reason, "bomb_cap");
    }
  }
});

test("bomb phase: the coin floor holds until the target is near-complete", () => {
  // 30 coins, target 5 tiles away, floor armed (no rackTiles given): keep BOMB_KEEP_COINS.
  const b = { ...early, myBalance: 30, letter: "S" };
  const r = applyBudget(30, { ...b, bomb: far });
  assert.equal(r.amount, Math.max(30 - BOMB_KEEP_COINS, Math.floor(30 * BOMB_BELOW_FLOOR_SHARE)));
  assert.equal(r.reason, "bomb_floor");
  // Below the floor we still bid a little instead of 0.
  const low = applyBudget(30, { ...b, myBalance: 20, bomb: far });
  assert.equal(low.reason, "bomb_floor");
  assert.equal(low.amount, Math.floor(20 * BOMB_BELOW_FLOOR_SHARE));
  assert.ok(low.amount > 0);
  // Target within 2 tiles: no floor, only the per-letter cap.
  const nearTarget: BombBidInput = { missing: "XS", targetOk: true, completes: false };
  const r2 = applyBudget(30, { ...b, letter: "E", bomb: nearTarget });
  assert.equal(r2.amount, Math.floor(Math.min(30 * BOMB_LETTER_SHARE, priceFor("E", 9, BOMB_MARKET_PCT))));
});

test("bomb phase: the coin floor is not armed on a small rack early (no stall)", () => {
  const b = { ...early, myBalance: 30, letter: "S" };
  const cap = Math.floor(Math.min(30 * BOMB_LETTER_SHARE, priceFor("S", 9, BOMB_MARKET_PCT)));
  assert.ok(cap > 30 - BOMB_KEEP_COINS);
  // Small rack, early round: only the per-letter cap.
  const small = applyBudget(30, { ...b, bomb: { ...far, rackTiles: BOMB_FLOOR_MIN_RACK - 1 } });
  assert.equal(small.amount, cap);
  assert.notEqual(small.reason, "bomb_floor");
  // Big rack: the floor binds.
  const big = applyBudget(30, { ...b, bomb: { ...far, rackTiles: BOMB_FLOOR_MIN_RACK } });
  assert.equal(big.reason, "bomb_floor");
  assert.equal(big.amount, Math.max(30 - BOMB_KEEP_COINS, Math.floor(30 * BOMB_BELOW_FLOOR_SHARE)));
  // Late round: the floor binds even on a small rack.
  const late = applyBudget(30, { ...b, round: BOMB_FLOOR_ROUND, auctionsLeft: 69 - BOMB_FLOOR_ROUND, bomb: { ...far, rackTiles: 6 } });
  assert.equal(late.reason, "bomb_floor");
});

test("bomb phase: a letter that nearly completes the target can exceed the normal cap", () => {
  const near: BombBidInput = { missing: "XES", targetOk: true, completes: false };
  const normalCap = Math.floor(Math.min(100 * BOMB_LETTER_SHARE, priceFor("X", 9, BOMB_MARKET_PCT)));
  const r = applyBudget(45, { ...early, letter: "X", bomb: near });
  assert.ok(r.amount > normalCap, `${r.amount} vs ${normalCap}`);
  assert.equal(r.amount, 45);
  const big = applyBudget(90, { ...early, letter: "X", bomb: near });
  assert.equal(big.amount, Math.floor(100 * BOMB_NEAR_SHARE));
  assert.equal(big.reason, "bomb_near");
  // A completing word counts as near even without a target.
  const done = bombCap(40, 100, "Q", 9, { missing: "", targetOk: false, completes: true });
  assert.equal(done.amount, 40);
  // A target that doesn't clear the cutoff doesn't unlock the higher cap.
  const weak = applyBudget(45, { ...early, letter: "X", bomb: { ...near, targetOk: false } });
  assert.ok(weak.amount <= normalCap);
});

test("post-bomb and spend-down bids are unchanged by the bomb rules", () => {
  for (const raw of [5, 20, 40]) {
    const post = applyBudget(raw, { ...early, letter: "E" });
    assert.deepEqual(post, { amount: raw, reason: "normal", pace: 100 / 59 });
    const late = { isLastAuction: false, auctionsLeft: 10, round: 59, myBalance: 100, letter: "E" };
    assert.deepEqual(applyBudget(raw, { ...late, bomb: far }), applyBudget(raw, late));
  }
});
