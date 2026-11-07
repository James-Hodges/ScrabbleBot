# ScrabbleBot Strategy Notes

Brainstorm notes based on the [game docs](https://scrabblebot.spacetimedb.com/docs).

## The game in one line

Each round there's a 1-second sealed-bid auction for one letter. You turn the letters you win into words, and words earn money and score. Money only pays for bids, and score decides the ranking. The match ends when the bag is empty.

## 1. Does paying for a letter lower score?

The docs say rewards add to both `balance` and `score`, but they never say whether paying for a letter lowers `score`. We think it doesn't, but we should test this with one cheap auction before building anything.

If it doesn't:

- **Money is only worth what it can buy.** Any balance left at the end is wasted, so we should plan to finish near zero.
- **We should bid harder as the bag empties.** Late in the game there are fewer chances left to spend, so each unit of money is worth less.
- **Draining opponents' money is a real tactic** (see #4).

If paying *does* lower score, every bid is a direct trade of points for a letter, and we should be far more careful.

## 2. "Hidden" information can mostly be worked out

Every finished auction shows the letter, the winner and the price, and every played word shows its letters. So:

- **Each opponent's rack** = letters they've won − letters they've played.
- **The bag** = the starting tiles − letters sold so far, assuming the standard 100-tile Scrabble set. The docs don't confirm that set. Unsold tiles go back into the bag.

That means we know everything except the order letters come out. A bot that tracks this should beat the starter bots, which almost certainly ignore it.

## 3. The length bonus dominates word play

| Length | Multiplier |
|---|---|
| 3 or fewer | 1× |
| 4 | 1.5× |
| 5 | 2× |
| 6 | 2.5× |
| 7+ | 3× |

One 7-letter word worth 10 base points scores 30. Split into a 3-letter and a 4-letter word, the same letters score about 4 + 9 = 13. So the main tension is:

- **Play short words now:** you get money sooner to fund bids.
- **Save letters for a 7+ letter word:** much more score, but anything still in your rack when the bag runs out probably scores nothing.

Likely plan: play short words early only when we need money, build toward 7+ letter words in the middle of the game, and dump everything playable as the bag nears empty. Since we can count the bag (#2), we know exactly when the end is close.

## 4. Each letter's value depends on two things

**What it's worth to us:** how much it raises the best score we can expect from our final words, given our rack and what's left in the bag. A Q without a U is nearly worthless, and an E is worth more when the rack has no vowels. This is the main part of `decideBid`.

**What it's worth to keep from opponents:** placement is what counts (OpenSkill rating, Swiss points, avoiding last place in playoffs). So a letter that completes a leader's 7-letter word is worth bidding on just to block it, even if we can't use it.

**Vickrey is not "just bid your true value" here.** That shortcut assumes one auction, private values, and no budget limit, and none of those hold. Two consequences:

- **Pushing up prices:** the winner pays the second-highest bid, so bidding high on a letter we expect a rival to win makes them pay more. The risk is that we win it.
- **Our budget is limited:** spending on this letter means less money for the next one, so the real cost of a bid is the best use we'd otherwise have for that money.

## 5. Unbid tiles go back to the bag

Since unbid tiles return, the bag only empties as tiles are actually bought. If we're leading, we can bid on everything to end the game sooner. If we're behind, we can let tiles go unbid and wait for better letters. It's worth checking whether a bid of 0 counts as a bid.

## 6. Smaller edges

- **Speed:** you get 1 second per auction. Values should be precomputed, for example with an index of dictionary words by their letters, so bids land on time.
- **Simulated bots:** the lobby fills empty seats with idle simulated bots. Playing those matches gives an easy early rating while our ± narrows to 175 (about 20–30 matches).
- **Finals are different:** playoff elimination only punishes last place, so play safe there. The final three games go by total score, so take more risk there.
- **Starting fresh:** a new bot version resets to 1500, so it's worth testing changes before tagging a version.

## Questions to answer from the starter kit or by testing

- [ ] Does paying for a letter lower score? (We think not.)
- [ ] What is the starting balance? Can balance go negative?
- [ ] How many players are in a match?
- [ ] What is the tile set, and are there blanks?
- [ ] Which dictionary is used?
- [ ] How are tied bids broken?
- [ ] Is there a minimum bid? Does a bid of 0 count?

## Main bet

Track every opponent's rack and the bag, and value each letter by how much it helps us plus how much it would help the leading opponent. That's where we expect the biggest gap over the starter bots.
