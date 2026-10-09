#!/usr/bin/env node
// Run only through test-local.mjs: accounts/sessions and interrupted intents
// are seeded by a guarded wrapper that exists solely in its disposable folder.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const base = new URL(process.argv[2] || "http://127.0.0.1:8799");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && base.protocol === "http:" && !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash, "Signup integration requires an uncredentialed localhost URL.");
const marker = JSON.parse(await readFile(new URL("../.local-fixture.json", import.meta.url), "utf8"));
assert.equal(marker.kind, "disposable-wevote-integration", "Only the disposable runner may seed signup fixtures.");
const vars = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
assert.match(vars, /^LOCAL_TEST_FIXTURES="disposable-only"$/m, "Disposable fixture switch missing.");
const rootKey = /^ADMIN_DASHBOARD_KEY="([a-f0-9]{64})"$/m.exec(vars)?.[1];
assert.ok(rootKey, "Generated local owner key missing.");
const origin = base.origin;
const localIp = `198.51.100.${1 + randomBytes(1)[0] % 250}`;
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks++; };

async function api(path, { method = "GET", body, cookie, owner = false, requestId, requestOrigin = origin, status = 200 } = {}) {
  const response = await fetch(new URL(path, origin), {
    method, redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { Origin: requestOrigin, "CF-Connecting-IP": localIp, ...(owner ? { Authorization: `Bearer ${rootKey}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(requestId ? { "Idempotency-Key": requestId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const allowed = Array.isArray(status) ? status : [status];
  check(allowed.includes(response.status), `${method} ${path}: unexpected HTTP ${response.status}`);
  if (path.startsWith("/api/admin/") || path.startsWith("/api/__local_test__/")) equal(response.headers.get("Cache-Control"), "no-store", "Private response cannot be cached");
  let data;
  try { data = await response.json(); } catch { throw new Error(`${method} ${path}: JSON response expected`); }
  return { data, status: response.status, response };
}

async function seed(suffix) {
  const { data } = await api("/api/__local_test__/seed-account", { method: "POST", owner: true, status: 201,
    body: { provider: "google", subject: `offline-signup-${suffix}-${randomUUID()}`, name: `Local signup ${suffix}` } });
  check(data.principal.selfRegistered && data.principal.role === "organizer" && data.cookie.startsWith("wv_admin="), "Fixture uses an actual organizer and stored session");
  return data;
}

function eventBody(overrides = {}) {
  const opened = Date.now() + 300_000;
  return { name: "Disposable signup event", question: "Choose one synthetic option", options: ["A", "B"], lifecycle: "draft",
    resultsVisibility: "live", opensAt: new Date(opened).toISOString(), closesAt: new Date(opened + 3_600_000).toISOString(), ...overrides };
}

async function create(account, body = eventBody(), requestId = randomUUID(), status = 201) {
  return api("/api/admin/events", { method: "POST", cookie: account.cookie, body, requestId, status });
}

async function quota(account) {
  const { data } = await api("/api/admin/me", { cookie: account.cookie });
  equal(data.principal.id, account.principal.id, "Session resolves correct account");
  return data.creationQuota;
}

function reservedConfig(account, body, id) {
  return { ...body, id, ownerId: account.principal.id, ballotVersion: randomBytes(8).toString("hex"),
    options: body.options.map((label, i) => ({ id: `o${i + 1}`, label })), createdAt: new Date(Date.now() - 1000).toISOString(), mode: "public-link",
    presentation: { theme: "ink", organizer: "", description: "", logoUrl: "", coverUrl: "" }, trial: { voteLimit: 10_000, maxDurationHours: 24 } };
}

async function inspect(eventId, shardIndexes = []) {
  return (await api("/api/__local_test__/inspect-storage", { method: "POST", owner: true, body: { eventId, shardIndexes } })).data;
}

function voterHash(eventId, cookie) {
  const randomId = cookie.split("=")[1].split(".")[0];
  return createHash("sha256").update(`${eventId}:${randomId}`).digest("hex");
}

const providers = (await api("/api/auth/providers")).data;
check(providers.google === false && providers.apple === false, "Disposable Worker has no provider credentials");
equal(providers.trial.eventLimit, 1, "Published signup policy has one event");
equal(providers.trial.voteLimit, 10_000, "Published trial vote ceiling is10000");
equal(providers.trial.maxDurationHours, 24, "Published trial duration ceiling is24h");
await api("/api/auth/google/start", { status: 503 });
await api("/api/__local_test__/seed-account", { method: "POST", body: {}, status: 403 });
await api("/api/__local_test__/seed-account", { method: "POST", owner: true, requestOrigin: "https://other.example", body: {}, status: 403 });

const first = await seed("first");
equal((await quota(first)).used, 0, "Fresh signup has not spent its event");
equal((await quota(first)).limit, 1, "Signup is lifetime limited");
await api("/api/admin/accounts", { cookie: first.cookie, status: 403 });
await api("/api/admin/accounts", { method: "POST", cookie: first.cookie, body: { name: "Privilege attempt", role: "admin" }, status: 403 });
await api(`/api/admin/accounts/${first.principal.id}`, { method: "PATCH", cookie: first.cookie, body: { role: "admin" }, status: 403 });
const tooLong = eventBody();
tooLong.closesAt = new Date(Date.parse(tooLong.opensAt) + 86_400_001).toISOString();
await create(first, tooLong, randomUUID(), 400);
equal((await quota(first)).used, 0, "Rejected over24h event does not spend quota");
await api("/api/admin/events", { method: "POST", cookie: first.cookie, body: eventBody(), status: 400 });
equal((await quota(first)).used, 0, "Missing idempotency identifier does not spend quota");
await api("/api/admin/events", { method: "POST", cookie: first.cookie, body: eventBody(), requestId: randomUUID(), requestOrigin: "https://other.example", status: 403 });
const firstBody = eventBody({ ownerId: "root", trial: { voteLimit: 1_000_000, maxDurationHours: 100 } });
firstBody.closesAt = new Date(Date.parse(firstBody.opensAt) + 86_400_000).toISOString();
const firstRequest = randomUUID();
const firstCreated = await create(first, firstBody, firstRequest);
const draft = firstCreated.data.event;
equal(draft.ownerId, first.principal.id, "Client cannot choose another event owner");
equal(draft.lifecycle, "draft", "Draft creation spends the lifetime event");
equal(draft.trial.voteLimit, 10_000, "Client cannot raise trial vote cap");
equal(draft.trial.maxDurationHours, 24, "Client cannot raise trial duration");
equal(firstCreated.data.creationQuota.used, 1, "Creation returns consumed quota");
equal((await quota(first)).eventId, draft.id, "Quota remembers immutable event ID");
await create(first, eventBody(), randomUUID(), 409);
equal((await create(first, firstBody, firstRequest)).data.event.id, draft.id, "Exact retry reuses original event");
const reordered = Object.fromEntries(Object.entries(firstBody).reverse());
equal((await create(first, reordered, firstRequest)).data.event.id, draft.id, "Object key ordering does not break idempotent retry");
const conflict = await create(first, { ...firstBody, name: "Changed retry payload" }, firstRequest, 409);
equal(conflict.data.code, "idempotency_conflict", "Changed request body reports explicit conflict");
const edited = { name: "Edited draft stays edited", question: draft.question, options: draft.options.map(option => option.label) };
await api(`/api/admin/events/${draft.id}`, { method: "PATCH", cookie: first.cookie, body: edited });
equal((await create(first, firstBody, firstRequest)).data.event.name, edited.name, "Retry never overwrites later draft edits");
await api(`/api/admin/events/${draft.id}`, { method: "PATCH", cookie: first.cookie, body: { ...edited,
  opensAt: draft.opensAt, closesAt: new Date(Date.parse(draft.opensAt) + 86_400_001).toISOString() }, status: 400 });
await api(`/api/admin/events/${draft.id}/access`, { method: "PUT", cookie: first.cookie, body: { accountIds: [] }, status: 403 });

const racing = await seed("race");
const raceBody = eventBody();
const raceKeys = [randomUUID(), randomUUID()];
const race = await Promise.all(raceKeys.map(requestId => create(racing, raceBody, requestId, [201, 409])));
equal(race.filter(result => result.status === 201).length, 1, "Only one concurrent creation succeeds");
const denied = race.find(result => result.status === 409);
equal(denied.data.code, "creation_quota_exhausted", "Competing create is denied by lifetime quota");
equal(denied.data.creationQuota.used, 1, "Concurrent denial carries fresh consumed quota");
const raceEvent = race.find(result => result.status === 201).data.event;
const raceList = (await api("/api/admin/events", { cookie: racing.cookie })).data.events;
equal(raceList.filter(event => event.ownerId === racing.principal.id).length, 1, "Racing account lists exactly one own event");
await api(`/api/admin/events/${draft.id}`, { cookie: racing.cookie, status: 403 });
await api(`/api/admin/events/${raceEvent.id}`, { cookie: first.cookie, status: 403 });
await api(`/api/admin/events/${raceEvent.id}/export?shard=0`, { cookie: first.cookie, status: 403 });
await api(`/api/admin/events/${draft.id}/access`, { method: "PUT", owner: true, body: { accountIds: [racing.principal.id] } });
await api(`/api/admin/events/${draft.id}`, { cookie: racing.cookie });
await api(`/api/admin/events/${draft.id}/access`, { method: "PUT", owner: true, body: { accountIds: [] } });
await api(`/api/admin/events/${draft.id}`, { cookie: racing.cookie, status: 403 });

const interrupted = await seed("interrupted");
const savedBody = eventBody();
const savedId = randomBytes(12).toString("hex");
const savedKey = randomUUID();
await api("/api/__local_test__/reserve-intent", { method: "POST", owner: true, body: {
  accountId: interrupted.principal.id, requestId: savedKey, input: savedBody, event: reservedConfig(interrupted, savedBody, savedId),
} });
check(!(await inspect(savedId)).coordinatorExists, "Interrupted fixture stores intent before coordinator initialization");
equal((await quota(interrupted)).used, 1, "Interrupted creation durably consumes its single slot");
const recovered = (await api("/api/admin/events", { cookie: interrupted.cookie })).data.events;
check(recovered.some(event => event.id === savedId), "Listing recovers reserved event after browser/request loss");
check((await inspect(savedId)).coordinatorExists, "Recovery initializes the actual event coordinator");
equal((await create(interrupted, savedBody, savedKey)).data.event.id, savedId, "Recovered event also supports exact POST replay");

const expired = await seed("expired-retry");
const expiredBody = eventBody({ lifecycle: "published", opensAt: new Date(Date.now() - 7_200_000).toISOString(), closesAt: new Date(Date.now() - 3_600_000).toISOString() });
const expiredId = randomBytes(12).toString("hex");
const expiredKey = randomUUID();
await api("/api/__local_test__/reserve-intent", { method: "POST", owner: true, body: {
  accountId: expired.principal.id, requestId: expiredKey, input: expiredBody, event: reservedConfig(expired, expiredBody, expiredId),
} });
equal((await create(expired, expiredBody, expiredKey)).data.event.id, expiredId, "Historical exact retry works even after scheduled close");
equal((await api(`/api/events/${expiredId}/results`)).data.phase, "closed", "Recovered historical event retains its closed phase");

for (const role of ["organizer", "admin"]) {
  const account = (await api("/api/admin/accounts", { method: "POST", owner: true, status: 201, body: { name: `Legacy ${role} local`, role } })).data;
  const login = await api("/api/admin/login", { method: "POST", body: { key: account.key } });
  const staff = { principal: login.data.principal, cookie: login.response.headers.get("Set-Cookie").split(";")[0] };
  check(staff.principal.selfRegistered === false, "Existing key-account provisioning stays distinct");
  equal((await quota(staff)).limit, null, "Key account has unlimited creation");
  const unlimitedBody = eventBody();
  unlimitedBody.closesAt = new Date(Date.parse(unlimitedBody.opensAt) + 48 * 3_600_000).toISOString();
  const one = await create(staff, unlimitedBody, null);
  const two = await create(staff, { ...unlimitedBody, name: "Another unrestricted local event" }, null);
  check(one.data.event.id !== two.data.event.id && !one.data.event.trial && !two.data.event.trial, "Legacy organizer/admin can create multiple uncapped events");
}
await api(`/api/admin/accounts/${first.principal.id}`, { method: "PATCH", owner: true, body: { role: "admin" } });
equal((await quota(first)).limit, null, "Current admin role overrides self-registration quota");
const adminBody = eventBody();
adminBody.closesAt = new Date(Date.parse(adminBody.opensAt) + 48 * 3_600_000).toISOString();
check(!(await create(first, adminBody, null)).data.event.trial, "Promoted admin creation has no trial cap");
check(!(await create(first, { ...adminBody, name: "Second promoted-admin event" }, null)).data.event.trial, "Promoted admin can create more than one event");
await api(`/api/admin/accounts/${first.principal.id}`, { method: "PATCH", owner: true, body: { role: "organizer" } });
equal((await quota(first)).used, 1, "Demotion preserves used lifetime allowance");
await create(first, eventBody(), randomUUID(), 409);

const voting = await seed("voting");
const liveBody = eventBody({ lifecycle: "published", opensAt: new Date(Date.now() - 1000).toISOString(), closesAt: new Date(Date.now() + 30_000).toISOString() });
const live = (await create(voting, liveBody)).data.event;
const route = `/api/events/${live.id}`;
const initial = (await api(`${route}/results`)).data;
equal(initial.phase, "open", "Trial voting opens normally");
equal(initial.trial.voteLimit, 10_000, "Public trial metadata matches server cap");
const cookies = [];
for (let i = 0; i < 2; i++) {
  const identity = await api(`${route}/identity`);
  const cookie = identity.response.headers.get("Set-Cookie").split(";")[0];
  cookies.push(cookie);
  const vote = { optionId: i === 0 ? "o1" : "o2", ballotVersion: initial.ballotVersion, turnstileToken: "test" };
  const cast = await api(`${route}/vote`, { method: "POST", cookie, body: vote });
  check(cast.data.recorded && !cast.data.duplicate, "Trial vote is recorded once");
  if (i === 0) {
    check((await api(`${route}/vote`, { method: "POST", cookie, body: vote })).data.duplicate, "Exact trial vote retry is idempotent");
    await api(`${route}/vote`, { method: "POST", cookie, body: { ...vote, optionId: "o2" }, status: 409 });
  }
}
const tally = (await api(`${route}/results`)).data;
equal(tally.turnout, 2, "Trial tally excludes duplicate/rejected votes");
assert.deepEqual(tally.counts, { o1: 1, o2: 1 }); checks++;
const hashes = cookies.map(cookie => voterHash(live.id, cookie));
const storage = await inspect(live.id, hashes.map(hash => Number.parseInt(hash.slice(0, 2), 16) % 128));
equal(storage.coordinatorTurnout, 2, "Trial ballots are held by their event coordinator");
check(storage.shardTurnouts.every(total => total === 0), "Trial votes never enter legacy vote shards");
await api(`/api/admin/events/${live.id}/export?shard=0`, { cookie: voting.cookie, status: 403 });
await api(`/api/admin/events/${live.id}/export?shard=0`, { cookie: first.cookie, status: 403 });
console.log("Signup checks passed through live trial voting; waiting for its short local deadline…");
await delay(Math.max(0, Date.parse(live.closesAt) - Date.now() + 100));
const closed = (await api(`${route}/results`)).data;
equal(closed.phase, "closed", "Trial reaches scheduled close");
equal(closed.turnout, 2, "Closed trial retains turnout");
assert.deepEqual(closed.counts, { o1: 1, o2: 1 }); checks++;
await api(`${route}/vote`, { method: "POST", cookie: cookies[0], body: { optionId: "o1", ballotVersion: initial.ballotVersion, turnstileToken: "test" }, status: 403 });
await api(`/api/admin/events/${live.id}/export?shard=128`, { cookie: voting.cookie, status: 400 });
const pages = await Promise.all(Array.from({ length: 128 }, (_, shard) => api(`/api/admin/events/${live.id}/export?shard=${shard}`, { cookie: voting.cookie })));
const rows = pages.flatMap(({ data }) => data.rows);
equal(rows.length, 2, "Closed trial export covers all128 compatible partitions");
equal(new Set(rows.map(row => row.voter_hash)).size, 2, "Export has no duplicate ballot rows");
check(rows.every(row => hashes.includes(row.voter_hash) && ["o1", "o2"].includes(row.option_id) && Number.isSafeInteger(row.created_at)), "Export shape and hashes match recorded trial ballots");
check(pages.every(({ data }) => data.next === null), "Small export pages have no cursor");
console.log(`Passed ${checks} disposable signup integration checks: quotas, retries/recovery, isolation, legacy/admin access, trial voting and export.`);
