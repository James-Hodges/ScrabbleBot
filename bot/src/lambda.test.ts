// Checks for λ bidding (S3-4): rivalBids.ts, lambda.ts, lambdaBid.ts, decide.ts.
// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { rawBid } from "./bid.js";
import { applyBudget, bombReserve } from "./budget.js";
import { bidModeFrom, decideBid, type DecideState } from "./decide.js";
import { LAMBDA_MIN, solveLambda, type LambdaContext } from "./lambda.js";
import { lambdaBid } from "./lambdaBid.js";
import { TILE_SET } from "./pool.js";
import {
  RIVAL_BIDS,
  cdf,
  distFrom,
  expectedPay,
  expectedPrice,
  matchScale,
  pWin,
  rivalDist,
  rivalMedian,
} from "./rivalBids.js";
import { auctionTarget, planValues, targetMissing } from "./target.js";
import { completesTarget } from "./bid.js";
import { WordIndex, type Rack } from "./words.js";

const index = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));
const rack = (s: string): Rack => {
  const r = new Map<string, number>();
  for (const c of s) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
const pool = (s: string): Rack => {
  const p = new Map(TILE_SET);
  for (const c of s) p.set(c, Math.max(0, p.get(c)! - 1));
  return p;
};
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// Uniform rival max on [10, 20].
const U = distFrom([10, 20], [0, 1]);

test("CDF is linear between quantiles", () => {
  close(cdf(U, 9), 0);
  close(cdf(U, 10), 0);
  close(cdf(U, 15), 0.5);
  close(cdf(U, 20), 1);
  close(cdf(U, 25), 1);
  const d = distFrom([0, 0, 4, 8], [0, 0.2, 0.6, 1]); // point mass 0.2 at 0
  close(cdf(d, 0), 0.2);
  close(cdf(d, 2), 0.4);
  close(cdf(d, 6), 0.8);
  close(pWin(d, 0), 0); // bid 0 never wins
  // Scale stretches the bids.
  close(cdf(U, 30, 2), 0.5);
});

test("E[price | win] is the mean rival max below the bid (min 1)", () => {
  close(expectedPay(U, 10), 0);
  close(expectedPrice(U, 20), 15);
  close(expectedPrice(U, 14), 12);
  close(expectedPay(U, 14), 0.4 * 12);
  close(expectedPrice(U, 100), 15); // beyond the max: all mass
  // Lone-bidder minimum: rival max 0 (point mass) costs 1.
  const d = distFrom([0, 0, 2], [0, 0.5, 1]);
  close(expectedPay(d, 1), 0.5 * 1 + 0.25 * 1); // mass 0 → 1, and x∈[0,1) → 1
  close(expectedPrice(distFrom([0, 4], [0, 1]), 4), (1 + (16 - 1) / 2) / 4);
  // Scale doubles prices.
  close(expectedPrice(U, 40, 2), 30);
});

test("the exported table is sane", () => {
  assert.equal(RIVAL_BIDS.probs.length, RIVAL_BIDS.tables.real.E[0].q.length);
  for (const t of ["real", "sim"] as const)
    for (const [L, cells] of Object.entries(RIVAL_BIDS.tables[t]))
      for (const c of cells) for (let i = 1; i < c.q.length; i++) assert.ok(c.q[i] >= c.q[i - 1], `${t} ${L}`);
  // Premium letters cost more than vowels; sim tables are cheaper.
  assert.ok(rivalMedian(rivalDist("Z", 30, "real")) > rivalMedian(rivalDist("E", 30, "real")));
  assert.ok(rivalMedian(rivalDist("E", 30, "sim")) < rivalMedian(rivalDist("E", 30, "real")));
});

const bidAt = (value: number, lambda: number, balance = 100, isLastAuction = false) =>
  lambdaBid({ value, lambda, balance, isLastAuction, dist: rivalDist("E", 30, "real") });

test("the optimal bid is the truthful v/λ, rising with v and falling with λ", () => {
  // Uniform market: argmax of P·v − λ·E[pay] is v/λ.
  assert.equal(lambdaBid({ value: 6, lambda: 0.4, balance: 100, isLastAuction: false, dist: U }).amount, 15);
  let prev = 0;
  for (const v of [2, 4, 6, 8, 12, 20]) {
    const b = bidAt(v, 0.5).amount;
    assert.ok(b >= prev, `bid rises with v (${v}: ${b} < ${prev})`);
    prev = b;
  }
  assert.ok(bidAt(20, 0.5).amount > bidAt(2, 0.5).amount);
  prev = Infinity;
  for (const lambda of [0.1, 0.3, 0.5, 1, 2]) {
    const b = bidAt(6, lambda).amount;
    assert.ok(b <= prev, `bid falls with λ (${lambda}: ${b})`);
    prev = b;
  }
  assert.ok(bidAt(6, 2).amount < bidAt(6, 0.1).amount);
});

test("the bid never exceeds the balance; 0 on the final auction and for useless letters", () => {
  for (const bal of [0, 1, 7, 30]) assert.ok(bidAt(50, 0.05, bal).amount <= bal);
  assert.equal(bidAt(50, 0.05, 7).amount, 7);
  assert.equal(bidAt(50, 0.05, 7).reason, "balance");
  assert.equal(bidAt(50, 0.05, 100, true).amount, 0);
  assert.equal(bidAt(50, 0.05, 100, true).reason, "last_auction");
  assert.equal(bidAt(0.2, 0.05).amount, 0);
});

const flatValues = (v: number) => new Float64Array(26).fill(v);
const lctx = (over: Partial<LambdaContext>): LambdaContext => ({
  balance: 100,
  auctionsLeft: 50,
  round: 19,
  letter: "E",
  openValue: 5,
  values: flatValues(5),
  unseen: pool("AEIRT"),
  rackBase: 0,
  tableType: "real",
  ...over,
});

test("λ is larger when coins are scarce and smaller when plentiful", () => {
  const scarce = solveLambda(lctx({ balance: 20 }));
  const normal = solveLambda(lctx({ balance: 100 }));
  const rich = solveLambda(lctx({ balance: 400 }));
  assert.ok(scarce.lambda > normal.lambda, `${scarce.lambda} > ${normal.lambda}`);
  assert.ok(normal.lambda > rich.lambda, `${normal.lambda} > ${rich.lambda}`);
  // More remaining value with the same coins: also a larger λ.
  const valuable = solveLambda(lctx({ values: flatValues(15), openValue: 15 }));
  assert.ok(valuable.lambda > normal.lambda);
  // A solved λ spends the budget.
  assert.equal(normal.bound, "solved");
  close(normal.plannedSpend, normal.budget, 0.5);
});

test("with lots of coins near the end λ falls so we spend down", () => {
  const mid = solveLambda(lctx({ balance: 90, auctionsLeft: 40, round: 29 }));
  const late = solveLambda(lctx({ balance: 90, auctionsLeft: 5, round: 64 }));
  assert.ok(late.lambda < mid.lambda, `${late.lambda} < ${mid.lambda}`);
  assert.equal(late.lambda, LAMBDA_MIN);
  // So a useful letter gets (nearly) the whole balance.
  const b = lambdaBid({ value: 5, lambda: late.lambda, balance: 90, isLastAuction: false, dist: rivalDist("E", 64, "real") });
  assert.ok(b.amount >= 50, `bid ${b.amount}`);
  // The floor keeps a thin mid-match table from doing the same.
  const thin = solveLambda(lctx({ balance: 90, values: flatValues(0.6), openValue: 0.6 }));
  assert.ok(thin.lambda >= 0.1, `floor ${thin.lambda}`);
});

test("rival scale follows observed prices", () => {
  const me = 1n;
  const high = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, letter: "E", winnerBotId: me, paid: 30 }));
  const low = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, letter: "E", winnerBotId: me, paid: 4 }));
  assert.ok(matchScale(high, me, "real") > 1.2);
  assert.ok(matchScale(low, me, "real") < 0.85);
  assert.equal(matchScale([], me, "real"), 1);
  assert.equal(matchScale(high, me, "real", 0), 1);
});

