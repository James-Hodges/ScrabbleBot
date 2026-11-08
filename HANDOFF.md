# Handoffs

Work that one of us built and the other needs to pick up. Delete an entry once it's closed.

## S1-1: Match state (ooVrq → James)

**Status:** code pushed, `npm test` 31/31 and `npx tsc --noEmit` clean. Not yet run live. You can do the live check in the same match as S0-4's.

- **New `bot/src/state.ts`:** this is the shared interface for word and bid code. Call `matchStateFromConn(conn, matchId, myBotId)` and you get a `MatchState` with:
  - `myRack`, `myBalance`, `myScore`;
  - `players` (each bot's public balance and score);
  - `round`, `bagTotal`, `auctionsLeft` and `isLastAuction`;
  - `auctions` (closed auctions with winner and price paid) and `words` (every word played).

  The core, `buildMatchState`, is pure and takes plain rows, so you can test against it without a server.
- **`auctionsLeft = bagTotal + 1`,** which includes the open auction. That's the same meaning `play.ts` already used. I checked it against the server's `game.ts`: `drawLetter` decrements `bagTotal` before the auction opens. `isLastAuction` (`bagTotal === 0` while an auction is open) is the hook for S2-5.
- **`index.ts`:** `tryBid` and `tryPlayWord` now read from the state, and `participantForMatch` is gone. Logging and the subscription code are unchanged.
- **Live check:** the bot bids and plays as before. In the log, the first `auction_seen` of a 6-player match shows `round: 1, bagTotal: 67`.

## S0-4: Match logging with bid timing (ooVrq → James)

**Status:** code pushed (`5c22098`, rebased onto S1-4), `npm test` 17/17 and `npx tsc --noEmit` clean. **Not yet run live**, since James runs the bot. S0-4 stays unticked on the sprint board until the live check below passes.

### What changed

- `bot/src/log.ts` (new): writes one JSONL file per match to `logs/<bot>-<matchId>-<YYYYMMDDTHHMMSSZ>.jsonl` at the repo root (git-ignored; `LOG_DIR` overrides). Writes are synchronous, happen **after** the bid is sent, and never throw: on an I/O error it warns once and stops logging that match.
- `bot/src/index.ts`: logs each event. `strategy.ts` is unchanged.
- `bot/src/log.test.ts` (new); `npm test` now runs it too.

### Events

Every line starts with `{t, ms, event, matchId}`.

| Event | Key fields |
|---|---|
| `match_start` | bagTotal, auctionType, auctionDurationMs, participants, rack |
| `auction_seen` | auctionId, letter, round, bagTotal, opensAtMs, seenMs, recvLagMs |
| `bid_sent` / `bid_skipped` | letter, amount, balance, rack, **decideMs**, **sinceOpenMs**, openBasis |
| `bid_error` | auctionId, letter, amount, error, sinceOpenMs |
| `auction_result` | letter, winnerBotId, won, weBid, paid |
| `word_played` | botId, mine, word, baseScore, bonus, reward (every bot's words) |
| `word_rejected` | word, error |
| `match_end` | myPlace, standings (name, score, balance, place), rackLeft |

### Timing fields (for deciding on B-7)

- `decideMs`: time spent in `decideBid`.
- `recvLagMs`: when we first saw the auction minus the server's `opensAt`.
- `sinceOpenMs`: when we sent the bid minus the server's `opensAt` (`openBasis: "server"`).

`sinceOpenMs` and `recvLagMs` compare the server's clock with ours, so any clock offset is included (they can even be negative). If `sinceOpenMs` is high but `decideMs` is small, the delay is network or clock, not our code.

### Live check for James

1. `git pull`, then from `bot/`: `BOT_NAME=main npm start`. Play one full match.
2. A new file should appear in `logs/`. Check it with:

   ```bash
   # every event type appears
   grep -o '"event":"[a-z_]*"' logs/*.jsonl | sort | uniq -c
   # slowest decisions and latest bids
   grep '"bid_sent"' logs/*.jsonl | grep -o '"decideMs":[0-9.]*' | sort -t: -k2 -n | tail -3
   grep '"bid_sent"' logs/*.jsonl | grep -o '"sinceOpenMs":-\?[0-9]*' | sort -t: -k2 -n | tail -3
   # missed auctions or rejected words
   grep -E '"bid_error"|"word_rejected"' logs/*.jsonl | head
   ```

3. **Pass:** the bot plays and rejoins the lobby as before. The log has `match_start`, `auction_seen`, `bid_sent`, `auction_result`, `word_played` and one `match_end` with our place. Then tick S0-4 on the board and delete this entry.
4. **B-7 trigger** (PLAN.md, over 10+ matches): `decideMs` > ~100, `sinceOpenMs` > ~300, or any "Auction closed" / "window expired" errors.

### Known limits

- `match_end` comes from the `matchState` update to `Ended`. If the bot disconnects before then, the file has no `match_end` line.
- Each event checks whether we're in the match by scanning all `matchParticipant` rows, the same way the starter already does at match end. If `decideMs` looks fine but the bot feels sluggish, this is the first place to look.
