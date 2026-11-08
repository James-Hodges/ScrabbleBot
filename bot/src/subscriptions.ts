// S1-7: targeted subscriptions, so the client caches only what the bot
// needs instead of the whole server history (subscribeToAllTables ran out
// of memory at ~3.4 GB once the database held ~1.75M auctions).
//
// Three query sets, added in order:
//
//   base  (on connect)        our credential, bot names, our rack.
//   core  (bot id known)      our matches' states and all their
//                             participants, our lobby memberships and
//                             those lobbies. One row or so per match we've
//                             played, so it grows slowly.
//   live  (after core)        auctions, auction results and word plays of
//                             our matches, newer than a floor timestamp.
//
// Everything is a join on match_participant WHERE bot_id = <us>, so a new
// match's rows (its first auction included) arrive in the same transaction
// as our participant row: no client round trip before we can bid.
//
// The live set is the one that grows (~150 rows per match), so after each
// of our matches ends it is replaced by one whose floor is that match's
// end time; unsubscribing the old set drops the ended match's rows.
//
// The server's subscription SQL can't compare enums (status = 'Running')
// or join on option columns (current_auction_id), hence the timestamp
// floor. Timestamps are compared as ISO strings with microseconds.

export function baseQueries(): string[] {
  return [
    "SELECT * FROM bot_credential WHERE identity = :sender",
    "SELECT * FROM bot",
    "SELECT * FROM my_rack",
  ];
}

export function coreQueries(botId: bigint): string[] {
  const b = botId.toString();
  return [
    `SELECT p.* FROM match_participant p JOIN match_participant q ON p.match_id = q.match_id WHERE q.bot_id = ${b}`,
    `SELECT m.* FROM match_state m JOIN match_participant p ON m.id = p.match_id WHERE p.bot_id = ${b}`,
    `SELECT * FROM lobby_member WHERE bot_id = ${b}`,
    `SELECT l.* FROM lobby l JOIN lobby_member lm ON l.id = lm.lobby_id WHERE lm.bot_id = ${b}`,
  ];
}

export function liveQueries(botId: bigint, sinceMicros: bigint): string[] {
  const b = botId.toString();
  const t = sqlTimestamp(sinceMicros);
  return [
    `SELECT a.* FROM auction a JOIN match_participant p ON a.match_id = p.match_id WHERE p.bot_id = ${b} AND a.closes_at > '${t}'`,
    `SELECT r.* FROM auction_result r JOIN match_participant p ON r.match_id = p.match_id WHERE p.bot_id = ${b} AND r.closed_at > '${t}'`,
    `SELECT w.* FROM word_play w JOIN match_participant p ON w.match_id = p.match_id WHERE p.bot_id = ${b} AND w.played_at > '${t}'`,
  ];
}

/** Microseconds since the epoch as 'YYYY-MM-DDTHH:MM:SS.ffffffZ'. */
export function sqlTimestamp(micros: bigint): string {
  if (micros < 0n) micros = 0n;
  const ms = micros / 1000n;
  const subMs = micros % 1000n;
  const iso = new Date(Number(ms)).toISOString(); // ...SS.mmmZ
  return `${iso.slice(0, -1)}${subMs.toString().padStart(3, "0")}Z`;
}

export type MatchTimes = {
  running: boolean;
  createdAtMicros: bigint;
  startedAtMicros?: bigint;
  endedAtMicros?: bigint;
};

/**
 * Floor for the live set, from server timestamps only (no local clock).
 * With a running match: just before it started, so all of its rows (and
 * its open auction) are included. Otherwise: the latest end of our
 * matches, so none of their rows are included but every later match's are.
 */
export function liveFloorMicros(matches: Iterable<MatchTimes>): bigint {
  let minRunningStart: bigint | undefined;
  let latest = 0n;
  for (const m of matches) {
    if (m.running) {
      const start = m.startedAtMicros ?? m.createdAtMicros;
      if (minRunningStart === undefined || start < minRunningStart) {
        minRunningStart = start;
      }
    } else {
      const end = m.endedAtMicros ?? m.createdAtMicros;
      if (end > latest) latest = end;
    }
  }
  if (minRunningStart !== undefined) return minRunningStart - 1n;
  return latest;
}
