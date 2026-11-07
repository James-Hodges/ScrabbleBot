import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MatchLogs, formatLine, logFileName, placings, sinceOpen } from "./log.js";

const T = Date.UTC(2026, 10, 7, 12, 34, 56, 789);

test("logFileName: bot, match id and UTC stamp; unsafe chars replaced", () => {
  assert.equal(logFileName("ooVrq", 42n, T), "ooVrq-42-20261107T123456Z.jsonl");
  assert.equal(logFileName("a/b c", 1, T), "a_b_c-1-20261107T123456Z.jsonl");
});

test("formatLine: one JSON line with t, ms, event, matchId and fields; bigints as numbers", () => {
  const line = formatLine("bid_sent", 7n, { amount: 3, auctionId: 99n, huge: 2n ** 64n }, T);
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1);
  const o = JSON.parse(line);
  assert.deepEqual(o, {
    t: "2026-11-07T12:34:56.789Z",
    ms: T,
    event: "bid_sent",
    matchId: 7,
    amount: 3,
    auctionId: 99,
    huge: "18446744073709551616",
  });
});

test("sinceOpen: prefers server open time, falls back to first-seen", () => {
  assert.deepEqual(sinceOpen(1250, 1000, 1100), { sinceOpenMs: 250, openBasis: "server" });
  assert.deepEqual(sinceOpen(1250, undefined, 1100), { sinceOpenMs: 150, openBasis: "seen" });
  assert.deepEqual(sinceOpen(1250, NaN, 1100), { sinceOpenMs: 150, openBasis: "seen" });
});

test("placings: rank by score desc, ties share a place", () => {
  const r = placings([{ id: "a", score: 5 }, { id: "b", score: 9 }, { id: "c", score: 5 }, { id: "d", score: 1 }]);
  assert.deepEqual(r.map((x) => [x.id, x.place]), [["b", 1], ["a", 2], ["c", 2], ["d", 4]]);
});

test("MatchLogs: one file per match, appends lines, reopens after close", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matchlogs-"));
  try {
    const logs = new MatchLogs(path.join(dir, "logs"), "bot", () => T);
    logs.log(1n, "match_start", { bagTotal: 70 });
    logs.log(2n, "match_start");
    logs.log(1n, "auction_seen", { letter: "E" });
    logs.close(1n);
    logs.log(1n, "word_rejected", { word: "QI" });
    logs.closeAll();
    const p1 = logs.pathFor(1n)!;
    assert.equal(path.basename(p1), "bot-1-20261107T123456Z.jsonl");
    const lines = fs.readFileSync(p1, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event), ["match_start", "auction_seen", "word_rejected"]);
    assert.equal(lines[0].bagTotal, 70);
    assert.equal(fs.readdirSync(path.join(dir, "logs")).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MatchLogs: never throws on I/O errors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matchlogs-"));
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const logs = new MatchLogs(path.join(blocker, "logs"), "bot", () => T);
    assert.doesNotThrow(() => logs.log(1n, "match_start"));
    assert.doesNotThrow(() => logs.log(1n, "match_end"));
    assert.equal(warned, 1);
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
