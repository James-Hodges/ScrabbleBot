// Match state (S1-1): one snapshot of everything we know about a match.
//
// This is the shared interface the bidding and play code builds against.
// The core (`buildMatchState`) is pure: it takes plain row data shaped like
// the generated table rows, so it is unit-testable without a server. The
// adapter (`matchStateFromConn`) reads those rows from a DbConnection.
//
// The state is rebuilt from the rows each time it's needed rather than
// patched event by event, so it always agrees with the server's tables.
// A match has at most ~70 auctions, so a rebuild is cheap.
//
// Later stories extend it: S1-2 (unseen-tile pool) and S1-3 (per-opponent
// letters won − played) derive from `auctions` and `words`.

import type { DbConnection } from "./module_bindings/index.js";
import type { Rack } from "./words.js";

// ---- Input rows (structural subsets of the generated row types) ----

export interface MatchRow {
  id: bigint;
  status: { tag: string };
  currentRound: number;
  currentAuctionId?: bigint | null;
  bagTotal: number;
  auctionType: { tag: string };
  auctionDurationMs: bigint;
  startingRackSize: number;
}

export interface ParticipantRow {
  matchId: bigint;
  botId: bigint;
  balance: bigint;
  score: bigint;
}

export interface RackRow {
  matchId: bigint;
  letter: string;
  count: number;
}

export interface AuctionRow {
  id: bigint;
  matchId: bigint;
  letter: string;
  status: { tag: string };
}

export interface AuctionResultRow {
  auctionId: bigint;
  matchId: bigint;
  letter: string;
  winnerBotId?: bigint | null;
  paid: bigint;
  closedAt?: { toMillis(): bigint };
}

export interface WordPlayRow {
  id: bigint;
  matchId: bigint;
  botId: bigint;
  word: string;
  baseScore: bigint;
  bonus: bigint;
  totalReward: bigint;
  playedAt?: { toMillis(): bigint };
}

/** Everything `buildMatchState` reads. Rows for other matches are ignored. */
export interface MatchSnapshot {
  myBotId: bigint;
  match: MatchRow;
  participants: Iterable<ParticipantRow>;
  /** Our own rack rows (the `myRack` view). */
  rack: Iterable<RackRow>;
  auctions?: Iterable<AuctionRow>;
  results?: Iterable<AuctionResultRow>;
  words?: Iterable<WordPlayRow>;
  /** Bot names by id, if known. */
  botNames?: (botId: bigint) => string | undefined;
}

// ---- Output ----

export type MatchStatusTag = "Lobby" | "Running" | "Ended";

export interface PlayerState {
  botId: bigint;
  name?: string;
  /** Public coin balance. */
  balance: number;
  /** Public score. */
  score: number;
  isMe: boolean;
}

/** A closed auction, from `auctionResult`. */
export interface AuctionEvent {
  auctionId: bigint;
  /**
   * 1-based position among this match's closed auctions (by auction id).
   * Equals the auction's round: the server starts `currentRound` at 1 and
   * adds 1 per auction (game.ts `closeAuction`).
   */
  seq: number;
  letter: string;
  /** null when nobody bid (the tile is thrown away). */
  winnerBotId: bigint | null;
  paid: number;
  closedAtMs?: number;
}

/** A word played, from `wordPlay`. */
export interface WordEvent {
  id: bigint;
  botId: bigint;
  word: string;
  baseScore: number;
  bonus: number;
  reward: number;
  playedAtMs?: number;
}

export interface MatchState {
  matchId: bigint;
  myBotId: bigint;
  status: MatchStatusTag;
  round: number;
  /** Tiles left in the bag, as the server reports it. */
  bagTotal: number;
  /**
   * Auctions left in the match, including the currently open one: the
   * meaning `PlayContext.auctionsLeft` in play.ts expects. See
   * `auctionsLeftFrom`.
   */
  auctionsLeft: number;
  /** True when the open auction is the match's last (its letter is worthless). */
  isLastAuction: boolean;
  auctionType: string;
  auctionDurationMs: number;
  startingRackSize: number;
  /** The open auction, if the auction rows include one. */
  openAuction: { auctionId: bigint; letter: string } | null;
  myRack: Rack;
  myBalance: number;
  myScore: number;
  /** Every participant, including us, by bot id. */
  players: Map<bigint, PlayerState>;
  /** Closed auctions, oldest first. */
  auctions: AuctionEvent[];
  /** Words played by anyone, oldest first. */
  words: WordEvent[];
}

