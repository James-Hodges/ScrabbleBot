// The bid decision for one auction, in either BID_MODE (S3-4).
//
//   current  exactly improved-bot's rule: bid.ts rawBid (market-anchored, with
//            the bingo/snowball/synergy overrides) then budget.ts applyBudget
//            (spend-down, final auction 0, bomb reserve before the first word).
//   lambda   lambdaBid.ts at the λ from lambda.ts against the rival-bid model
//            (rivalBids.ts); applyBudget is bypassed except the final-auction 0
//            (lambdaBid bids 0 there itself).
//
// index.ts calls decideBid and logs `fields`. Pure apart from the λ cache.

import { rawBid as decideRawBid, completesTarget } from "./bid.js";
import { applyBudget, bombReserve } from "./budget.js";
import { solveLambda, type LambdaResult } from "./lambda.js";
import { lambdaBid, lambdaValue } from "./lambdaBid.js";
import { matchScale, rivalDist, type TableType } from "./rivalBids.js";
import type { MatchState } from "./state.js";
import type { PlanTable } from "./target.js";
import { valueOf } from "./value.js";
import type { Rack, WordIndex } from "./words.js";

export type BidMode = "lambda" | "current";

/** BID_MODE from the environment: "current" or (default on this branch) "lambda". */
export function bidModeFrom(env: string | undefined): BidMode {
  return env?.trim().toLowerCase() === "current" ? "current" : "lambda";
}

export type DecideState = Pick<
  MatchState,
  "myBalance" | "auctionsLeft" | "round" | "isLastAuction" | "myRack" | "auctions" | "myBotId"
>;

export interface DecideInput {
  mode: BidMode;
  letter: string;
  state: DecideState;
  table: PlanTable;
  /** We have played a word this match (the bomb is down). */
  played: boolean;
  /** Target tiles still missing (targetMissing of the auction's target). */
  missing: string;
  index: WordIndex;
  /** Unseen tiles (pool.ts), lambda mode only. */
  unseen: Rack;
  tableType: TableType;
  /** Reuse λ for an unchanged (balance, auctionsLeft, rack value) key. */
  lambdaCache?: { key: string; result: LambdaResult } | null;
}

export interface Decision {
  amount: number;
  /** Fields for bid_sent / bid_skipped. */
  fields: Record<string, unknown>;
  /** The λ solve to cache (lambda mode). */
  lambdaCache?: { key: string; result: LambdaResult };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function decideBid(inp: DecideInput): Decision {
  return inp.mode === "current" ? decideCurrent(inp) : decideLambda(inp);
}

function decideCurrent(inp: DecideInput): Decision {
  const { state, table, letter } = inp;
  const rack = state.myRack;
  // S2-3: market-anchored bid with bingo & early snowball detection.
  const bid = decideRawBid({
    letter,
    values: table,
    balance: state.myBalance,
    auctionsLeft: state.auctionsLeft,
    round: state.round,
    completesWord: completesTarget(table, rack, letter),
    rack,
    index: inp.index,
    minReward: table.minReward,
    floor: table.floor,
  });
  const rawBid = bid.amount;
  // S2-4/S2-5: spend-down pace and never bidding on the last auction.
  // Before the bomb, keep coins for the target's remaining letters.
  const reserveCoins = inp.played ? 0 : bombReserve(inp.missing, letter);
  const { amount, reason: budgetReason } = applyBudget(rawBid, { ...state, letter, reserveCoins });
  return {
    amount,
    fields: {
      bidMode: "current",
      rawBid,
      budgetReason,
      value: r2(bid.value),
      ceiling: r2(bid.ceiling),
      marketCap: bid.marketCap,
      marketPct: bid.pct,
      bidReason: bid.reason,
      reserveCoins,
    },
  };
}

function decideLambda(inp: DecideInput): Decision {
  const { state, table, letter } = inp;
  const lv = lambdaValue(valueOf(table, letter), state.myRack, letter, inp.index, table.minReward);
  const scale = matchScale(state.auctions, state.myBotId, inp.tableType);
  const key = [state.myBalance, state.auctionsLeft, letter, r3(lv.value), r3(table.base), r3(scale), inp.tableType].join("|");
  let solved: LambdaResult;
  if (inp.lambdaCache && inp.lambdaCache.key === key) solved = inp.lambdaCache.result;
  else
    solved = solveLambda({
      balance: state.myBalance,
      auctionsLeft: state.auctionsLeft,
      round: state.round,
      letter,
      openValue: lv.value,
      values: table.values,
      unseen: inp.unseen,
      rackBase: table.base,
      tableType: inp.tableType,
      scale,
    });
  const bid = lambdaBid({
    value: lv.value,
    lambda: solved.lambda,
    balance: state.myBalance,
    isLastAuction: state.isLastAuction,
    dist: rivalDist(letter, state.round, inp.tableType),
    scale,
  });
  return {
    amount: bid.amount,
    lambdaCache: { key, result: solved },
    fields: {
      bidMode: "lambda",
      rawBid: bid.amount,
      budgetReason: state.isLastAuction ? "last_auction" : "lambda",
      bidReason: bid.reason,
      value: r2(lv.value),
      tableValue: r2(lv.tableValue),
      bingo: lv.bingo?.word,
      lambda: r3(solved.lambda),
      lambdaBound: solved.bound,
      truthfulBid: r2(bid.truthful),
      pWin: r3(bid.pWin),
      ePrice: r2(bid.ePrice),
      tableType: inp.tableType,
      rivalScale: r3(scale),
      budget: r2(solved.budget),
      income: r2(solved.income),
      plannedSpend: r2(solved.plannedSpend),
      plannedWins: r2(solved.plannedWins),
    },
  };
}
