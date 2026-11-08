# ScrabbleBot Delivery Plan

An agile plan to get a competitive bot playing live today. It builds on [STRATEGY.md](STRATEGY.md) (rules and game theory) and [ANALYSIS.md](ANALYSIS.md) (what the current meta does).

## Goal

**Ship a bot that finishes in the top two of a six-real-bot lobby more often than not**, then keep improving it until the tournament.

We get there by doing what the leaders (LUCENT, Bron) do, plus what they still miss:

- Buy lots of tiles at fair prices.
- Hold letters for 7+ letter words.
- Spend every coin before the end.
- Skip the last auction.

## Team and time

- **Team:** James and ooVrq. Owners below are suggestions; swap freely at standups.
- **Time box:** about 4 hours of build time, split into four short sprints plus a buffer. Shift the clock times if we start later.
- **Language:** TypeScript, starting from the official `bot-starter/` kit, so the SDK bindings and connection code already work.

## How we work

- **Standup at each sprint boundary (5 min):** what's done, what's blocked, and re-split the next sprint's stories.
- **Small commits to `main`, pushed often.** No long-lived branches today. Pull before starting a story.
- **Ship working code each sprint.** At the end of every sprint the bot must still connect and play a full match without crashing.
- **Measure, don't guess.** Each sprint after the first ends with at least one live match, compared with the benchmarks below.

### Working with Claude

Each of us runs **one main Claude session** for the whole day. The main session coordinates; **subagents do the work**, one per story. This keeps the main session's context small, so it stays sharp for hours instead of filling up with code, test output and query results.

**The main session:**

- **Reads the plan and picks the next story** from the sprint board below.
- **Starts one subagent per story** with a complete brief (see the template below). It doesn't write the story's code itself.
- **Reviews what comes back:** reads the diff, runs `npm test` in `bot/`, and checks the acceptance criteria.
- **Commits and pushes**, then ticks the story on the board. Only the main session commits; subagents never commit or push.
- **Keeps its own context lean.** Big outputs (match logs, SQL results, long test runs) stay in subagents, which report back a short summary.

**Running subagents in parallel:** only for stories whose files don't overlap; see the ownership table under [Parallel work](#parallel-work). Stories touching the same files run one after another.

**Coordinating between our two sessions** goes through git, not chat:

1. `git pull` before starting a story.
2. Claim it on the sprint board (put your name in the Owner column), commit and push the claim, so the other session doesn't start it too.
3. Push as soon as the story is done, then tick it.

