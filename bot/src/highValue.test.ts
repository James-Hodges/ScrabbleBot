// Checks for the high-value experiment (highValue.ts). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBudget } from "./budget.js";
import { choosePlay, ENDGAME_AUCTIONS } from "./play.js";
import { TILE_SET } from "./pool.js";
import { priceFor, type Pct } from "./prices.js";
import {
  BIG_WORD_REWARD,
  DEFAULT_STRATEGY,
  PREMIUM,
  PREMIUM_SHARE,
  RESERVE,
  budgetHighValue,
  highValueBid,
  highValuePlay,
  playFor,
  reserveFor,
  strategyFromEnv,
  type HighValueContext,
} from "./highValue.js";
import { WordIndex, wordReward, type Rack } from "./words.js";

const index = WordIndex.fromFile(new URL("../data/wordlist.txt", import.meta.url));

const rack = (letters: string): Rack => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

/** Full tile set minus rack and the open letter, with `gone` letters set to 0. */
const pool = (rackLetters: string, open: string, gone = ""): Rack => {
  const p = new Map(TILE_SET);
  for (const c of rackLetters + open) p.set(c, Math.max(0, p.get(c)! - 1));
  for (const c of gone) p.set(c, 0);
  return p;
};

const ctx = (r: string, letter: string, over: Partial<HighValueContext> = {}): HighValueContext => ({
  letter,
  rack: rack(r),
  pool: pool(r, letter),
  balance: 100,
  auctionsLeft: 50,
  round: 19,
  isLastAuction: false,
  index,
  ...over,
});

test("usable premium letter: bid ~PREMIUM_SHARE of balance", () => {
  const b = highValueBid(ctx("AEINR", "Z"));
  assert.equal(b.reason, "premium");
  assert.equal(b.amount, Math.ceil(PREMIUM_SHARE * 100));
  assert.ok(b.target && b.target.word.includes("Z"), JSON.stringify(b.target));
});

test("premium bid is at least the letter's p90 when affordable", () => {
  const p90 = priceFor("Z", 19, 90);
  const b = highValueBid(ctx("AEINR", "Z", { balance: 60 }));
  assert.equal(b.reason, "premium");
  assert.equal(b.amount, Math.min(60, Math.max(45, p90)));
  // Can't afford p90: the whole balance.
  const poor = highValueBid(ctx("AEINR", "Z", { balance: 20 }));
  assert.equal(poor.amount, 20);
});

test("Q with no U in the rack or pool: 0", () => {
  const b = highValueBid(ctx("EEIRS", "Q", { pool: pool("EEIRS", "Q", "U") }));
  assert.equal(b.amount, 0);
  assert.equal(b.reason, "skip");
  // Same rack with Us still out there: premium.
  assert.equal(highValueBid(ctx("EEIRS", "Q")).reason, "premium");
});

test("premium letter with no reachable target: 0", () => {
  // Two usable auctions left after this one, and the rack has nothing for X.
  const b = highValueBid(ctx("QQJJV", "X", { auctionsLeft: 3, pool: pool("", "X") }));
  assert.equal(b.amount, 0);
});

test("support letter for a held-premium target: modest bid", () => {
  const b = highValueBid(ctx("ZAEIR", "B"));
  assert.equal(b.reason, "support");
  assert.ok(b.target!.word.includes("Z"), b.target!.word);
  assert.ok(b.amount > 0, String(b.amount));
  assert.ok(b.amount <= priceFor("B", 19, 50), String(b.amount));
});

test("unrelated letter: 0", () => {
  // No premium held and no big word within reach that G would help.
  const b = highValueBid(ctx("UUUII", "G", { auctionsLeft: 4 }));
  assert.equal(b.amount, 0);
  assert.equal(b.reason, "skip");
});

test("reserve: support bids stay out of it", () => {
  const p50 = () => 50; // a market that would let support bid high
  const prices = (_l: string, _r: number, _p: Pct) => p50();
  const b = highValueBid(ctx("ZAEIR", "B", { balance: RESERVE + 4, prices }));
  assert.equal(b.reason, "support");
  assert.ok(b.amount <= 4, String(b.amount));
  const broke = highValueBid(ctx("ZAEIR", "B", { balance: RESERVE, prices }));
  assert.equal(broke.reason, "reserve");
  assert.equal(broke.amount, 0);
});

