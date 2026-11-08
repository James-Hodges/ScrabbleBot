# ScrabbleBot Strategy Notes

Brainstorm notes based on the [game docs](https://scrabblebot.spacetimedb.com/docs) and the [server source](https://github.com/clockworklabs/scrabblebot). Where the two disagree, these notes follow the source code (`spacetimedb/src/game.ts`, `letters.ts`, `index.ts`), since that's what actually runs.

## The game in one line

Each round there's a 1-second sealed-bid auction for one letter. You turn the letters you win into words, and words earn money and score. Money only pays for bids, and score decides the ranking. The match ends when the bag is empty.

**Starting state:** each player starts with **100 coins** and **5 tiles**. The 5 starting tiles are dealt privately, so opponents can't see yours and you can't see theirs.

## Rules confirmed from the source code

| Rule | Value | Source |
|---|---|---|
| Tile set | 98 tiles, standard Scrabble counts, **no blanks** | `letters.ts` |
| Players per lobby match | up to 6 (empty seats filled by simulated bots) | `LOBBY_MAX_SIZE` |
| Lobby timer | **90 seconds** (docs say 60) | `LOBBY_DURATION_SECONDS` |
| Starting balance / tiles | 100 coins, 5 tiles | `STARTING_BALANCE`, `STARTING_RACK_SIZE` |
| Auctions per 6-player match | **68** (98 − 6 × 5) | derived |
| Auction length | 1 second | `AUCTION_DURATION_MS` |
| Unbid tiles | **thrown away**, not returned to the bag (docs are wrong) | `closeAuction` |
| Lone bidder pays | 1 coin | `AUCTION_RESERVE` |
| Tied bids | decided at random | `closeAuction` |
| Max bid | your current balance; balance never goes negative | `submitBid` |
| Changing a bid | allowed during the window; the new bid replaces the old one | `replaceBid` |
| Paying for a letter | lowers **balance only**, never score | `closeAuction`, `playWord` |
| Word reward | added to both balance and score | `playWord` |
| Dictionary | 172,820 words (matches the ENABLE list), 2+ letters | `wordlist.txt` |
| Repeating a word | allowed; nothing blocks it | `submitWord` |
| Reward rounding | rounds down, so 4- and 6-letter words with an odd base lose half a point | `lengthMultiplier` |
| Words after match end | rejected ("Match not running") | `submitWord` |
| Lobby auction type | always Vickrey; tournaments can be set to first-price by an admin | `lobby.ts` |

Admins can change the auction length, starting tiles and lobby size, so read `matchState` at the start of each match rather than hardcoding these values.

## 1. Money is only worth what it can buy

Paying for a letter never lowers score, so:

- **Any balance left at the end is wasted.** We should plan to finish near zero.
- **We should bid harder as the bag empties.** Late in the game there are fewer chances left to spend, so each coin is worth less.
- **Draining opponents' money is a real tactic** (see #4).

**The 100-coin start:** everyone begins with the same budget, so early on nobody can outbid everyone else for long. Playing a word early turns letters into coins, which means more buying power for the rest of the game. Starting with 5 tiles also means we may be able to play a short word right away for coins.

## 2. "Hidden" information can mostly be worked out

What bots can see during a match:

- **Public:** every player's **balance and score** (`matchParticipant`), every auction result (letter, winner, price paid), every word played, and the number of tiles left in the bag (`bagTotal`).
- **Hidden:** opponents' racks, the bag's letter counts, other bots' live bids, and the **winning bid** of each auction. Winning bids only become public after the match ends.

From that:

- **Each opponent's rack** = their 5 unknown starting tiles + letters they've won − letters they've played.
- **The bag** = the 98-tile set − our own 5 starting tiles − every opponent's 5 unknown starting tiles − every letter auctioned so far (sold or thrown away).
- **Each opponent's maximum bid** = their balance, which is public.
- **Under Vickrey, the price paid is the second-highest bid.** Every result tells us something about how the other bots value letters.

So the only real unknowns are each opponent's 5 starting tiles and the order letters come out. We can narrow down the starting tiles as the game goes:

- **Words they play:** any letter in a played word that they never won at auction must have come from their starting tiles.
- **What's left:** the hidden starting tiles all come from the tiles not yet seen, so we can estimate them from the remaining letter counts. That estimate gets sharper as more tiles are auctioned.
- **How they bid:** a bot that bids high on a U probably holds a Q, and one that ignores vowels probably started with several.

Early in the game the starting tiles are a big share of each rack, so our read on opponents is fuzzy. Later it gets much sharper. A bot that tracks this should still beat the starter bots, which almost certainly ignore it.

Our own 5 starting tiles are hidden from opponents too, so early on they can't tell exactly which letters we need.

## 3. The length bonus dominates word play

| Length | Multiplier |
|---|---|
| 3 or fewer | 1× |
| 4 | 1.5× |
| 5 | 2× |
| 6 | 2.5× |
| 7+ | 3× |

One 7-letter word worth 10 base points scores 30. Split into a 3-letter and a 4-letter word, the same letters score about 4 + 9 = 13. Words longer than 7 letters still get 3×; extra letters only add to the base. So the main tension is:

- **Play short words now:** you get money sooner to fund bids.
- **Save letters for a 7+ letter word:** much more score, but anything still in your rack when the match ends scores nothing.

With 68 auctions in a 6-player match, each player ends up with roughly 16 tiles (5 starting + about 11 won). That's enough for maybe two 7-letter words, so every tile matters.

Likely plan: play short words early only when we need money, build toward 7+ letter words in the middle of the game, and dump everything playable as the bag nears empty.

## 4. Each letter's value depends on two things

**What it's worth to us:** how much it raises the best score we can expect from our final words, given our rack and what's left in the bag. A Q without a U is nearly worthless, and an E is worth more when the rack has no vowels. This is the main part of `decideBid`.

**What it's worth to keep from opponents:** placement is what counts (OpenSkill rating, Swiss points, avoiding last place in playoffs). So a letter that completes a leader's 7-letter word is worth bidding on just to block it, even if we can't use it.

**Vickrey is not "just bid your true value" here.** That shortcut assumes one auction, private values, and no budget limit, and none of those hold. Two consequences:

- **Pushing up prices:** the winner pays the second-highest bid, so bidding high on a letter we expect a rival to win makes them pay more. The risk is that we win it. Their public balance tells us how far we can push.
- **Our budget is limited:** spending on this letter means less money for the next one, so the real cost of a bid is the best use we'd otherwise have for that money.

Tournaments can use first-price auctions instead, where the winner pays their own bid. There we should bid below our value, so the bidding code needs a mode for each.

## 5. The end of the match is fixed and predictable

Unbid tiles are thrown away, so the match always lasts exactly as many auctions as there are tiles left after dealing (68 with 6 players). Skipping a tile doesn't slow the game down. `bagTotal` is public, so we always know how many auctions remain.

- **The last letter is worthless.** The final auction gives its letter to the winner and ends the match in the same step, and words can't be played after the match ends. Don't bid on it.
- **Letters near the end are only worth something if we can use them in time.** A letter won near the end must go into a word that can be played before the next auction closes.
- **Dump the rack before the last auction closes.** Anything still in the rack at the end scores nothing.

## 6. The simulated bots are fully predictable

Simulated bots fill empty lobby seats. Each one bids based only on the letter's value, plus ±2 of random noise, capped at its balance:

| Bot | Type | Bid |
|---|---|---|
| Cheapo-sim, Snippet-sim | Cheapskate | value − 1 |
| Valor-sim, Hagrid-sim | ValueBidder | value |
| Brutus-sim, Maverick-sim | Aggressive | value + 2 (+4 for vowels) |

They ignore their own rack. After winning a letter they immediately play their longest word of 3 or more letters, so they rarely build up to 7-letter words.

- **They overpay for Q and Z**, bidding about 10 on letters they can rarely use. Let them have them.
- **Aggressive bots push vowels up to about 7**, so consonants are the cheap letters when they're at the table.
- **We can predict what we'll pay.** Under Vickrey we pay the second-highest bid, so against sims we know roughly what each letter will cost.
- **Easy early rating:** matches against sims are a cheap way to build rating while our ± narrows to 175 (about 20–30 matches).

## 7. The starter bot is weak in the same way

The starter bot bids the letter's value (+2 if it has none of that letter yet) and plays its longest possible word every time its rack changes, even a 2-letter one. Teams that barely change it will waste the length bonus. Holding letters for long words is how we beat them.

## 8. Smaller edges

- **Speed:** you get 1 second per auction. Values should be precomputed, for example with an index of dictionary words by their letters, so bids land on time.
- **Finals are different:** playoff elimination only punishes last place, so play safe there. The final three games go by total score, so take more risk there.
- **Starting fresh:** a new bot version resets to 1500, so it's worth testing changes before tagging a version.

## Open questions

- [x] Does paying for a letter lower score? No; it only lowers balance.
- [x] What is the starting balance? 100 coins, plus 5 private starting tiles.
- [x] Can balance go negative? No; bids are capped at your balance.
- [x] How many players are in a match? Up to 6 in the lobby. Tournament table size is set by the admin.
- [x] What is the tile set, and are there blanks? The 98-tile standard set, no blanks.
- [x] Which dictionary is used? A 172,820-word list (matches ENABLE).
- [x] How are tied bids broken? At random.
- [x] Is there a minimum bid? Does a bid of 0 count? Bids of 0 are ignored; a lone bidder pays 1.
- [ ] Which auction type will the tournament use?
- [x] How much time is there between the last auction closing and the match ending, in practice? None: `closeAuction` awards the letter and sets the match to Ended in the same reducer.

## Main bet

Track every opponent's rack and the bag, including best guesses at their 5 starting tiles, and value each letter by how much it helps us plus how much it would help the leading opponent. Hold letters for 7+ letter words, and plan the endgame around the known number of auctions. That's where we expect the biggest gap over the starter bots and the simulated bots.
