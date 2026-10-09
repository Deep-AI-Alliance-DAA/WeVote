#!/usr/bin/env node
// Real SQLite unit checks for trial storage. This is not a workerd concurrency
// or burst-capacity test; HTTP/runtime behavior is covered by local API tests.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTrialBallot, recordTrialVote, readTrialResults, exportTrialVotes } from "../src/trial-ballot.js";

const now = Date.now();
const databases = [];
const workspace = await mkdtemp(join(tmpdir(), "wevote-trial-test-"));
let checks = 0;
function equal(actual, expected, label) { checks++; assert.deepEqual(actual, expected, label); }
function check(condition, label) { checks++; assert.ok(condition, label); }

function context(filename = ":memory:") {
  const db = new DatabaseSync(filename);
  databases.push(db);
  const prepared = new Map();
  const sql = {
    fail: null,
    exec(query, ...bindings) {
      if (sql.fail?.(query)) throw new Error("Synthetic SQL write failure");
      let statement = prepared.get(query);
      if (!statement) { statement = db.prepare(query); prepared.set(query, statement); }
      const reads = /^\s*(?:SELECT|EXPLAIN)\b/i.test(query);
      const rows = reads ? statement.all(...bindings).map(row => ({ ...row })) : [];
      const result = reads ? {} : statement.run(...bindings);
      return { toArray: () => rows, one: () => {
        assert.equal(rows.length, 1); return rows[0];
      }, rowsWritten: Number(result.changes || 0) };
    },
  };
  const storage = {
    sql, syncs: 0, syncHook: null,
    transactionSync(callback) {
      db.exec("BEGIN");
      try { const result = callback(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async sync() { storage.syncs++; if (storage.syncHook) await storage.syncHook(); },
  };
  initTrialBallot(sql);
  return { storage, db };
}

function config(overrides = {}) {
  return {
    trial: { voteLimit: 10_000, maxDurationHours: 24 }, lifecycle: "published",
    opensAt: new Date(now - 1000).toISOString(), closesAt: new Date(now + 3_600_000).toISOString(),
    ballotVersion: "current-version", options: [{ id: "o1" }, { id: "o2" }, { id: "o3" }], ...overrides,
  };
}
function hash(index, prefix = index % 256) {
  return prefix.toString(16).padStart(2, "0") + BigInt(index).toString(16).padStart(62, "0");
}
function vote(index, optionId = `o${index % 3 + 1}`, prefix) {
  return { voterHash: hash(index, prefix), optionId, ballotVersion: "current-version" };
}

try {
  const ctx = context();
  const ballot = config();
  equal(readTrialResults(ctx.storage.sql, ballot), { turnout: 0, counts: { o1: 0, o2: 0, o3: 0 } }, "Every option starts at zero");
  for (let first = 0; first < 9999; first += 64) {
    const results = await Promise.all(Array.from({ length: Math.min(64, 9999 - first) }, (_, offset) => recordTrialVote(ctx, ballot, vote(first + offset), now)));
    check(results.every(result => result.status === 200 && !result.body.duplicate), "Concurrent promise batches record unique votes");
  }
  equal(readTrialResults(ctx.storage.sql, ballot).turnout, 9999, "The actual tally reaches 9,999 before its boundary");
  equal(await recordTrialVote(ctx, ballot, { ...vote(9999), createdAt: 1, closesAt: now - 1, voteLimit: 99_999 }, now), { status: 200, body: { ok: true, recorded: true } }, "The actual 10,000th vote is admitted using authoritative limits/deadline");
  const denied = await recordTrialVote(ctx, ballot, { ...vote(10000), voteLimit: 99_999 }, now);
  equal(denied.status, 403, "The 10,001st vote is rejected");
  equal(denied.body.code, "TRIAL_VOTE_LIMIT", "The client gets a bounded trial limit error");
  equal(await recordTrialVote(ctx, ballot, vote(9999), now), { status: 200, body: { ok: true, recorded: true, duplicate: true } }, "Same-choice retry still succeeds at the cap");
  equal((await recordTrialVote(ctx, ballot, vote(9999, "o2"), now)).status, 409, "Changed choice remains rejected at the cap");
  equal(readTrialResults(ctx.storage.sql, ballot), { turnout: 10_000, counts: { o1: 3334, o2: 3333, o3: 3333 } }, "Mixed choices tally exactly with no extra accepted vote");
  equal(ctx.storage.sql.exec("SELECT created_at FROM trial_votes WHERE voter_hash = ?", hash(9999)).one().created_at, now, "Stored time comes only from server now");
  equal(ctx.storage.sql.exec("SELECT COUNT(*) AS total FROM trial_votes").one().total, 10_000, "The physical ledger stops at 10,000");
  initTrialBallot(ctx.storage.sql);
  equal(readTrialResults(ctx.storage.sql, ballot).turnout, 10_000, "Schema reinitialization preserves votes");

  const exported = new Set();
  for (let index = 0; index < 128; index++) {
    const page = exportTrialVotes(ctx.storage.sql, ballot, { index });
    equal(page.next, null, "Distributed shard fixture fits a single page");
    for (const row of page.rows) {
      check(!exported.has(row.voter_hash), "Export partitions do not overlap");
      equal(Number.parseInt(row.voter_hash.slice(0, 2), 16) % 128, index, "Each exported hash belongs to the requested partition");
      equal(Object.keys(row).sort(), ["created_at", "option_id", "voter_hash"], "Export contains hashes only, without internal shard metadata");
      exported.add(row.voter_hash);
    }
  }
  equal(exported.size, 10_000, "All 128 partitions export every vote exactly once");
  check(Array.from({ length: 10_000 }, (_, index) => hash(index)).every(value => exported.has(value)), "No known voter hash is omitted");

  const paged = context();
  await Promise.all(Array.from({ length: 1001 }, (_, index) => recordTrialVote(paged, ballot, vote(index, "o1", 0), now)));
  const pages = [];
  let after = "";
  do {
    const page = exportTrialVotes(paged.storage.sql, ballot, { index: 0, after });
    pages.push(page); after = page.next;
  } while (after);
  equal(pages.map(page => page.rows.length), [500, 500, 1], "Cursor pages are strictly bounded at 500 rows");
  const pagedHashes = pages.flatMap(page => page.rows.map(row => row.voter_hash));
  equal(new Set(pagedHashes).size, 1001, "Cursor pages have no overlap");
  equal(pagedHashes, Array.from({ length: 1001 }, (_, index) => hash(index, 0)), "Cursor ordering omits no vote across page boundaries");
  for (const args of [{ index: -1 }, { index: 128 }, { index: 1.5 }, { index: "0" }, { index: 0, after: "bad" }, { index: 0, after: "F".repeat(64) }]) {
    checks++; assert.throws(() => exportTrialVotes(paged.storage.sql, ballot, args), error => error.status === 400);
  }

  const small = context();
  const limitOne = config({ trial: { voteLimit: 1, maxDurationHours: 24 } });
  const racing = await Promise.all(Array.from({ length: 20 }, (_, index) => recordTrialVote(small, limitOne, vote(index), now)));
  equal(racing.filter(result => result.status === 200).length, 1, "Competing promise calls cannot exceed the shared cap");
  equal(racing.filter(result => result.body.code === "TRIAL_VOTE_LIMIT").length, 19, "All over-cap promises are refused");
  const retries = await Promise.all(Array.from({ length: 20 }, () => recordTrialVote(small, limitOne, vote(0), now)));
  check(retries.every(result => result.status === 200 && result.body.duplicate), "Concurrent same-hash retries are idempotent at cap");
  equal(readTrialResults(small.storage.sql, limitOne).turnout, 1, "Retry promises do not add votes");

  const rollback = context();
  rollback.storage.sql.fail = query => query.startsWith("INSERT INTO trial_counts");
  equal((await recordTrialVote(rollback, ballot, vote(0), now)).status, 503, "Interrupted count write never reports acceptance");
  equal(rollback.storage.sql.exec("SELECT COUNT(*) AS total FROM trial_votes").one().total, 0, "Atomic rollback removes the inserted vote");
  equal(readTrialResults(rollback.storage.sql, ballot).turnout, 0, "Atomic rollback preserves all counters");
  rollback.storage.sql.fail = null;
  equal((await recordTrialVote(rollback, ballot, vote(0), now)).status, 200, "Retry after SQL rollback records the vote once");

  const durable = context(join(workspace, "trial.sqlite"));
  durable.storage.syncHook = () => { throw new Error("Synthetic durability failure"); };
  equal((await recordTrialVote(durable, ballot, vote(0), now)).status, 503, "Unconfirmed durability never reports successful acceptance");
  equal(readTrialResults(durable.storage.sql, ballot).turnout, 1, "Committed SQL remains available for an idempotent retry");
  durable.storage.syncHook = null;
  equal((await recordTrialVote(durable, ballot, vote(0), now)).body.duplicate, true, "Durability retry confirms the same committed vote");
  durable.db.close(); databases.splice(databases.indexOf(durable.db), 1);
  const reopened = context(join(workspace, "trial.sqlite"));
  equal(readTrialResults(reopened.storage.sql, ballot).turnout, 1, "Counts survive SQLite close/reopen");
  equal((await recordTrialVote(reopened, ballot, vote(0), now)).body.duplicate, true, "A reopened ledger still prevents duplicate votes");

  const gated = context();
  let release;
  gated.storage.syncHook = () => new Promise(resolve => { release = resolve; });
  let replied = false;
  const pending = recordTrialVote(gated, ballot, vote(0), now).then(result => { replied = true; return result; });
  await Promise.resolve();
  equal(replied, false, "A response waits until storage.sync resolves");
  release();
  equal((await pending).status, 200, "Confirmed durable write returns success");

  const invalid = context();
  for (const voteLimit of [undefined, 0, -1, 10001, 1.5, "10000", Infinity, NaN]) {
    const bad = config({ trial: { voteLimit, maxDurationHours: 24 } });
    equal((await recordTrialVote(invalid, bad, vote(0), now)).status, 503, "Invalid trial cap fails closed");
    checks++; assert.throws(() => readTrialResults(invalid.storage.sql, bad), error => error.status === 503);
  }
  for (const maxDurationHours of [undefined, 0, 25, "24", Infinity]) {
    equal((await recordTrialVote(invalid, config({ trial: { voteLimit: 10000, maxDurationHours } }), vote(0), now)).status, 503, "Invalid duration limit fails closed");
  }
  for (const bad of [config({ trial: undefined }), config({ opensAt: "invalid" }), config({ closesAt: config().opensAt }),
    config({ closesAt: new Date(now - 1000 + 24 * 3_600_000 + 1).toISOString() }),
    config({ options: [{ id: "o1" }, { id: "o1" }] }), config({ lifecycle: "unknown" })]) {
    equal((await recordTrialVote(invalid, bad, vote(0), now)).status, 503, "Malformed authoritative configuration cannot accept votes");
  }
  for (const boundary of [config({ lifecycle: "draft" }), config({ opensAt: new Date(now + 1).toISOString() }), config({ closesAt: new Date(now).toISOString() })]) {
    equal((await recordTrialVote(invalid, boundary, vote(0), now)).status, 403, "Draft, pending and exact closing boundary reject votes");
  }
  equal((await recordTrialVote(invalid, config({ opensAt: new Date(now).toISOString(), closesAt: new Date(now + 24 * 3_600_000).toISOString() }), vote(0), now)).status, 200, "Exact opening boundary and exact 24-hour duration are allowed");
  equal((await recordTrialVote(invalid, ballot, { ...vote(1), ballotVersion: "stale" }, now)).status, 409, "Stale ballot version is rejected");
  for (const data of [null, [], { ...vote(1), voterHash: "f".repeat(63) }, { ...vote(1), voterHash: "F".repeat(64) },
    { ...vote(1), optionId: "unknown" }, { ...vote(1), optionId: "x".repeat(33) }, { ...vote(1), ballotVersion: "x".repeat(65) }]) {
    equal((await recordTrialVote(invalid, ballot, data, now)).status, 400, "Malformed bounded input is rejected");
  }
  equal(readTrialResults(invalid.storage.sql, ballot).turnout, 1, "Rejected configuration/input/boundaries do not write votes");
  console.log(`Passed ${checks} real-SQLite trial ballot checks: exact 10,000 cap, idempotency, rollback/durability, timing, bounded inputs and complete partitioned exports.`);
} finally {
  for (const db of databases) db.close();
  await rm(workspace, { recursive: true, force: true });
}
