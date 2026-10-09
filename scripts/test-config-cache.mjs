#!/usr/bin/env node
// Standalone regression: no server, secrets, storage, or network required.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

const source = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const executable = source
  .replace(/^import \{ DurableObject \} from "cloudflare:workers";$/m, "class DurableObject {}")
  .replace(/^import .* from "\.\/(?:organizer-auth|trial-ballot)\.js";$/gm, "")
  .replace(/^export \{ AdminDirectory \} from "\.\/admin-directory\.js";$/m, "")
  .replace(/^export default /m, "const worker = ")
  .replace(/^export class /gm, "class ");
assert(!/^\s*(?:import|export)\b/m.test(executable), "Worker module transform needs updating.");

let now = Date.parse("2026-10-09T04:00:00Z");
class TestDate extends Date { static now() { return now; } }
const { eventConfig, eventConfigs, EventCoordinator, resultsCacheControl, adminEvents } = new Script(
  `${executable}\n;({ eventConfig, eventConfigs, EventCoordinator, resultsCacheControl, adminEvents });`,
  { filename: "src/worker.js" },
).runInNewContext({ Date: TestDate, TextEncoder, URL });
const readState = (config) => EventCoordinator.prototype.configState.call({ getConfig: () => config });
const id = "0123456789abcdef01234567";
const base = { id, lifecycle: "published", opensAt: now + 100, closesAt: now + 3600_000, ballotVersion: "old" };
const environment = (configState) => ({
  EVENT_COORDINATOR: { getByName: (requestedId) => {
    assert.equal(requestedId, id);
    return { configState };
  } },
  EVENTS: { get: () => { throw new Error("Unexpected KV fallback."); } },
});

// The durable read is pending; its response arrives after editing and opening.
const oldState = readState(base);
assert.equal(oldState.cacheable, false);
let resolveRead;
const delayedRead = new Promise((resolve) => { resolveRead = resolve; });
const edited = { ...base, ballotVersion: "new" };
let calls = 0;
const delayedEnv = environment(() => ++calls === 1 ? delayedRead : readState(edited));
const pendingLookup = eventConfig(delayedEnv, id);
assert.equal(calls, 1);
now = base.opensAt + 1;
resolveRead(oldState);
assert.equal(await pendingLookup, base);
assert.equal(eventConfigs.has(id), false, "A delayed pending read must not become permanently cached.");
assert.equal((await eventConfig(delayedEnv, id)).ballotVersion, "new");
assert.equal(calls, 2, "The next request must read the edited ballot.");

// A draft remains editable even when its scheduled opening time is in the past.
eventConfigs.clear();
const draft = { ...edited, lifecycle: "draft" };
assert.equal(readState(draft).cacheable, false);
calls = 0;
const draftEnv = environment(() => { calls++; return readState(draft); });
await eventConfig(draftEnv, id);
assert.equal(eventConfigs.has(id), false);
await eventConfig(draftEnv, id);
assert.equal(calls, 2, "Draft configuration must be read again.");

// A configuration read authoritatively after opening can stay cached.
eventConfigs.clear();
assert.equal(readState(edited).cacheable, true);
calls = 0;
const openEnv = environment(() => { calls++; return readState(edited); });
assert.equal(await eventConfig(openEnv, id), edited);
assert.equal(eventConfigs.has(id), true);
assert.equal(await eventConfig(openEnv, id), edited);
assert.equal(calls, 1, "An opened ballot should reuse its cached read.");

const activeBallot = { ...edited, options: [{ id: "o1", label: "One" }, { id: "o2", label: "Two" }] };
const maxAge = (config, state, updatedAt) => {
  const header = resultsCacheControl(config, state, updatedAt);
  assert.match(header, /^public, max-age=\d+$/);
  return Number(header.match(/max-age=(\d+)/)[1]);
};

