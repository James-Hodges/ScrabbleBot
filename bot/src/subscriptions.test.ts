import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coreQueries,
  liveFloorMicros,
  liveQueries,
  sqlTimestamp,
} from "./subscriptions.js";

test("sqlTimestamp keeps microseconds", () => {
  assert.equal(sqlTimestamp(0n), "1970-01-01T00:00:00.000000Z");
  assert.equal(
    sqlTimestamp(1793139745002828n),
    "2026-10-27T22:22:25.002828Z",
  );
  assert.equal(sqlTimestamp(1_000_001n), "1970-01-01T00:00:01.000001Z");
});

test("queries filter on our bot id", () => {
  for (const q of coreQueries(42n)) assert.match(q, /bot_id = 42\b/);
  const live = liveQueries(42n, 1_000_001n);
  assert.equal(live.length, 3);
  for (const q of live) {
    assert.match(q, /bot_id = 42\b/);
    assert.match(q, /> '1970-01-01T00:00:01\.000001Z'$/);
  }
});

test("liveFloorMicros: running match wins, else latest end", () => {
  assert.equal(liveFloorMicros([]), 0n);
  assert.equal(
    liveFloorMicros([
      { running: false, createdAtMicros: 10n, endedAtMicros: 50n },
      { running: false, createdAtMicros: 60n, endedAtMicros: 90n },
    ]),
    90n,
  );
  assert.equal(
    liveFloorMicros([
      { running: false, createdAtMicros: 10n, endedAtMicros: 500n },
      { running: true, createdAtMicros: 100n, startedAtMicros: 120n },
    ]),
    119n,
  );
});
