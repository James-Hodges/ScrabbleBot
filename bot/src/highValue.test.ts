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
  WAIT_MIN_AUCTIONS,
  budgetHighValue,
  commitTargets,
  highValueBid,
  highValuePlan,
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

// v2 change: with a premium letter held, support bids became target bids
// (below). The v1 support rule now only runs while we hold no HIGH letter.
test("support letter for a big target, no HIGH letter held: modest bid", () => {
  const b = highValueBid(ctx("AEIRT", "B"));
  assert.equal(b.reason, "support");
  assert.ok(b.amount > 0, String(b.amount));
  assert.ok(b.amount <= priceFor("B", 19, 50), String(b.amount));
  assert.deepEqual(b.committed, []);
});

test("unrelated letter: 0", () => {
  // No premium held and no big word within reach that G would help.
  const b = highValueBid(ctx("UUUII", "G", { auctionsLeft: 4 }));
  assert.equal(b.amount, 0);
  assert.equal(b.reason, "skip");
});

// v2 change: rack AEIRT instead of ZAEIR. Holding a premium letter now
// drops the reserve, so the reserve only applies with no HIGH letter held.
test("reserve: support bids stay out of it (no HIGH letter held)", () => {
  const p50 = () => 50; // a market that would let support bid high
  const prices = (_l: string, _r: number, _p: Pct) => p50();
  const b = highValueBid(ctx("AEIRT", "B", { balance: RESERVE + 4, prices }));
  assert.equal(b.reason, "support");
  assert.ok(b.amount <= 4, String(b.amount));
  const broke = highValueBid(ctx("AEIRT", "B", { balance: RESERVE, prices }));
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

// ---- v2: committed targets, target bids, waiting, refill ----

const words = (b: { committed?: { word: string }[] }) => (b.committed ?? []).map((t) => t.word);

test("v2: holding Z, a letter a committed target needs gets ≥ p75, reserve doesn't block it", () => {
  // Balance just above the v1 reserve: v1 had room for only 5 coins here.
  const b = highValueBid(ctx("ZAEIRT", "N", { balance: RESERVE + 5, round: 30, auctionsLeft: 40 }));
  assert.equal(b.reason, "target", JSON.stringify(b));
  assert.equal(b.reserve, 0);
  assert.ok(b.served!.length > 0 && b.served!.every((w) => w.includes("Z") && w.includes("N")), String(b.served));
  assert.ok(b.amount >= priceFor("N", 30, 75), `${b.amount} < p75 ${priceFor("N", 30, 75)}`);
  assert.ok(b.amount > 5, String(b.amount));
  // Last missing tile: at least p90, with plenty of balance up to ~TARGET_SHARE+.
  const last = highValueBid(ctx("QUAIEST", "E", { balance: 100, round: 38, auctionsLeft: 30 }));
  assert.equal(last.reason, "target");
  assert.equal(last.detail, "last");
  assert.ok(last.amount >= priceFor("E", 38, 90) && last.amount >= 40, String(last.amount));
});

test("v2: holding Z, a letter no committed target needs gets 0", () => {
  const b = highValueBid(ctx("ZAEIRT", "B", { round: 30, auctionsLeft: 40 }));
  assert.equal(b.amount, 0);
  assert.equal(b.detail, "not_in_target");
  assert.deepEqual(b.served, []);
  assert.ok(words(b).length > 0);
  // A further premium letter is still a premium bid (v1 rule kept).
  assert.equal(highValueBid(ctx("ZAEIRT", "X", { round: 30, auctionsLeft: 40 })).reason, "premium");
});

test("v2: committed targets stay stable across a small rack change", () => {
  const first = highValueBid(ctx("ZAEIR", "T"));
  const kept = words(first);
  assert.equal(kept.length, 3);
  for (const add of "BGDLMPS") {
    const r = "ZAEIR" + add;
    const again = highValueBid(ctx(r, "T", { auctionsLeft: 49, committed: kept }));
    assert.deepEqual(words(again), kept, `after +${add}`);
  }
  // Without the memory the same rack may pick different words (that's the flip-flop).
  const fresh = commitTargets({ rack: rack("ZAEIRB"), pool: pool("ZAEIRB", ""), horizon: 48, index });
  assert.notDeepEqual(fresh.map((t) => t.word), kept);
});

test("v2: holding no HIGH letter, no commitment", () => {
  assert.deepEqual(commitTargets({ rack: rack("AEIRT"), pool: pool("AEIRT", ""), horizon: 40, index }), []);
});

// RETAINS (7 letters, 21) is playable now; ZEATINES (8, 51) needs one more E.
const waitIndex = new WordIndex(["RETAINS", "ZEATINES"]);
const waitRack = "AEINRSTZ";

test("v2 play: waits for a reachable 8-letter word over a 7 with many auctions left", () => {
  const plan = highValuePlan({ rack: rack(waitRack), balance: 50, auctionsLeft: 40, index: waitIndex, pool: pool(waitRack, "") });
  assert.deepEqual(plan.words, []);
  assert.equal(plan.waited?.word, "RETAINS");
  assert.equal(plan.waited?.longer, "ZEATINES");
  assert.equal(plan.waited?.missing, "E");
});

test("v2 play: plays the 7 when few auctions remain or the 8 is unlikely", () => {
  const base = { rack: rack(waitRack), balance: 50, index: waitIndex, pool: pool(waitRack, "") };
  assert.deepEqual(highValuePlay({ ...base, auctionsLeft: WAIT_MIN_AUCTIONS }), ["RETAINS"]);
  // Only one E left unseen: ~20% to win it, not worth 21 points now.
  const oneE = pool(waitRack, "", "E");
  oneE.set("E", 1);
  const plan = highValuePlan({ ...base, auctionsLeft: 40, pool: oneE });
  assert.deepEqual(plan.words, ["RETAINS"]);
  assert.equal(plan.waited, undefined);
  // Without pool information: v1 behaviour (play at once).
  assert.deepEqual(highValuePlay({ ...base, pool: undefined, auctionsLeft: 40 }), ["RETAINS"]);
});

test("v2 play: refill avoids the premium letter while its target is alive", () => {
  const small = new WordIndex(["ZEATINES", "ZA", "TEA"]);
  const r = "ZAETIN";
  const plan = highValuePlan({ rack: rack(r), balance: 5, auctionsLeft: 40, index: small, pool: pool(r, "") });
  assert.equal(plan.protectedLetters, "Z");
  assert.deepEqual(plan.words, ["TEA"]); // v1 would play ZA (11 > 3)
  // No alternative: refill still plays ZA.
  const only = new WordIndex(["ZEATINES", "ZA"]);
  assert.deepEqual(highValuePlay({ rack: rack(r), balance: 5, auctionsLeft: 40, index: only, pool: pool(r, "") }), ["ZA"]);
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

// v2: the loop threads committed targets between decisions and gives the
// play policy the unseen pool, as index.ts does live.
test("simulation: premium bidding doesn't blow the coins on the first K", () => {
  const MATCHES = Number(process.env.HV_SIM_MATCHES ?? 30);
  const rand = mulberry32(42);
  let auctions = 0, premiumBids = 0, premiumBidSum = 0, premiumWins = 0, premiumPaid = 0;
  let otherBids = 0, otherBidSum = 0, targetBids = 0, targetBidSum = 0, targetWins = 0, wins = 0;
  let firstPremiumBalAfter = 0, firstPremiumN = 0, score = 0, words = 0, coinsLeft = 0, broke = 0;
  let premiumWords = 0, premiumWordReward = 0, waits = 0, stranded = 0, longWords = 0;
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
    let committed: string[] | undefined;
    const n = auctionLetters.length;
    for (let a = 0; a < n; a++) {
      const letter = auctionLetters[a];
      const round = a + 1;
      const auctionsLeft = n - a;
      unseen.set(letter, unseen.get(letter)! - 1);
      const b = highValueBid({
        letter, rack: my, pool: unseen, balance, auctionsLeft, round,
        isLastAuction: auctionsLeft === 1, index, committed,
      });
      if (b.committed) committed = b.committed.map((t) => t.word);
      const amount = budgetHighValue(b, { isLastAuction: auctionsLeft === 1, auctionsLeft, round, myBalance: balance, letter }).amount;
      auctions++;
      const isPremium = b.reason === "premium" && b.detail === "tier1";
      if (isPremium) {
        premiumBids++;
        premiumBidSum += amount;
      } else if (b.reason === "target" && amount > 0) {
        targetBids++;
        targetBidSum += amount;
      } else if (amount > 0) {
        otherBids++;
        otherBidSum += amount;
      }
      const top = rivalTop(letter, round, rand());
      if (amount > top) {
        balance -= top;
        wins++;
        if (b.reason === "target") targetWins++;
        my.set(letter, (my.get(letter) ?? 0) + 1);
        if (isPremium) {
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
      const plan = highValuePlan({ rack: my, balance, auctionsLeft: auctionsLeft - 1 || 1, index, pool: unseen, committed });
      if (plan.waited) waits++;
      if (plan.committed.length > 0) committed = plan.committed.map((t) => t.word);
      for (const w of plan.words) {
        const r = wordReward(w);
        balance += r;
        score += r;
        words++;
        if (w.length >= 7) longWords++;
        if ([...PREMIUM].some((c) => w.includes(c))) {
          premiumWords++;
          premiumWordReward += r;
        }
        for (const c of w) my.set(c, my.get(c)! - 1);
      }
    }
    for (const c of PREMIUM) stranded += my.get(c) ?? 0;
    coinsLeft += balance;
  }
  const avg = (x: number, d: number) => (d ? (x / d).toFixed(1) : "-");
  console.log(
    `high-value v2 sim over ${MATCHES} matches / ${auctions} auctions:\n` +
      `  premium (tier1) bids ${premiumBids} (${avg(premiumBids, MATCHES)}/match), avg bid ${avg(premiumBidSum, premiumBids)}, ` +
      `won ${premiumWins}, avg paid ${avg(premiumPaid, premiumWins)}\n` +
      `  target bids ${targetBids} (${avg(targetBids, MATCHES)}/match), avg ${avg(targetBidSum, targetBids)}, won ${targetWins}; ` +
      `other bids ${otherBids}, avg ${avg(otherBidSum, otherBids)}\n` +
      `  tiles won/match ${avg(wins, MATCHES)}; balance right after first premium win ${avg(firstPremiumBalAfter, firstPremiumN)}; ` +
      `near-broke auctions ${broke}\n` +
      `  score/match ${avg(score, MATCHES)}, words/match ${avg(words, MATCHES)} (7+: ${avg(longWords, MATCHES)}), coins left ${avg(coinsLeft, MATCHES)}\n` +
      `  premium words ${premiumWords}, avg reward ${avg(premiumWordReward, premiumWords)}; premium tiles stranded ${stranded}; waits ${waits}`,
  );
  assert.ok(premiumBids > 0);
  // Vickrey: paying the rival's top bid, a premium win shouldn't cost most of our coins.
  assert.ok(firstPremiumN === 0 || firstPremiumBalAfter / firstPremiumN > 30);
});
