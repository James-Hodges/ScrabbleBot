// Checks for the unseen-tile pool (S1-2). Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { opponentLetters } from "./opponents.js";
import { poolCheck, TILE_SET, TILE_SET_SIZE, unseenPool } from "./pool.js";
import {
  buildMatchState,
  type AuctionResultRow,
  type AuctionRow,
  type MatchState,
  type WordPlayRow,
} from "./state.js";
import type { Rack } from "./words.js";

const M = 9n;
const ME = 1n;

const rackOf = (letters: string): Rack => {
  const r: Rack = new Map();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
const obj = (r: Rack) =>
  Object.fromEntries([...r].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : 1)));

test("tile set is the server's 98-tile bag", () => {
  let n = 0;
  for (const c of TILE_SET.values()) n += c;
  assert.equal(n, 98);
  assert.equal(TILE_SET_SIZE, 98);
  assert.equal(TILE_SET.size, 26);
});

// ---- Small hand-written cases ----

interface Mini {
  myRack: string;
  bots: bigint[];
  bagTotal: number;
  open?: string;
  /** [letter, winner, closedAtMs?]; default ms = position (1, 2, ...). */
  auctions?: [string, bigint | null, number?][];
  /** [bot, word, playedAtMs?]; default ms = 1000 + position (after the auctions). */
  words?: [bigint, string, number?][];
  /** Omit all timestamps (forces the unordered fallback). */
  untimed?: boolean;
}
const mini = (m: Mini): MatchState => {
  let id = 0n;
  return buildMatchState({
    myBotId: ME,
    match: {
      id: M,
      status: { tag: "Running" },
      currentRound: 1,
      bagTotal: m.bagTotal,
      auctionType: { tag: "Vickrey" },
      auctionDurationMs: 2000n,
      startingRackSize: 5,
    },
    participants: m.bots.map((botId) => ({ matchId: M, botId, balance: 100n, score: 0n })),
    rack: [...rackOf(m.myRack)].map(([letter, count]) => ({ matchId: M, letter, count })),
    auctions: m.open
      ? [{ id: 999n, matchId: M, letter: m.open, status: { tag: "Open" } }]
      : [],
    results: (m.auctions ?? []).map(([letter, winnerBotId, ms], i) => ({
      auctionId: ++id,
      matchId: M,
      letter,
      winnerBotId,
      paid: 1n,
      closedAt: m.untimed ? undefined : at(ms ?? i + 1),
    })),
    words: (m.words ?? []).map(([botId, word, ms], i) => ({
      id: ++id,
      matchId: M,
      botId,
      word,
      baseScore: 0n,
      bonus: 0n,
      totalReward: 0n,
      playedAt: m.untimed ? undefined : at(ms ?? 1000 + i),
    })),
  });
};
const at = (ms: number) => ({ toMillis: () => BigInt(ms) });

test("start of match: unseen is everything but our rack and the open letter", () => {
  // 2 bots: 98 - 10 dealt - 1 open = 87 in the bag.
  const s = mini({ myRack: "AEIOU", bots: [ME, 2n], bagTotal: 87, open: "Q" });
  const p = unseenPool(s);
  assert.equal(p.total, 98 - 5 - 1);
  assert.equal(p.unseen.get("A"), 8);
  assert.equal(p.unseen.get("Q"), undefined);
  assert.deepEqual(poolCheck(s, p), { unseenTotal: 92, unseenExpected: 92, ok: true });
});

test("opponent plays a letter they never won: counted as a revealed starting tile", () => {
  const s = mini({
    myRack: "AEIOU",
    bots: [ME, 2n],
    bagTotal: 85,
    open: "B",
    auctions: [["Z", 2n], ["T", null]],
    words: [[2n, "ZAX"]],
  });
  const p = unseenPool(s);
  assert.deepEqual(obj(p.revealedStarting.get(2n)!), { A: 1, X: 1 });
  assert.equal(p.unseen.get("Z"), undefined);
  assert.equal(p.unseen.get("X"), undefined);
  assert.equal(p.unseen.get("A"), 9 - 1 - 1); // ours + theirs
  assert.equal(p.unseen.get("T"), 5); // thrown away = seen
  const c = poolCheck(s, p);
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.unseenExpected, 85 + (5 - 2));
});

test("we win then play a letter: not double counted", () => {
  // Dealt AEIOU, won Z and X, played "ZAX" -> rack EIOU.
  const s = mini({
    myRack: "EIOU",
    bots: [ME, 2n],
    bagTotal: 85,
    open: "B",
    auctions: [["Z", ME], ["X", ME]],
    words: [[ME, "ZAX"]],
  });
  const p = unseenPool(s);
  assert.deepEqual(obj(p.myStarting), obj(rackOf("AEIOU")));
  assert.equal(p.unseen.get("A"), 8);
  assert.equal(p.unseen.get("Z"), undefined);
  assert.ok(poolCheck(s, p).ok);
});