**Subagent brief template** (copy into each subagent's prompt):

```
Story: <ID and title from PLAN.md>
Acceptance criteria: <copied from PLAN.md>
Files you own: <paths>. Don't edit other files; if you need to, stop and say why.
Interfaces to use: <e.g. the GameState type in bot/src/state.ts>
Context: read STRATEGY.md and ANALYSIS.md sections <x> if needed.
Done means: code written, `npm test` passes in bot/, `npx tsc --noEmit` is clean.
Do not commit or push.
Report back in under 200 words: what you changed (files), test results,
anything unfinished or any decision the main session should make.
```

### Definition of done (every story)

- [ ] Code is committed and pushed to `main`.
- [ ] The bot still runs a full lobby match end to end.
- [ ] Anything with logic (scoring, valuation, word search) has a unit test or a logged check.
- [ ] Any new rule or number is noted in STRATEGY.md or ANALYSIS.md if it changes our understanding.

## Benchmarks

Taken from ANALYSIS.md: first-place averages in recent real-bot matches, and the leading bots' numbers.

| Metric | First-place average | LUCENT / Bron | Our target |
|---|---|---|---|
| Average place | – | 1.76 / 1.86 | ≤ 2.0 |
| Score per match | 161 | 151 / 144 | ≥ 160 |
| Tiles won per match | 24.4 | 23.3 / 23.8 | ≥ 24 |
| Coins per tile | 9.2 | 9.5 / 8.1 | ≤ 10 |
| 7+ letter words per match | 3.2 | 3.2 / 3.2 | ≥ 3 |
| Coins left at the end | 36 | 28 / 52 | ≤ 10 |
| Bought the last letter | – | – | never |

## Sprint board

The main sessions update this board: claim a story by putting your name in Owner and pushing, then tick it once it's committed and pushed. Owners in the backlog are only suggestions.

| Story | Title | Owner | Done |
|---|---|---|---|
| S0-1 | Bot identity and token | James | [x] |
| S0-2 | Starter kit in our repo | James | [x] |
| S0-3 | First live match | James | [x] |
| S0-4 | Match logging with bid timing | ooVrq (live check: James) | [x] |
| S1-1 | Match state | ooVrq (live check: James) | [x] |
| S1-2 | Unseen-tile pool | ooVrq (live check: James) | [x] |
| S1-3 | Opponents' known letters | ooVrq (live check: James) | [x] |
| S1-4 | Fast word index | James | [x] |
| S1-5 | Hold letters for long words | James | [x] |
| S1-6 | Empty the rack before the end | James | [x] |
| S1-7 | Subscribe only to our own matches (fixes out-of-memory crash) | James | [x] |
| S2-1 | Winning-bid table per letter and phase | ooVrq | [x] |
| S2-2 | Letter valuation | James | [x] |
| S2-3 | Bid formula | James | [x] |
| S2-4 | Spend down coins | ooVrq (live check: James) | [x] |
| S2-5 | Skip the last auction | ooVrq (live check: James) | [x] |
| S2-6 | Early coin snowball | Antigravity | [x] |
| S3-1 | Benchmark script | ooVrq | [x] |
| S3-2 | Tune bid and play numbers | | [ ] |
| S3-3 | Tag a version only when better | | [ ] |
| B-1 | Register for the tournament | | [ ] |
| B-2 | Deny letters to the leader | | [ ] |
| B-3 | Push up rivals' prices | | [ ] |
| B-4 | First-price auction mode | | [ ] |
| B-5 | Guess opponents' starting tiles | | [ ] |
| B-6 | Survive disconnects | | [ ] |
| B-7 | Precomputed instant bids (only if needed) | | [ ] |

## Sprint plan

| Sprint | Time | Goal | Exit check |
|---|---|---|---|
| 0. Setup | 0:00–0:30 | The starter bot plays a live lobby match from our repo | A match appears on the site with our bot in it |
| 1. Game state and words | 0:30–1:45 | The bot knows the full game state and finds the best words fast | Unit tests pass; word search stays well under 100 ms on a full rack |
| 2. Bidding | 1:45–3:00 | Bids come from letter value and expected price, with a spend-down plan | A live match where we win 20+ tiles and finish with under 20 coins |
| 3. Live tuning | 3:00–4:00 | Tune numbers against the benchmarks over many matches | 10+ live matches logged, average place ≤ 2.5 |
| Buffer | 4:00+ | Tournament prep and stretch goals | Bot registered for the tournament |

## Backlog

Priority uses MoSCoW: **M** = must, **S** = should, **C** = could. Estimates are in minutes.

### Sprint 0: Setup

| ID | Story | Acceptance criteria | Est | Pri | Owner |
|---|---|---|---|---|---|
| S0-1 | As a team, we have a bot identity, so we can connect. | Both of us linked at `/account`, team created at `/team`, a bot token minted and stored locally (never committed). | 10 | M | James |
| S0-2 | As a developer, the starter kit runs from our repo. | `bot-starter/` copied into `bot/`, dependencies installed, `.token-*` files git-ignored, README says how to run it. | 15 | M | ooVrq |
| S0-3 | As a team, we see the bot play one live match. | The bot joins the lobby, bids, plays words and rejoins after the match ends. | 5 | M | James |
| S0-4 | As a developer, every match writes a log, so we can measure it. | One JSON line per event (auction seen, bid sent, auction result, word played, match end) written to `logs/` (git-ignored). Each bid line records **how long we took to decide** and **how long after the auction opened the bid was sent**, so we can tell whether we need B-7. | 20 | S | ooVrq |

### Sprint 1: Game state and words

| ID | Story | Acceptance criteria | Est | Pri | Owner |
|---|---|---|---|---|---|
| S1-1 | As the bot, I track the match state. | Keeps our rack, our balance, every player's public balance and score, the round number, and auctions left (from `bagTotal`). | 25 | M | ooVrq |
| S1-2 | As the bot, I track the unseen-tile pool. | Unseen = 98-tile set − our rack − every letter auctioned or played that we can attribute. Tested against a recorded match. | 25 | M | ooVrq |
| S1-3 | As the bot, I track each opponent's known letters. | Per opponent: letters won − letters played, plus a count of their unknown starting tiles still in hand (5 − starting letters they've revealed in words). | 20 | S | ooVrq |
| S1-4 | As the bot, I find the best playable words quickly. | Dictionary loaded once into an index keyed by sorted letters (or counts). Returns the best word for a rack in < 100 ms; tested on sample racks. | 30 | M | James |
| S1-5 | As the bot, I hold letters for long words. | Play policy: play a 7+ letter word as soon as one is possible; play a shorter word only if (a) we need coins to keep bidding, or (b) it's the endgame. Plays the highest-reward set of words, not just the longest single word. | 30 | M | James |
| S1-6 | As the bot, I empty my rack before the match ends. | From about 3 auctions before the end, play the best-scoring set of words (`bestWordSet` in `play.ts`, from S1-5). Word play also re-runs on every `matchState` update, not only when our rack changes, so the endgame dump and the low-coins refill fire even if we win nothing late. A test shows no playable word is left in the rack at the end. | 15 | M | James |
| S1-7 | As the bot, I start up without loading the whole server's history. | Replace `subscribeToAllTables()` with targeted subscriptions: our credential, bots, lobby, and only the matches we're in (match state, participants, auctions, results, words, our rack). Startup memory stays under ~300 MB and the bot plays a full match. Found when the bot crashed out of memory at ~3.4 GB downloading all ~1.75M auctions. | 30 | M | James |

