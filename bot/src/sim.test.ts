// S3-4 offline comparison: BID_MODE=current vs lambda on random auctions.
// Not a match simulator: each sample is an independent auction with a random
// rack, round, balance and seen letters. Prints, per mode, the average bid
// ÷ the letter's median winning bid (prices.json p50), the share of auctions
// bid on, and the expected spend / wins per match by phase under the
// real-table rival model (rivalBids.ts). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decideBid, type BidMode, type DecideState } from "./decide.js";
import { TILE_SET } from "./pool.js";
import { priceFor } from "./prices.js";
import { PHASE_COUNT, RIVAL_BIDS, expectedPay, pWin, phaseIndex, rivalDist } from "./rivalBids.js";
import { auctionTarget, planValues, targetMissing } from "./target.js";
import { WordIndex, type Rack } from "./words.js";

const index = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));
const SAMPLES = 300;
const PREMIUM = new Set(["Z", "X", "J", "Q", "K"]);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BAG: string[] = [];
for (const [l, n] of TILE_SET) for (let i = 0; i < n; i++) BAG.push(l);

interface Acc {
  n: number;
  bids: number;
  ratio: number;
  premBids: number;
  premRatio: number;
  spend: number[];
  wins: number[];
  count: number[];
  lambda: number[];
}
const acc = (): Acc => ({
  n: 0,
  bids: 0,
  ratio: 0,
  premBids: 0,
  premRatio: 0,
  spend: new Array(PHASE_COUNT).fill(0),
  wins: new Array(PHASE_COUNT).fill(0),
  count: new Array(PHASE_COUNT).fill(0),
  lambda: new Array(PHASE_COUNT).fill(0),
});

test("simulation: current vs lambda on random auctions", () => {
  const rand = mulberry32(0x5e4);
  const res: Record<BidMode, Acc> = { current: acc(), lambda: acc() };
  let maxMs = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const bag = BAG.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    const round = 1 + Math.floor(rand() * 67);
    const auctionsLeft = 69 - round;
    const rackSize = 5 + Math.floor(rand() * Math.min(8, 1 + round / 6));
    const r: Rack = new Map();
    for (const c of bag.splice(0, rackSize)) r.set(c, (r.get(c) ?? 0) + 1);
    const letter = bag.shift()!;
    bag.splice(0, round - 1); // letters already auctioned
    const unseen: Rack = new Map();
    for (const c of bag) unseen.set(c, (unseen.get(c) ?? 0) + 1);
    const balance = Math.max(3, Math.round(100 - 0.9 * round + (rand() - 0.5) * 60));
    const played = round > 35 && rand() < 0.5;
    const table = planValues({ rack: r, pool: unseen, auctionsLeft, index, explain: true, hasPlayedWord: played });
    const missing = targetMissing(auctionTarget(table, letter).target, r);
    const state: DecideState = {
      myBalance: balance,
      auctionsLeft,
      round,
      isLastAuction: false,
      myRack: r,
      auctions: [],
      myBotId: 1n,
    };
    const ph = phaseIndex(round);
    const dist = rivalDist(letter, round, "real");
    const median = priceFor(letter, round, 50);
    for (const mode of ["current", "lambda"] as BidMode[]) {
      const t0 = performance.now();
      const d = decideBid({ mode, letter, state, table, played, missing, index, unseen, tableType: "real" });
      const ms = performance.now() - t0;
      if (mode === "lambda") maxMs = Math.max(maxMs, ms);
      assert.ok(d.amount >= 0 && d.amount <= balance);
      const a = res[mode];
      a.n++;
      a.count[ph]++;
      if (d.amount > 0) {
        a.bids++;
        a.ratio += d.amount / median;
        if (PREMIUM.has(letter)) {
          a.premBids++;
          a.premRatio += d.amount / median;
        }
      }
      a.spend[ph] += expectedPay(dist, d.amount);
      a.wins[ph] += pWin(dist, d.amount);
      if (mode === "lambda") a.lambda[ph] += Number(d.fields.lambda);
    }
  }
  // Scale per-auction means to a 67-auction match: rounds per phase bucket.
  const rounds = RIVAL_BIDS.phases.map(([lo, hi]) => hi - lo + 1);
  const fmt = (x: number) => x.toFixed(1).padStart(6);
  const lines = [
    `S3-4 sim: ${SAMPLES} random auctions, real-table rival model (per-match numbers scale per-auction means by rounds per phase)`,
    `phases (rounds): ${RIVAL_BIDS.phases.map(([lo, hi]) => `${lo}-${hi}`).join(" ")}`,
  ];
  for (const mode of ["current", "lambda"] as BidMode[]) {
    const a = res[mode];
    const spend = a.spend.map((x, i) => (a.count[i] ? (x / a.count[i]) * rounds[i] : 0));
    const wins = a.wins.map((x, i) => (a.count[i] ? (x / a.count[i]) * rounds[i] : 0));
    lines.push(
      `${mode.padEnd(8)} bid/median ${(a.ratio / Math.max(1, a.bids)).toFixed(2)}  bid on ${((100 * a.bids) / a.n).toFixed(0)}%` +
        `  (Z X J Q K ${(a.premRatio / Math.max(1, a.premBids)).toFixed(2)}, n=${a.premBids})` +
        `  spend/match ${spend.reduce((x, y) => x + y, 0).toFixed(0)}  wins/match ${wins.reduce((x, y) => x + y, 0).toFixed(1)}`,
      `         spend by phase ${spend.map(fmt).join("")}`,
      `         wins by phase  ${wins.map(fmt).join("")}`,
    );
    if (mode === "lambda")
      lines.push(`         mean λ by phase ${a.lambda.map((x, i) => (a.count[i] ? x / a.count[i] : 0).toFixed(2).padStart(6)).join("")}`);
  }
  lines.push(`lambda decision max ${maxMs.toFixed(1)} ms`);
  console.log(lines.join("\n"));
});
