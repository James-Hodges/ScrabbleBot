// Opponents' letters (S1-3): what we know about each opponent's rack.
//
// One replay per opponent, shared with the unseen pool (S1-2, pool.ts):
// replay their auction wins and words in time order (auction first on an
// equal ms). Each played letter uses a won-and-unplayed copy first; any
// excess is a revealed starting tile. This relies on bots only playing
// letters they hold, which the server validates. At the end:
//
//   known            = won copies not yet played (certainly in their rack).
//   revealedStarting = starting tiles they have shown in words.
//   hiddenStarting   = startingRackSize − Σ revealedStarting (clamped at 0).
//   rackSize         = Σ known + hiddenStarting (their exact tile count).
//
// Assuming won copies are played first is the tightest safe bound: it
// never claims a starting tile was revealed unless it must have been.
// Without timestamps the replay falls back to the unordered formulas
// known = max(0, won − played), revealed = max(0, played − won) per letter
// (`ordered: false`), which can undercount both.

import type { MatchState } from "./state.js";
import type { Rack } from "./words.js";

/** The parts of `MatchState` the replay reads. */
export type OpponentsInput = Pick<
  MatchState,
  "myBotId" | "players" | "startingRackSize" | "auctions" | "words"
>;

export interface OpponentLetters {
  botId: bigint;
  name?: string;
  balance: number;
  score: number;
  /** Letters won and not yet played: certainly in their rack now. */
  known: Rack;
  /** Starting tiles revealed in their words. */
  revealedStarting: Rack;
  /** Starting tiles never revealed: still in their rack, letters unknown. */
  hiddenStarting: number;
  /** Σ known + hiddenStarting: their current tile count. */
  rackSize: number;
  /** False when timestamps were missing and the unordered fallback was used. */
  ordered: boolean;
  /** Tiles dropped by clamping hiddenStarting at 0. 0 when consistent. */
  inconsistencies: number;
}

export function add(r: Rack, letter: string, n = 1): void {
  if (n === 0) return;
  r.set(letter, (r.get(letter) ?? 0) + n);
}

export function sum(r: Rack): number {
  let s = 0;
  for (const n of r.values()) s += n;
  return s;
}

/** Letters A–Z of a word as a rack (case-insensitive; other chars ignored). */
export function wordLetters(word: string, into: Rack = new Map()): Rack {
  for (const ch of word.toUpperCase()) if (ch >= "A" && ch <= "Z") add(into, ch);
  return into;
}

/** Replay one bot's wins and words. Pure. */
export function replayOpponent(s: OpponentsInput, botId: bigint): OpponentLetters {
  const wins = s.auctions.filter((a) => a.winnerBotId === botId);
  const plays = s.words.filter((w) => w.botId === botId);
  const ordered =
    wins.every((a) => a.closedAtMs !== undefined) &&
    plays.every((w) => w.playedAtMs !== undefined);
  const known: Rack = new Map();
  const revealedStarting: Rack = new Map();

  if (ordered) {
    // Events by time; on a tie the auction comes first (a sim's play in
    // closeAuction shares the result's reducer timestamp).
    type Ev = { ms: number; kind: 0 | 1; seq: number; letters: string };
    const evs: Ev[] = [
      ...wins.map((a, i) => ({ ms: a.closedAtMs!, kind: 0 as const, seq: i, letters: a.letter })),
      ...plays.map((w, i) => ({ ms: w.playedAtMs!, kind: 1 as const, seq: i, letters: w.word })),
    ].sort((a, b) => a.ms - b.ms || a.kind - b.kind || a.seq - b.seq);
    for (const e of evs) {
      if (e.kind === 0) add(known, e.letters);
      else
        for (const [l, n] of wordLetters(e.letters)) {
          const fromWon = Math.min(n, known.get(l) ?? 0);
          if (fromWon) add(known, l, -fromWon);
          add(revealedStarting, l, n - fromWon);
        }
    }
    for (const [l, n] of known) if (n <= 0) known.delete(l);
  } else {
    const won: Rack = new Map();
    for (const a of wins) add(won, a.letter);
    const played: Rack = new Map();
    for (const w of plays) wordLetters(w.word, played);
    for (const l of new Set([...won.keys(), ...played.keys()])) {
      const k = (won.get(l) ?? 0) - (played.get(l) ?? 0);
      if (k > 0) known.set(l, k);
      else if (k < 0) revealedStarting.set(l, -k);
    }
  }

  const rawHidden = s.startingRackSize - sum(revealedStarting);
  const hiddenStarting = Math.max(0, rawHidden);
  const p = s.players.get(botId);
  return {
    botId,
    name: p?.name,
    balance: p?.balance ?? 0,
    score: p?.score ?? 0,
    known,
    revealedStarting,
    hiddenStarting,
    rackSize: sum(known) + hiddenStarting,
    ordered,
    inconsistencies: rawHidden < 0 ? -rawHidden : 0,
  };
}

/**
 * Every opponent's letters, by bot id: all players but us, plus any bot
 * that played a word without a participant row.
 */
export function opponentLetters(s: OpponentsInput): Map<bigint, OpponentLetters> {
  const ids = new Set<bigint>([...s.players.keys(), ...s.words.map((w) => w.botId)]);
  ids.delete(s.myBotId);
  const out = new Map<bigint, OpponentLetters>();
  for (const id of ids) out.set(id, replayOpponent(s, id));
  return out;
}
