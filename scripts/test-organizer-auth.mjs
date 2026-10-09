#!/usr/bin/env node
// Offline tests only: generated provider keys, mocked HTTP, temporary SQLite.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { finishOrganizerOAuth, oauthAvailability, startOrganizerOAuth, verifyOrganizerIdentityToken } from "../src/organizer-auth.js";

let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks++; }
async function rejects(action, message) { await assert.rejects(action, undefined, message); checks++; }
const clean = (value) => JSON.parse(JSON.stringify(value));
const sha = async (value) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
const source = (await readFile(new URL("../src/admin-directory.js", import.meta.url), "utf8"))
  .replace('import { DurableObject } from "cloudflare:workers";', "")
  .replace("export class AdminDirectory", "class AdminDirectory") + "\nglobalThis.TestDirectory = AdminDirectory;";
const db = new DatabaseSync(":memory:");
const legacyId = "a".repeat(24);
const legacyKey = "b".repeat(64);
db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','organizer')), disabled INTEGER NOT NULL DEFAULT 0, credential_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)");
db.prepare("INSERT INTO accounts VALUES (?, 'Legacy organizer', 'organizer', 0, ?, ?)").run(legacyId, await sha(legacyKey), new Date().toISOString());
let initialization;
let durableSyncs = 0;
const ctx = {
  blockConcurrencyWhile(fn) { initialization = fn(); },
  storage: {
    sql: { exec(query, ...bindings) {
      const statement = db.prepare(query);
      const returnsRows = /^\s*(SELECT|PRAGMA)\b/i.test(query);
      const rows = returnsRows ? statement.all(...bindings) : [];
      const result = returnsRows ? null : statement.run(...bindings);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, rowsWritten: Number(result?.changes || 0) };
    } },
    transactionSync(fn) {
      db.exec("BEGIN");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async sync() { durableSyncs++; },
  },
};
const sandbox = { crypto, TextEncoder, URL, Date, DurableObject: class { constructor(state, env) { this.ctx = state; this.env = env; } } };
vm.runInNewContext(source, sandbox, { filename: "admin-directory.js" });
const directoryEnv = { PUBLIC_ORGANIZER_ACCOUNT_LIMIT: "1000" };
const directory = new sandbox.TestDirectory(ctx, directoryEnv);
await initialization;
const providerKeys = await generateKeyPair("RS256");
const publicJwk = { ...await exportJWK(providerKeys.publicKey), kid: "offline-provider", alg: "RS256", use: "sig" };
const localKeys = createLocalJWKSet({ keys: [publicJwk] });
const appleKeys = await generateKeyPair("ES256", { extractable: true });
const env = {
  PUBLIC_BASE_URL: "https://vote.example", VOTE_SIGNING_KEY: "offline-state-secret-".repeat(3),
  GOOGLE_CLIENT_ID: "offline-google-client", GOOGLE_CLIENT_SECRET: "offline-google-secret",
  APPLE_SERVICE_ID: "offline.apple.service", APPLE_TEAM_ID: "OFFLINETEAM", APPLE_KEY_ID: "OFFLINEKEY",
  APPLE_PRIVATE_KEY: await exportPKCS8(appleKeys.privateKey),
};
let activeFlow;
const authDirectory = {
  createOAuthFlow: (flow) => directory.createOAuthFlow(flow),
  async consumeOAuthFlow(hash, provider) { activeFlow = await directory.consumeOAuthFlow(hash, provider); return activeFlow; },
  resolveOAuthAccount: (identity) => directory.resolveOAuthAccount(identity),
};
let exchangeMode = "valid";
let tokenRequests = 0;
let lastAuthorization;
let lastAppleSecretClaims;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  check(init.signal instanceof AbortSignal, "provider fetch has an abort signal");
  equal(init.redirect, "error", "provider redirects are rejected");
  if (url.endsWith("/certs") || url.endsWith("/auth/keys")) return Response.json({ keys: [publicJwk] });
  if (!url.endsWith("/token")) throw new Error("Unexpected outbound request in offline test");
  tokenRequests++;
  const provider = url.includes("appleid") ? "apple" : "google";
  const form = new URLSearchParams(init.body);
  equal(form.get("grant_type"), "authorization_code", "authorization code exchange");
  equal(form.get("redirect_uri"), `${env.PUBLIC_BASE_URL}/api/auth/${provider}/callback`, "fixed callback used in exchange");
  if (provider === "google") {
    equal(form.get("client_secret"), env.GOOGLE_CLIENT_SECRET, "Google exchange is authenticated server-side");
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier")))).toString("base64url");
    equal(challenge, lastAuthorization.searchParams.get("code_challenge"), "Google PKCE verifier matches challenge");
  } else {
    const verified = await jwtVerify(form.get("client_secret"), appleKeys.publicKey, { algorithms: ["ES256"], issuer: env.APPLE_TEAM_ID, audience: "https://appleid.apple.com", subject: env.APPLE_SERVICE_ID });
    lastAppleSecretClaims = verified.payload;
    equal(form.get("code_verifier"), null, "Apple uses its documented confidential-client flow");
  }
  if (exchangeMode === "provider-error") return Response.json({ error: "PRIVATE_PROVIDER_MARKER" }, { status: 400 });
  if (exchangeMode === "oversized") return new Response("x".repeat(65_537));
  return Response.json({ id_token: await identityToken(provider, { nonce: exchangeMode === "wrong-nonce" ? "wrong" : activeFlow.nonce }) });
};

