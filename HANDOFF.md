# Handoffs

Work that one of us built and the other needs to pick up. Delete an entry once it's closed.

## State of affairs, 2026-11-07 ~18:30 PST (James → Ryan)

James is out of Claude usage for now, so this is everything you need to carry on alone. (An earlier version of this handoff is on `main`; this one replaces it.)

### TL;DR

- **The active branch is `improved-bot`**: your commit `81cc4b3` plus James's `bed9125`, which sets `COINS_PER_POINT` to **2.3**, the rate that tested best on `main`.
- **James's bot is running `improved-bot` at 2.3** (started 18:23 PST), so there are no live results for it yet. **Before you run the bot, ask James to stop his:** the same bot can't play from two places.
- **Bug to investigate:** James saw the bot **get stuck when it has 0 tiles**. Not investigated yet (see below).
- **Before the tournament:** B-1, tournament registration, is still open.

### Getting the bot running on your machine

**You need:** git, and Node.js 20 or newer (James uses 25). You don't need the spacetime CLI: the generated bindings and the wordlist are committed.

1. **Get the branch.**

   ```bash
   git clone https://github.com/James-Hodges/ScrabbleBot.git
   cd ScrabbleBot
   git switch improved-bot
   ```

   If you already have the repo: `git fetch && git switch improved-bot && git pull`.

2. **Install dependencies.**

   ```bash
   cd bot
   npm install
   ```

3. **Check it works.** All 98 tests should pass, and the typecheck should print nothing.

   ```bash
   npm test
   npx tsc --noEmit
   ```

4. **Get a token.** On the [team page](https://scrabblebot.spacetimedb.com/team), click **Generate token** and copy it. It's shown only once.
   - **Heads-up:** we haven't checked whether a new token stops James's existing one from working. If his bot suddenly can't connect after you generate yours, that's why; he can generate a fresh one.
   - **Keep it secret.** Never paste it into Claude, a chat, or a commit. Anyone with it can play as our bot. `.token-*` files are git-ignored.

5. **Save the token to a file in `bot/`** without it showing on screen or in your shell history. On macOS, straight from the clipboard:

   ```bash
   pbpaste > .token-main
   ```

   On any system, typed in hidden:

   ```bash
   read -rs TOKEN && printf '%s' "$TOKEN" > .token-main && unset TOKEN
   ```

6. **Make sure James's bot is stopped,** then start yours:

   ```bash
   BOT_NAME=main npm start
   ```

   `BOT_NAME=main` only picks the `.token-main` file. A healthy start prints `connected as …`, `subscription applied`, then `acting as bot 'Nigel "Bidderson" Richards'`. It joins the lobby, and a match starts within about 90 seconds. It rejoins the lobby after every match, so stop it with Ctrl+C when you're done.

   If you see `no BotCredential for this token`, the token file is wrong or empty: generate a new token and repeat step 5.

7. **Check results.** Each match writes `logs/<bot>-<match>-<time>.jsonl` at the repo root. After about 10 matches (roughly 25 minutes), from the repo root:

   ```bash
   python3 -I analysis/benchmark.py --logs logs/ --since <start time as ISO UTC, e.g. 2026-11-08T02:30:00Z>
   ```

### Results so far (live, ~9 matches each)

| Setup | Avg place | Wins | Score | Tiles | Coins/tile | Coins left |
|---|---|---|---|---|---|---|
| `main`, rate 1.4 (1 match) | 6.0 | 0% | 40 | 8 | 13 | 33 |
| **`main`, rate 2.3** | **3.00** | **22%** | **89** | **13.1** | 12.3 | 28 |
| `main`, rate 2.3 + early boost 1.5 | 3.33 | 11% | 70 | 10.1 | 14.2 | 26 |
| `experiment/high-value` v1 (premium letters at 75% of balance) | 4.78 | 0% | 54 | 5.4 | 18.3 | 54 |
| `experiment/high-value` v2 (commit to target words) | 3.56 | 11% | 70 | 9.3 | 15.7 | 24 |
| **`improved-bot` at 2.3** | *running now* | | | | | |

What we've learned:

- **Raising the rate 1.4 → 2.3 was the big win.** Our value ceiling had been setting almost every bid below market.
- **`main`'s early boost (S2-6, `EARLY_BOOST = 1.5`) won more early tiles but overspent.** Mid- and late-match win rates halved. It's still switched on on `main` (not on `improved-bot`). If anyone goes back to `main`, set it to 1.0 first.
- **The high-value branch produces one big premium word per match** (ZAPTIAH 63, VIZIERS 57, FIREBOX 57). But it bids 0 on every letter outside its target words, so it wins few tiles and rarely gets a second big word.
- **We still win far fewer tiles than the leaders** (13 vs ~24) and pay more per tile (12 vs ~9). That's the main gap.

### Branches

- **`improved-bot`:** active. Your market-anchored bids, bingo and snowball detection, and rack balancing, at rate 2.3.
- **`main`:** the tuning history (tuning log at the bottom of `PLAN.md`), the early boost (on), and the earlier handoff. Merge `improved-bot` into `main` once a 10-match run beats `main`'s 2.3 numbers.
- **`experiment/high-value`:** premium-letter strategy v1/v2 (`bot/src/highValue.ts`, `STRATEGY=highvalue|main`). Its own tuning log is in that branch's `PLAN.md`. A possible v3 (not started): `main`-style value bids for ordinary letters plus v2's premium and target bids.

### Bug to investigate: stuck at 0 tiles

James saw the bot "getting stuck" when its rack is empty. Unverified; nobody has looked at logs or code yet. Places to start:

- **`bot/src/value.ts` `letterValues`** with an empty rack: are all values ~0, so `rawBid` bids 0 on everything (`MIN_VALUE_POINTS` = 0.5) and we never buy our way back in? With few auctions left, the 2-missing-tile horizon may see no reachable word from zero.
- **Your new rack-leave/synergy code in `bid.ts`:** can it push an empty rack's values to 0?
- **`bot/src/play.ts` / `playGuard.ts`:** does an empty rack, or one emptied by our own plays, block re-evaluation?
- **In the logs:** look for long runs of `bid_skipped` or `"amount":0` after a `word_played` that emptied the rack; the `rack` field on bid lines shows it.

A likely fix: a floor value for letters when the rack is empty or tiny (for example from 3–5 letter word rewards), so we keep buying.

### Sprint board

- **Sprints 0–2:** done and live-checked.
- **S3-1:** done.
- **S3-2 (tuning):** in progress; take it over and add a row to the tuning log for each run.
- **Open:** S3-3 (tag a version only when better), **B-1 (tournament registration, needed before the tournament)**, and the other B stories.

### Working rules

- **One change at a time,** 10+ matches each, then a tuning-log row.
- **Commit before you pull.** `git pull --rebase --autostash` with uncommitted changes once put conflict markers into `PLAN.md`.
- **Only one copy of the bot at a time.**
