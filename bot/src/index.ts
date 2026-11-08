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
import { rawBid as decideRawBid, completesTarget, nearTarget, playedLongWord } from "./bid.js";
import { letterValues, type ValueTable } from "./value.js";
import { applyBudget } from "./budget.js";
import { MatchLogs, defaultLogDir, placings, sinceOpen } from "./log.js";
import {
  budgetHighValue,
  highValueBid,
  highValuePlan,
  playFor,
  strategyFromEnv,
  targetSummary,
} from "./highValue.js";
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
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
// Experiment switch (highValue.ts): STRATEGY=highvalue (default on this
// branch) or STRATEGY=main for main's bid formula and play policy.
const STRATEGY = strategyFromEnv(process.env.STRATEGY);
const choosePlay = playFor(STRATEGY);

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
    strategy: STRATEGY,
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

// One ValueTable per match, reused while (rack, auctionsLeft, round) is
// unchanged: tryBid can run more than once for the same auction.
const valueCache = new Map<string, { key: string; table: ValueTable }>();

function valueTableFor(
  matchId: bigint,
  state: NonNullable<ReturnType<typeof matchStateFromConn>>,
): ValueTable {
  const rackKey = [...state.myRack.entries()]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([l, n]) => `${l}${n}`)
    .join("");
  const key = `${rackKey}|${state.auctionsLeft}|${state.round}`;
  const hit = valueCache.get(String(matchId));
  if (hit && hit.key === key) return hit.table;
  const table = letterValues({
    rack: state.myRack,
    pool: unseenPool(state).unseen,
    auctionsLeft: state.auctionsLeft,
    index: WORD_INDEX,
    explain: true,
  });
  valueCache.set(String(matchId), { key, table });
  return table;
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
  if (STRATEGY === "highvalue") {
    tryBidHighValue(conn, { auctionId, matchId, letter, state, key, seenMs, opensAtMs });
    return;
  }
  // decideMs times valuation, the bid formula and applyBudget together (the whole decision).
  const t0 = performance.now();
  // S2-2: letter values. unseenPool already counts the open auction's letter
  // as seen, so poolIncludesLetter stays unset.
  const table = valueTableFor(matchId, state);
  // S2-3: min(value ceiling, market cap).
  const bid = decideRawBid({
    letter,
    values: table,
    balance: state.myBalance,
    auctionsLeft: state.auctionsLeft,
    round: state.round,
    completesWord: completesTarget(table, rack, letter),
    // S2-6: early boost until our first 5+ letter word.
    haveLongWord: playedLongWord(state.words, myBotId),
    nearTarget: nearTarget(table, rack, letter),
  });
  const rawBid = bid.amount;
  // S2-4/S2-5: spend-down pace and never bidding on the last auction.
  const { amount, reason: budgetReason } = applyBudget(rawBid, { ...state, letter });
  const decideMs = performance.now() - t0;
  sendAndLog(conn, { auctionId, matchId, letter, state, key, seenMs, opensAtMs }, amount, {
    strategy: STRATEGY,
    rawBid,
    budgetReason,
    value: Math.round(bid.value * 100) / 100,
    ceiling: Math.round(bid.ceiling * 100) / 100,
    marketCap: bid.marketCap,
    marketPct: bid.pct,
    bidReason: bid.reason,
    boost: bid.boost,
    boostReason: bid.boostReason,
    decideMs: Math.round(decideMs * 1000) / 1000,
  });
}

interface BidTarget {
  auctionId: bigint;
  matchId: bigint;
  letter: string;
  state: NonNullable<ReturnType<typeof matchStateFromConn>>;
  key: string;
  seenMs: number;
  opensAtMs?: number;
}

// v2: committed target words per match (highValue.ts commitTargets), passed
// back each decision so targets stay stable between auctions.
const committedByMatch = new Map<string, string[]>();

