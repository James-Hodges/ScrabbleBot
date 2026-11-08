# Handoffs

Work that one of us built and the other needs to pick up. Delete an entry once it's closed.

## State of affairs, 2026-11-07 ~18:15 PST (James → ooVrq)

James is out of Claude usage for now, so this is everything you need to carry on alone.

### TL;DR

- **Best setup so far: `main` at `COINS_PER_POINT = 2.3`, WITHOUT the early boost.** Over 9 live matches: average place 3.00, 22% wins, 89 points.
- **`main` currently has the early boost switched ON** (`EARLY_BOOST = 1.5` in `bot/src/bid.ts`), which tested worse. **First job: set `EARLY_BOOST = 1.0`** (keep the code), run the tests, push.
- **The high-value experiment** on branch `experiment/high-value` is promising but still below `main`. Details below.
- **Bug report to investigate:** James saw the bot **get stuck when it has 0 tiles**. Not yet investigated (see below).
- **The live bot:** James's machine is running the experiment branch (v2) from a separate worktree. If you run the bot yourself, run only one copy: the same bot can't be in two lobbies.

### Sprint board

- **Sprints 0–2:** all done and live-checked, except S2-6, which is built but tested worse (see the tuning log).
- **S3-1:** done (yours).
- **S3-2 (tuning):** in progress, owner James. Take it over; the tuning log at the bottom of `PLAN.md` has every run.
- **Still open:** S3-3 (tag a version only when better), B-1 (tournament registration, **must do before the tournament**), and the other B stories.

### Results so far (live, ~9 matches each; `python3 -I analysis/benchmark.py --logs logs/ --since <time>`)

| Setup | Avg place | Wins | Score | Tiles | Coins/tile | Coins left |
|---|---|---|---|---|---|---|
| `main`, rate 1.4 (1 match) | 6.0 | 0% | 40 | 8 | 13 | 33 |
| **`main`, rate 2.3** | **3.00** | **22%** | **89** | **13.1** | 12.3 | 28 |
| `main`, rate 2.3 + early boost 1.5 (current `main`) | 3.33 | 11% | 70 | 10.1 | 14.2 | 26 |
| Experiment v1 (premium letters at 75% of balance) | 4.78 | 0% | 54 | 5.4 | 18.3 | 54 |
| Experiment v2 (commit to target words) | 3.56 | 11% | 70 | 9.3 | 15.7 | 24 |

What we've learned:

- **Raising the exchange rate (1.4 → 2.3) was the big win.** Our value ceiling had been setting almost every bid below market.
- **The early boost won more early tiles but overspent.** Mid- and late-match win rates halved.
- **Premium letters + target words do produce one big word per match** (ZAPTIAH 63, VIZIERS 57, FIREBOX 57, LIQUORED 54). But v2 bids 0 on every letter that doesn't serve a target (363 of 662 auctions), so it wins few tiles and rarely gets a second big word. The "wait for an 8–9 letter word" rule almost never fires (2 of 24 decisions).
- **We still win far fewer tiles than the leaders** (13 vs ~24) and pay more per tile (12 vs ~9). That's the main gap.

### The experiment branch

- **Branch:** `experiment/high-value` (latest `5badac1`), pushed. Code: `bot/src/highValue.ts` (+ tests).
- **Switching strategy:** on the branch, `STRATEGY=highvalue` (default) or `STRATEGY=main`. The branch's own tuning log in `PLAN.md` has the v1/v2 rows.
- **James's worktree** is at `../ScrabbleBot-highvalue` on his machine. You'll just check out the branch.
- **Suggested next step (v3, not started):** use `main`'s value-based bidding (`bid.ts` `rawBid`) for ordinary letters instead of bidding 0, and keep v2's premium and target-letter bids. That would combine `main`'s tile volume with v2's big word. Watch the coin budget, since the two halves compete for it.
- **Don't merge the branch into `main`** unless a 10-match run beats `main`'s 2.3 numbers.

### Bug to investigate: stuck at 0 tiles

James saw the bot "getting stuck" when its rack is empty. Unverified; nobody has looked at logs or code yet. Places to start:

- **`bot/src/value.ts` `letterValues`** with an empty rack: are all values ~0, so `rawBid` bids 0 on everything (`MIN_VALUE_POINTS` = 0.5) and the bot never buys its way back in? With few auctions left, the 2-tile-missing horizon may see no reachable word from zero.
- **`bot/src/highValue.ts`** (branch): with no premium letter and no targets, does every letter fall into `skip`?
- **`bot/src/play.ts` / `playGuard.ts`:** does an empty rack, or a rack emptied by our own plays, block re-evaluation?
- **In the logs:** look for long runs of `bid_skipped` / `amount: 0` after a `word_played` that emptied the rack. `rackLeft` and the rack field on bid lines help.

A likely fix: give letters a floor value when the rack is empty or tiny (e.g. use the unconditional average letter worth, or `wordReward`-based value for 3–5 letter words), so we keep buying.

### Running and checking

- **Setup:** `cd bot && npm install`, then `BOT_NAME=<name> npm start` with your own token file (see `README.md`). Logs go to `logs/`.
- **Tests:** `npm test` (123 on the branch, ~103 on `main`) and `npx tsc --noEmit`.
- **Tuning rule:** one change at a time, 10+ matches each, then a row in the tuning log.
- **Git lesson from today:** **commit before you pull.** A `git pull --rebase --autostash` with uncommitted changes once put conflict markers into `PLAN.md`.
