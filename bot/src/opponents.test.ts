// Checks for opponents' letters (S1-3). Run with `npm test`.
// The seeded 6-player simulation check lives in pool.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { opponentLetters } from "./opponents.js";
import { buildMatchState, type MatchState } from "./state.js";
import type { Rack } from "./words.js";

const M = 9n;
const ME = 1n;
const OPP = 2n;
const at = (ms: number) => ({ toMillis: () => BigInt(ms) });
const obj = (r: Rack) =>
  Object.fromEntries([...r].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : 1)));

/** auctions: [letter, winner, ms]; words: [bot, word, ms]. */
function state(
  auctions: [string, bigint | null, number][],
  words: [bigint, string, number][],
  opts: { untimed?: boolean; startingRackSize?: number } = {},
): MatchState {
  let id = 0n;
  return buildMatchState({
    myBotId: ME,
    match: {
      id: M,
      status: { tag: "Running" },
      currentRound: 1,
      bagTotal: 50,
      auctionType: { tag: "Vickrey" },
      auctionDurationMs: 2000n,
      startingRackSize: opts.startingRackSize ?? 5,
    },
    participants: [
      { matchId: M, botId: ME, balance: 100n, score: 0n },
      { matchId: M, botId: OPP, balance: 77n, score: 12n },
    ],
    rack: [],
    botNames: (b) => (b === OPP ? "rival" : "me"),
    results: auctions.map(([letter, winnerBotId, ms]) => ({
      auctionId: ++id,
      matchId: M,
      letter,
      winnerBotId,
      paid: 1n,
      closedAt: opts.untimed ? undefined : at(ms),
    })),
    words: words.map(([botId, word, ms]) => ({
      id: ++id,
      matchId: M,
      botId,
      word,
      baseScore: 0n,
      bonus: 0n,
      totalReward: 0n,
      playedAt: opts.untimed ? undefined : at(ms),
    })),
  });
}

test("start: no known letters, all starting tiles hidden; public fields copied", () => {
  const ops = opponentLetters(state([], []));
  assert.deepEqual([...ops.keys()], [OPP]);
  const o = ops.get(OPP)!;
  assert.equal(o.known.size, 0);
  assert.equal(o.hiddenStarting, 5);
  assert.equal(o.rackSize, 5);
  assert.equal(o.name, "rival");
  assert.equal(o.balance, 77);
  assert.equal(o.score, 12);
  assert.ok(o.ordered);
});

test("wins letters: they become known", () => {
  const o = opponentLetters(state([["Q", OPP, 1], ["S", OPP, 2], ["T", ME, 3]], [])).get(OPP)!;
  assert.deepEqual(obj(o.known), { Q: 1, S: 1 });
  assert.equal(o.rackSize, 7);
});

test("wins then plays the won letter: known drops", () => {
  const o = opponentLetters(state([["Q", OPP, 1], ["S", OPP, 2]], [[OPP, "QIS", 10]])).get(OPP)!;
  assert.equal(o.known.size, 0);
  assert.deepEqual(obj(o.revealedStarting), { I: 1 });
  assert.equal(o.hiddenStarting, 4);
  assert.equal(o.rackSize, 4);
});

test("plays a letter never won: revealed starting, hidden count drops", () => {
  const o = opponentLetters(state([["Z", OPP, 1]], [[OPP, "ZAX", 10]])).get(OPP)!;
  assert.deepEqual(obj(o.revealedStarting), { A: 1, X: 1 });
  assert.equal(o.known.size, 0);
  assert.equal(o.hiddenStarting, 3);
  assert.equal(o.rackSize, 3);
});

test("plays starting E then wins E: known has E, revealed has E", () => {
  const s = state([["E", OPP, 10]], [[OPP, "TEN", 5]]);
  const o = opponentLetters(s).get(OPP)!;
  assert.deepEqual(obj(o.known), { E: 1 });
  assert.deepEqual(obj(o.revealedStarting), { E: 1, N: 1, T: 1 });
  assert.equal(o.hiddenStarting, 2);
  assert.equal(o.rackSize, 3);
});

test("no timestamps: unordered fallback, known = max(0, won − played)", () => {
  const o = opponentLetters(
    state([["E", OPP, 10], ["E", OPP, 11], ["Q", OPP, 12]], [[OPP, "TEN", 5]], { untimed: true }),
  ).get(OPP)!;
  assert.equal(o.ordered, false);
  assert.deepEqual(obj(o.known), { E: 1, Q: 1 });
  assert.deepEqual(obj(o.revealedStarting), { N: 1, T: 1 });
  assert.equal(o.hiddenStarting, 3);
});

test("uses startingRackSize, and a clamp is flagged", () => {
  assert.equal(opponentLetters(state([], [], { startingRackSize: 7 })).get(OPP)!.hiddenStarting, 7);
  const o = opponentLetters(state([], [[OPP, "ABC", 1], [OPP, "DEF", 2]])).get(OPP)!;
  assert.equal(o.hiddenStarting, 0);
  assert.equal(o.inconsistencies, 1);
});
