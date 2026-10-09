#!/usr/bin/env node
// Standalone regression: no server, secrets, storage, or network required.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

const source = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
const executable = source
  .replace(/^import \{ DurableObject \} from "cloudflare:workers";$/m, "class DurableObject {}")
  .replace(/^export \{ AdminDirectory \} from "\.\/admin-directory\.js";$/m, "")
  .replace(/^export default /m, "const worker = ")
  .replace(/^export class /gm, "class ");
assert(!/^\s*(?:import|export)\b/m.test(executable), "Worker module transform needs updating.");

let now = Date.parse("2026-10-09T04:00:00Z");
class TestDate extends Date { static now() { return now; } }
const { eventConfig, eventConfigs, EventCoordinator } = new Script(
  `${executable}\n;({ eventConfig, eventConfigs, EventCoordinator });`,
  { filename: "src/worker.js" },
).runInNewContext({ Date: TestDate, TextEncoder });
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

console.log("Config cache regression passed (3 scenarios).");