// Cache lifetimes include the shared snapshot's age and upcoming phase boundary.
const sampledAt = now;
assert.equal(maxAge(activeBallot, "open"), 1);
assert.equal(maxAge(activeBallot, "open", new Date(sampledAt).toISOString()), 1);
assert.equal(maxAge(activeBallot, "open", new Date(sampledAt + 1000).toISOString()), 1);
assert.equal(maxAge({ ...activeBallot, opensAt: now + 5000 }, "pending"), 1);
now = sampledAt + 1250;
assert.equal(maxAge(activeBallot, "open", new Date(sampledAt).toISOString()), 1);
assert.equal(maxAge({ ...activeBallot, closesAt: now + 500 }, "open"), 1);
assert.equal(maxAge({ ...activeBallot, opensAt: now + 500 }, "pending"), 1);
assert.equal(maxAge(activeBallot, "closed", new Date(sampledAt).toISOString()), 60);

const snapshotObject = (config, fetchShard) => ({
  env: { VOTE_SHARD: { idFromName: (name) => name, get: () => ({ fetch: fetchShard }) } },
  getConfig: () => config,
  displaySettings: () => ({ resultsVisibility: "after-close" }),
  snapshotValue: null,
  refreshPromise: null,
});
const snapshot = (object) => EventCoordinator.prototype.snapshot.call(object);

// Concurrent readers share one 128-shard aggregation, reused until 1s expiry.
let releaseShards;
const shardGate = new Promise((resolve) => { releaseShards = resolve; });
let shardReads = 0;
const shared = snapshotObject(activeBallot, async () => {
  shardReads++;
  await shardGate;
  return { ok: true, json: async () => ({ turnout: 1, counts: { o1: 1 } }) };
});
const firstSnapshot = snapshot(shared);
const concurrentSnapshot = snapshot(shared);
releaseShards();
const tallies = await Promise.all([firstSnapshot, concurrentSnapshot]);
assert.equal(shardReads, 128, "Concurrent snapshots must share a single shard scan.");
for (const tally of tallies) {
  assert.equal(tally.turnout, 128);
  assert.equal(tally.counts.o1, 128);
}
const refreshedAt = shared.snapshotValue.refreshedAt;
now = refreshedAt + 999;
await snapshot(shared);
assert.equal(shardReads, 128, "A snapshot younger than 1s must be reused.");
now = refreshedAt + 1000;
await snapshot(shared);
assert.equal(shardReads, 256, "A snapshot must refresh at 1s expiry.");

// Draft and pending ballots have no votes and must never wake vote shards.
for (const [lifecycle, opensAt, expectedPhase] of [
  ["draft", now - 1000, "draft"],
  ["published", now + 1000, "pending"],
]) {
  let reads = 0;
  const object = snapshotObject({ ...activeBallot, lifecycle, opensAt }, () => {
    reads++;
    throw new Error("Draft/pending snapshot must not read shards.");
  });
  const tally = await snapshot(object);
  assert.equal(tally.phase, expectedPhase);
  assert.equal(tally.turnout, 0);
  assert.equal(tally.counts.o1, 0);
  assert.equal(tally.counts.o2, 0);
  assert.equal(reads, 0);
}

// Revocation between authentication and quota lookup must fail closed. Null
// means disabled/missing; valid unrestricted staff receive { limit: null }.
const revokedDirectory = {
  session: async () => ({ id, role: "organizer", selfRegistered: true }),
  getCreationQuota: async () => null,
  getReservedEvent: () => { throw new Error("Revoked account reached event recovery."); },
};
for (const method of ["GET", "POST"]) {
  const request = new Request("http://127.0.0.1/api/admin/events", { method, headers: { Cookie: "wv_admin=fixture" } });
  await assert.rejects(adminEvents(request, { ADMIN_DIRECTORY: { getByName: () => revokedDirectory } }), error => error.status === 401,
    "Revoked quota cannot become unlimited creation or management.");
}
console.log("Config/result cache and account revocation regression passed (8 scenarios).");
