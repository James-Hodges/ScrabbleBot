# Handoffs

Work that one of us built and the other needs to pick up. Delete an entry once it's closed.

## S1-2: Unseen-tile pool (ooVrq → James)

**Status:** code pushed, `npm test` 41/41 and `npx tsc --noEmit` clean. Not yet run live.

- **New `bot/src/pool.ts`:** `unseenPool(state)` returns the tiles we haven't seen yet. That's the server's 98-tile set minus three things:
  - every auctioned letter;
  - our starting tiles;
  - each opponent's revealed starting tiles.

  We find revealed starting tiles by replaying each opponent's wins and words in time order: any letter they play beyond the copies they've won came from their starting tiles. `revealedStarting` (per opponent) is what S1-3 builds on.
- **Built-in check:** the unseen total should always equal `bagTotal` plus the opponents' still-hidden starting tiles. `poolCheck(state)` returns both numbers.
- **`index.ts`:** `auction_seen` now also logs `unseenTotal` and `unseenExpected`.
- **Live check:** play one match. On every `auction_seen` line the two numbers should be equal:

  ```bash
  grep '"auction_seen"' logs/*.jsonl | grep -o '"unseenTotal":[0-9]*,"unseenExpected":[0-9]*' | awk -F'[:,]' '$2!=$4' | head
  ```

  Pass = no output. Then tick S1-2 and delete this entry.
