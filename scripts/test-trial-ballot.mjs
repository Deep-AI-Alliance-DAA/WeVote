#!/usr/bin/env node
// Real SQLite unit checks for trial storage. This is not a workerd concurrency
// or burst-capacity test; HTTP/runtime behavior is covered by local API tests.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { initTrialBallot, recordTrialVote, readTrialResults, exportTrialVotes, normalizeOptionIds, storedOptionIds, exportVoteRow } from "../src/trial-ballot.js";

const now = Date.now();
const databases = [];
const workspace = await mkdtemp(join(tmpdir(), "wevote-trial-test-"));
let checks = 0;
function equal(actual, expected, label) { checks++; assert.deepEqual(actual, expected, label); }
function check(condition, label) { checks++; assert.ok(condition, label); }

function context(filename = ":memory:", beforeInit) {
  const db = new DatabaseSync(filename);
  databases.push(db);
  const prepared = new Map();
  const sql = {
    fail: null,
    exec(query, ...bindings) {
      if (sql.fail?.(query)) throw new Error("Synthetic SQL write failure");
      let statement = prepared.get(query);
      if (!statement) { statement = db.prepare(query); prepared.set(query, statement); }
      const reads = /^\s*(?:SELECT|EXPLAIN|PRAGMA)\b/i.test(query);
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
  beforeInit?.(db);
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
      equal(Object.keys(row).sort(), ["created_at", "option_id", "option_ids", "voter_hash"], "Export contains hashes and unambiguous selections, without internal shard metadata");
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

  const multiple = context();
  const multipleBallot = config({ maxChoices: 2, trial: { voteLimit: 2, maxDurationHours: 24 } });
  const multiVote = { voterHash: hash(0), optionIds: ["o2", "o1"], ballotVersion: "current-version" };
  equal((await recordTrialVote(multiple, multipleBallot, multiVote, now)).status, 200, "A two-choice ballot is accepted");
  equal(readTrialResults(multiple.storage.sql, multipleBallot), { turnout: 1, counts: { o1: 1, o2: 1, o3: 0 } }, "Multiple selections consume one ballot and increment each option once");
  equal((await recordTrialVote(multiple, multipleBallot, { ...multiVote, optionIds: ["o1", "o2"] }, now)).body.duplicate, true, "Selection order does not change duplicate identity");
  equal((await recordTrialVote(multiple, multipleBallot, { ...multiVote, optionIds: ["o1", "o3"] }, now)).status, 409, "Changing a previously submitted set is rejected");
  for (const optionIds of [[], ["o1", "o1"], ["o1", "o2", "o3"], ["o1", "missing"], "o1", null]) {
    equal((await recordTrialVote(multiple, multipleBallot, { ...multiVote, voterHash: hash(1), optionIds, maxChoices: 20 }, now)).status, 400, "Empty, duplicate, excessive and invalid selections do not consume quota");
  }
  equal((await recordTrialVote(multiple, multipleBallot, { ...multiVote, optionId: "o1" }, now)).status, 400, "Mixed single and multiple request fields are rejected");
  equal((await recordTrialVote(multiple, multipleBallot, vote(1, "o3"), now)).status, 200, "Legacy single input remains valid on a multiple-choice event");
  equal((await recordTrialVote(multiple, multipleBallot, { ...multiVote, voterHash: hash(2) }, now)).body.code, "TRIAL_VOTE_LIMIT", "Two ballots reach the cap even though their option tally sums to three");
  equal(readTrialResults(multiple.storage.sql, multipleBallot), { turnout: 2, counts: { o1: 1, o2: 1, o3: 1 } }, "Trial limit and turnout count ballots rather than selections");
  const multiRows = exportTrialVotes(multiple.storage.sql, multipleBallot, { index: 0 }).rows;
  equal(multiRows.length, 1, "A multi-choice ballot is exported once");
  equal(multiRows[0].option_ids, ["o1", "o2"], "Export includes the complete canonical selection array");
  equal(multiRows[0].option_id, "", "Multi-choice export does not pretend one option represents the whole ballot");
  equal(exportTrialVotes(multiple.storage.sql, multipleBallot, { index: 1 }).rows[0].option_id, "o3", "Single-choice export preserves its legacy option_id");
  equal((await recordTrialVote(multiple, multipleBallot, { ...multiVote, optionIds: ["o1", "o2"] }, now)).body.duplicate, true, "A multi-choice duplicate succeeds at the trial cap without changing counters");

  const oldTrial = context(":memory:", db => {
    db.exec("CREATE TABLE trial_votes (voter_hash TEXT PRIMARY KEY, shard INTEGER NOT NULL, option_id TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE trial_counts (option_id TEXT PRIMARY KEY, total INTEGER NOT NULL); CREATE TABLE trial_totals (singleton INTEGER PRIMARY KEY, total INTEGER NOT NULL)");
    db.prepare("INSERT INTO trial_votes VALUES (?, 0, 'o1', ?)").run(hash(0), now);
    db.exec("INSERT INTO trial_counts VALUES ('o1', 1); INSERT INTO trial_totals VALUES (1, 1)");
  });
  equal(readTrialResults(oldTrial.storage.sql, ballot), { turnout: 1, counts: { o1: 1, o2: 0, o3: 0 } }, "A pre-migration single-choice trial retains its turnout and tally");
  equal((await recordTrialVote(oldTrial, ballot, vote(0, "o1"), now)).body.duplicate, true, "Legacy rows still recognize idempotent single-choice retries");
  equal(exportTrialVotes(oldTrial.storage.sql, ballot, { index: 0 }).rows[0].option_ids, ["o1"], "Legacy trial rows export their exact preserved choice as an array");
  equal((await recordTrialVote(oldTrial, ballot, { voterHash: hash(1), optionIds: ["o1", "o2"], ballotVersion: "current-version" }, now)).status, 400, "Existing events default to one selection after migration");

  const multiRollback = context();
  multiRollback.storage.sql.fail = query => query.startsWith("INSERT INTO trial_counts") && multiRollback.storage.sql.exec("SELECT COUNT(*) AS total FROM trial_counts").one().total === 1;
  equal((await recordTrialVote(multiRollback, multipleBallot, multiVote, now)).status, 503, "Failure during the second option tally does not report acceptance");
  multiRollback.storage.sql.fail = null;
  equal(readTrialResults(multiRollback.storage.sql, multipleBallot), { turnout: 0, counts: { o1: 0, o2: 0, o3: 0 } }, "All selections, the ledger and ballot quota roll back together");

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
  for (const maxChoices of [null, 0, 4, 1.5, "2", Infinity]) {
    equal((await recordTrialVote(invalid, config({ maxChoices }), vote(0), now)).status, 503, "Malformed authoritative selection limits fail closed");
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

  // Exercise staff shard migrations and pinned selection limits with the same
  // real SQLite adapter. HTTP routing remains covered by the runtime suites.
  const source = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
  const executable = source
    .replace(/^import \{ DurableObject \} from "cloudflare:workers";$/m, "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }")
    .replace(/^import .* from "\.\/(?:organizer-auth|trial-ballot|billing)\.js";$/gm, "")
    .replace(/^export \{ AdminDirectory \} from "\.\/admin-directory\.js";$/m, "")
    .replace(/^export default /m, "const worker = ")
    .replace(/^export class /gm, "class ");
  const VoteShard = new Script(`${executable}\n;VoteShard;`, { filename: "src/worker.js" }).runInNewContext({
    TextEncoder, URL, Response, Date, normalizeOptionIds, storedOptionIds, exportVoteRow,
  });
  const eventId = "0123456789abcdef01234567";
  let authoritative = { ...config({ maxChoices: 2 }), id: eventId };
  let reads = 0;
  const shardEnvironment = { EVENT_COORDINATOR: { getByName: id => {
    equal(id, eventId, "Shard loads only its event's authoritative ballot");
    return { getConfig: async () => { reads++; return authoritative; } };
  } } };
  const staffContext = context();
  const staff = new VoteShard(staffContext, shardEnvironment);
  const staffVote = async (data, target = staff) => {
    const response = await target.fetch(new Request("https://shard.internal/vote", { method: "POST", body: JSON.stringify({ eventId, createdAt: now, closesAt: now + 3_600_000, ...data }) }));
    return { status: response.status, body: await response.json() };
  };
  equal((await staffVote(multiVote)).status, 200, "Staff shard accepts multiple choices under its authoritative limit");
  equal(await (await staff.fetch(new Request("https://shard.internal/count"))).json(), { turnout: 1, counts: { o1: 1, o2: 1 } }, "Staff turnout counts ballots once with separate option tallies");
  equal((await staffVote({ ...multiVote, optionIds: ["o1", "o2"] })).body.duplicate, true, "Staff shard duplicates compare unordered sets");
  equal((await staffVote({ ...multiVote, optionIds: ["o2", "o3"] })).status, 409, "Staff shard rejects a changed selection set");
  authoritative = { ...authoritative, maxChoices: 3 };
  equal((await staffVote({ ...multiVote, voterHash: hash(2), optionIds: ["o1", "o2", "o3"], maxChoices: 3 })).status, 400, "Once opened, the pinned shard ignores attempted limit expansion");
  equal((await staffVote({ ...multiVote, voterHash: hash(2), ballotVersion: "old" })).status, 409, "Staff ballot version remains authoritative");
  equal(reads, 1, "Opened shard uses its persisted authoritative selection limit");
  equal((await staffVote(vote(1, "o3"))).status, 200, "Staff multiple-choice ballots still support old optionId requests");
  const staffExport = await (await staff.fetch(new Request("https://shard.internal/export"))).json();
  equal(staffExport.rows.length, 2, "Staff export includes each submitted ballot once");
  equal(staffExport.rows[0].option_ids, ["o1", "o2"], "Staff export includes every selected option");
  equal(staffExport.rows[1].option_id, "o3", "Staff export retains single-choice option_id compatibility");
  new VoteShard(staffContext, shardEnvironment);
  equal(await (await staff.fetch(new Request("https://shard.internal/count"))).json(), { turnout: 2, counts: { o1: 1, o2: 1, o3: 1 } }, "Repeated shard schema initialization preserves turnout and all option tallies");

  const legacyStaffContext = context(":memory:", db => {
    db.exec("CREATE TABLE votes (voter_hash TEXT PRIMARY KEY, option_id TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE counts (option_id TEXT PRIMARY KEY, total INTEGER NOT NULL); CREATE TABLE ballot (singleton INTEGER PRIMARY KEY, version TEXT NOT NULL, options_json TEXT NOT NULL)");
    db.prepare("INSERT INTO votes VALUES (?, 'o1', ?)").run(hash(0), now);
    db.exec("INSERT INTO counts VALUES ('o1', 1); INSERT INTO ballot VALUES (1, 'current-version', '[\"o1\",\"o2\",\"o3\"]')");
  });
  const oldStaff = new VoteShard(legacyStaffContext, shardEnvironment);
  equal(await (await oldStaff.fetch(new Request("https://shard.internal/count"))).json(), { turnout: 1, counts: { o1: 1 } }, "Existing shard turnout migrates from the preserved ballot ledger");
  equal((await staffVote(vote(0, "o1"), oldStaff)).body.duplicate, true, "Existing shard rows retain single-choice idempotency");
  equal((await staffVote({ ...multiVote, voterHash: hash(1) }, oldStaff)).status, 400, "An already pinned legacy ballot stays single-choice after migration");
  equal((await (await oldStaff.fetch(new Request("https://shard.internal/export"))).json()).rows[0].option_ids, ["o1"], "Legacy shard export contains its exact original choice");
  equal(legacyStaffContext.storage.sql.exec("SELECT max_choices FROM ballot WHERE singleton = 1").one().max_choices, 1, "Legacy ballot migration defaults to a one-choice cap");

  const staffRollbackContext = context();
  const staffRollback = new VoteShard(staffRollbackContext, shardEnvironment);
  authoritative = { ...authoritative, maxChoices: 2 };
  staffRollbackContext.storage.sql.fail = query => query.startsWith("INSERT INTO counts") && staffRollbackContext.storage.sql.exec("SELECT COUNT(*) AS total FROM counts").one().total === 1;
  checks++; await assert.rejects(staffVote(multiVote, staffRollback), /Synthetic SQL write failure/, "A staff tally failure never reports successful acceptance");
  staffRollbackContext.storage.sql.fail = null;
  equal(await (await staffRollback.fetch(new Request("https://shard.internal/count"))).json(), { turnout: 0, counts: {} }, "Staff ledger and every selection counter roll back atomically");
  equal(staffRollbackContext.storage.sql.exec("SELECT COUNT(*) AS total FROM votes").one().total, 0, "Staff partial tally failure leaves no submitted ballot");
  equal((await staffVote(multiVote, staffRollback)).status, 200, "Staff retry after rollback records the complete set once");

  const legacyTicketContext = context();
  const legacyTicket = new VoteShard(legacyTicketContext, {});
  const ticketVote = data => legacyTicket.fetch(new Request("https://shard.internal/vote", { method: "POST", body: JSON.stringify({ ...data, createdAt: now, closesAt: now + 3_600_000 }) }));
  equal((await ticketVote(vote(0, "o1"))).status, 200, "The original non-event ticket API still records single optionId votes");
  equal((await ticketVote({ voterHash: hash(1), optionIds: ["o1", "o2"] })).status, 400, "The original non-event ticket poll remains single-choice");

  console.log(`Passed ${checks} real-SQLite ballot checks: exact 10,000 cap, multi-choice turnout/idempotency/rollback, staff and trial migrations, durability, pinned limits and complete partitioned exports.`);
} finally {
  for (const db of databases) db.close();
  await rm(workspace, { recursive: true, force: true });
}
