// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
  type SubscriptionHandle,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { auctionTarget, planValues, targetMissing, type PlanTable } from "./target.js";
import { bidModeFrom, decideBid } from "./decide.js";
import type { LambdaResult } from "./lambda.js";
import type { TableType } from "./rivalBids.js";
import { MatchLogs, defaultLogDir, placings, sinceOpen } from "./log.js";
import { choosePlay, minRewardFor } from "./play.js";
import { PlayGuard, playPhase } from "./playGuard.js";
import { WordIndex } from "./words.js";
import { matchStateFromConn } from "./state.js";
import { poolCheck, unseenPool } from "./pool.js";
import {
  baseQueries,
  coreQueries,
  liveFloorMicros,
  liveQueries,
  type MatchTimes,
} from "./subscriptions.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
// S3-4: "lambda" (default on experiment/lambda) or "current" (improved-bot's bidding), for A/B.
const BID_MODE = bidModeFrom(process.env.BID_MODE);
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
// It lives in bot/data/ and is refreshed by `npm run generate`.
const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "data",
  "wordlist.txt",
);
if (!fs.existsSync(dictionaryPath)) {
  // Without the wordlist the bot can never play a word, so fail loudly.
  console.error(`Wordlist not found at ${dictionaryPath}. Run \`npm run generate\`.`);
  process.exit(1);
}
const DICTIONARY: string[] = fs
  .readFileSync(dictionaryPath, "utf8")
  .split("\n")
  .map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2);
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick
const WORD_INDEX = new WordIndex(DICTIONARY);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();

// S0-4 match logs: logs/<bot>-<matchId>-<time>.jsonl at the repo root.
const matchLogs = new MatchLogs(defaultLogDir(), BOT_NAME);
const seenAuctions = new Set<string>();
const startedMatches = new Set<string>();
const endedMatches = new Set<string>();

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inMatch(conn: DbConnection, matchId: bigint): boolean {
  if (myBotId === null) return false;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId === matchId && p.botId === myBotId) return true;
  }
  return false;
}

function participantsSummary(conn: DbConnection, matchId: bigint) {
  const rows = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    rows.push({
      botId: p.botId,
      name: conn.db.bot.id.find(p.botId)?.name,
      me: p.botId === myBotId,
      score: Number(p.score),
      balance: Number(p.balance),
    });
  }
  return placings(rows);
}

function noteMatchStart(conn: DbConnection, matchId: bigint) {
  // Opponents' participant rows come with the live subscription; wait for
  // it so the start log lists everyone (bootstrapActivity catches up).
  if (!liveReady) return;
  const key = String(matchId);
  if (startedMatches.has(key)) return;
  const m = conn.db.matchState.id.find(matchId);
  if (m?.status.tag !== "Running" || !inMatch(conn, matchId)) return;
  startedMatches.add(key);
  matchLogs.log(matchId, "match_start", {
    myBotId,
    bidMode: BID_MODE,
    startedAtMs: m.startedAt ? Number(m.startedAt.toMillis()) : undefined,
    bagTotal: m.bagTotal,
    auctionType: m.auctionType.tag,
    auctionDurationMs: m.auctionDurationMs,
    startingRackSize: m.startingRackSize,
    participants: participantsSummary(conn, matchId),
    rack: Object.fromEntries(rackForMatch(conn, matchId)),
  });
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

// One value table per match, reused while (rack, auctionsLeft, round,
// hasPlayedWord) is unchanged: tryBid can run more than once for the same auction.
const valueCache = new Map<string, { key: string; table: PlanTable }>();

/** Whether we have played a word in this match (the bomb is down). */
function hasPlayedWord(state: NonNullable<ReturnType<typeof matchStateFromConn>>): boolean {
  return state.words.some((w) => w.botId === state.myBotId);
}

function valueTableFor(
  matchId: bigint,
  state: NonNullable<ReturnType<typeof matchStateFromConn>>,
  played: boolean,
): PlanTable {
  const rackKey = [...state.myRack.entries()]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([l, n]) => `${l}${n}`)
    .join("");
  const key = `${rackKey}|${state.auctionsLeft}|${state.round}|${played}`;
  const hit = valueCache.get(String(matchId));
  if (hit && hit.key === key) return hit.table;
  const table = planValues({
    rack: state.myRack,
    pool: unseenPool(state).unseen,
    auctionsLeft: state.auctionsLeft,
    index: WORD_INDEX,
    explain: true,
    hasPlayedWord: played,
  });
  valueCache.set(String(matchId), { key, table });
  return table;
}

