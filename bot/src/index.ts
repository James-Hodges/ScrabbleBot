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
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { decideBid } from "./strategy.js";
import { MatchLogs, defaultLogDir, placings, sinceOpen } from "./log.js";
import { choosePlay } from "./play.js";
import { WordIndex } from "./words.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
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
  const key = String(matchId);
  if (startedMatches.has(key)) return;
  const m = conn.db.matchState.id.find(matchId);
  if (m?.status.tag !== "Running" || !inMatch(conn, matchId)) return;
  startedMatches.add(key);
  matchLogs.log(matchId, "match_start", {
    myBotId,
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

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
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
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const match = conn.db.matchState.id.find(matchId);
  const rack = rackForMatch(conn, matchId);
  const t0 = performance.now();
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rack,
  });
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
    matchLogs.log(matchId, "auction_seen", {
      auctionId,
      letter,
      round: match?.currentRound,
      bagTotal: match?.bagTotal,
      opensAtMs,
      seenMs,
      recvLagMs: opensAtMs !== undefined ? seenMs - opensAtMs : undefined,
    });
  }
  matchLogs.log(matchId, amount > 0 ? "bid_sent" : "bid_skipped", {
    auctionId,
    letter,
    amount,
    balance: participant.balance,
    rack: Object.fromEntries(rack),
    decideMs: Math.round(decideMs * 1000) / 1000,
    ...sinceOpen(sendMs, opensAtMs, seenMs),
  });
  if (amount <= 0) return;
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`,
  );
}

// Rack states (per match) we've already submitted words for, including the
// in-between states our own multi-word plays pass through, so the rack
// updates those plays cause don't resubmit the same words.
const playedRackStates = new Map<string, Set<string>>();

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches = new Map<bigint, number>(); // matchId -> bagTotal
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") matches.set(p.matchId, Number(m.bagTotal));
  }
  const rackKey = (r: Map<string, number>) =>
    [...r].filter(([, n]) => n > 0).map(([c, n]) => c + n).sort().join("");
  for (const [matchId, bagTotal] of matches) {
    const key = String(matchId);
    const seen = playedRackStates.get(key) ?? new Set<string>();
    playedRackStates.set(key, seen);
    const rack = rackForMatch(conn, matchId);
    if (seen.has(rackKey(rack))) continue;
    const participant = participantForMatch(conn, matchId);
    if (!participant) continue;
    const words = choosePlay({
      rack,
      balance: participant.balance,
      auctionsLeft: bagTotal + 1,
      index: WORD_INDEX,
    });
    if (words.length === 0) continue;
    const left = new Map(rack);
    for (const word of words) {
      seen.add(rackKey(left));
      for (const c of word) left.set(c, (left.get(c) ?? 0) - 1);
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

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

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
            bootstrapActivity(conn);
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
      bootstrapActivity(conn);
    })
    .subscribeToAllTables();

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
    // We subscribe to every table, so this fires for every match on the
    // server. Only print and log our own matches.
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

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (neu.status.tag === "Running") noteMatchStart(conn, neu.id);
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
      }
    }
  });
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
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
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