// Experiment: premium letters, big words (highValue.ts).
function tryBidHighValue(conn: DbConnection, b: BidTarget) {
  const { state, letter } = b;
  const t0 = performance.now();
  const bid = highValueBid({
    letter,
    rack: state.myRack,
    pool: unseenPool(state).unseen,
    balance: state.myBalance,
    auctionsLeft: state.auctionsLeft,
    round: state.round,
    isLastAuction: state.isLastAuction,
    index: WORD_INDEX,
    committed: committedByMatch.get(String(b.matchId)),
  });
  if (bid.committed) committedByMatch.set(String(b.matchId), bid.committed.map((t) => t.word));
  // S2-4/S2-5 still apply; budgetHighValue keeps spend-down out of the reserve.
  const { amount, budgetReason, clampedToReserve } = budgetHighValue(bid, { ...state, letter });
  const decideMs = performance.now() - t0;
  sendAndLog(conn, b, amount, {
    strategy: STRATEGY,
    rawBid: bid.amount,
    budgetReason,
    bidReason: bid.reason,
    bidDetail: bid.detail,
    target: bid.target?.word,
    targetReward: bid.target?.reward,
    targetMissing: bid.target?.missing,
    gain: bid.gain !== undefined ? Math.round(bid.gain * 100) / 100 : undefined,
    reserve: bid.reserve,
    clampedToReserve,
    committed: targetSummary(bid.committed),
    servesTarget: bid.served ? bid.served.length > 0 : undefined,
    servedTargets: bid.served,
    decideMs: Math.round(decideMs * 1000) / 1000,
  });
}

// Send the bid (if any), then log auction_seen once and bid_sent/bid_skipped.
function sendAndLog(
  conn: DbConnection,
  b: BidTarget,
  amount: number,
  fields: Record<string, unknown>,
) {
  const { auctionId, matchId, letter, state, key, seenMs, opensAtMs } = b;
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
    ...fields,
    balance: state.myBalance,
    rack: Object.fromEntries(state.myRack),
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
// our balance changes, so the endgame dump and the refill fire even when the
// rack hasn't changed.
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
    const basePhase = playPhase(state.auctionsLeft, state.myBalance);
    // highvalue v2 also depends on auctionsLeft and the unseen pool (waiting,
    // refill protection), so it re-decides every auction outside the endgame.
    const phase =
      STRATEGY === "highvalue" && basePhase !== "endgame" ? `${basePhase}:${state.auctionsLeft}` : basePhase;
    if (!guard.shouldEvaluate(rack, phase)) continue;
    let words: string[];
    if (STRATEGY === "highvalue") {
      const plan = highValuePlan({
        rack,
        balance: state.myBalance,
        auctionsLeft: state.auctionsLeft,
        index: WORD_INDEX,
        pool: unseenPool(state).unseen,
        committed: committedByMatch.get(key),
      });
      words = plan.words;
      if (plan.committed.length > 0) committedByMatch.set(key, plan.committed.map((t) => t.word));
      if (words.length > 0 || plan.waited) {
        matchLogs.log(matchId, "play_decision", {
          words,
          waited: plan.waited !== undefined,
          waitedWord: plan.waited?.word,
          waitedReward: plan.waited?.reward,
          waitFor: plan.waited?.longer,
          waitForReward: plan.waited?.longerReward,
          waitForMissing: plan.waited?.missing,
          waitForP: plan.waited ? Math.round(plan.waited.p * 1000) / 1000 : undefined,
          protectedLetters: plan.protectedLetters || undefined,
          committed: targetSummary(plan.committed),
          balance: state.myBalance,
          auctionsLeft: state.auctionsLeft,
          rack: Object.fromEntries(rack),
        });
      }
    } else {
      words = choosePlay({
        rack,
        balance: state.myBalance,
        auctionsLeft: state.auctionsLeft,
        index: WORD_INDEX,
      });
    }
    guard.record(rack, phase, words);
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
  // Our balance changed: may cross into or out of the refill phase.
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
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST} (strategy ${STRATEGY})`);
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