test("opponent wins a letter and plays it: not revealed as starting", () => {
  const s = mini({
    myRack: "AEIOU",
    bots: [ME, 2n],
    bagTotal: 86,
    auctions: [["Q", 2n], ["S", 2n]],
    words: [[2n, "QIS"]],
  });
  const p = unseenPool(s);
  assert.deepEqual(obj(p.revealedStarting.get(2n)!), { I: 1 });
  assert.ok(poolCheck(s, p).ok);
});

test("opponent plays a starting E, later wins an E: the starting E stays revealed", () => {
  const base: Mini = {
    myRack: "AIOUS",
    bots: [ME, 2n],
    bagTotal: 86,
    words: [[2n, "TEN", 5]],
    auctions: [["X", null, 1], ["E", 2n, 10]],
  };
  const s = mini(base);
  const p = unseenPool(s);
  assert.deepEqual(obj(p.revealedStarting.get(2n)!), { E: 1, N: 1, T: 1 });
  assert.equal(p.unseen.get("E"), 12 - 2); // the won E and the played starting E
  assert.equal(p.unorderedFallbacks, 0);
  assert.ok(poolCheck(s, p).ok);

  // Same events without timestamps: unordered fallback, looser and counted.
  const u = unseenPool(mini({ ...base, untimed: true }));
  assert.deepEqual(obj(u.revealedStarting.get(2n)!), { N: 1, T: 1 });
  assert.equal(u.unseen.get("E"), 12 - 1);
  assert.equal(u.unorderedFallbacks, 1);
});

test("an auction and a word at the same ms: the auction counts first", () => {
  const s = mini({
    myRack: "AIOUS",
    bots: [ME, 2n],
    bagTotal: 87,
    words: [[2n, "ZEN", 7]],
    auctions: [["Z", 2n, 7]],
  });
  assert.deepEqual(obj(unseenPool(s).revealedStarting.get(2n)!), { E: 1, N: 1 });
});

test("inconsistent input is flagged, not hidden", () => {
  // Opponent plays a second Z that doesn't exist.
  const s = mini({
    myRack: "AEIOU",
    bots: [ME, 2n],
    bagTotal: 86,
    auctions: [["Z", 2n]],
    words: [[2n, "ZZZ"]],
  });
  const p = unseenPool(s);
  assert.equal(p.inconsistencies, 2);
  assert.equal(poolCheck(s, p).ok, false);
});

// ---- Simulated recorded match ----

/** mulberry32: small deterministic RNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimBot {
  id: bigint;
  /** Starting tiles still held. */
  starting: string[];
  /** Won tiles still held. */
  won: string[];
}

/** What the sim hands each check: the state plus two ground truths. */
interface SimView {
  s: MatchState;
  /** Bag + opponents' starting tiles really still on their racks. */
  actual: Rack;
  /** Each opponent's true rack, split into won and starting tiles still held. */
  racks: Map<bigint, { won: Rack; starting: Rack }>;
}