/**
 * Auctions left, including the open one.
 *
 * The match lasts exactly as many auctions as there are tiles left after
 * dealing (STRATEGY.md §5). The letter on the open auction has already been
 * drawn, so `bagTotal` counts only the auctions still to come and the open
 * one adds 1. This keeps the `bagTotal + 1` that index.ts used before S1-1.
 * Confirmed in the server's game.ts: `drawLetter` decrements `bagTotal`
 * before the auction is inserted, and `closeAuction` ends the match when
 * the bag is empty, so `bagTotal === 0` on an open auction means it's the last.
 * An ended match has none left.
 */
export function auctionsLeftFrom(status: string, bagTotal: number): number {
  if (status === "Ended") return 0;
  return bagTotal + 1;
}

/** Build the match state from plain rows. Pure. */
export function buildMatchState(s: MatchSnapshot): MatchState {
  const m = s.match;
  const matchId = m.id;
  const status = m.status.tag as MatchStatusTag;

  const players = new Map<bigint, PlayerState>();
  for (const p of s.participants) {
    if (p.matchId !== matchId) continue;
    players.set(p.botId, {
      botId: p.botId,
      name: s.botNames?.(p.botId),
      balance: Number(p.balance),
      score: Number(p.score),
      isMe: p.botId === s.myBotId,
    });
  }
  const me = players.get(s.myBotId);

  const myRack: Rack = new Map();
  for (const r of s.rack) {
    if (r.matchId !== matchId || r.count <= 0) continue;
    myRack.set(r.letter, (myRack.get(r.letter) ?? 0) + r.count);
  }

  let openAuction: MatchState["openAuction"] = null;
  for (const a of s.auctions ?? []) {
    if (a.matchId !== matchId || a.status.tag !== "Open") continue;
    if (!openAuction || a.id > openAuction.auctionId)
      openAuction = { auctionId: a.id, letter: a.letter };
  }

  const results = [...(s.results ?? [])]
    .filter((r) => r.matchId === matchId)
    .sort((a, b) => cmp(a.auctionId, b.auctionId));
  const auctions: AuctionEvent[] = results.map((r, i) => ({
    auctionId: r.auctionId,
    seq: i + 1,
    letter: r.letter,
    winnerBotId: r.winnerBotId ?? null,
    paid: Number(r.paid),
    closedAtMs: r.closedAt ? Number(r.closedAt.toMillis()) : undefined,
  }));

  const words: WordEvent[] = [...(s.words ?? [])]
    .filter((w) => w.matchId === matchId)
    .sort((a, b) => cmp(a.id, b.id))
    .map((w) => ({
      id: w.id,
      botId: w.botId,
      word: w.word,
      baseScore: Number(w.baseScore),
      bonus: Number(w.bonus),
      reward: Number(w.totalReward),
      playedAtMs: w.playedAt ? Number(w.playedAt.toMillis()) : undefined,
    }));

  const auctionsLeft = auctionsLeftFrom(status, m.bagTotal);
  return {
    matchId,
    myBotId: s.myBotId,
    status,
    round: m.currentRound,
    bagTotal: m.bagTotal,
    auctionsLeft,
    isLastAuction: auctionsLeft === 1,
    auctionType: m.auctionType.tag,
    auctionDurationMs: Number(m.auctionDurationMs),
    startingRackSize: m.startingRackSize,
    openAuction,
    myRack,
    myBalance: me?.balance ?? 0,
    myScore: me?.score ?? 0,
    players,
    auctions,
    words,
  };
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Adapter: build the state for one match from the connection's cached
 * tables. Null if the match isn't cached or we aren't in it.
 */
export function matchStateFromConn(
  conn: DbConnection,
  matchId: bigint,
  myBotId: bigint,
): MatchState | null {
  const match = conn.db.matchState.id.find(matchId);
  if (!match) return null;
  const state = buildMatchState({
    myBotId,
    match,
    participants: conn.db.matchParticipant.iter(),
    rack: conn.db.myRack.iter(),
    auctions: conn.db.auction.iter(),
    results: conn.db.auctionResult.iter(),
    words: conn.db.wordPlay.iter(),
    botNames: (id) => conn.db.bot.id.find(id)?.name,
  });
  return state.players.has(myBotId) ? state : null;
}