test("BID_MODE parsing", () => {
  assert.equal(bidModeFrom(undefined), "lambda");
  assert.equal(bidModeFrom("lambda"), "lambda");
  assert.equal(bidModeFrom("current"), "current");
  assert.equal(bidModeFrom(" CURRENT "), "current");
});

const CASES: [string, string, number, number, boolean][] = [
  ["AEIRT", "S", 3, 100, false],
  ["AEIRT", "Q", 3, 100, false],
  ["RETAINQ", "U", 20, 60, false],
  ["AEGLNRT", "S", 40, 50, true],
  ["DOGLNRT", "E", 55, 80, true],
  ["AEIRST", "N", 66, 90, true],
  ["AEIRST", "N", 68, 90, true],
];

test("BID_MODE=current reproduces improved-bot's bids", () => {
  for (const [rk, letter, round, balance, played] of CASES) {
    const auctionsLeft = 69 - round;
    const unseen = pool(rk + letter);
    const r = rack(rk);
    const table = planValues({ rack: r, pool: unseen, auctionsLeft, index, explain: true, hasPlayedWord: played });
    const missing = targetMissing(auctionTarget(table, letter).target, r);
    const state: DecideState = {
      myBalance: balance,
      auctionsLeft,
      round,
      isLastAuction: auctionsLeft === 1,
      myRack: r,
      auctions: [],
      myBotId: 1n,
    };
    // improved-bot's tryBid, inline.
    const raw = rawBid({
      letter,
      values: table,
      balance,
      auctionsLeft,
      round,
      completesWord: completesTarget(table, r, letter),
      rack: r,
      index,
      minReward: table.minReward,
      floor: table.floor,
    });
    const want = applyBudget(raw.amount, { ...state, letter, reserveCoins: played ? 0 : bombReserve(missing, letter) });
    const got = decideBid({ mode: "current", letter, state, table, played, missing, index, unseen, tableType: "real" });
    assert.equal(got.amount, want.amount, `${rk}+${letter} r${round}`);
    assert.equal(got.fields.budgetReason, want.reason);
    // Lambda mode: final auction 0, never above balance, and fast.
    const t0 = performance.now();
    const lam = decideBid({ mode: "lambda", letter, state, table, played, missing, index, unseen, tableType: "real" });
    const ms = performance.now() - t0;
    assert.ok(lam.amount <= balance);
    if (auctionsLeft === 1) assert.equal(lam.amount, 0);
    assert.ok(ms < 30, `lambda decision took ${ms.toFixed(1)} ms`);
  }
});
