// Checks for the budget layer (S2-4, S2-5). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBudget, SPEND_DOWN_AUCTIONS, TARGET_LEFTOVER, type BudgetContext } from "./budget.js";
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