### Sprint 2: Bidding

| ID | Story | Acceptance criteria | Est | Pri | Owner |
|---|---|---|---|---|---|
| S2-1 | As a developer, I have a winning-bid table per letter and phase. | A script extends `analyze.sql` to output 25th/50th/75th/90th percentile **winning bids** per letter for rounds 1–20, 21–48 and 49–67, exported to `bot/src/prices.json`. | 20 | M | ooVrq |
| S2-2 | As the bot, I value each letter by what it adds to our words. | Value = expected gain in final word reward if we add this letter, using our rack and the unseen pool. Start simple: how many good 7-letter words this letter brings within one or two tiles, weighted by their reward. Unit-tested on a few racks. | 40 | M | James |
| S2-3 | As the bot, I bid from value and expected price. | Bid = min(value-based ceiling, a price from the table that wins often enough). Never above balance. A letter we can't use gets 0. | 20 | M | James |
| S2-4 | As the bot, I spend down my coins. | Coins left ÷ auctions left sets a spend pace. From round ~55, bids rise so we finish with ≤ 10 coins. | 15 | M | ooVrq |
| S2-5 | As the bot, I never pay for the last letter. | Bid 0 when `bagTotal` shows the final auction. Confirm from a log that the last letter can't be played. | 5 | M | ooVrq |
| S2-6 | As the bot, I get the coin snowball going early. | In rounds 1–20 we favour letters that finish our first 5+ letter word, so a ~40-coin reward funds the rest of the match. | 20 | S | James |

### Sprint 3: Live tuning

| ID | Story | Acceptance criteria | Est | Pri | Owner |
|---|---|---|---|---|---|
| S3-1 | As a team, we compare our matches with the benchmarks. | A script reads our logs (or re-pulls the database) and prints our numbers next to the benchmark table. | 20 | M | ooVrq |
| S3-2 | As a team, we tune the bid and play numbers. | At least 10 live matches. Adjust the price percentile, spend pace and play thresholds one at a time, and note each change and result in a short log at the bottom of this file. | 40 | M | both |
| S3-3 | As a team, we tag a version only when it's better. | A new bot version resets rating to 1500, so tag only when 10+ matches show a clear improvement in average place. | 5 | M | James |

### Buffer and stretch goals

| ID | Story | Acceptance criteria | Est | Pri | Owner |
|---|---|---|---|---|---|
| B-1 | As a team, the bot is registered for the tournament. | The bot calls `registerForTournament` from its own process once registration opens, and stays online. Offline bots still get seated and lose every auction. | 10 | M | James |
| B-2 | As the bot, I keep a letter from a leader who needs it. | If the top-scoring opponent's known letters are one tile from a 7-letter word, our value for that tile includes the denial value. | 30 | C | James |
| B-3 | As the bot, I make rivals pay more. | When we're sure a rival will win a letter we don't need, bid just under their likely bid to push up what they pay. Capped so a mistake costs little. | 20 | C | ooVrq |
| B-4 | As the bot, I handle first-price auctions. | If `auctionType` is first-price, bid below our value instead of near it. Needed only if the tournament uses first-price. | 20 | S | ooVrq |
| B-5 | As the bot, I guess opponents' starting tiles. | Use letters they play but never won to narrow their 5 starting tiles, and use that to estimate the unseen pool better. | 30 | C | ooVrq |
| B-6 | As the bot, I survive disconnects. | Reconnects automatically, recovers state from subscriptions, and rejoins the lobby. | 20 | S | James |
| B-7 | As the bot, I bid instantly, so slow calculations never miss an auction. **Only if testing shows it's needed** (see below). | Whenever our rack changes, work out the bid for all 26 letters and store them in a table. When an auction arrives, send the stored bid at once; send an improved bid later only if a fuller calculation finishes before the window closes (the server keeps the latest bid). Any heavy calculation runs in chunks or a worker thread so the bot keeps receiving messages. | 30 | C | James |

