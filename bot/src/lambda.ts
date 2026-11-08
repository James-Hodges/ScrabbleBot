// λ, the points-per-coin shadow price of a coin (S3-4).
//
// Each auction we solve for λ such that bidding optimally (lambdaBid.ts) on
// every remaining useful auction is expected to spend what we will have:
//
//   spend(λ) = Σ_letters Σ_phases c[L][ph] · expectedPay_L,ph( min(v_L / λ, cap) )
//            + expectedPay_open( min(v_open / λ, balance) )
//   budget   = balance + INCOME_SHARE · income
//   income   = V(rack) + MATCH_POINTS_PRIOR · F / USABLE_AUCTIONS
//   solve      spend(λ) = budget  by bisection in log λ on [LAMBDA_MIN, LAMBDA_MAX]
//
// where
//   * v_L / λ is the optimal Vickrey bid (truthful at the exchange rate λ:
//     maximising P(win)·v − λ·E[pay] gives b = v/λ under a continuous CDF).
//   * F = auctionsLeft − 2: future useful auctions after the open one (the
//     final auction's letter can't be played). They are spread over the
//     phase buckets of rivalBids by round, and each holds letter L with
//     probability unseen_L / |unseen|, so c[L][ph] = rounds in ph × unseen_L / N.
//   * v_L is the current value table (planValues: value.ts + target.ts) as a
//     proxy for what a future copy of L will be worth. Letters below
//     MIN_VALUE_POINTS are planned at 0 (we would not bid on them).
//   * Future bids are not capped at today's balance (word income comes back),
//     only at PLAN_BID_CAP; the open letter's bid is capped at the balance.
//   * income: V(rack) (expected reward of the best word our rack is close to)
//     plus a prior for the word points still to come (MATCH_POINTS_PRIOR per
//     match, pro rata over the useful auctions left). INCOME_SHARE is the
//     part of it that comes back as coins in time to be spent.
//
// spend(λ) falls as λ rises. If even LAMBDA_MIN can't spend the budget
// (late, with coins to spare and little left to buy) λ = LAMBDA_MIN, so we
// bid up to v/LAMBDA_MIN (in practice the balance) on anything useful: spend
// down. If LAMBDA_MAX still overspends, λ = LAMBDA_MAX.
//
// Floor: before the end, λ never drops below a floor that falls linearly
// from LAMBDA_FLOOR_EARLY (at the start) to LAMBDA_MIN (with
// SPEND_DOWN_AUCTIONS useful auctions left). A thin value table mid-match
// would otherwise drive λ to LAMBDA_MIN and turn a 0.5-point letter into a
// 25-coin bid; near the end that is exactly what we want.
//
// The planned wins and spend per phase are returned for logs and the sim.

import { MIN_VALUE_POINTS } from "./bid.js";
import { PHASE_COUNT, expectedPay, pWin, phaseIndex, rivalDist, type TableType } from "./rivalBids.js";
import { rackCounts, type Rack } from "./words.js";

export const LAMBDA_MIN = 0.02;
export const LAMBDA_MAX = 4;
export const BISECT_ITERS = 30;
/** Share of expected future word income that returns as coins in time to spend. */
export const INCOME_SHARE = 0.45;
/** Prior word points per match for us (leaders at all-real tables score ~85–95). */
export const MATCH_POINTS_PRIOR = 90;
/** Useful auctions in a 68-auction match (the final one is not). */
export const USABLE_AUCTIONS = 67;
/** Planned future bids are capped here (not at today's balance). */
export const PLAN_BID_CAP = 300;
/** λ floor at the start of the match (bid at most 1/0.2 = 5 coins per point). */
export const LAMBDA_FLOOR_EARLY = 0.2;
/** With this many useful auctions left (incl. the open one) the floor is LAMBDA_MIN. */
export const SPEND_DOWN_AUCTIONS = 8;
/** Multiplier on the solved λ (K-13 used ~1.08 at 6 seats); 1 = untuned. */
export const LAMBDA_SCALE = 1;

const A = 65;

export interface LambdaContext {
  balance: number;
  /** Auctions left including the open one (MatchState.auctionsLeft). */
  auctionsLeft: number;
  /** 1-based round of the open auction. */
  round: number;
  /** Letter on the open auction. */
  letter: string;
  /** Value of the open letter (points), after any override (lambdaBid's value). */
  openValue: number;
  /** Value table (points), 0..25 = A..Z: the proxy for future letters. */
  values: Float64Array;
  /** Unseen tiles (pool.ts unseenPool(...).unseen); the open letter is already out. */
  unseen: Rack | Uint8Array;
  /** V(rack): expected reward of the best word our rack is near (value table base). */
  rackBase: number;
  tableType: TableType;
  /** In-match rival scale (rivalBids.matchScale). Default 1. */
  scale?: number;
}

export type LambdaBound = "solved" | "min" | "max" | "floor" | "none";

