# Match History Analysis

What the public match history says about the current meta. Data pulled on 2026-11-07 with `analysis/pull_data.py`; every table below comes from `analysis/analyze.sql`.

## Sample

- **Full history:** 25,826 matches since 2026-10-23, all Vickrey.
- **Sample used here:** the **672 matches from the last 3 days with at least 4 real bots**. Older matches are mostly earlier bot versions, so they'd describe a meta that no longer exists.
- **All-real matches are new:** matches with 6 real bots only appear today (206 of them). Before today almost every match had at least one sim.
- **Offline bots:** `Afterword` and `hinsonloo` sit in many matches but win nothing; they're excluded from the place comparisons.

## 1. The meta pays far more than face value

| Rounds | Avg winning bid | Avg price paid | % sold |
|---|---|---|---|
| 1–20 | 16.7 | 12.7 | 100 |
| 21–48 | 15.6 | 12.1 | 100 |
| 49–63 | 16.3 | 11.2 | 100 |
| 64–68 | 15.0 | 7.1 | 89 |

- **About 12 coins per letter**, while the average letter is worth about 2 points. Coins only matter for bidding, so prices settle wherever the coin supply allows.
- **Prices hardly move through the match.** They don't rise late, even though leftover coins are worthless.
- **The last letter still sells 84% of the time** (average 1.5 coins). Most bots haven't noticed that it can't be played.

## 2. Price per letter (rounds 1–67)

| Letter | Avg paid | Median | 90th pct |
|---|---|---|---|
| Z | 26.4 | 27 | 37 |
| X | 24.1 | 25 | 32 |
| J | 22.9 | 23 | 30 |
| Q | 20.6 | 20 | 30 |
| K | 17.9 | 18 | 25 |
| H, Y | 15.6 | 15 | 22 |
| F, W | ~14 | 14 | ~20 |
| C, V, M, P, B | ~12.5 | 12–13 | ~18 |
| D | 10.3 | 10 | 15 |
| G | 9.4 | 9 | 14 |
| S | 8.8 | 8 | 14 |
| 1-point letters (E A R L U N O I T) | 7.3–8.2 | 7 | 11–13 |

**Relative to points, the expensive letters are the bargain.** Z costs about 3.5× an E but scores 10× as much. Per coin spent:

- **Z:** about 0.38 base points per coin.
- **1-point letters:** about 0.13 base points per coin.

The catch is that a long word also needs common letters to fill it out, so we still have to buy those.

## 3. Finishing place tracks tiles won

Real bots only, by finishing place:

| Place | Score | Tiles won | Coins / tile | Coins spent | Coins left | Words | Avg word length | 7+ letter words |
|---|---|---|---|---|---|---|---|---|
| 1 | 161 | 24.4 | 9.2 | 225 | 36 | 4.6 | 6.2 | 3.21 |
| 2 | 129 | 20.9 | 9.4 | 196 | 32 | 4.2 | 6.1 | 2.65 |
| 3 | 98 | 16.3 | 10.6 | 173 | 25 | 3.5 | 5.8 | 1.93 |
| 4 | 63 | 11.0 | 11.8 | 130 | 33 | 2.8 | 5.4 | 1.25 |
| 5 | 41 | 7.1 | 12.4 | 88 | 53 | 2.2 | 4.8 | 0.67 |
| 6 | 22 | 3.9 | 12.0 | 46 | 76 | 1.5 | 4.5 | 0.30 |

- **Winners buy six times as many tiles as last place**, and pay less per tile.
- **Winners spend 225 coins, more than double the 100 they start with.** Money recycles: tiles → long words → coins → more tiles. A 7-letter word pays about 40 coins, which buys 4–5 more tiles.
- **This compounds.** Getting the first long word down early is what starts the loop.
- **Even winners finish with 36 unused coins.** Those coins could have bought 3–4 more tiles.

## 4. Long words are what pay

| Word length | Words | Avg reward | Points per tile |
|---|---|---|---|
| 2–3 | 1,942 | 4.6 | 1.85 |
| 4–5 | 1,820 | 15.3 | 3.39 |
| 6 | 908 | 29.5 | 4.92 |
| 7 | 4,310 | 39.7 | 5.67 |
| 8+ | 1,178 | 44.2 | 5.41 |

A tile in a 7-letter word earns about 3× what it earns in a 2–3 letter word. The 7-letter word is already the most common play in the sample, so most bots have learned this.

## 5. The bots to beat

Real bots with 20+ sample matches, ordered by average place:

| Bot | Matches | Win % | Avg place | Score | Coins left | Tiles won | Coins / tile | Avg word length | 7+ words |
|---|---|---|---|---|---|---|---|---|---|
| LUCENT | 542 | 52 | 1.76 | 151 | 28 | 23.3 | 9.5 | 6.3 | 3.2 |
| Bron | 567 | 37 | 1.86 | 144 | 52 | 23.8 | 8.1 | 6.3 | 3.2 |
| GodOfThudner | 84 | 37 | 2.01 | 103 | 12 | 15.8 | 12.1 | 5.3 | 1.6 |
| marcellinus | 20 | 25 | 2.35 | 111 | 15 | 18.1 | 10.8 | 5.8 | 2.3 |
| maverick-bot | 345 | 16 | 2.45 | 121 | 23 | 18.6 | 10.7 | 5.9 | 2.0 |
| StickBot | 54 | 30 | 2.48 | 93 | 15 | 14.1 | 12.6 | 5.4 | 1.5 |

LUCENT and Bron are clearly ahead. How they play:

- **They buy a lot of tiles cheaply.** Average winning bids are 14.6 (LUCENT) and 12.3 (Bron), below the table average, so they seem to take letters other bots don't fight over rather than winning bidding wars.
- **They don't chase big letters.** Only 5% of their tiles are Z/X/J/Q/K, and 41–42% are vowels, the same mix as everyone else.
- **They hold letters, then play long words.** About half their words come after round 48, and only 14–19% come in the first 20 rounds.
- **They still waste coins.** Bron finishes with 52 unspent coins on average, LUCENT with 28.

## What this means for our bot

1. **Value tiles by how many we can get, not by face value.** Winning is about tile count and long words. Bid on many letters at or below their median price rather than fighting for a few.
2. **Use the winning-bid data, not the price paid, to set bids.** To win a letter we have to beat the highest other bid, which is closer to the "winning bid" column (about 16 on average) than the "price paid" column (about 12). Bidding at the median price paid will lose most auctions. Bid up toward the 90th percentile only for letters that complete a 7-letter word. A per-letter table of winning bids is the next thing to compute.
3. **Buy big letters when they fit a word.** Per coin they're the best deal, but only if we can place them.
4. **Get the first long word down early.** The 40-coin reward funds the rest of the match.
5. **Spend everything.** Raise bids in rounds 55–67 so we finish near zero coins; the leaders leave 28–52 on the table.
6. **Skip the last auction.** Its letter can't be played, and 84% of the time someone pays for it anyway.

## Caveats

- **Three days is short, and bots change daily.** Rerun `pull_data.py` and `analyze.sql` before tuning final numbers.
- **The `rating` field in `bot_stats` looks inconsistent** (some low-placing bots show ratings over 4,000), so the leaderboard here uses average finishing place instead.
- **Starting tiles are never revealed,** so tile counts here are tiles *won*, not total rack size. Every bot also gets 5 starting tiles.
- **Bids below second place are never recorded,** so we see what letters sell for, not how every bot values them.
