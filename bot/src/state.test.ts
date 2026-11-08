// Checks for the match state (S1-1). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auctionsLeftFrom,
  buildMatchState,
  type AuctionResultRow,
  type MatchRow,
  type MatchSnapshot,
  type ParticipantRow,
  type RackRow,
  type WordPlayRow,
} from "./state.js";

const M = 7n;
const ME = 1n;
const A = 2n;
const B = 3n;

const match = (o: Partial<MatchRow> = {}): MatchRow => ({
  id: M,
  status: { tag: "Running" },
  currentRound: 1,
  currentAuctionId: 100n,
  bagTotal: 82, // 98 - 3*5 dealt - 1 drawn for the open auction
  auctionType: { tag: "Vickrey" },
  auctionDurationMs: 2000n,
  startingRackSize: 5,
  ...o,
});

const part = (botId: bigint, balance: number, score: number): ParticipantRow => ({
  matchId: M,
  botId,
  balance: BigInt(balance),
  score: BigInt(score),
});

const rackRows = (letters: string, matchId = M): RackRow[] => {
  const counts = new Map<string, number>();
  for (const c of letters) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([letter, count]) => ({ matchId, letter, count }));
};

const names = new Map([[ME, "us"], [A, "alice"], [B, "bob"]]);

const snap = (o: Partial<MatchSnapshot> = {}): MatchSnapshot => ({
  myBotId: ME,
  match: match(),
  participants: [part(ME, 100, 0), part(A, 100, 0), part(B, 100, 0)],
  rack: rackRows("CATSE"),
  auctions: [{ id: 100n, matchId: M, letter: "R", status: { tag: "Open" } }],
  results: [],
  words: [],
  botNames: (id) => names.get(id),
  ...o,
});

test("start of a 3-player match", () => {
  const s = buildMatchState(snap());
  assert.equal(s.matchId, M);
  assert.equal(s.status, "Running");
  assert.equal(s.round, 1);
  assert.equal(s.bagTotal, 82);
  assert.equal(s.auctionsLeft, 83); // 98 - 15 dealt
  assert.equal(s.isLastAuction, false);
  assert.equal(s.auctionType, "Vickrey");
  assert.equal(s.auctionDurationMs, 2000);
  assert.equal(s.startingRackSize, 5);
  assert.deepEqual(s.openAuction, { auctionId: 100n, letter: "R" });
  assert.deepEqual(
    s.myRack,
    new Map([["C", 1], ["A", 1], ["T", 1], ["S", 1], ["E", 1]]),
  );
  assert.equal(s.myBalance, 100);
  assert.equal(s.myScore, 0);
  assert.equal(s.players.size, 3);
  assert.deepEqual(s.players.get(A), {
    botId: A,
    name: "alice",
    balance: 100,
    score: 0,
    isMe: false,
  });
  assert.equal(s.players.get(ME)?.isMe, true);
});

test("after we win an auction and play a word", () => {
  const results: AuctionResultRow[] = [
    { auctionId: 101n, matchId: M, letter: "Q", winnerBotId: null, paid: 0n },
    { auctionId: 100n, matchId: M, letter: "R", winnerBotId: ME, paid: 4n },
  ];
  const words: WordPlayRow[] = [
    {
      id: 9n,
      matchId: M,
      botId: ME,
      word: "CRATES",
      baseScore: 8n,
      bonus: 2n,
      totalReward: 10n,
    },
  ];
  const s = buildMatchState(
    snap({
      match: match({ currentRound: 3, bagTotal: 80, currentAuctionId: 102n }),
      // Server state after: we paid 4, played CRATES for 10.
      participants: [part(ME, 106, 10), part(A, 97, 0), part(B, 100, 0)],
      rack: [], // all six letters played
      auctions: [
        { id: 100n, matchId: M, letter: "R", status: { tag: "Closed" } },
        { id: 101n, matchId: M, letter: "Q", status: { tag: "Closed" } },
        { id: 102n, matchId: M, letter: "E", status: { tag: "Open" } },
      ],
      results,
      words,
    }),
  );
  assert.equal(s.myBalance, 106);
  assert.equal(s.myScore, 10);
  assert.equal(s.myRack.size, 0);
  assert.equal(s.players.get(A)?.balance, 97);
  assert.equal(s.round, 3);
  assert.equal(s.auctionsLeft, 81);
  assert.deepEqual(s.openAuction, { auctionId: 102n, letter: "E" });
  // History sorted oldest first, seq numbered.
  assert.deepEqual(
    s.auctions.map((a) => [a.seq, a.letter, a.winnerBotId, a.paid]),
    [
      [1, "R", ME, 4],
      [2, "Q", null, 0],
    ],
  );
  assert.deepEqual(s.words, [
    {
      id: 9n,
      botId: ME,
      word: "CRATES",
      baseScore: 8,
      bonus: 2,
      reward: 10,
      playedAtMs: undefined,
    },
  ]);
});

test("auctionsLeft at the last auction and after the end", () => {
  const last = buildMatchState(snap({ match: match({ bagTotal: 0 }) }));
  assert.equal(last.auctionsLeft, 1);
  assert.equal(last.isLastAuction, true);
  const ended = buildMatchState(
    snap({ match: match({ bagTotal: 0, status: { tag: "Ended" } }) }),
  );
  assert.equal(ended.auctionsLeft, 0);
  assert.equal(ended.isLastAuction, false);
  assert.equal(auctionsLeftFrom("Running", 40), 41);
});

test("rows from other matches are ignored", () => {
  const s = buildMatchState(
    snap({
      participants: [part(ME, 50, 5), { ...part(A, 1, 1), matchId: 99n }],
      rack: [...rackRows("AB"), ...rackRows("ZZZ", 99n)],
      results: [
        { auctionId: 1n, matchId: 99n, letter: "Z", winnerBotId: A, paid: 9n },
      ],
    }),
  );
  assert.equal(s.players.size, 1);
  assert.deepEqual(s.myRack, new Map([["A", 1], ["B", 1]]));
  assert.equal(s.auctions.length, 0);
});

test("missing own participant row gives zero balance", () => {
  const s = buildMatchState(snap({ participants: [part(A, 100, 0)] }));
  assert.equal(s.myBalance, 0);
  assert.equal(s.players.has(ME), false);
});