export interface LambdaResult {
  lambda: number;
  /** balance + INCOME_SHARE · income. */
  budget: number;
  income: number;
  /** spend(λ) and expected wins at the chosen λ. */
  plannedSpend: number;
  plannedWins: number;
  /** Planned spend per rivalBids phase bucket (open auction included). */
  spendByPhase: number[];
  bound: LambdaBound;
  /** The floor applied this auction. */
  floor: number;
}

/** λ floor for the useful auctions left (incl. the open one). */
export function lambdaFloor(usableLeft: number): number {
  const span = USABLE_AUCTIONS - SPEND_DOWN_AUCTIONS;
  const frac = Math.min(1, Math.max(0, (usableLeft - SPEND_DOWN_AUCTIONS) / span));
  return LAMBDA_MIN + (LAMBDA_FLOOR_EARLY - LAMBDA_MIN) * frac;
}

interface Item {
  v: number;
  /** Expected number of such auctions. */
  count: number;
  phase: number;
  cap: number;
  letter: string;
  round: number;
}

export function solveLambda(ctx: LambdaContext): LambdaResult {
  const balance = Math.max(0, Math.floor(ctx.balance));
  const scale = ctx.scale ?? 1;
  const usableLeft = Math.max(0, ctx.auctionsLeft - 1); // open + future, final excluded
  const future = Math.max(0, ctx.auctionsLeft - 2);
  const income = Math.max(0, ctx.rackBase) + (MATCH_POINTS_PRIOR * future) / USABLE_AUCTIONS;
  const budget = balance + INCOME_SHARE * income;
  const empty = (bound: LambdaBound, lambda: number): LambdaResult => ({
    lambda,
    budget,
    income,
    plannedSpend: 0,
    plannedWins: 0,
    spendByPhase: new Array(PHASE_COUNT).fill(0),
    bound,
    floor: lambdaFloor(usableLeft),
  });
  if (usableLeft <= 0) return empty("none", LAMBDA_MAX);

  // Items: the open letter, then expected future letters per phase.
  const items: Item[] = [];
  if (ctx.openValue >= MIN_VALUE_POINTS)
    items.push({ v: ctx.openValue, count: 1, phase: phaseIndex(ctx.round), cap: balance, letter: ctx.letter, round: ctx.round });
  if (future > 0) {
    const pool = ctx.unseen instanceof Uint8Array ? ctx.unseen : rackCounts(ctx.unseen);
    let N = 0;
    for (let i = 0; i < 26; i++) N += pool[i];
    // Rounds per phase among the future useful rounds round+1 .. round+future.
    const rounds = new Map<number, { n: number; round: number }>();
    for (let r = ctx.round + 1; r <= ctx.round + future; r++) {
      const ph = phaseIndex(r);
      const e = rounds.get(ph);
      if (e) e.n++;
      else rounds.set(ph, { n: 1, round: r });
    }
    if (N > 0)
      for (let i = 0; i < 26; i++) {
        const v = ctx.values[i];
        if (!(v >= MIN_VALUE_POINTS) || pool[i] === 0) continue;
        for (const [ph, e] of rounds)
          items.push({ v, count: (e.n * pool[i]) / N, phase: ph, cap: PLAN_BID_CAP, letter: String.fromCharCode(A + i), round: e.round });
      }
  }
  const dists = items.map((it) => rivalDist(it.letter, it.round, ctx.tableType));

  const evalAt = (lambda: number, byPhase?: number[]) => {
    let spend = 0;
    let wins = 0;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const b = Math.min(it.v / lambda, it.cap);
      const pay = it.count * expectedPay(dists[k], b, scale);
      spend += pay;
      wins += it.count * pWin(dists[k], b, scale);
      if (byPhase) byPhase[it.phase] += pay;
    }
    return { spend, wins };
  };

  let bound: LambdaBound = "solved";
  let lambda: number;
  if (evalAt(LAMBDA_MIN).spend <= budget) {
    lambda = LAMBDA_MIN;
    bound = "min";
  } else if (evalAt(LAMBDA_MAX).spend > budget) {
    lambda = LAMBDA_MAX;
    bound = "max";
  } else {
    let lo = Math.log(LAMBDA_MIN);
    let hi = Math.log(LAMBDA_MAX);
    for (let it = 0; it < BISECT_ITERS; it++) {
      const mid = (lo + hi) / 2;
      if (evalAt(Math.exp(mid)).spend > budget) lo = mid;
      else hi = mid;
    }
    lambda = Math.exp(hi);
  }
  lambda *= LAMBDA_SCALE;
  const floor = lambdaFloor(usableLeft);
  if (lambda < floor) {
    lambda = floor;
    bound = "floor";
  }
  lambda = Math.min(LAMBDA_MAX, Math.max(LAMBDA_MIN, lambda));
  const spendByPhase = new Array(PHASE_COUNT).fill(0);
  const { spend, wins } = evalAt(lambda, spendByPhase);
  return { lambda, budget, income, plannedSpend: spend, plannedWins: wins, spendByPhase, bound, floor };
}
