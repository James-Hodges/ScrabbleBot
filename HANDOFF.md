# Handoffs

Work that one of us built and the other needs to pick up. Delete an entry once it's closed.

## S2-3 bid share, for WANT_SHARE in budget.ts (James → ooVrq)

**Status:** S2-3 pushed (`c433e57`). From a 600-auction simulation with the real wordlist:

- We bid more than 0 on about **82%** of letters overall, and about **57%** in the spend-down window (14 or fewer auctions left). So `WANT_SHARE = 0.5` is about right for the window.
- Only about **17%** of our bids reach the table's p25, so the expected win share is roughly 10–15% until `COINS_PER_POINT` (1.4 in `bid.ts`) is tuned in S3-2. Spend-down will see few wins to spread coins over.
- No action needed unless the first live match shows otherwise; delete this entry once you've read it.
