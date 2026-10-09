import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Deliberately restricted to local development: this creates disposable events.
const base = new URL(process.argv[2] || "http://localhost:8800");
assert.ok(["localhost", "127.0.0.1"].includes(base.hostname), "Run smoke tests locally only.");
const vars = await readFile(".dev.vars", "utf8");
const key = /^ADMIN_DASHBOARD_KEY="?([^"\r\n]+)"?$/m.exec(vars)?.[1];
assert.ok(key, "Run setup:dev or add a local ADMIN_DASHBOARD_KEY.");
let checks = 0;
async function api(path, { method = "GET", body, auth = false, cookie, headers = {} } = {}, status = 200) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...headers,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, status, `${method} ${path}: HTTP ${response.status}`);
  checks++;
  return { data: await response.json(), response };
}
async function create(overrides = {}) {
  const { data } = await api("/api/admin/events", {
    method: "POST", auth: true,
    body: { name: "Local smoke test", question: "Choose one", options: ["A", "B"],
      opensAt: new Date(Date.now() - 1000).toISOString(),
      closesAt: new Date(Date.now() + 60_000).toISOString(), ...overrides },
  }, 201);
  return data.event;
}
await api("/api/admin/events", {}, 401);
await api("/api/admin/events", { auth: true, method: "POST", body: { name: "invalid" } }, 400);
await api("/api/admin/events", { auth: true, method: "POST", body: "x".repeat(8200) }, 413);
const scheduled = await create({ opensAt: new Date(Date.now() + 60_000).toISOString(), closesAt: new Date(Date.now() + 120_000).toISOString() });
assert.equal((await api(`/api/events/${scheduled.id}/results`)).data.phase, "pending");
await api(`/api/events/${scheduled.id}/vote`, { method: "POST", body: { optionId: "o1", turnstileToken: "test" } }, 403);

await api("/api/admin/events", { method: "POST", auth: true, body: {
  name: "Too many options", question: "Choose one", options: Array.from({ length: 21 }, (_, i) => `Option ${i + 1}`),
  opensAt: new Date(Date.now() - 1000).toISOString(), closesAt: new Date(Date.now() + 60_000).toISOString(),
} }, 400);
const maximumOptions = Array.from({ length: 20 }, (_, i) => `方案${i + 1}`.padEnd(100, "選"));
const event = await create({ name: "名".repeat(100), question: "題".repeat(300), options: maximumOptions,
  closesAt: new Date(Date.now() + 24_000).toISOString() });
const route = `/api/events/${event.id}`;
const open = (await api(`${route}/results`)).data;
assert.equal(open.phase, "open");
assert.equal(open.options.length, 20);
assert.equal(open.counts, null);
const identity = await api(`${route}/identity`);
const cookie = identity.response.headers.get("Set-Cookie").split(";")[0];
assert.match(identity.response.headers.get("Set-Cookie"), /HttpOnly/);
await api(`${route}/vote`, { method: "POST", body: { optionId: "o1", turnstileToken: "test" } }, 403);
await api(`${route}/vote`, { method: "POST", cookie: cookie + "bad", body: { optionId: "o1", turnstileToken: "test" } }, 403);
await api(`${route}/vote`, { method: "POST", cookie, headers: { Origin: "https://other.example" }, body: { optionId: "o1" } }, 403);
await api(`${route}/vote`, { method: "POST", cookie, body: { optionId: "invalid" } }, 400);
await api(`${route}/vote`, { method: "POST", cookie, body: { optionId: "o1", ballotVersion: open.ballotVersion } }, 403);
const cast = { method: "POST", cookie, body: { optionId: "o20", turnstileToken: "test", ballotVersion: open.ballotVersion } };
await api(`${route}/vote`, { ...cast, body: { ...cast.body, ballotVersion: "stale-version" } }, 409);
await api(`${route}/vote`, cast);
assert.equal((await api(`${route}/vote`, cast)).data.duplicate, true);
await api(`${route}/vote`, { ...cast, body: { ...cast.body, optionId: "o2" } }, 409);
await api(`/api/admin/events/${event.id}/export?shard=0`, { auth: true }, 403);
await api(`${route}/results?random=1`, {}, 400);
await api(`${route}/identity`, { method: "POST" }, 405);

const isolated = await create();
const isolatedResult = (await api(`/api/events/${isolated.id}/results`)).data;
assert.equal(isolatedResult.turnout, 0);
// Wait only for the deliberately short local event, then verify the boundary.
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(event.closesAt) - Date.now() + 100)));
const closed = (await api(`${route}/results`)).data;
assert.equal(closed.phase, "closed");
assert.equal(closed.turnout, 1);
assert.deepEqual(closed.counts, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`o${i + 1}`, i === 19 ? 1 : 0])));
await api(`${route}/vote`, cast, 403);
await api(`/api/admin/events/${event.id}/export?shard=0`, {}, 401);
await api(`/api/admin/events/${event.id}/export?shard=128`, { auth: true }, 400);
const exports = await Promise.all(Array.from({ length: 128 }, (_, shard) => api(`/api/admin/events/${event.id}/export?shard=${shard}`, { auth: true })));
const rows = exports.flatMap(({ data }) => data.rows);
assert.equal(rows.length, 1);
assert.equal(rows[0].option_id, "o20");
console.log(`Passed ${checks} local API checks: event timing, privacy, identity, duplicate votes, event isolation and complete export.`);
