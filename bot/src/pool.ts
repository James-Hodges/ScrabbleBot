// Unseen-tile pool (S1-2): which tiles we haven't seen yet in a match.
//
// Definition (each physical tile counted at most once):
//
//   tileSet  = the server's starting bag (TILE_SET below, 98 tiles).
//   seen     = (1) every auctioned letter: all closed auctions, sold or
//                  thrown away, plus the open auction's letter. This
//                  includes letters we won.
//            + (2) our starting tiles, per letter:
//                  (myRack + letters in our played words) − letters we won.
//            + (3) each opponent's revealed starting tiles: replay their
//                  auction wins and words in time order (auction first on a
//                  tie); each played letter uses a won-and-unplayed copy
//                  first, and any excess is a revealed starting tile. This is
//                  the tightest safe lower bound on what they were dealt. It
//                  relies on bots only playing letters they hold, which the
//                  server validates. Without timestamps it falls back to
//                  max(0, played − won) per letter (counted in
//                  `unorderedFallbacks`).
//   unseen   = tileSet − seen, per letter, clamped at 0.
//
// A clamp means the inputs disagree with the tile set (e.g. a row update
// arrived out of order). It's reported in `inconsistencies`, not hidden.
//
// Invariant: the unseen tiles are exactly the bag plus the opponents'
// still-hidden starting tiles, so with consistent inputs
//   total unseen === bagTotal + Σ opponents (startingRackSize − revealed).
// `poolCheck` returns both numbers so a live match can compare them.
//
// The replay in (3) is shared with S1-3 (opponents.ts `opponentLetters`).

import { add, opponentLetters, sum, wordLetters } from "./opponents.js";
import type { MatchState } from "./state.js";
import type { Rack } from "./words.js";

/**
 * The server's starting bag: standard Scrabble distribution, no blanks,
 * 98 tiles. Source: clockworklabs/scrabblebot spacetimedb/src/letters.ts
 * `DEFAULT_BAG` (used by game.ts to fill `bagLetter` and set `bagTotal`).
 */
export const TILE_SET: ReadonlyMap<string, number> = new Map([
  ["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3],
  ["H", 2], ["I", 9], ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6],
  ["O", 8], ["P", 2], ["Q", 1], ["R", 6], ["S", 4], ["T", 6], ["U", 4],
  ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1],
]);
export const TILE_SET_SIZE = 98;

/** The parts of `MatchState` the pool reads. */
export type PoolInput = Pick<
  MatchState,
  | "myBotId"
  | "myRack"
  | "players"
  | "startingRackSize"
  | "bagTotal"
  | "openAuction"
  | "auctions"
  | "words"
>;

export interface UnseenPool {
  /** Unseen tiles per letter (letters with 0 are omitted). */
  unseen: Rack;
  /** Σ unseen. */
  total: number;
  /** Every auctioned letter, closed and open (seen part 1). */
  auctioned: Rack;
  /** Our starting tiles as reconstructed (seen part 2). */
  myStarting: Rack;
  /** Per opponent: revealed starting tiles (seen part 3). Every opponent has an entry. */
  revealedStarting: Map<bigint, Rack>;
  /**
   * Tiles dropped by clamping at 0, summed over letters: unseen clamps,
   * plus negative "our starting" counts. 0 when the inputs are consistent.
   */
  inconsistencies: number;
  /** Opponents whose events lacked timestamps, so the unordered formula was used. */
  unorderedFallbacks: number;
}

export interface PoolCheck {
  /** Σ unseen. */
  unseenTotal: number;
  /** bagTotal + Σ opponents (startingRackSize − revealed starting count). */
  unseenExpected: number;
  ok: boolean;
}

/** Build the unseen-tile pool from a match state. Pure. */
export function unseenPool(s: PoolInput): UnseenPool {
  let inconsistencies = 0;

  // (1) Auctioned letters, and who won each.
  const auctioned: Rack = new Map();
  const won = new Map<bigint, Rack>();
  const closedIds = new Set<bigint>();
  for (const a of s.auctions) {
    closedIds.add(a.auctionId);
    add(auctioned, a.letter);
    if (a.winnerBotId !== null) {
      let w = won.get(a.winnerBotId);
      if (!w) won.set(a.winnerBotId, (w = new Map()));
      add(w, a.letter);
    }
  }
  if (s.openAuction && !closedIds.has(s.openAuction.auctionId))
    add(auctioned, s.openAuction.letter);

  // Letters each bot has played.
  const played = new Map<bigint, Rack>();
  for (const w of s.words) {
    let p = played.get(w.botId);
    if (!p) played.set(w.botId, (p = new Map()));
    wordLetters(w.word, p);
  }

  // (2) Our starting tiles: (rack + played) − won.
  const myWon = won.get(s.myBotId) ?? new Map<string, number>();
  const myHeld: Rack = new Map(s.myRack);
  for (const [l, n] of played.get(s.myBotId) ?? []) add(myHeld, l, n);
  const myStarting: Rack = new Map();
  for (const l of new Set([...myHeld.keys(), ...myWon.keys()])) {
    const n = (myHeld.get(l) ?? 0) - (myWon.get(l) ?? 0);
    if (n > 0) myStarting.set(l, n);
    else if (n < 0) inconsistencies += -n;
  }

  // (3) Opponents' revealed starting tiles: the shared replay (opponents.ts).
  const revealedStarting = new Map<bigint, Rack>();
  let unorderedFallbacks = 0;
  for (const [id, o] of opponentLetters(s)) {
    revealedStarting.set(id, o.revealedStarting);
    if (!o.ordered) unorderedFallbacks++;
  }

  // unseen = tileSet − seen, clamped at 0.
  const seen: Rack = new Map(auctioned);
  for (const [l, n] of myStarting) add(seen, l, n);
  for (const r of revealedStarting.values()) for (const [l, n] of r) add(seen, l, n);
  const unseen: Rack = new Map();
  for (const l of new Set([...TILE_SET.keys(), ...seen.keys()])) {
    const n = (TILE_SET.get(l) ?? 0) - (seen.get(l) ?? 0);
    if (n > 0) unseen.set(l, n);
    else if (n < 0) inconsistencies += -n;
  }

  return {
    unseen,
    total: sum(unseen),
    auctioned,
    myStarting,
    revealedStarting,
    inconsistencies,
    unorderedFallbacks,
  };
}

/** The invariant check: unseen total vs. bag + opponents' hidden starting tiles. */
export function poolCheck(s: PoolInput, pool: UnseenPool = unseenPool(s)): PoolCheck {
  let unseenExpected = s.bagTotal;
  for (const r of pool.revealedStarting.values())
    unseenExpected += s.startingRackSize - sum(r);
  return {
    unseenTotal: pool.total,
    unseenExpected,
    ok: pool.total === unseenExpected && pool.inconsistencies === 0,
  };
}