test("reserve tapers out and vanishes with no premium letter unseen", () => {
  assert.equal(reserveFor(new Map(TILE_SET), 60), RESERVE);
  assert.ok(reserveFor(new Map(TILE_SET), 12) < RESERVE);
  assert.equal(reserveFor(new Map(TILE_SET), 2), 0);
  const noPremium = new Map(TILE_SET);
  for (const c of PREMIUM) noPremium.set(c, 0);
  assert.equal(reserveFor(noPremium, 60), 0);
});

test("spend-down can't push a support bid into the reserve; premium passes", () => {
  // Two non-last auctions left: spend-down bids its whole floor (30).
  const state = { isLastAuction: false, auctionsLeft: 3, round: 66, myBalance: 40, letter: "B" };
  const support = { amount: 5, reason: "support" as const, detail: "held_premium", reserve: 25 };
  const raised = applyBudget(5, state).amount;
  assert.ok(raised > 15, `applyBudget alone raises to ${raised}`);
  const out = budgetHighValue(support, state);
  assert.equal(out.amount, 15);
  assert.equal(out.clampedToReserve, true);
  const premium = { amount: 45, reason: "premium" as const, detail: "tier1", reserve: 20 };
  assert.equal(budgetHighValue(premium, { ...state, letter: "Z" }).amount, applyBudget(45, { ...state, letter: "Z" }).amount);
});

test("final auction: 0, before and after applyBudget", () => {
  const b = highValueBid(ctx("AEINR", "Z", { auctionsLeft: 1, isLastAuction: true }));
  assert.equal(b.amount, 0);
  const out = budgetHighValue({ ...b, amount: 50, reason: "premium" }, {
    isLastAuction: true,
    auctionsLeft: 1,
    round: 68,
    myBalance: 100,
    letter: "Z",
  });
  assert.equal(out.amount, 0);
});

test("play: holds a 30-point word, plays a 50-point one", () => {
  assert.ok(wordReward("FRIGHT") < BIG_WORD_REWARD && wordReward("FRIGHT") >= 30);
  assert.ok(wordReward("QUARTZ") >= 50);
  const small = new WordIndex(["FRIGHT", "QUARTZ", "FIG"]);
  const base = { balance: 100, auctionsLeft: 40, index: small };
  assert.deepEqual(highValuePlay({ ...base, rack: rack("FRIGHT") }), []);
  assert.deepEqual(highValuePlay({ ...base, rack: rack("QUARTZ") }), ["QUARTZ"]);
  // Endgame still dumps.
  assert.deepEqual(highValuePlay({ ...base, rack: rack("FRIGHT"), auctionsLeft: ENDGAME_AUCTIONS }), ["FRIGHT"]);
  // Low balance still refills.
  assert.deepEqual(highValuePlay({ ...base, rack: rack("FRIGHT"), balance: 5 }), ["FRIGHT"]);
});

test("STRATEGY switch picks the right path", () => {
  assert.equal(DEFAULT_STRATEGY, "highvalue");
  assert.equal(strategyFromEnv(undefined), "highvalue");
  assert.equal(strategyFromEnv("highvalue"), "highvalue");
  assert.equal(strategyFromEnv("MAIN"), "main");
  assert.equal(strategyFromEnv("nonsense"), "highvalue");
  assert.equal(playFor("main"), choosePlay);
  assert.equal(playFor("highvalue"), highValuePlay);
});

// ---- Simulation ----
// Not a game model: rivals are one "top bid" per auction, drawn from the
// winning-bid percentiles in prices.json; we pay it if we beat it (Vickrey).
// Rival bids are independent of ours, so this shows how our coins flow, not
// how often two bots both go big.

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

