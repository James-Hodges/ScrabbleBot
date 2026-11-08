# Handoffs

Work that one of us built and the other needs to pick up. Delete an entry once it's closed.

## S2-4 and S2-5: Spend down coins, skip the last auction (ooVrq → James)

**Status:** code pushed, `npm test` 76/76 and `npx tsc --noEmit` clean. Not yet run live.

- **New `bot/src/budget.ts`:** `applyBudget(rawBid, ctx)` adjusts whatever `decideBid` returns. `tryBid` in `index.ts` calls it, and `strategy.ts` is untouched. The rules:
  - **Last auction:** always 0. The server awards the letter and ends the match in the same step, so it can't be played.
  - **Unwanted letters:** a raw bid of 0 stays 0. We never buy a letter just to spend coins.
  - **From 14 auctions left (round 55 of 68):** if we hold more than 10 coins, the bid rises toward (balance − 10) ÷ the wins we expect. It's capped at the letter's late-match winning bid from S2-1, which moves from p50 to p75 to p90 as auctions run out. With 2 auctions left there's no market cap. We keep 1 coin for each later auction, and never bid above our balance.
  - **Before the window:** the raw bid, capped at our balance.
- **Logs:** `bid_sent` and `bid_skipped` now include `rawBid` and `budgetReason`.
- **Live check:** run one match.
  - The last auction's line should be `bid_skipped` with `"budgetReason":"last_auction"`, and its `auction_result` should show `"weBid":false`.
  - Bids from round 55 on show `"budgetReason":"spend_down"`.
  - `match_end` shows our coins left.

  If all that holds, tick S2-4 and S2-5 and delete this entry.
- **Tuning for S3-2:** we pay the second-highest bid (Vickrey), not our own, so raising bids spends less than the formula assumes. Expect to finish above 10 coins until `WANT_SHARE` (0.5, the share of letters we expect to want) and the other constants in `budget.ts` are tuned. Set `WANT_SHARE` to match how many letters S2-2/S2-3 actually bid on.

## S2-3 bid share, for WANT_SHARE in budget.ts (James → ooVrq)

**Status:** S2-3 pushed (`c433e57`). From a 600-auction simulation with the real wordlist:

- We bid more than 0 on about **82%** of letters overall, and about **57%** in the spend-down window (14 or fewer auctions left). So `WANT_SHARE = 0.5` is about right for the window.
- Only about **17%** of our bids reach the table's p25, so the expected win share is roughly 10–15% until `COINS_PER_POINT` (1.4 in `bid.ts`) is tuned in S3-2. Spend-down will see few wins to spread coins over.
- No action needed unless the first live match shows otherwise; delete this entry once you've read it.
