#!/usr/bin/env node
// Local integration test. Creates three disabled-at-end accounts and demo
// events in the local Wrangler state; never sends credentials to remote hosts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const base = new URL(process.argv[2] || "http://127.0.0.1:8799");
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || !["http:", "https:"].includes(base.protocol) || base.username || base.password) {
  throw new Error("Admin smoke tests only accept a localhost URL.");
}
const origin = base.origin;
const localVars = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
const keyLine = /^\s*ADMIN_DASHBOARD_KEY\s*=\s*(.*?)\s*$/m.exec(localVars)?.[1];
const rootKey = keyLine && /^["']/.test(keyLine) ? keyLine.slice(1, -1) : keyLine;
assert.ok(typeof rootKey === "string" && rootKey.length >= 32, "Local ADMIN_DASHBOARD_KEY is missing.");
const runId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const localIp = `198.51.100.${1 + randomBytes(1)[0] % 250}`;
const accountFields = ["createdAt", "disabled", "id", "name", "role", "selfRegistered"];

async function api(path, { method = "GET", cookie, body, status = 200, requestOrigin = origin } = {}) {
  const headers = { Origin: requestOrigin, "CF-Connecting-IP": localIp };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(new URL(path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual", signal: AbortSignal.timeout(30_000),
  });
  // Never print bodies/cookies: successful creation responses contain keys.
  assert.equal(response.status, status, `${method} ${path}: unexpected HTTP status`);
  if (path.startsWith("/api/admin/")) assert.equal(response.headers.get("Cache-Control"), "no-store", "Admin response must not be cached.");
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${method} ${path}: expected a JSON response.`); }
  return { data, cookie: response.headers.get("Set-Cookie")?.split(";")[0], setCookie: response.headers.get("Set-Cookie") };
}

function safeAccount(account) {
  assert.ok(account && typeof account === "object", "Expected a safe account object.");
  assert.deepEqual(Object.keys(account).sort(), accountFields, "Account response exposed unexpected fields.");
  assert.ok(/^[a-f0-9]{24}$/.test(account.id), "Account ID format is invalid.");
  assert.ok(["admin", "organizer"].includes(account.role), "Account role is invalid.");
  assert.equal(typeof account.disabled, "boolean", "Account disabled state is invalid.");
  assert.equal(account.selfRegistered, false, "Staff account must remain exempt from the public quota.");
}

async function login(key, status = 200) {
  const result = await api("/api/admin/login", { method: "POST", body: { key }, status });
  if (status === 200) {
    assert.ok(result.data.principal && result.cookie, "Successful login must return principal and a cookie.");
    assert.ok(/HttpOnly/i.test(result.setCookie) && /SameSite=Strict/i.test(result.setCookie), "Session cookie attributes are missing.");
    assert.ok(/Max-Age=28800(?:;|$)/i.test(result.setCookie), "Session cookie must expire after eight hours.");
  }
  return result;
}

async function createAccount(cookie, suffix, role) {
  const { data } = await api("/api/admin/accounts", { method: "POST", cookie, body: { name: `Smoke ${suffix} ${runId}`, role }, status: 201 });
  safeAccount(data.account);
  assert.ok(/^[a-f0-9]{64}$/.test(data.key), "Account key must contain 256 random bits.");
  return data;
}

async function eventList(cookie) {
  const { data } = await api("/api/admin/events", { cookie });
  assert.ok(Array.isArray(data.events), "Expected an event list.");
  return new Set(data.events.map((event) => event.id));
}

async function detail(cookie, id) {
  const { data } = await api(`/api/admin/events/${id}`, { cookie });
  assert.ok(data.event && typeof data.presentation === "object" && ["live", "after-close"].includes(data.resultsVisibility), "Event detail shape is invalid.");
  return data;
}

async function createEvent(cookie, suffix, { pending = false, spoofOwner } = {}) {
  const now = Date.now();
  const { data } = await api("/api/admin/events", {
    method: "POST", cookie, status: 201,
    body: { name: `Smoke event ${suffix} ${runId}`, question: "Local smoke test question", options: ["Alpha", "Beta"],
      opensAt: new Date(now + (pending ? 300_000 : -5000)).toISOString(), closesAt: new Date(now + 900_000).toISOString(),
      ...(spoofOwner ? { ownerId: spoofOwner } : {}) },
  });
  assert.ok(/^[a-f0-9]{24}$/.test(data.event?.id), "Event creation did not return an event ID.");
  return data.event;
}

await api("/api/admin/me", { status: 401 });
await api("/api/admin/accounts", { status: 401 });
const owner = await login(rootKey);
assert.equal(owner.data.principal.id, "root", "Root key must authenticate system owner.");
assert.equal(owner.data.principal.role, "owner", "Root role is invalid.");
const ownerMe = (await api("/api/admin/me", { cookie: owner.cookie })).data;
assert.equal((ownerMe.principal || ownerMe).id, "root", "Session identity differs from login identity.");

const organizerA = await createAccount(owner.cookie, "A", "organizer");
const organizerB = await createAccount(owner.cookie, "B", "organizer");
const adminC = await createAccount(owner.cookie, "C", "admin");
const accounts = (await api("/api/admin/accounts", { cookie: owner.cookie })).data.accounts;
assert.ok(Array.isArray(accounts), "Expected accounts array.");
accounts.forEach(safeAccount);
assert.ok(accounts.some((account) => account.id === organizerA.account.id), "Created account is absent from account list.");

const a = await login(organizerA.key);
const aSecond = await login(organizerA.key);
const b = await login(organizerB.key);
const c = await login(adminC.key);
assert.ok(a.cookie !== aSecond.cookie, "Every login must issue a fresh session.");
await api("/api/admin/accounts", { cookie: a.cookie, status: 403 });
await api(`/api/admin/accounts/${organizerA.account.id}`, { method: "PATCH", cookie: a.cookie, body: { role: "admin" }, status: 403 });
await api("/api/admin/accounts", { cookie: c.cookie, status: 403 });

const aEvent = await createEvent(a.cookie, "A", { spoofOwner: organizerB.account.id });
const bEvent = await createEvent(b.cookie, "B");
const pendingEvent = await createEvent(a.cookie, "pending", { pending: true });
assert.equal((await detail(owner.cookie, aEvent.id)).event.ownerId, organizerA.account.id, "Server must assign ownership from the session.");
const aEvents = await eventList(a.cookie);
const bEvents = await eventList(b.cookie);
const allEvents = await eventList(c.cookie);
assert.ok(aEvents.has(aEvent.id) && aEvents.has(pendingEvent.id) && !aEvents.has(bEvent.id), "Organizer A event isolation failed.");
assert.ok(bEvents.has(bEvent.id) && !bEvents.has(aEvent.id), "Organizer B event isolation failed.");
assert.ok(allEvents.has(aEvent.id) && allEvents.has(bEvent.id), "Admin must see all events.");
await api(`/api/admin/events/${aEvent.id}/export?shard=0`, { cookie: b.cookie, status: 403 });
await api(`/api/admin/events/${bEvent.id}/export?shard=0`, { cookie: a.cookie, status: 403 });
await api(`/api/admin/events/${aEvent.id}`, { cookie: b.cookie, status: 403 });

await api(`/api/admin/events/${aEvent.id}/access`, { method: "PUT", cookie: owner.cookie, body: { accountIds: [organizerB.account.id] } });
assert.ok((await eventList(b.cookie)).has(aEvent.id), "Assigned organizer cannot see the event.");
await detail(b.cookie, aEvent.id);
await api(`/api/admin/events/${aEvent.id}/access`, { method: "PUT", cookie: owner.cookie, body: { accountIds: [] } });
assert.ok(!(await eventList(b.cookie)).has(aEvent.id), "Revoked assignment still appears in organizer list.");
await api(`/api/admin/events/${aEvent.id}/export?shard=0`, { cookie: b.cookie, status: 403 });

await api(`/api/admin/events/${aEvent.id}/settings`, { method: "PATCH", cookie: owner.cookie, body: { resultsVisibility: "live" } });
const live = (await api(`/api/events/${aEvent.id}/results`)).data;
assert.ok(live.counts !== null && typeof live.counts === "object" && !Array.isArray(live.counts), "Live results must expose counts during voting.");
await api(`/api/admin/events/${aEvent.id}/settings`, { method: "PATCH", cookie: owner.cookie, body: { resultsVisibility: "after-close" } });
const hidden = (await api(`/api/events/${aEvent.id}/results`)).data;
assert.equal(hidden.counts, null, "After-close mode must hide counts during voting.");
assert.equal((await detail(owner.cookie, aEvent.id)).resultsVisibility, "after-close", "Event detail settings are stale.");
await api(`/api/admin/events/${aEvent.id}`, { method: "PATCH", cookie: a.cookie, body: { name: "Disallowed edit", question: "Changed", options: ["X", "Y"] }, status: 409 });
await api(`/api/admin/events/${pendingEvent.id}`, { method: "PATCH", cookie: a.cookie, body: { name: `Edited ${runId}`, question: "Updated pending question", options: ["One", "Two", "Three"] } });
const edited = await detail(a.cookie, pendingEvent.id);
assert.equal(edited.event.question, "Updated pending question", "Pending event content was not updated.");
assert.equal(edited.event.options.length, 3, "Pending event options were not updated.");

await api(`/api/admin/events/${aEvent.id}/settings`, { method: "PATCH", cookie: owner.cookie, requestOrigin: "https://wrong-origin.invalid", body: { resultsVisibility: "live" }, status: 403 });
await api(`/api/admin/accounts/${organizerB.account.id}`, { method: "PATCH", cookie: owner.cookie, body: { role: "admin" } });
assert.ok((await eventList(b.cookie)).has(aEvent.id), "Role promotion must take effect in the existing session.");
await api(`/api/admin/accounts/${organizerB.account.id}`, { method: "PATCH", cookie: owner.cookie, body: { role: "organizer" } });
assert.ok(!(await eventList(b.cookie)).has(aEvent.id), "Role demotion must take effect in the existing session.");

const invalidShort = await login("invalid", 401);
const invalidRandom = await login(randomBytes(32).toString("hex"), 401);
assert.equal(invalidShort.data.error, invalidRandom.data.error, "Invalid credentials must use a uniform error response.");
const rotated = (await api(`/api/admin/accounts/${organizerA.account.id}/rotate`, { method: "POST", cookie: owner.cookie, body: {} })).data;
safeAccount(rotated.account);
assert.ok(/^[a-f0-9]{64}$/.test(rotated.key) && rotated.key !== organizerA.key, "Rotation must issue a new 256-bit key.");
await api("/api/admin/me", { cookie: a.cookie, status: 401 });
await api("/api/admin/me", { cookie: aSecond.cookie, status: 401 });
await login(organizerA.key, 401);
const aRotated = await login(rotated.key);
assert.equal(aRotated.data.principal.id, organizerA.account.id, "Rotated key authenticated a different account.");

await api(`/api/admin/accounts/${organizerB.account.id}`, { method: "PATCH", cookie: owner.cookie, body: { disabled: true } });
await api("/api/admin/me", { cookie: b.cookie, status: 401 });
await login(organizerB.key, 401);
await api("/api/admin/logout", { method: "POST", cookie: c.cookie, body: {} });
await api("/api/admin/me", { cookie: c.cookie, status: 401 });

// Leave created accounts disabled in the local database after a successful run.
await api(`/api/admin/accounts/${organizerA.account.id}`, { method: "PATCH", cookie: owner.cookie, body: { disabled: true } });
await api(`/api/admin/accounts/${adminC.account.id}`, { method: "PATCH", cookie: owner.cookie, body: { disabled: true } });
await api("/api/admin/logout", { method: "POST", cookie: owner.cookie, body: {} });
await api("/api/admin/me", { cookie: owner.cookie, status: 401 });
console.log("Local admin smoke passed: account isolation, event assignments, settings, edits, sessions and revocation.");
