#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

// Mutates local Wrangler data only. Redirects are never followed, so a local
// server cannot forward the development management key to a remote host.
const base = new URL(process.argv[2] || "http://localhost:8800");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && ["http:", "https:"].includes(base.protocol) && !base.username && !base.password, "Run draft smoke tests locally only.");
const origin = base.origin;
const vars = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
const line = /^\s*ADMIN_DASHBOARD_KEY\s*=\s*(.*?)\s*$/m.exec(vars)?.[1];
const rootKey = line && /^["']/.test(line) ? line.slice(1, -1) : line;
assert.ok(typeof rootKey === "string" && rootKey.length >= 32, "Add a local ADMIN_DASHBOARD_KEY before running draft smoke tests.");
const runId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
let checks = 0;

async function api(path, { method = "GET", body, key, requestOrigin = origin } = {}, status = 200) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: { Origin: requestOrigin, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual", signal: AbortSignal.timeout(30_000),
  });
  // Responses can contain generated keys. Assertions never print response
  // bodies, Authorization headers, or Set-Cookie values.
  assert.equal(response.status, status, `${method} ${path}: unexpected HTTP status`);
  if (path.startsWith("/api/admin/")) assert.equal(response.headers.get("Cache-Control"), "no-store", "Admin response must not be cached.");
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${method} ${path}: expected JSON.`); }
  checks++;
  return { data, response };
}

function admin(path, options = {}, status = 200) {
  return api(path, { key: rootKey, ...options }, status);
}

function body(overrides = {}) {
  const now = Date.now();
  return { name: `Local draft smoke ${runId}`, question: "Which work do you choose?", options: ["First work", "Second work"],
    opensAt: new Date(now - 60_000).toISOString(), closesAt: new Date(now + 3_600_000).toISOString(), ...overrides };
}

async function create(overrides = {}) {
  const { data } = await admin("/api/admin/events", { method: "POST", body: body(overrides) }, 201);
  assert.ok(/^[a-f0-9]{24}$/.test(data.event?.id), "Created event ID is invalid.");
  return data.event;
}

async function detail(id) {
  const { data } = await admin(`/api/admin/events/${id}`);
  assert.ok(data.event && typeof data.presentation === "object", "Event detail shape is invalid.");
  return data;
}

async function assertDraftBlocked(id) {
  const route = `/api/events/${id}`;
  const result = await api(`${route}/results`);
  assert.equal(result.data.phase, "draft", "A draft must remain draft regardless of scheduled time.");
  assert.equal(result.data.counts, null, "Draft counts must remain hidden.");
  const identity = await api(`${route}/identity`, {}, 403);
  assert.equal(identity.response.headers.get("Set-Cookie"), null, "Drafts must not issue voting identities.");
  // No valid identity is supplied, so these checks cannot call Turnstile even
  // if a server regression accidentally treats the draft as open.
  await api(`${route}/vote`, { method: "POST", body: { optionId: "o1", turnstileToken: "local-draft-test" } }, 403);
}

let unrelated;
try {
  const first = await create({ lifecycle: "draft", resultsVisibility: "live", presentation: { theme: "ink", coverUrl: "https://example.invalid/cover.webp" } });
  assert.equal(first.lifecycle, "draft", "Draft lifecycle was not saved.");
  await assertDraftBlocked(first.id);
  const initialDetail = await detail(first.id);
  assert.equal(initialDetail.presentation.coverUrl, "https://example.invalid/cover.webp", "Valid HTTPS cover was not saved.");
  const catalog = (await admin("/api/admin/events")).data.events;
  assert.equal(catalog.find((event) => event.id === first.id)?.lifecycle, "draft", "Catalog must identify draft events.");

  const account = (await admin("/api/admin/accounts", { method: "POST", body: { name: `Draft scope test ${runId}`, role: "organizer" } }, 201)).data;
  assert.ok(account.account?.id && /^[a-f0-9]{64}$/.test(account.key), "Local organizer creation failed.");
  unrelated = account;
  await api(`/api/admin/events/${first.id}/publish`, { method: "POST", body: {} }, 401);
  await api(`/api/admin/events/${first.id}/publish`, { method: "POST", key: account.key, body: {} }, 403);
  await admin(`/api/admin/events/${first.id}/publish`, { method: "POST", requestOrigin: "https://wrong-origin.invalid", body: {} }, 403);
  await admin(`/api/admin/events/${first.id}/publish`, {}, 405);
  assert.equal((await detail(first.id)).event.lifecycle, "draft", "Rejected publish changed the lifecycle.");

  const now = Date.now();
  const edited = { name: `Edited local draft ${runId}`, question: "Updated draft ballot", options: ["Alpha", "Beta", "Gamma"],
    opensAt: new Date(now + 300_000).toISOString(), closesAt: new Date(now + 900_000).toISOString() };
  await admin(`/api/admin/events/${first.id}`, { method: "PATCH", body: edited });
  const saved = (await detail(first.id)).event;
  assert.equal(saved.question, edited.question, "Draft content was not updated.");
  assert.equal(saved.options.length, 3, "Draft option edits were not saved.");
  assert.equal(saved.opensAt, edited.opensAt, "Draft opening time was not updated.");
  assert.equal(saved.closesAt, edited.closesAt, "Draft closing time was not updated.");
  await assertDraftBlocked(first.id);

  const invalidSchedules = [
    { closesAt: new Date(now - 1000).toISOString() },
    { opensAt: new Date(now + 1_200_000).toISOString(), closesAt: new Date(now + 600_000).toISOString() },
    { opensAt: new Date(now + 300_000).toISOString(), closesAt: new Date(now + 92 * 86400_000).toISOString() },
    { opensAt: "invalid-date" },
  ];
  for (const invalid of invalidSchedules) {
    await admin(`/api/admin/events/${first.id}`, { method: "PATCH", body: { ...edited, ...invalid } }, 400);
  }
  assert.equal((await detail(first.id)).event.closesAt, edited.closesAt, "Rejected schedule edits changed the saved draft.");

  const published = (await admin(`/api/admin/events/${first.id}/publish`, { method: "POST", body: {} })).data.event;
  assert.equal(published?.lifecycle, "published", "Publish must return the published event.");
  assert.equal((await api(`/api/events/${first.id}/results`)).data.phase, "pending", "Publishing a future draft must produce pending state.");
  await admin(`/api/admin/events/${first.id}/publish`, { method: "POST", body: {} }, 409);
  await api(`/api/events/${first.id}/vote`, { method: "POST", body: { optionId: "o1" } }, 403);
  await admin(`/api/admin/events/${first.id}`, { method: "PATCH", body: { name: edited.name, question: "Published but still pending", options: ["One", "Two"] } });
  assert.equal((await detail(first.id)).event.question, "Published but still pending", "Published pending ballots should remain editable.");
  const publishedCatalog = (await admin("/api/admin/events")).data.events;
  assert.equal(publishedCatalog.find((event) => event.id === first.id)?.lifecycle, "published", "Catalog lifecycle was not updated after publication.");

  const readyNow = await create({ lifecycle: "draft" });
  await assertDraftBlocked(readyNow.id);
  await admin(`/api/admin/events/${readyNow.id}/publish`, { method: "POST", body: {} });
  assert.equal((await api(`/api/events/${readyNow.id}/results`)).data.phase, "open", "A past-open draft should open immediately when published.");
  await admin(`/api/admin/events/${readyNow.id}`, { method: "PATCH", body: { name: "Locked ballot", question: "Cannot change an active ballot", options: ["X", "Y"] } }, 409);

  const defaultPublished = await create();
  assert.equal(defaultPublished.lifecycle, "published", "Omitted lifecycle must preserve the existing published default.");
  assert.equal((await api(`/api/events/${defaultPublished.id}/results`)).data.phase, "open", "Default events must keep existing open behavior.");
  await admin(`/api/admin/events/${defaultPublished.id}/publish`, { method: "POST", body: {} }, 409);

  for (const lifecycle of ["preview", 123]) await admin("/api/admin/events", { method: "POST", body: body({ lifecycle }) }, 400);
  const invalidCovers = [
    "http://example.invalid/cover.webp", "https://user:password@example.invalid/cover.webp",
    `https://example.invalid/${"x".repeat(2048)}`, 123,
  ];
  for (const coverUrl of invalidCovers) {
    await admin("/api/admin/events", { method: "POST", body: body({ lifecycle: "draft", presentation: { coverUrl } }) }, 400);
    await admin(`/api/admin/events/${first.id}/settings`, { method: "PATCH", body: { presentation: { coverUrl } } }, 400);
  }
  for (const invalid of invalidSchedules) await admin("/api/admin/events", { method: "POST", body: body({ lifecycle: "draft", ...invalid }) }, 400);
} finally {
  if (unrelated?.account?.id) await admin(`/api/admin/accounts/${unrelated.account.id}`, { method: "PATCH", body: { disabled: true } });
}

console.log(`Passed ${checks} local draft checks: lifecycle, publication permissions, scheduled edits, locked ballots and cover validation.`);