// S3-4: the last λ solve per match (decide.ts reuses it while its key is unchanged).
const lambdaCache = new Map<string, { key: string; result: LambdaResult }>();

/** "sim" when a simulated bot is seated in the match, else "real" (rivalBids.ts). */
function tableTypeFor(conn: DbConnection, matchId: bigint): TableType {
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId === matchId && conn.db.bot.id.find(p.botId)?.isSimulated) return "sim";
  }
  return "real";
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
  opensAtMs?: number,
) {
  const seenMs = Date.now();
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const state = matchStateFromConn(conn, matchId, myBotId);
  if (!state) return;
  const rack = state.myRack;
  // decideMs times valuation and the bid decision together (incl. the λ solve in lambda mode).
  const t0 = performance.now();
  // S2-2: letter values. unseenPool already counts the open auction's letter
  // as seen, so poolIncludesLetter stays unset.
  // Bomb rework: values also count long target words, gated by the play phase.
  const played = hasPlayedWord(state);
  const table = valueTableFor(matchId, state, played);
  // The target if we win this letter, when better: the open letter is out of
  // the unseen pool, so table.target alone forgets the tile on the block.
  const { target, source: targetSource } = auctionTarget(table, letter);
  const missing = targetMissing(target, rack);
  // S3-4: BID_MODE picks the λ bid or improved-bot's rawBid + applyBudget (decide.ts).
  const tableType = tableTypeFor(conn, matchId);
  const decision = decideBid({
    mode: BID_MODE,
    letter,
    state,
    table,
    played,
    missing,
    index: WORD_INDEX,
    unseen: BID_MODE === "lambda" ? unseenPool(state).unseen : new Map(),
    tableType,
    lambdaCache: lambdaCache.get(String(matchId)) ?? null,
  });
  if (decision.lambdaCache) lambdaCache.set(String(matchId), decision.lambdaCache);
  const amount = decision.amount;
  const decideMs = performance.now() - t0;
  const sendMs = Date.now();
  if (amount > 0) {
    conn.reducers
      .submitBid({ auctionId, amount: BigInt(amount) })
      .catch((err: unknown) => {
        logFailure(`bid on auction ${auctionId}`)(err);
        matchLogs.log(matchId, "bid_error", {
          auctionId,
          letter,
          amount,
          error: errMsg(err),
          ...sinceOpen(Date.now(), opensAtMs, seenMs),
        });
      });
    bidsByAuction.add(key);
  }
  // Log after sending so the file write never delays the bid.
  if (!seenAuctions.has(key)) {
    seenAuctions.add(key);
    noteMatchStart(conn, matchId);
    const pool = poolCheck(state);
    matchLogs.log(matchId, "auction_seen", {
      auctionId,
      letter,
      round: state.round,
      bagTotal: state.bagTotal,
      opensAtMs,
      seenMs,
      recvLagMs: opensAtMs !== undefined ? seenMs - opensAtMs : undefined,
      unseenTotal: pool.unseenTotal,
      unseenExpected: pool.unseenExpected,
    });
  }
  matchLogs.log(matchId, amount > 0 ? "bid_sent" : "bid_skipped", {
    auctionId,
    letter,
    amount,
    ...decision.fields,
    balance: state.myBalance,
    rack: Object.fromEntries(rack),
    playPhase: table.phase,
    target: target?.word,
    targetReward: target?.reward,
    targetMissing: missing || undefined,
    targetProb: target ? Math.round(target.prob * 1000) / 1000 : undefined,
    targetSource: target ? targetSource : undefined,
    valueFloor: table.floor,
    decideMs: Math.round(decideMs * 1000) / 1000,
    ...sinceOpen(sendMs, opensAtMs, seenMs),
  });
  if (amount <= 0) return;
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`,
  );
}

// Per-match play guard (playGuard.ts): re-decide only when the rack or the
// play phase changes, and never while our own words are in flight.
const playGuards = new Map<string, PlayGuard>();

// Runs on our rack changes, on every round of our running matches, and on
// our participant-row updates, so the bomb deadline and the endgame dump fire
// even when the rack hasn't changed. Balance is no longer a play input.
function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches: bigint[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") matches.push(p.matchId);
  }
  for (const matchId of matches) {
    const key = String(matchId);
    const guard = playGuards.get(key) ?? new PlayGuard();
    playGuards.set(key, guard);
    const state = matchStateFromConn(conn, matchId, myBotId);
    if (!state) continue;
    const rack = state.myRack;
    const played = hasPlayedWord(state);
    const phase = playPhase(state.auctionsLeft, played);
    if (!guard.shouldEvaluate(rack, phase)) continue;
    const words = choosePlay({
      rack,
      auctionsLeft: state.auctionsLeft,
      hasPlayedWord: played,
      index: WORD_INDEX,
    });
    guard.record(rack, phase, words);
    if (words.length > 0) {
      matchLogs.log(matchId, "play_chosen", {
        words,
        playPhase: phase,
        minReward: minRewardFor(phase),
        auctionsLeft: state.auctionsLeft,
        balance: state.myBalance,
      });
    }
    for (const word of words) {
      console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
      conn.reducers
        .submitWord({ matchId, word })
        .catch((err: unknown) => {
          logFailure(`playing '${word}'`)(err);
          matchLogs.log(matchId, "word_rejected", { word, error: errMsg(err) });
        });
    }
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  const subscribeStart = Date.now();
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(
        `[${BOT_NAME}] subscription applied (${Date.now() - subscribeStart} ms, ${rssMb()} MB rss)`,
      );

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            subscribeToOurMatches(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      subscribeToOurMatches(conn);
    })
    .onError(subscriptionError("base"))
    .subscribe(baseQueries());

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open")
      tryBid(conn, a.id, a.matchId, a.letter, Number(a.opensAt.toMillis()));
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    // We only subscribe to our own matches, but keep the check in case a
    // subscription ever returns more.
    if (!inMatch(conn, r.matchId)) return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
    const winnerBotId = r.winnerBotId ?? null;
    matchLogs.log(r.matchId, "auction_result", {
      auctionId: r.auctionId,
      letter: r.letter,
      winnerBotId,
      won: winnerBotId !== null && winnerBotId === myBotId,
      weBid: bidsByAuction.has(`${r.matchId}:${r.auctionId}`),
      paid: r.paid,
      closedAtMs: Number(r.closedAt.toMillis()),
    });
  });
  conn.db.wordPlay.onInsert((_ctx, w) => {
    if (!inMatch(conn, w.matchId)) return;
    matchLogs.log(w.matchId, "word_played", {
      botId: w.botId,
      mine: w.botId === myBotId,
      word: w.word,
      baseScore: w.baseScore,
      bonus: w.bonus,
      reward: w.totalReward,
    });
  });
  conn.db.matchState.onInsert((_ctx, m) => noteMatchStart(conn, m.id));
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (p.botId === myBotId) noteMatchStart(conn, p.matchId);
  });
  // Our participant row changed (balance, score): cheap to re-check; the guard skips unchanged phases.
  conn.db.matchParticipant.onUpdate((_ctx, _old, p) => {
    if (p.botId === myBotId) tryPlayWord(conn);
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (neu.status.tag === "Running") {
      noteMatchStart(conn, neu.id);
      // Round advance: may enter the endgame with an unchanged rack.
      if (inMatch(conn, neu.id)) tryPlayWord(conn);
    }
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn && !endedMatches.has(String(neu.id))) {
        endedMatches.add(String(neu.id));
        const standings = participantsSummary(conn, neu.id);
        matchLogs.log(neu.id, "match_end", {
          endedAtMs: neu.endedAt ? Number(neu.endedAt.toMillis()) : undefined,
          rounds: neu.currentRound,
          myPlace: standings.find((s) => s.me)?.place,
          standings,
          rackLeft: Object.fromEntries(rackForMatch(conn, neu.id)),
        });
        matchLogs.close(neu.id);
      }
      if (wasIn) {
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
        // Drop the ended match's auctions, results and words from the cache.
        subscribeLive(conn);
      }
    }
  });
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1e6);
}

function subscriptionError(what: string) {
  return (_ctx: ErrorContext, err?: Error) =>
    console.error(
      `[${BOT_NAME}] ${what} subscription failed: ${err?.message ?? "unknown error"}`,
    );
}

// S1-7: after the bot id is known, subscribe to our matches only (see
// subscriptions.ts): first the core set (our match states, their
// participants, our lobbies), then the live set (auctions, results, words)
// with a floor computed from those match states. Start playing once both
// are applied.
let coreSubscribed = false;
function subscribeToOurMatches(conn: DbConnection) {
  if (myBotId === null || coreSubscribed) return;
  coreSubscribed = true;
  const start = Date.now();
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(
        `[${BOT_NAME}] match subscription applied (${Date.now() - start} ms, ${rssMb()} MB rss)`,
      );
      subscribeLive(conn, () => {
        console.log(
          `[${BOT_NAME}] live subscription applied (${Date.now() - start} ms, ${rssMb()} MB rss)`,
        );
        liveReady = true;
        bootstrapActivity(conn);
      });
    })
    .onError(subscriptionError("match"))
    .subscribe(coreQueries(myBotId));
}

function ourMatchTimes(conn: DbConnection): MatchTimes[] {
  const out: MatchTimes[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (!m) continue;
    out.push({
      running: m.status.tag === "Running",
      createdAtMicros: m.createdAt.microsSinceUnixEpoch,
      startedAtMicros: m.startedAt?.microsSinceUnixEpoch,
      endedAtMicros: m.endedAt?.microsSinceUnixEpoch,
    });
  }
  return out;
}

// The live set is replaced after each of our matches ends. The new set is
// subscribed first and the old one dropped once the new one is applied, so
// there's no gap; rows in both are reference-counted by the SDK and don't
// fire onInsert again.
let liveHandle: SubscriptionHandle | null = null;
let liveReady = false;
function subscribeLive(conn: DbConnection, onReady?: () => void) {
  if (myBotId === null) return;
  const prev = liveHandle;
  const floor = liveFloorMicros(ourMatchTimes(conn));
  const handle: SubscriptionHandle = conn
    .subscriptionBuilder()
    .onApplied(() => {
      if (prev?.isActive()) prev.unsubscribe();
      // Superseded by a newer live set while this one was being applied.
      if (liveHandle !== handle && handle.isActive()) handle.unsubscribe();
      onReady?.();
    })
    .onError(subscriptionError("live"))
    .subscribe(liveQueries(myBotId, floor));
  liveHandle = handle;
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId === myBotId) noteMatchStart(conn, p.matchId);
  }
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open")
      tryBid(conn, a.id, a.matchId, a.letter, Number(a.opensAt.toMillis()));
  }
  tryPlayWord(conn);
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST} (BID_MODE=${BID_MODE})`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => {
      console.log("disconnected");
      matchLogs.closeAll();
    })
    .build();
}

main();