function rivalTop(letter: string, round: number, u: number): number {
  const p = (pct: Pct) => priceFor(letter, round, pct);
  const pts: [number, number][] = [[0, 0], [0.25, p(25)], [0.5, p(50)], [0.75, p(75)], [0.9, p(90)], [1, p(90) * 1.3]];
  for (let i = 1; i < pts.length; i++) {
    const [u1, v1] = pts[i];
    const [u0, v0] = pts[i - 1];
    if (u <= u1) return Math.round(v0 + ((u - u0) / (u1 - u0)) * (v1 - v0));
  }
  return p(90);
}

test("simulation: premium bidding doesn't blow the coins on the first K", () => {
  const MATCHES = Number(process.env.HV_SIM_MATCHES ?? 30);
  const rand = mulberry32(42);
  let auctions = 0, premiumBids = 0, premiumBidSum = 0, premiumWins = 0, premiumPaid = 0;
  let supportBids = 0, supportBidSum = 0, wins = 0;
  let firstPremiumBalAfter = 0, firstPremiumN = 0, score = 0, words = 0, coinsLeft = 0, broke = 0;
  for (let m = 0; m < MATCHES; m++) {
    const bag: string[] = [];
    for (const [c, n] of TILE_SET) for (let i = 0; i < n; i++) bag.push(c);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    const my = rack(bag.slice(0, 5).join(""));
    const unseen = rack(bag.slice(5).join(""));
    const auctionLetters = bag.slice(30); // 25 more dealt to 5 rivals
    let balance = 100;
    let firstPremium = true;
    const n = auctionLetters.length;
    for (let a = 0; a < n; a++) {
      const letter = auctionLetters[a];
      const round = a + 1;
      const auctionsLeft = n - a;
      unseen.set(letter, unseen.get(letter)! - 1);
      const b = highValueBid({
        letter, rack: my, pool: unseen, balance, auctionsLeft, round,
        isLastAuction: auctionsLeft === 1, index,
      });
      const amount = budgetHighValue(b, { isLastAuction: auctionsLeft === 1, auctionsLeft, round, myBalance: balance, letter }).amount;
      auctions++;
      if (b.reason === "premium" && b.detail === "tier1") {
        premiumBids++;
        premiumBidSum += amount;
      } else if (amount > 0) {
        supportBids++;
        supportBidSum += amount;
      }
      const top = rivalTop(letter, round, rand());
      if (amount > top) {
        balance -= top;
        wins++;
        my.set(letter, (my.get(letter) ?? 0) + 1);
        if (b.reason === "premium" && b.detail === "tier1") {
          premiumWins++;
          premiumPaid += top;
          if (firstPremium) {
            firstPremium = false;
            firstPremiumBalAfter += balance;
            firstPremiumN++;
          }
        }
      }
      if (balance <= 5 && auctionsLeft > 10) broke++;
      for (const w of highValuePlay({ rack: my, balance, auctionsLeft: auctionsLeft - 1 || 1, index })) {
        const r = wordReward(w);
        balance += r;
        score += r;
        words++;
        for (const c of w) my.set(c, my.get(c)! - 1);
      }
    }
    coinsLeft += balance;
  }
  const avg = (x: number, d: number) => (d ? (x / d).toFixed(1) : "-");
  console.log(
    `high-value sim over ${MATCHES} matches / ${auctions} auctions:\n` +
      `  premium (tier1) bids ${premiumBids} (${avg(premiumBids, MATCHES)}/match), avg bid ${avg(premiumBidSum, premiumBids)}, ` +
      `won ${premiumWins}, avg paid ${avg(premiumPaid, premiumWins)}\n` +
      `  other bids ${supportBids} (${avg(supportBids, MATCHES)}/match), avg ${avg(supportBidSum, supportBids)}; tiles won/match ${avg(wins, MATCHES)}\n` +
      `  balance right after first premium win ${avg(firstPremiumBalAfter, firstPremiumN)}; ` +
      `auctions spent near-broke (≤5 coins, >10 left) ${broke}\n` +
      `  score/match ${avg(score, MATCHES)}, words/match ${avg(words, MATCHES)}, coins left ${avg(coinsLeft, MATCHES)}`,
  );
  assert.ok(premiumBids > 0);
  // Vickrey: paying the rival's top bid, a premium win shouldn't cost most of our coins.
  assert.ok(firstPremiumN === 0 || firstPremiumBalAfter / firstPremiumN > 30);
});