function simulate(seed: number, check: (v: SimView) => void) {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

  const bag: string[] = [];
  for (const [l, n] of TILE_SET) for (let i = 0; i < n; i++) bag.push(l);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }

  const bots: SimBot[] = [1n, 2n, 3n, 4n, 5n, 6n].map((id) => {
    return { id, starting: bag.splice(0, 5), won: [] };
  });
  const results: AuctionResultRow[] = [];
  const words: WordPlayRow[] = [];
  let nextId = 1n;
  let clock = 0;

  const snapshot = (open: { id: bigint; letter: string } | null, ended: boolean) => {
    const me = bots[0];
    const auctions: AuctionRow[] = open
      ? [{ id: open.id, matchId: M, letter: open.letter, status: { tag: "Open" } }]
      : [];
    const s = buildMatchState({
      myBotId: ME,
      match: {
        id: M,
        status: { tag: ended ? "Ended" : "Running" },
        currentRound: results.length + 1,
        bagTotal: bag.length,
        auctionType: { tag: "Vickrey" },
        auctionDurationMs: 2000n,
        startingRackSize: 5,
      },
      participants: bots.map((b) => ({ matchId: M, botId: b.id, balance: 0n, score: 0n })),
      rack: [...rackOf([...me.starting, ...me.won].join(""))].map(([letter, count]) => ({
        matchId: M,
        letter,
        count,
      })),
      auctions,
      results,
      words,
    });
    // Ground truth, tracked by the sim independently of pool.ts.
    const actual = rackOf(bag.join(""));
    for (const b of bots.slice(1))
      for (const l of b.starting) actual.set(l, (actual.get(l) ?? 0) + 1);
    const racks = new Map(
      bots.slice(1).map((b) => [b.id, { won: rackOf(b.won.join("")), starting: rackOf(b.starting.join("")) }]),
    );
    check({ s, actual, racks });
  };

  const play = (b: SimBot) => {
    const held = [...b.won.map((l) => ({ l, won: true })), ...b.starting.map((l) => ({ l, won: false }))];
    if (held.length < 3) return;
    const len = 3 + Math.floor(rand() * Math.min(3, held.length - 2));
    const chosen: string[] = [];
    for (let i = 0; i < len; i++) chosen.push(held.splice(Math.floor(rand() * held.length), 1)[0].l);
    // Fungible tiles: a played letter uses a won copy first, the same
    // choice an observer makes (pool.ts), so the truth is exact.
    for (const l of chosen) {
      const wi = b.won.indexOf(l);
      if (wi >= 0) b.won.splice(wi, 1);
      else b.starting.splice(b.starting.indexOf(l), 1);
    }
    words.push({
      id: nextId++,
      matchId: M,
      botId: b.id,
      word: chosen.join("").toLowerCase(),
      baseScore: 0n,
      bonus: 0n,
      totalReward: 0n,
      // Half the plays share the auction's ms (sims play inside closeAuction).
      playedAt: at(clock + (rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 900))),
    });
  };

  while (bag.length > 0) {
    const letter = bag.shift()!;
    const open = { id: nextId++, letter };
    snapshot(open, false);
    const winner = rand() < 0.2 ? null : pick(bots);
    clock += 1000;
    results.push({
      auctionId: open.id,
      matchId: M,
      letter,
      winnerBotId: winner?.id ?? null,
      paid: 1n,
      closedAt: at(clock),
    });
    if (winner) {
      winner.won.push(letter);
    }
    for (const b of bots) if (rand() < 0.15) play(b);
  }
  snapshot(null, true);
  return bots;
}

test("simulated 6-player match: unseen pool equals the hidden tiles at every step", () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    let steps = 0;
    let last: MatchState | null = null;
    simulate(seed, ({ s, actual }) => {
      steps++;
      const where = `seed ${seed} step ${steps}`;
      const p = unseenPool(s);
      assert.equal(p.inconsistencies, 0, where);
      assert.equal(p.unorderedFallbacks, 0, where);
      // Exact: bag + opponents' unplayed starting tiles, per letter.
      assert.deepEqual(obj(p.unseen), obj(actual), where);
      const c = poolCheck(s, p);
      assert.ok(c.ok, `${where}: ${JSON.stringify(c)}`);
      last = s;
    });
    assert.equal(steps, 98 - 30 + 1, "68 auctions + the end");
    // End: bag empty, unseen is only opponents' still-hidden starting tiles.
    const s = last!;
    assert.equal(s.bagTotal, 0);
    const p = unseenPool(s);
    let hidden = 0;
    for (const r of p.revealedStarting.values()) for (const n of r.values()) hidden -= n;
    hidden += 5 * 5;
    assert.equal(p.total, hidden);
    assert.equal(p.revealedStarting.size, 5);
  }
});

test("simulated match: some words actually reveal opponent starting tiles", () => {
  let revealed = 0;
  simulate(7, ({ s }) => {
    for (const r of unseenPool(s).revealedStarting.values()) for (const n of r.values()) revealed = Math.max(revealed, n);
  });
  assert.ok(revealed > 0);
});

test("simulated 6-player match: opponents' known letters match their true racks", () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    let steps = 0;
    simulate(seed, ({ s, racks }) => {
      steps++;
      const ops = opponentLetters(s);
      assert.equal(ops.size, 5);
      for (const [id, truth] of racks) {
        const where = `seed ${seed} step ${steps} bot ${id}`;
        const o = ops.get(id)!;
        assert.ok(o.ordered, where);
        assert.equal(o.inconsistencies, 0, where);
        let trueSize = 0;
        const trueRack: Rack = new Map(truth.starting);
        for (const [l, n] of truth.won) trueRack.set(l, (trueRack.get(l) ?? 0) + n);
        for (const n of trueRack.values()) trueSize += n;
        // known ⊆ true rack, and the tile count is exact.
        for (const [l, n] of o.known) assert.ok(n <= (trueRack.get(l) ?? 0), `${where} ${l}`);
        assert.equal(o.rackSize, trueSize, where);
        // The sim plays won copies first (the observer's attribution), so
        // known and hidden starting are exact too.
        assert.deepEqual(obj(o.known), obj(truth.won), where);
        let hidden = 0;
        for (const n of truth.starting.values()) hidden += n;
        assert.equal(o.hiddenStarting, hidden, where);
      }
    });
  }
});