async function identityToken(provider, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com", aud: provider === "google" ? env.GOOGLE_CLIENT_ID : env.APPLE_SERVICE_ID,
    sub: "same-subject-across-different-providers", nonce: "expected-nonce", name: "Offline organizer", email: "same@example.invalid", iat: now, exp: now + 300, ...overrides };
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: publicJwk.kid }).sign(providerKeys.privateKey);
}

async function start(provider = "google") {
  const response = await startOrganizerOAuth(new Request(`${env.PUBLIC_BASE_URL}/api/auth/${provider}/start`), env, provider, authDirectory);
  equal(response.status, 302, `${provider} authorization starts`);
  lastAuthorization = new URL(response.headers.get("Location"));
  return { state: lastAuthorization.searchParams.get("state"), cookie: response.headers.get("Set-Cookie").split(";")[0], response };
}

function callback(flow, provider = "google", parameters = {}, cookie = flow.cookie) {
  const form = new URLSearchParams({ state: flow.state, code: "offline-code", ...parameters });
  const url = `${env.PUBLIC_BASE_URL}/api/auth/${provider}/callback`;
  return provider === "google" ? new Request(`${url}?${form}`, { headers: { Cookie: cookie } }) :
    new Request(url, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
}

try {
  check(!oauthAvailability({}).google && !oauthAvailability({}).apple, "signup disabled without configuration");
  check(oauthAvailability(env).google && oauthAvailability(env).apple, "complete configuration enables providers");
  check(!oauthAvailability({ ...env, GOOGLE_CLIENT_SECRET: "" }).google, "Google needs its secret");
  check(!oauthAvailability({ ...env, APPLE_PRIVATE_KEY: "" }).apple, "Apple needs its signing key");
  check(!oauthAvailability({ ...env, PUBLIC_BASE_URL: "http://vote.example" }).google, "HTTPS callback required");
  check(!oauthAvailability({ ...env, PUBLIC_BASE_URL: "https://vote.example/path" }).apple, "callback origin cannot include a path");
  equal((await startOrganizerOAuth(new Request(`${env.PUBLIC_BASE_URL}/api/auth/google/start`), {}, "google", authDirectory)).status, 503, "incomplete provider cannot start");
  equal((await startOrganizerOAuth(new Request(`${env.PUBLIC_BASE_URL}/api/auth/constructor/start`), env, "constructor", authDirectory)).status, 503, "inherited object names are not providers");
  equal((await startOrganizerOAuth(new Request("https://wrong.example/api/auth/google/start"), env, "google", authDirectory)).status, 400, "alternate host cannot start OAuth");
  const legacy = await directory.authenticate(legacyKey);
  check(legacy && legacy.selfRegistered === false, "old schema migrates existing key account without changing auth");
  equal(directory.getCreationQuota(legacy.id).limit, null, "legacy organizer has no new quota");
  const googleFlow = await start();
  equal(lastAuthorization.searchParams.get("response_type"), "code", "no implicit token flow");
  equal(lastAuthorization.searchParams.get("code_challenge_method"), "S256", "Google uses PKCE S256");
  const stateClaims = JSON.parse(Buffer.from(googleFlow.state.split(".")[1], "base64url").toString());
  check(!Object.hasOwn(stateClaims, "nonce") && !Object.hasOwn(stateClaims, "verifier"), "URL state does not disclose flow secrets");
  check(googleFlow.response.headers.get("Set-Cookie").includes("Secure; HttpOnly; Path=/; SameSite=Lax"), "Google cookie is browser bound and protected");
  equal(googleFlow.response.headers.get("Cache-Control"), "no-store", "OAuth authorization cannot be cached");
  const googleResult = await finishOrganizerOAuth(callback(googleFlow), env, "google", authDirectory);
  check(!(googleResult instanceof Response), "valid Google callback succeeds");
  equal(googleResult.principal.role, "organizer", "signup cannot grant admin role");
  check(googleResult.principal.selfRegistered, "new account is quota scoped");
  check(/^[a-f0-9]{24}$/.test(googleResult.principal.id), "account ID fits existing event ACL contract");
  equal(googleResult.redirectTo, `${env.PUBLIC_BASE_URL}/admin.html?auth=success`, "success redirect is fixed");
  check(googleResult.clearCookie.includes("Max-Age=0"), "successful callback clears state cookie");
  check(!JSON.stringify(googleResult.principal).includes("credential") && !JSON.stringify(googleResult.principal).includes("email"), "principal contains no credential or email");
  const beforeReplay = tokenRequests;
  equal((await finishOrganizerOAuth(callback(googleFlow), env, "google", authDirectory)).status, 400, "callback is single use");
  equal(tokenRequests, beforeReplay, "replay fails before provider exchange");
  const repeatFlow = await start();
  const repeated = await finishOrganizerOAuth(callback(repeatFlow), env, "google", authDirectory);
  equal(repeated.principal.id, googleResult.principal.id, "repeat provider identity resolves same account");
  const session = await directory.createSession(googleResult.principal);
  equal((await directory.session(session)).id, googleResult.principal.id, "OAuth principal works with existing session store");
  const appleFlow = await start("apple");
  equal(lastAuthorization.searchParams.get("response_mode"), "form_post", "Apple uses form_post callback");
  check(appleFlow.response.headers.get("Set-Cookie").includes("SameSite=None"), "Apple cross-site callback retains protected state cookie");
  const appleResult = await finishOrganizerOAuth(callback(appleFlow, "apple"), env, "apple", authDirectory);
  check(!(appleResult instanceof Response), "valid Apple callback succeeds");
  check(appleResult.principal.id !== googleResult.principal.id, "providers never auto-link by matching email or subject");
  check(lastAppleSecretClaims.exp - lastAppleSecretClaims.iat <= 300, "Apple client secret is short lived");
  for (const overrides of [{ iss: "https://wrong.example" }, { aud: "wrong-client" }, { exp: Math.floor(Date.now() / 1000) - 120 }, { nonce: "wrong" }, { sub: "" }, { azp: "wrong-client" }, { aud: [env.GOOGLE_CLIENT_ID, "other"] }, { iat: undefined }]) {
    const token = await identityToken("google", overrides);
    await rejects(() => verifyOrganizerIdentityToken("google", token, env.GOOGLE_CLIENT_ID, "expected-nonce", localKeys), "invalid signed identity claims rejected");
  }
  await rejects(() => verifyOrganizerIdentityToken("google", "x".repeat(16_385), env.GOOGLE_CLIENT_ID, "expected-nonce", localKeys), "oversized JWT rejected");
  const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`;
  await rejects(() => verifyOrganizerIdentityToken("google", unsigned, env.GOOGLE_CLIENT_ID, "expected-nonce", localKeys), "unsigned identity cannot authenticate");
  const wrongKey = await generateKeyPair("RS256");
  const wrongSignature = await new SignJWT({ iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, sub: "signed-by-wrong-key", nonce: "expected-nonce", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid }).sign(wrongKey.privateKey);
  await rejects(() => verifyOrganizerIdentityToken("google", wrongSignature, env.GOOGLE_CLIENT_ID, "expected-nonce", localKeys), "valid-looking claims signed by wrong key rejected");
  const badFlow = await start();
  equal((await finishOrganizerOAuth(callback(badFlow, "google", {}, ""), env, "google", authDirectory)).status, 400, "missing state cookie rejected");
  const stateSegments = badFlow.state.split(".");
  stateSegments[2] = (stateSegments[2].startsWith("a") ? "b" : "a") + stateSegments[2].slice(1);
  const tamperedState = stateSegments.join(".");
  equal((await finishOrganizerOAuth(callback({ ...badFlow, state: tamperedState, cookie: `__Host-wevote_oauth=${tamperedState}` }), env, "google", authDirectory)).status, 400, "state signature checked even when browser cookie matches");
  equal((await finishOrganizerOAuth(callback(badFlow, "apple"), env, "apple", authDirectory)).status, 400, "provider swapping rejected");
  const cancellation = await finishOrganizerOAuth(callback(badFlow, "google", { error: "access_denied" }), env, "google", authDirectory);
  equal(cancellation.status, 303, "provider cancellation returns to admin");
  check(cancellation.headers.get("Set-Cookie").includes("Max-Age=0"), "cancelled flow is cleared");
  const duplicateFlow = await start();
  const duplicateRequest = callback(duplicateFlow);
  equal((await finishOrganizerOAuth(new Request(duplicateRequest.url + "&state=duplicate", { headers: duplicateRequest.headers }), env, "google", authDirectory)).status, 400, "duplicate callback parameters rejected");
  for (const mode of ["wrong-nonce", "provider-error", "oversized"]) {
    exchangeMode = mode;
    const flow = await start();
    const result = await finishOrganizerOAuth(callback(flow), env, "google", authDirectory);
    equal(result.status, 400, `${mode} provider response rejected`);
    const text = await result.text();
    check(!text.includes("PRIVATE_PROVIDER_MARKER") && !text.includes("offline-code") && !text.includes(env.GOOGLE_CLIENT_SECRET), "callback errors do not leak provider data");
  }
  exchangeMode = "valid";
  const bodyFlow = await start("apple");
  equal((await finishOrganizerOAuth(new Request(`${env.PUBLIC_BASE_URL}/api/auth/apple/callback`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: bodyFlow.cookie }, body: "x=" + "x".repeat(16_385) }), env, "apple", authDirectory)).status, 400, "callback body size bounded");
  const invalidFlow = { stateHash: "a".repeat(64), provider: "google", nonce: "b".repeat(64), verifier: "c".repeat(64), redirectUri: "https://vote.example/api/auth/google/callback", expiresAt: Date.now() + 60_000 };
  await directory.createOAuthFlow(invalidFlow);
  db.prepare("UPDATE oauth_flows SET expires_at=? WHERE state_hash=?").run(Date.now() - 1, invalidFlow.stateHash);
  equal(await directory.consumeOAuthFlow(invalidFlow.stateHash, "google"), null, "expired server-side flow rejected");
  equal(db.prepare("SELECT COUNT(*) AS total FROM oauth_flows WHERE state_hash=?").get(invalidFlow.stateHash).total, 0, "expired consumed flow removed");
  const publicId = googleResult.principal.id;
  equal(directory.getCreationQuota(publicId).used, 0, "new signup initially has one available creation");
  const requestA = { requestId: "request-a-1234567890", payloadHash: "1".repeat(64), eventId: "1".repeat(24), event: { id: "1".repeat(24), ownerId: publicId, name: "Saved draft", lifecycle: "draft" } };
  const requestB = { requestId: "request-b-1234567890", payloadHash: "2".repeat(64), eventId: "2".repeat(24), event: { id: "2".repeat(24), ownerId: publicId, name: "Second draft", lifecycle: "draft" } };
  const concurrent = await Promise.all([directory.reserveSelfRegisteredEvent(publicId, requestA), directory.reserveSelfRegisteredEvent(publicId, requestB)]);
  equal(concurrent.filter((r) => !r.error).length, 1, "concurrent different event creates cannot exceed lifetime quota");
  equal(concurrent.filter((r) => r.error === "quota_exceeded").length, 1, "concurrent second creation denied");
  const replay = await directory.reserveSelfRegisteredEvent(publicId, { ...requestA, eventId: "3".repeat(24) });
  equal(replay.eventId, requestA.eventId, "retry uses original immutable event ID");
  check(replay.reused, "retry is identified as replay");
  equal((await directory.reserveSelfRegisteredEvent(publicId, { ...requestA, payloadHash: "4".repeat(64) })).error, "idempotency_conflict", "changed payload cannot reuse request ID");
  equal(directory.lookupSelfRegisteredEvent(publicId, requestA).eventId, requestA.eventId, "read-only lookup can replay before expired-schedule validation");
  equal(directory.lookupSelfRegisteredEvent(publicId, requestB).error, "quota_exceeded", "lookup rejects different event after one creation");
  equal(clean(directory.getCreationQuota(publicId)).eventId, requestA.eventId, "quota identifies reserved event");
  equal(directory.getReservedEvent(publicId).name, "Saved draft", "validated event survives interrupted coordinator creation");
  const legacyReservations = await Promise.all([directory.reserveSelfRegisteredEvent(legacyId, requestA), directory.reserveSelfRegisteredEvent(legacyId, requestB)]);
  check(legacyReservations.every((r) => !r.error), "legacy accounts remain unlimited");
  equal(directory.lookupSelfRegisteredEvent("root", requestA), null, "system owner bypasses quota lookup");
  equal((await directory.reserveSelfRegisteredEvent("root", requestB)).eventId, requestB.eventId, "system owner creates without limit");
  await directory.updateAccount(publicId, { role: "admin" });
  equal((await directory.session(session)).role, "admin", "role changes apply to existing OAuth sessions immediately");
  equal(directory.getCreationQuota(publicId).limit, null, "promoted admins have unlimited creation");
  check(!(await directory.reserveSelfRegisteredEvent(publicId, requestB)).error, "current admin bypasses lifetime gate");
  await directory.updateAccount(publicId, { role: "organizer" });
  equal((await directory.reserveSelfRegisteredEvent(publicId, requestB)).error, "quota_exceeded", "demotion does not reset previously used quota");
  await rejects(() => directory.updateAccount(publicId, { selfRegistered: false }), "account edits cannot remove public registration scope");
  await directory.updateAccount(publicId, { disabled: true });
  equal(await directory.session(session), null, "disabled OAuth account loses session");
  equal(await directory.resolveOAuthAccount({ provider: "google", subject: "same-subject-across-different-providers", name: "Again" }), null, "disabled provider identity cannot recreate an account");
  equal((await directory.reserveSelfRegisteredEvent(publicId, requestA)).error, "unauthorized", "disabled account cannot reserve or replay");
  await directory.updateAccount(publicId, { disabled: false });
  equal(directory.getCreationQuota(publicId).used, 1, "reenabling account does not restore free event");
  const beforeCap = db.prepare("SELECT COUNT(*) AS total FROM accounts WHERE self_registered=1").get().total;
  directoryEnv.PUBLIC_ORGANIZER_ACCOUNT_LIMIT = String(beforeCap);
  equal(await directory.resolveOAuthAccount({ provider: "google", subject: "new-cap-blocked", name: "Blocked" }), null, "configured platform cap rejects new signup");
  check(await directory.resolveOAuthAccount({ provider: "apple", subject: "same-subject-across-different-providers", name: "Existing" }), "platform cap still permits existing OAuth login");
  const manual = await directory.createAccount({ name: "Manual admin", role: "admin" });
  check(!manual.account.selfRegistered && manual.key, "public signup cap does not consume legacy staff provisioning");
  for (let i = 1000; i < 1100; i++) db.prepare("INSERT INTO accounts (id,name,role,disabled,credential_hash,created_at,self_registered) VALUES (?, 'Public fixture', 'organizer', 0, ?, ?, 1)")
    .run(i.toString(16).padStart(24, "0"), i.toString(16).padStart(64, "0"), new Date().toISOString());
  check((await directory.createAccount({ name: "Staff after public growth", role: "admin" })).account, "more than100 public accounts still cannot exhaust staff account quota");
  const unusedPublic = appleResult.principal.id;
  await rejects(() => directory.reserveSelfRegisteredEvent(unusedPublic, { ...requestB, event: { ...requestB.event, ownerId: legacyId } }), "reservation rejects mismatching event owner");
  equal(directory.getCreationQuota(unusedPublic).used, 0, "invalid event owner does not spend quota");
  await rejects(() => directory.reserveSelfRegisteredEvent(unusedPublic, { ...requestB, event: { ...requestB.event, ownerId: unusedPublic, description: "字".repeat(3000) } }), "stored event size bounded by bytes");
  equal(directory.getCreationQuota(unusedPublic).used, 0, "oversized snapshot rolls back quota reservation");
  await rejects(() => directory.reserveSelfRegisteredEvent(appleResult.principal.id, { ...requestA, requestId: "short" }), "malformed idempotency key rejected");
  check(durableSyncs > 0, "mutations wait for durable storage");
  console.log(`Organizer auth tests passed (${checks} checks). No real provider or production requests.`);
} finally {
  globalThis.fetch = originalFetch;
  db.close();
}
