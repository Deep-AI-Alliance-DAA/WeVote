#!/usr/bin/env node
// Disposable workerd checks. Stripe fulfillment is mocked through the guarded
// local fixture; signature/remote-payment verification has separate offline tests.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const base = new URL(process.argv[2] || "");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && base.protocol === "http:" && !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash);
const marker = JSON.parse(await readFile(new URL("../.local-fixture.json", import.meta.url), "utf8"));
assert.equal(marker.kind, "disposable-wevote-integration");
const vars = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
assert.match(vars, /^LOCAL_TEST_FIXTURES="disposable-only"$/m);
const rootKey = /^ADMIN_DASHBOARD_KEY="([a-f0-9]{64})"$/m.exec(vars)?.[1];
assert.ok(rootKey);
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };

async function api(path, { method = "GET", body, cookie, owner = false, requestId, origin = base.origin, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: "manual", signal: AbortSignal.timeout(30000),
    headers: { Origin: origin, ...(owner ? { Authorization: `Bearer ${rootKey}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(requestId ? { "Idempotency-Key": requestId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  check((Array.isArray(status) ? status : [status]).includes(response.status), `${method} ${path}: HTTP ${response.status}`);
  if (path.startsWith("/api/admin/") || path.startsWith("/api/billing/")) equal(response.headers.get("Cache-Control"), "no-store", "Billing and organizer state cannot be cached");
  return { data: await response.json(), response, status: response.status };
}
async function seed(name) {
  return (await api("/api/__local_test__/seed-account", { method: "POST", owner: true, status: 201,
    body: { provider: "google", subject: `billing-local-${randomUUID()}`, name } })).data;
}
function ballot(hours = 1, overrides = {}) {
  const opened = Date.now() + 60000;
  return { name: "Disposable paid ballot", question: "Synthetic choices", options: ["A", "B", "C"], maxChoices: 2,
    lifecycle: "draft", resultsVisibility: "live", opensAt: new Date(opened).toISOString(), closesAt: new Date(opened + hours * 3600000).toISOString(), ...overrides };
}
async function create(account, body, requestId = randomUUID(), status = 201) {
  return api("/api/admin/events", { method: "POST", cookie: account.cookie, body, requestId, status });
}
async function grant(account, requestId = randomUUID()) {
  return (await api("/api/__local_test__/seed-paid-credit", { method: "POST", owner: true, body: { accountId: account.principal.id, requestId } })).data.creationQuota;
}

await api("/api/admin/billing", { status: 401 });
await api("/api/billing/webhook", { status: 405 });
await api("/api/billing/webhook", { method: "POST", body: {}, status: 503 });
const account = await seed("Billing workerd fixture");
const overview = (await api("/api/admin/billing", { cookie: account.cookie })).data;
equal({ enabled: overview.enabled, eligible: overview.eligible, offer: overview.offer, paidCredits: overview.paidCredits, latestCheckout: overview.latestCheckout },
  { enabled: false, eligible: false, offer: null, paidCredits: 0, latestCheckout: null }, "Unconfigured production Checkout is honestly disabled");
equal(overview.principal.id, account.principal.id, "Billing response carries current principal");
equal(overview.creationQuota.nextEvent.maxDurationHours, 24, "Free event remains 24 hours");
await api("/api/admin/billing/checkout", { method: "POST", body: {}, cookie: account.cookie, requestId: randomUUID(), status: 503 });
await api("/api/admin/billing/checkout", { method: "POST", body: {}, cookie: account.cookie, origin: "https://other.example", status: 403 });
await api("/api/admin/billing/reconcile", { method: "POST", body: { orderId: randomUUID() }, cookie: account.cookie, status: 503 });
await create(account, ballot(168, { entitlement: { kind: "paid-credit" }, trial: { voteLimit: 1000000, maxDurationHours: 168 } }), randomUUID(), 400);
const free = (await create(account, ballot(24))).data.event;
equal(free.trial, { voteLimit: 10000, maxDurationHours: 24 }, "Client cannot promote free quota into paid capacity");
const purchaseId = randomUUID();
equal((await grant(account, purchaseId)).paidCredits, 1, "Durable paid fixture creates one credit");
equal((await grant(account, purchaseId)).paidCredits, 1, "Duplicate fulfillment does not issue another credit");
await create(account, ballot(168 + 1 / 3600000), randomUUID(), 400);
const paidOpening = Date.now() - 1000;
const bodyA = ballot(168, { opensAt: new Date(paidOpening).toISOString(), closesAt: new Date(paidOpening + 168 * 3600000).toISOString() });
const bodyB = { ...bodyA };
const requestA = randomUUID(); const requestB = randomUUID();
const simultaneous = await Promise.all([create(account, bodyA, requestA, [201, 409]), create(account, bodyB, requestB, [201, 409])]);
equal(simultaneous.map(result => result.status).sort(), [201, 409], "One remaining credit serves exactly one concurrent create");
const acceptedIndex = simultaneous[0].status === 201 ? 0 : 1;
const accepted = simultaneous[acceptedIndex].data;
const acceptedBody = acceptedIndex ? bodyB : bodyA;
const acceptedRequest = acceptedIndex ? requestB : requestA;
equal(accepted.event.entitlement, { kind: "paid-credit" }, "Only safe paid entitlement appears in event JSON");
equal(accepted.event.trial, { voteLimit: 10000, maxDurationHours: 168 }, "Paid cap is authoritative seven days and 10k ballots");
equal(accepted.creationQuota.paidCredits, 0, "Event consumes the credit once");
equal(accepted.requestId, acceptedRequest, "Create echoes the exact immutable request");
const retried = (await create(account, acceptedBody, acceptedRequest)).data;
equal(retried.event.id, accepted.event.id, "Paid request retry recovers original event");
equal(retried.creationQuota.paidCredits, 0, "Replay does not need another credit");
await create(account, { ...acceptedBody, maxChoices: 1 }, acceptedRequest, 409);
const listing = (await api("/api/admin/events", { cookie: account.cookie })).data;
check(listing.events.some(event => event.id === free.id) && listing.events.some(event => event.id === accepted.event.id), "Free and paid activities are both listed");
check(listing.creationReservations.some(value => value.requestId === acceptedRequest && value.eventId === accepted.event.id), "Recovery exposes the matching request/event pair");
await api(`/api/admin/events/${accepted.event.id}`, { method: "PATCH", cookie: account.cookie, body: { ...acceptedBody, closesAt: new Date(Date.parse(acceptedBody.opensAt) + 168 * 3600000 + 1).toISOString() }, status: 400 });
await api(`/api/admin/events/${accepted.event.id}/publish`, { method: "POST", cookie: account.cookie, body: {} });
const publicEvent = (await api(`/api/events/${accepted.event.id}/results`)).data;
equal(publicEvent.entitlement, { kind: "paid-credit" }, "Public page sees paid policy without purchase identifiers");
equal(publicEvent.trial.maxDurationHours, 168, "Public policy reports paid duration correctly");
const identity = await api(`/api/events/${accepted.event.id}/identity`);
const voterCookie = identity.response.headers.get("Set-Cookie").split(";")[0];
const selection = { optionIds: ["o1", "o2"], ballotVersion: publicEvent.ballotVersion, turnstileToken: "test" };
await api(`/api/events/${accepted.event.id}/vote`, { method: "POST", cookie: voterCookie, body: selection });
check((await api(`/api/events/${accepted.event.id}/vote`, { method: "POST", cookie: voterCookie, body: { ...selection, optionIds: ["o2", "o1"] } })).data.duplicate, "Paid multi-choice retries remain idempotent");
await delay(1200);
const updated = (await api(`/api/events/${accepted.event.id}/results`)).data;
equal(updated.turnout, 1, "Paid ballot with two selections counts one valid vote");
equal(updated.counts, { o1: 1, o2: 1, o3: 0 }, "Paid atomic cap path tallies each selected option");
const recovery = await seed("Interrupted paid event");
await create(recovery, ballot());
await grant(recovery);
const pendingBody = ballot(168);
const pendingRequest = randomUUID();
const pendingId = randomUUID().replaceAll("-", "").slice(0, 24);
const pendingConfig = { ...pendingBody, id: pendingId, ownerId: recovery.principal.id, ballotVersion: "disposable-paid-version",
  options: pendingBody.options.map((label, index) => ({ id: `o${index + 1}`, label })), createdAt: new Date().toISOString(), mode: "public-link",
  trial: { voteLimit: 10000, maxDurationHours: 24 } };
await api("/api/__local_test__/reserve-intent", { method: "POST", owner: true, body: { accountId: recovery.principal.id, requestId: pendingRequest, input: pendingBody, event: pendingConfig } });
const recovered = (await api("/api/admin/events", { cookie: recovery.cookie })).data;
check(recovered.events.some(event => event.id === pendingId && event.trial.maxDurationHours === 168), "Listing recovers paid intent even after an interrupted coordinator initialization");
equal((await create(recovery, pendingBody, pendingRequest)).data.event.id, pendingId, "Retry recovers exact paid event after listing without a second credit");
const ownerQuota = (await api("/api/admin/me", { owner: true })).data.creationQuota;
equal(ownerQuota.remaining, null, "Owner remains unlimited");
equal(ownerQuota.canCreate, true, "Owner needs no credit");
console.log(`Billing workerd integration passed (${checks} checks). No Stripe calls or production data.`);