#### When to pick up B-7

Language isn't the bottleneck: network delay is the same in any language, and TypeScript is fast enough for our calculations if they're structured well. B-7 is a fallback, not a default. Pick it up if the S0-4 logs show any of these over 10+ matches:

- **Slow decisions:** deciding a bid takes more than about 100 ms.
- **Late bids:** bids are sent more than about 300 ms after the auction opens.
- **Missed auctions:** any "Auction closed" or "Auction window expired" errors, or words rejected because we no longer hold the letters.

If bids are late but decisions are fast, the problem is network distance, not code. Run the bot from a machine closer to the server instead.

## Parallel work

The two of us can work at the same time without touching the same files:

| Sprint | James | ooVrq |
|---|---|---|
| 0 | Account, team, token, first live match | Repo layout, run script, match logging |
| 1 | Word index, play policy, endgame rack dump (`words.ts`) | Match state, unseen pool, opponent letters (`state.ts`) |
| 2 | Letter valuation and bid formula (`value.ts`, `strategy.ts`) | Price table, spend pace, last-auction rule (`prices.json`, `budget.ts`) |
| 3 | Run matches and tune numbers | Benchmark script and match review |

**Shared interface:** agree on the shape of `state.ts` at the start of Sprint 1 so the word and bid code can be built against it in parallel.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Word search or valuation is too slow for 1-second auctions | We bid on closed auctions and play spent letters | Precompute the index at startup; time it in tests; watch the S0-4 timing logs and pick up B-7 if they show slow or late bids |
| Valuation code takes too long to build | Sprint 2 slips | Ship a simple version first (price table + "is it in a near-complete word?"), then improve |
| The meta shifts during the day | Price table goes stale | Re-run `pull_data.py` before final tuning |
| Bad versions hurt our rating | Rating resets for nothing | Test on the current version; tag a new one only after 10+ good matches |
| Bot goes offline during the tournament | We lose every auction | Run the bot from a machine that stays awake; add reconnects (B-6) |
| A token gets committed to the public repo | Someone else can play as our bot | Ignore `.token-*` and `.env`; mint a new token on `/team` if one leaks |

## Open questions

- [x] Is there any time to play a word after the last auction closes? No: the server ends the match in the same step that awards the last letter, and later words get "Match not running" (checked in S2-5).
- [ ] Which auction type will the tournament use? (Decides whether B-4 is needed.)
- [ ] When does tournament registration open, and how many bots per table?

## Tuning log

Record each change made during Sprint 3 here.

| Time | Change | Matches | Avg place | Tiles won | Coins left | Notes |
|---|---|---|---|---|---|---|
| 2026-11-08 02:54Z | `improved-bot` + bomb-first play (ce28f44): first word 60+ (30+ after 20 auctions left), then 30+ only, target-word bidding, 6-coin reserve per missing target tile | 10 (46141–46296) | 2.80 | 14.5 | 20.3 | 1 win (10%), score 89.4, 11.7 coins/tile, 1.4 7+ words. Compare `main` at 2.3: 3.00 / 22% / 13.1 tiles / 28 left. 60+ word early in 5 of 10 → never worse than 3rd (2,2,2,2,3); deadline fallback in 5 → avg 3.4. Gap after the first word: often no second 30+ word until the endgame. |
| 2026-11-08 03:20Z | Sliding first-word cutoff (fa372c8): 60 until 50 left, linear to 30 at 25 left, lowered by coin affordability | 4 (46450–46492; 46436 joined mid-match, excluded) | 4.00 | 11.5 | ~16 | Worse. Bot spent 90–96 coins in the first 8–18 auctions (market anchoring at p75/p90, no balance cap), so the cutoff dropped to 30–46 and it played a medium first word early, then was broke. Stopped early. |
| 2026-11-08 03:29Z | Spending cap before the first word (6911ab3): 18% of balance and ≤ p50 per letter, 50% for near-complete target letters, keep 38 coins while the target is far | 4 (46551–46593) | 4.50 | 12.5 | ~18 | Overcorrected: places 1, 6, 6, 5. Still ~60 coins after 20 bids, 9–11 tiles in 3 of 4, first word late (27–28 left). 48 cap/floor-bound bids lost by a median of 5 coins. Low-value 10-letter targets (REGELATING, IDEALITIES) a separate problem. |
| 2026-11-08 | Looser cap: 30% of balance and ≤ p75; floor 25 coins, only once rack ≥ 10 tiles or round ≥ 35; 15% allowed below the floor | – | – | – | – | Not yet run live. Log replay: up to 30 of the 48 lost capped bids would have beaten the winning price. |
