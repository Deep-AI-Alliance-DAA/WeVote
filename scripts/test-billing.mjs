#!/usr/bin/env node
// Offline only: real disposable SQLite, generated fixture identities and mocked
// Stripe HTTP. Never loads operator credentials or makes a real payment.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { billingConfiguration, billingEligible, billingOverview, createBillingCheckout,
  reconcileBillingCheckout, handleBillingWebhook, verifyStripeWebhook, STRIPE_API_VERSION } from "../src/billing.js";
import { initTrialBallot, recordTrialVote, readTrialResults } from "../src/trial-ballot.js";
import { testBillingRuntime } from "./test-billing-runtime.mjs";

let checks = 0;
const clean = value => JSON.parse(JSON.stringify(value));
const equal = (actual, expected, label) => { assert.deepEqual(clean(actual), clean(expected), label); checks++; };
const check = (value, label) => { assert.ok(value, label); checks++; };
async function rejects(action, status, label) {
  await assert.rejects(action, error => error.status === status, label); checks++;
}
const accountA = "1".repeat(24), accountB = "2".repeat(24), accountC = "3".repeat(24);
const principal = { id: accountA, name: "Offline organizer", role: "organizer", selfRegistered: true, disabled: false };
const other = { ...principal, id: accountB };
const testEnv = { PUBLIC_BASE_URL: "https://billing-fixture.invalid", STRIPE_SECRET_KEY: `rk_test_${"a".repeat(40)}`,
  STRIPE_WEBHOOK_SECRET: `whsec_${"b".repeat(40)}`, STRIPE_PRICE_ID: "price_OfflineOneEvent", STRIPE_PRICE_AMOUNT: "12345",
  STRIPE_PRICE_CURRENCY: "hkd", STRIPE_TEST_ORGANIZER_IDS: `${accountA},${accountB}` };
const liveEnv = { ...testEnv, STRIPE_SECRET_KEY: `rk_live_${"c".repeat(40)}`, STRIPE_TEST_ORGANIZER_IDS: "" };
const workspace = await mkdtemp(join(tmpdir(), "wevote-billing-test-"));
const databases = [];
const directorySource = (await readFile(new URL("../src/admin-directory.js", import.meta.url), "utf8"))
  .replace('import { DurableObject } from "cloudflare:workers";', "")
  .replace("export class AdminDirectory", "class AdminDirectory") + "\nglobalThis.TestDirectory = AdminDirectory;";

async function directoryFixture(env = { ...testEnv }, filename = ":memory:") {
  const db = new DatabaseSync(filename); databases.push(db);
  let initializing;
  const sql = { fail: null, exec(query, ...bindings) {
    if (sql.fail?.(query)) throw new Error("Synthetic billing SQL failure");
    const statement = db.prepare(query);
    const reads = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query) || /\bRETURNING\b/i.test(query);
    const rows = reads ? statement.all(...bindings).map(row => ({ ...row })) : [];
    const result = reads ? {} : statement.run(...bindings);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, rowsWritten: Number(result.changes || 0) };
  } };
  const storage = { sql, syncHook: null, syncs: 0, transactionSync(callback) {
    db.exec("BEGIN");
    try { const result = callback(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }, async sync() { storage.syncs++; if (storage.syncHook) await storage.syncHook(); } };
  const ctx = { storage, blockConcurrencyWhile(callback) { initializing = callback(); } };
  const sandbox = { crypto, TextEncoder, URL, Date, DurableObject: class { constructor(state, bindings) { this.ctx = state; this.env = bindings; } } };
  vm.runInNewContext(directorySource, sandbox, { filename: "admin-directory-billing-test.js" });
  const directory = new sandbox.TestDirectory(ctx, env);
  await initializing;
  for (const [id, marker] of [[accountA, "a"], [accountB, "b"], [accountC, "c"]]) {
    db.prepare("INSERT OR IGNORE INTO accounts (id,name,role,disabled,credential_hash,created_at,self_registered) VALUES (?,?,'organizer',0,?,?,1)")
      .run(id, "Offline organizer", marker.repeat(64), new Date().toISOString());
  }
  return { directory, db, storage, env };
}

const sessions = new Map(), intents = new Map(), charges = new Map(), postAttempts = [], outbound = [];
const rejectedCheckoutKeys = new Map();
const legacyCheckoutReplies = new Map();
let sequence = 0, fetchFailure = null, priceChanges = {}, sessionChanges = null, intentChanges = null, checkoutRejection = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  check(url.origin === "https://api.stripe.com", "Every outbound request is mocked Stripe API traffic");
  equal(init.headers["Stripe-Version"], STRIPE_API_VERSION, "Stripe API version is explicitly pinned");
  equal(init.redirect, "manual", "Stripe redirects are handled explicitly on Workers without forwarding credentials");
  check(init.signal instanceof AbortSignal, "Stripe HTTP has a bounded abort signal");
  outbound.push({ path: url.pathname, method: init.method || "GET" });
  if (fetchFailure === "network") throw new Error("PRIVATE_STRIPE_NETWORK_MARKER");
  if (fetchFailure === "http") return Response.json({ error: { message: "PRIVATE_STRIPE_ERROR_MARKER" } }, { status: 500 });
  if (fetchFailure === "oversized") return new Response("x".repeat(262145));
  if (fetchFailure === "invalid-json") return new Response("PRIVATE_STRIPE_INVALID_JSON");
  if (typeof fetchFailure === "string" && fetchFailure.startsWith("redirect-")) {
    return new Response("PRIVATE_STRIPE_REDIRECT_MARKER", { status: Number(fetchFailure.slice("redirect-".length)), headers: { Location: "https://untrusted.example/steal" } });
  }
  const livemode = /^(?:Bearer )?(?:sk|rk)_live_/.test(init.headers.Authorization);
  if (url.pathname.startsWith("/v1/prices/")) {
    return Response.json({ id: url.pathname.slice("/v1/prices/".length), active: true, type: "one_time", recurring: null,
      unit_amount: 12345, currency: "hkd", livemode, ...priceChanges });
  }
  if (url.pathname === "/v1/checkout/sessions" && init.method === "POST") {
    const form = new URLSearchParams(init.body);
    equal(form.get("mode"), "payment", "Checkout is one-time payment, not subscription");
    equal(form.get("line_items[0][quantity]"), "1", "One checkout buys exactly one event credit");
    if (form.has("managed_payments[enabled]")) {
      equal(form.get("managed_payments[enabled]"), "false", "Checkout explicitly uses the operator as merchant without inheriting Managed Payments defaults");
    } else {
      const previous = postAttempts.at(-1);
      equal(previous?.key, init.headers["Idempotency-Key"], "Legacy compatibility retry retains the immediately preceding Stripe key");
      const previousBody = new URLSearchParams(previous.body); previousBody.delete("managed_payments[enabled]");
      equal(init.body, previousBody.toString(), "Legacy compatibility changes only the added Managed Payments field");
    }
    equal(form.get("allowed_payment_method_types[0]"), "card", "Checkout only offers immediate card payment");
    check(!form.has("line_items[0][price_data][unit_amount]"), "Checkout uses a server-configured Price, not client amount");
    check(init.headers["Idempotency-Key"].startsWith("wevote-order-"), "Remote creation uses durable order idempotency");
    postAttempts.push({ body: init.body, key: init.headers["Idempotency-Key"] });
    const legacyReply = legacyCheckoutReplies.get(init.headers["Idempotency-Key"]);
    if (legacyReply) {
      if (init.body !== legacyReply.body) return Response.json({ error: { type: "idempotency_error", message: "PRIVATE_STRIPE_DIFFERENT_PARAMETERS" } }, { status: 400 });
      if (legacyReply.network) throw new Error("PRIVATE_STRIPE_LEGACY_NETWORK_MARKER");
      return legacyReply.session ? Response.json(legacyReply.session) : Response.json({ error: legacyReply.error }, { status: legacyReply.status });
    }
    const rejection = rejectedCheckoutKeys.get(init.headers["Idempotency-Key"]) || checkoutRejection;
    if (rejection) return Response.json({ error: rejection.error }, { status: rejection.status });
    const existing = [...sessions.values()].find(session => session.metadata.wevote_order_id === form.get("metadata[wevote_order_id]"));
    if (existing) return Response.json(existing);
    const id = `cs_${livemode ? "live" : "test"}_Offline${String(++sequence).padStart(8, "0")}`;
    const orderId = form.get("metadata[wevote_order_id]");
    const session = { id, object: "checkout.session", mode: "payment", status: "open", payment_status: "unpaid", livemode,
      expires_at: Number(form.get("expires_at")), url: `https://checkout.stripe.com/c/pay/${id}`,
      client_reference_id: form.get("client_reference_id"), metadata: { wevote_order_id: orderId, wevote_account_id: form.get("metadata[wevote_account_id]") },
      currency: "hkd", amount_subtotal: 12345, amount_total: 12345,
      line_items: { has_more: false, data: [{ quantity: 1, price: { id: form.get("line_items[0][price]"), active: true, type: "one_time", recurring: null, unit_amount: 12345, currency: "hkd", livemode } }] },
      payment_intent: { id: `pi_Offline${String(sequence).padStart(8, "0")}`, status: "succeeded", livemode, amount: 12345, currency: "hkd",
        metadata: { wevote_order_id: form.get("payment_intent_data[metadata][wevote_order_id]") },
        latest_charge: { id: `ch_Offline${String(sequence).padStart(8, "0")}`, amount_refunded: 0 } } };
    const success = new URL(form.get("success_url"));
    equal(success.origin, testEnv.PUBLIC_BASE_URL, "Success URL uses canonical configured origin");
    equal(success.pathname, "/admin.html", "Success returns to organizer dashboard");
    equal(success.searchParams.get("order_id"), orderId, "Success references the stored order");
    equal(success.searchParams.get("session_id"), "{CHECKOUT_SESSION_ID}", "Stripe fills the Checkout Session placeholder");
    sessions.set(id, session); intents.set(session.payment_intent.id, session.payment_intent);
    charges.set(session.payment_intent.latest_charge.id, { id: session.payment_intent.latest_charge.id, payment_intent: session.payment_intent.id, amount_refunded: 0, livemode });
    if (fetchFailure === "post-ambiguous") {
      fetchFailure = null;
      throw new Error("Synthetic lost Checkout creation response");
    }
    return Response.json(session);
  }
  if (url.pathname.startsWith("/v1/checkout/sessions/")) {
    const id = url.pathname.slice("/v1/checkout/sessions/".length);
    check(url.searchParams.getAll("expand[0]").includes("line_items.data.price"), "Session retrieval expands authoritative Price");
    const session = sessions.get(id); if (!session) return Response.json({}, { status: 404 });
    return Response.json(sessionChanges ? sessionChanges(clean(session)) : session);
  }
  if (url.pathname.startsWith("/v1/payment_intents/")) {
    const intent = intents.get(url.pathname.slice("/v1/payment_intents/".length));
    return Response.json(intentChanges ? intentChanges(clean(intent)) : intent);
  }
  if (url.pathname.startsWith("/v1/charges/")) return Response.json(charges.get(url.pathname.slice("/v1/charges/".length)));
  throw new Error(`Unmocked Stripe fixture route: ${url.pathname}`);
};

function signedRequest(env, type, object, { time = Math.floor(Date.now() / 1000), eventId = `evt_Offline${randomUUID().replaceAll("-", "")}`, livemode = billingConfiguration(env).livemode } = {}) {
  const raw = JSON.stringify({ id: eventId, type, livemode, data: { object } });
  const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${time}.${raw}`).digest("hex");
  return new Request(`${env.PUBLIC_BASE_URL}/api/billing/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${time},v1=${signature}` }, body: raw });
}
async function purchase(fixture, user = principal, env = fixture.env, requestId = randomUUID()) {
  const result = await createBillingCheckout(env, fixture.directory, user, requestId);
  check(result.checkout?.sessionId, "Checkout binds a session to its durable order");
  return { result, session: sessions.get(result.checkout.sessionId), requestId };
}
function paid(session) { session.status = "complete"; session.payment_status = "paid"; return session; }
function reservation(user, index, overrides = {}) {
  const eventId = index.toString(16).padStart(24, "0");
  return { requestId: `billing-event-request-${index}`, payloadHash: index.toString(16).padStart(64, "0"), eventId,
    event: { id: eventId, ownerId: user.id, name: "Offline ballot", lifecycle: "draft",
      opensAt: new Date(Date.now() + 60000).toISOString(), closesAt: new Date(Date.now() + 3600000).toISOString(), ...overrides } };
}
async function persistLegacyAttempt(fixture) {
  const requestId = randomUUID(), orderId = randomUUID();
  const result = await fixture.directory.prepareBillingOrder(principal.id, { requestId, orderId,
    priceId: testEnv.STRIPE_PRICE_ID, amountMinor: Number(testEnv.STRIPE_PRICE_AMOUNT), currency: "hkd", livemode: false,
    expiresAt: Math.floor(Date.now() / 1000) + 3600, origin: testEnv.PUBLIC_BASE_URL });
  const order = result.order;
  // This is the canonical request body used before Managed Payments was
  // explicitly disabled, reconstructed from the immutable saved order.
  const body = new URLSearchParams({ mode: "payment", "line_items[0][price]": order.price_id, "line_items[0][quantity]": "1",
    "allowed_payment_method_types[0]": "card", client_reference_id: order.account_id,
    "metadata[wevote_order_id]": order.id, "metadata[wevote_account_id]": order.account_id,
    "payment_intent_data[metadata][wevote_order_id]": order.id, expires_at: String(order.expires_at),
    success_url: `${order.origin}/admin.html?billing=success&order_id=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${order.origin}/admin.html?billing=cancelled&order_id=${order.id}` }).toString();
  return { requestId, order, body, key: `wevote-order-${order.id}` };
}

try {
  equal(billingConfiguration({}), null, "Billing is disabled with no configuration");
  check(billingConfiguration(testEnv)?.livemode === false && billingConfiguration(liveEnv)?.livemode === true, "Restricted API keys select explicit test/live mode");
  for (const type of ["sk_test", "sk_live", "rk_test", "rk_live"]) {
    const env = { ...(type.endsWith("live") ? liveEnv : testEnv), STRIPE_SECRET_KEY: `${type}_${"d".repeat(40)}` };
    check(billingConfiguration(env), "Both restricted and secret key prefixes are supported");
  }
  for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID", "STRIPE_PRICE_AMOUNT", "STRIPE_PRICE_CURRENCY"]) {
    const env = { ...testEnv }; delete env[name]; equal(billingConfiguration(env), null, "Partial Stripe configuration cannot enable checkout");
  }
  for (const change of [{ STRIPE_SECRET_KEY: `pk_test_${"a".repeat(40)}` }, { STRIPE_PRICE_AMOUNT: "0" }, { STRIPE_PRICE_AMOUNT: "100000001" },
    { STRIPE_PRICE_AMOUNT: "1e4" }, { STRIPE_PRICE_CURRENCY: "HKD" }, { STRIPE_TEST_ORGANIZER_IDS: "" }, { STRIPE_TEST_ORGANIZER_IDS: "*" },
    { STRIPE_TEST_ORGANIZER_IDS: `${accountA},${accountA}` }, { STRIPE_TEST_ORGANIZER_IDS: `${accountA},` }, { PUBLIC_BASE_URL: "http://billing-fixture.invalid" },
    { PUBLIC_BASE_URL: "https://user:private@billing-fixture.invalid" }, { PUBLIC_BASE_URL: "https://billing-fixture.invalid/path" }]) {
    equal(billingConfiguration({ ...testEnv, ...change }), null, "Unsafe configuration cannot enable checkout");
  }
  equal(billingConfiguration({ ...liveEnv, STRIPE_TEST_ORGANIZER_IDS: accountA }), null, "Live configuration requires removing stale test allowlist");
  check(billingEligible(principal, testEnv), "Allowlisted organizer may test checkout");
  check(!billingEligible({ ...principal, id: accountC }, testEnv), "Public organizer cannot buy using test card mode");
  for (const changed of [{ disabled: true }, { role: "admin" }, { role: "owner" }, { selfRegistered: false }]) check(!billingEligible({ ...principal, ...changed }, testEnv), "Only enabled self-registered organizers buy credits");
  check(billingEligible({ ...principal, id: accountC }, liveEnv), "Live offer may be used by ordinary registered organizer");

  const now = Math.floor(Date.now() / 1000), raw = '{"id":"evt_OfflineSignature"}', secret = testEnv.STRIPE_WEBHOOK_SECRET;
  const signature = createHmac("sha256", secret).update(`${now}.${raw}`).digest("hex");
  equal(await verifyStripeWebhook(raw, `t=${now},v1=${signature}`, secret, now), JSON.parse(raw), "Correct raw-body HMAC is accepted");
  equal(await verifyStripeWebhook(raw, `t=${now},v1=${"0".repeat(64)},v0=ignored,v1=${signature}`, secret, now), JSON.parse(raw), "Multiple v1 signatures allow safe signing-secret rotation");
  for (const [body, header, clock] of [[raw+' ',`t=${now},v1=${signature}`,now], [raw,`t=${now},v0=${signature}`,now],
    [raw,`t=${now},t=${now},v1=${signature}`,now], [raw,`t=${now},v1=${signature}`,now+301], [raw,`t=${now},v1=${signature}`,now-301],
    [raw,`t=${now},v1=${"a".repeat(64)}`,now], ["x".repeat(262145),`t=${now},v1=${signature}`,now]]) {
    await rejects(() => verifyStripeWebhook(body, header, secret, clock), 400, "Tampering, unsupported signature, stale/future timestamps and oversized payload rejected");
  }
  const invalidJson = "not JSON", invalidSignature = createHmac("sha256", secret).update(`${now}.${invalidJson}`).digest("hex");
  await rejects(() => verifyStripeWebhook(invalidJson, `t=${now},v1=${invalidSignature}`, secret, now), 400, "Correct signature cannot turn invalid JSON into a billing event");

  const fixture = await directoryFixture({ ...testEnv }, join(workspace, "billing.sqlite"));
  equal(fixture.directory.getCreationQuota(principal.id).used, 0, "Adding billing preserves unused free trial");
  equal((await billingOverview(testEnv, fixture.directory, principal)).paidCredits, 0, "No credit exists before a paid purchase");
  const unsupportedCalls = outbound.length;
  equal(await handleBillingWebhook(signedRequest(testEnv, "customer.created", { id: "cus_Offline" }), testEnv, fixture.directory), { received: true }, "Unsupported signed event is acknowledged");
  equal(outbound.length, unsupportedCalls, "Unsupported event makes no Stripe request");
  const externalSession = { id: "cs_test_ExternalApplication0001", metadata: {}, livemode: false, mode: "payment", status: "complete", payment_status: "paid" };
  sessions.set(externalSession.id, externalSession);
  const initialOrders = fixture.db.prepare("SELECT COUNT(*) AS count FROM billing_orders").get().count;
  const initialReversals = fixture.db.prepare("SELECT COUNT(*) AS count FROM billing_payment_reversals").get().count;
  equal(await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: externalSession.id }), testEnv, fixture.directory), { received: true }, "A valid unrelated Checkout notification is acknowledged without repeated failure");
  externalSession.metadata = { wevote_order_id: randomUUID() };
  equal(await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: externalSession.id }), testEnv, fixture.directory), { received: true }, "A foreign unknown order does not become a local purchase");
  const externalPayment = { id: "pi_ExternalApplication0001", metadata: {}, livemode: false };
  const externalRefund = { id: "ch_ExternalApplication0001", payment_intent: externalPayment.id, livemode: false, amount_refunded: 12345 };
  intents.set(externalPayment.id, externalPayment); charges.set(externalRefund.id, externalRefund);
  equal(await handleBillingWebhook(signedRequest(testEnv, "charge.refunded", { id: externalRefund.id }), testEnv, fixture.directory), { received: true }, "An unrelated refunded payment is acknowledged on a shared Stripe account");
  externalPayment.metadata = { wevote_order_id: randomUUID() };
  await handleBillingWebhook(signedRequest(testEnv, "charge.refunded", { id: externalRefund.id }), testEnv, fixture.directory);
  const legacyRefund = { id: "ch_ExternalLegacyCharge0001", payment_intent: null, livemode: false, amount_refunded: 12345 };
  charges.set(legacyRefund.id, legacyRefund);
  const beforeLegacyCalls = outbound.length;
  for (let delivery = 0; delivery < 2; delivery++) {
    equal(await handleBillingWebhook(signedRequest(testEnv, "charge.refunded", { id: legacyRefund.id }), testEnv, fixture.directory), { received: true }, "An unrelated legacy direct-Charge refund is acknowledged on first delivery and replay");
  }
  equal(outbound.slice(beforeLegacyCalls), Array.from({ length: 2 }, () => ({ path: `/v1/charges/${legacyRefund.id}`, method: "GET" })), "A legacy refund verifies only its Charge and never attempts PaymentIntent retrieval");
  legacyRefund.livemode = true;
  await rejects(() => handleBillingWebhook(signedRequest(testEnv, "charge.refunded", { id: legacyRefund.id }), testEnv, fixture.directory), 400, "Ignoring a legacy refund does not bypass charge mode validation");
  equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM billing_orders").get().count, initialOrders, "Foreign signed notifications cannot create a local billing order");
  equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM billing_payment_reversals").get().count, initialReversals, "Foreign refunds do not accumulate local payment reversal tombstones");
  equal((await billingOverview(testEnv, fixture.directory, principal)).paidCredits, 0, "Foreign Checkout and refund notifications cannot change event credits");
  await rejects(() => createBillingCheckout(testEnv, fixture.directory, { ...principal, id: accountC }, randomUUID()), 403, "Non-allowlisted organizer cannot initiate public test checkout");
  await rejects(() => createBillingCheckout(testEnv, fixture.directory, principal, "bad-id"), 400, "Checkout requires a valid idempotency key");
  const first = await purchase(fixture);
  const posted = postAttempts.length;
  const repeated = await createBillingCheckout(testEnv, fixture.directory, principal, first.requestId);
  equal(repeated.checkout.sessionId, first.result.checkout.sessionId, "Same request reuses the bound checkout");
  equal(postAttempts.length, posted, "Retry of bound checkout makes no new remote purchase");
  const alternateRequestId = randomUUID();
  const alternate = await createBillingCheckout(testEnv, fixture.directory, principal, alternateRequestId);
  equal(alternate.checkout.orderId, first.result.checkout.orderId, "Distinct requests share the existing open checkout order");
  equal(alternate.checkout.sessionId, first.session.id, "Distinct requests share the existing hosted checkout session");
  equal(postAttempts.length, posted, "A second checkout request cannot create another pending remote session");
  await rejects(() => reconcileBillingCheckout(testEnv, fixture.directory, other, { sessionId: first.session.id }), 404, "Another organizer cannot reconcile somebody else's payment");
  for (const input of [{}, { orderId: first.result.checkout.orderId, sessionId: first.session.id }, { sessionId: "https://outside.invalid" }, []]) {
    await rejects(() => reconcileBillingCheckout(testEnv, fixture.directory, principal, input), 400, "Reconcile accepts exactly one bounded order or session identifier");
  }
  await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: first.session.id }), testEnv, fixture.directory);
  equal((await billingOverview(testEnv, fixture.directory, principal)).paidCredits, 0, "Checkout completed but unpaid grants no credit");
  paid(first.session);
  const fulfillments = await Promise.all(Array.from({ length: 12 }, (_, index) => handleBillingWebhook(signedRequest(testEnv,
    index % 2 ? "checkout.session.completed" : "checkout.session.async_payment_succeeded", { id: first.session.id }), testEnv, fixture.directory)));
  check(fulfillments.every(result => result.received), "Concurrent repeated and distinct events for same Checkout Session are acknowledged");
  equal((await billingOverview(testEnv, fixture.directory, principal)).paidCredits, 1, "One paid Session grants one credit despite repeated and distinct webhook events");
  const reconciled = await reconcileBillingCheckout(testEnv, fixture.directory, principal, { orderId: first.result.checkout.orderId });
  equal(reconciled.paidCredits, 1, "Return-page reconciliation cannot grant duplicate credit");
  const alternateAfterPayment = await createBillingCheckout(testEnv, fixture.directory, principal, alternateRequestId);
  equal(alternateAfterPayment.checkout.orderId, first.result.checkout.orderId, "A reused checkout request stays bound to its original order after payment");
  equal(alternateAfterPayment.checkout.status, "paid", "Replaying a reused request returns the paid order");
  equal(postAttempts.length, posted, "Replaying a reused request after payment cannot start another purchase");
  check(!JSON.stringify(reconciled).includes(testEnv.STRIPE_SECRET_KEY) && !JSON.stringify(reconciled).includes(testEnv.STRIPE_WEBHOOK_SECRET), "Organizer response contains no Stripe secrets");
  const free = reservation(principal, 1, { trial: { voteLimit: 10000, maxDurationHours: 24 } });
  check(!(await fixture.directory.reserveSelfRegisteredEvent(principal.id, free)).error, "First reservation still uses the lifetime free trial");
  equal((await billingOverview(testEnv, fixture.directory, principal)).paidCredits, 1, "Free reservation does not consume purchased credit");
  const a = reservation(principal, 2, { trial: { voteLimit: 10000, maxDurationHours: 168 }, entitlement: { kind: "paid-credit" } });
  const b = reservation(principal, 3, { trial: { voteLimit: 10000, maxDurationHours: 168 }, entitlement: { kind: "paid-credit" } });
  const reservations = await Promise.all([fixture.directory.reserveSelfRegisteredEvent(principal.id, a), fixture.directory.reserveSelfRegisteredEvent(principal.id, b)]);
  equal(reservations.filter(value => !value.error).length, 1, "One purchased credit admits exactly one concurrent event reservation");
  const accepted = reservations[0].error ? b : a;
  const retry = await fixture.directory.reserveSelfRegisteredEvent(principal.id, { ...accepted, eventId: "f".repeat(24) });
  equal(retry.eventId, accepted.eventId, "Retry recovers original paid event without spending twice");
  check(retry.reused, "Paid event retry is marked reused");
  equal((await billingOverview(testEnv, fixture.directory, principal)).paidCredits, 0, "Paid credit is consumed exactly once");
  equal((await fixture.directory.reserveSelfRegisteredEvent(principal.id, { ...accepted, payloadHash: "f".repeat(64) })).error, "idempotency_conflict", "Same request cannot substitute a different paid ballot");
  check(fixture.directory.getCreationReservations(principal.id).length === 2, "Free and paid reservation intents remain recoverable");
  const storedPaidEvent = fixture.directory.getReservedEvent(principal.id, accepted.requestId);
  equal(storedPaidEvent.entitlement, { kind: "paid-credit" }, "Authoritative reservation pins paid entitlement");
  equal(storedPaidEvent.trial, { voteLimit: 10000, maxDurationHours: 168 }, "Authoritative reservation pins paid limits");
  // Recreate the deployed pre-failure schema around existing paid data. The
  // migration must preserve order identities, aliases, balances and rowids.
  fixture.db.prepare("UPDATE billing_orders SET rowid = 37 WHERE id = ?").run(first.result.checkout.orderId);
  const savedOrders = fixture.db.prepare("SELECT rowid, * FROM billing_orders ORDER BY rowid").all();
  const savedAliases = fixture.db.prepare("SELECT * FROM billing_checkout_requests ORDER BY request_id").all();
  const savedCredits = fixture.db.prepare("SELECT * FROM billing_credits ORDER BY id").all();
  const legacyOrderSchema = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'billing_orders'").get().sql
    .replace(/CREATE TABLE(?: IF NOT EXISTS)? billing_orders/i, "CREATE TABLE billing_orders_legacy")
    .replace(", 'failed'", "");
  const orderColumns = "rowid, id, account_id, request_id, price_id, amount_minor, currency, livemode, origin, status, expires_at, created_at, session_id, checkout_url, payment_intent";
  fixture.db.exec("BEGIN");
  try {
    fixture.db.exec(legacyOrderSchema);
    fixture.db.exec(`INSERT INTO billing_orders_legacy (${orderColumns}) SELECT ${orderColumns} FROM billing_orders`);
    fixture.db.exec("DROP TABLE billing_orders");
    fixture.db.exec("ALTER TABLE billing_orders_legacy RENAME TO billing_orders");
    fixture.db.exec("COMMIT");
  } catch (error) { fixture.db.exec("ROLLBACK"); throw error; }
  const reopened = await directoryFixture({ ...testEnv }, join(workspace, "billing.sqlite"));
  check(reopened.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'billing_orders'").get().sql.includes("'failed'"), "Legacy schema gains the terminal failed state atomically");
  equal(reopened.db.prepare("SELECT rowid, * FROM billing_orders ORDER BY rowid").all(), savedOrders, "Legacy migration preserves every order value and insertion rowid");
  equal(reopened.db.prepare("SELECT * FROM billing_checkout_requests ORDER BY request_id").all(), savedAliases, "Legacy migration preserves accepted checkout aliases");
  equal(reopened.db.prepare("SELECT * FROM billing_credits ORDER BY id").all(), savedCredits, "Legacy migration preserves purchased credit records and spent state");
  check(reopened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'billing_orders_account'").get(), "Migration restores the account lookup index");
  equal(reopened.directory.getCreationReservations(principal.id).length, 2, "Reopening SQLite preserves both lifetime and purchased reservations");
  equal((await billingOverview(testEnv, reopened.directory, principal)).paidCredits, 0, "Reopening SQLite cannot restore a spent event credit");

  const aliasFixture = await directoryFixture();
  const aliasPurchase = await purchase(aliasFixture);
  let lastAlias;
  const aliasPosts = postAttempts.length;
  for (let index = 0; index < 32; index++) {
    lastAlias = randomUUID();
    const aliasResult = await createBillingCheckout(testEnv, aliasFixture.directory, principal, lastAlias);
    equal(aliasResult.checkout.orderId, aliasPurchase.result.checkout.orderId, "Permitted checkout aliases retain the original pending order");
  }
  equal(aliasFixture.db.prepare("SELECT COUNT(*) AS count FROM billing_checkout_requests").get().count, 32, "Pending-order aliases have a finite durable storage bound");
  const aliasRequests = outbound.length;
  await rejects(() => createBillingCheckout(testEnv, aliasFixture.directory, principal, randomUUID()), 429, "A new checkout UUID beyond the alias bound is rate limited");
  equal(aliasFixture.db.prepare("SELECT COUNT(*) AS count FROM billing_checkout_requests").get().count, 32, "Rate limiting cannot insert another durable alias");
  equal(outbound.length, aliasRequests, "Rate-limited checkout cannot call Stripe");
  equal((await createBillingCheckout(testEnv, aliasFixture.directory, principal, aliasPurchase.requestId)).checkout.orderId, aliasPurchase.result.checkout.orderId, "Original request remains recoverable at the alias bound");
  equal((await createBillingCheckout(testEnv, aliasFixture.directory, principal, lastAlias)).checkout.orderId, aliasPurchase.result.checkout.orderId, "Accepted alias remains recoverable at the alias bound");
  paid(aliasPurchase.session);
  await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: aliasPurchase.session.id }), testEnv, aliasFixture.directory);
  equal((await createBillingCheckout(testEnv, aliasFixture.directory, principal, lastAlias)).checkout.status, "paid", "Accepted alias still recovers its paid order after the storage limit");
  equal(postAttempts.length, aliasPosts, "Alias replay and limit handling never create an additional Stripe Session");

  const fresh = await purchase(fixture, other);
  paid(fresh.session);
  for (const mutate of [
    value => ({ ...value, client_reference_id: accountA }), value => ({ ...value, metadata: { ...value.metadata, wevote_account_id: accountA } }),
    value => ({ ...value, livemode: true }), value => ({ ...value, mode: "subscription" }), value => ({ ...value, currency: "usd" }),
    value => ({ ...value, amount_total: 1 }), value => ({ ...value, amount_subtotal: 1 }),
    value => ({ ...value, line_items: { ...value.line_items, has_more: true } }),
    value => ({ ...value, line_items: { data: [{ ...value.line_items.data[0], quantity: 2 }], has_more: false } }),
    value => ({ ...value, line_items: { data: [{ ...value.line_items.data[0], price: { ...value.line_items.data[0].price, id: "price_Wrong" } }], has_more: false } }),
    value => ({ ...value, payment_intent: { ...value.payment_intent, status: "processing" } }),
    value => ({ ...value, payment_intent: { ...value.payment_intent, currency: "usd" } }),
    value => ({ ...value, payment_intent: { ...value.payment_intent, metadata: { wevote_order_id: randomUUID() } } }),
  ]) {
    sessionChanges = mutate;
    await assert.rejects(() => handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: fresh.session.id }), testEnv, fixture.directory)); checks++;
    equal((await billingOverview(testEnv, fixture.directory, other)).paidCredits, 0, "Mismatched order, amount, Price, quantity, mode and payment intent never grant credit");
  }
  sessionChanges = null;
  await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: fresh.session.id }), testEnv, fixture.directory);
  equal((await billingOverview(testEnv, fixture.directory, other)).paidCredits, 1, "Valid payment can retry after rejected metadata or Price mismatch");
  const charge = charges.get(fresh.session.payment_intent.latest_charge.id); charge.amount_refunded = 1;
  await Promise.all([handleBillingWebhook(signedRequest(testEnv, "charge.refunded", { id: charge.id }), testEnv, fixture.directory),
    handleBillingWebhook(signedRequest(testEnv, "charge.refunded", { id: charge.id }), testEnv, fixture.directory)]);
  equal((await billingOverview(testEnv, fixture.directory, other)).paidCredits, 0, "Refund revokes one unspent credit once");
  await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: fresh.session.id }), testEnv, fixture.directory);
  equal((await billingOverview(testEnv, fixture.directory, other)).paidCredits, 0, "Payment replay cannot reissue a refunded credit");
  const spentCharge = charges.get(first.session.payment_intent.latest_charge.id); spentCharge.amount_refunded = 12345;
  await handleBillingWebhook(signedRequest(testEnv, "charge.refunded", { id: spentCharge.id }), testEnv, fixture.directory);
  equal(fixture.directory.getCreationReservations(principal.id).length, 2, "Refund of spent credit preserves already reserved event data");

  for (const failure of ["http", "network", "oversized", "invalid-json"]) {
    fetchFailure = failure;
    try { await createBillingCheckout(testEnv, fixture.directory, other, randomUUID()); assert.fail("Expected Stripe failure"); }
    catch (error) { check(error.status === 503 && !error.message.includes("PRIVATE_STRIPE") && !error.message.includes(testEnv.STRIPE_SECRET_KEY), "Provider failures return safe errors without granting credit"); }
  }
  fetchFailure = null;
  const rejected = await directoryFixture();
  const rejectedRequestId = randomUUID(), rejectedOrderId = randomUUID();
  await rejected.directory.prepareBillingOrder(principal.id, { requestId: rejectedRequestId, orderId: rejectedOrderId,
    priceId: testEnv.STRIPE_PRICE_ID, amountMinor: Number(testEnv.STRIPE_PRICE_AMOUNT), currency: "hkd", livemode: false,
    expiresAt: Math.floor(Date.now() / 1000) + 3600, origin: testEnv.PUBLIC_BASE_URL });
  const rejectedAliasId = randomUUID();
  await rejected.directory.prepareBillingOrder(principal.id, { requestId: rejectedAliasId, orderId: randomUUID(),
    priceId: testEnv.STRIPE_PRICE_ID, amountMinor: Number(testEnv.STRIPE_PRICE_AMOUNT), currency: "hkd", livemode: false,
    expiresAt: Math.floor(Date.now() / 1000) + 3600, origin: testEnv.PUBLIC_BASE_URL });
  rejectedCheckoutKeys.set(`wevote-order-${rejectedOrderId}`, { status: 400, error: { type: "invalid_request_error", param: "allowed_payment_method_types", message: "PRIVATE_STRIPE_REJECTED_MARKER" } });
  const beforeRejectedSessions = sessions.size;
  try { await createBillingCheckout(testEnv, rejected.directory, principal, rejectedRequestId); assert.fail("Expected definitive Checkout rejection"); }
  catch (error) {
    check(error.status === 503 && error.code === "billing_checkout_failed", "A cached definitive Stripe 400 makes the original order terminally failed");
    check(!error.message.includes("PRIVATE_STRIPE") && !error.message.includes(testEnv.STRIPE_SECRET_KEY), "Definitive rejection does not expose Stripe error text or credentials");
  }
  equal((await billingOverview(testEnv, rejected.directory, principal)).latestCheckout.status, "failed", "The persisted terminal failure is visible after dashboard reload");
  equal(rejected.directory.getBillingOrder(rejectedOrderId).session_id, null, "Only an order without a remote Session becomes failed");
  equal(sessions.size, beforeRejectedSessions, "Cached Stripe 400 does not create a Session");
  const beforeFailedReplay = outbound.length;
  equal((await createBillingCheckout(testEnv, rejected.directory, principal, rejectedRequestId)).checkout.status, "failed", "The old request UUID replays its failed order");
  equal((await createBillingCheckout(testEnv, rejected.directory, principal, rejectedAliasId)).checkout.status, "failed", "Every accepted alias stays bound to the failed order");
  equal(outbound.length, beforeFailedReplay, "Replaying a terminally failed order never retries the same cached Stripe error");
  const afterFailure = await purchase(rejected, principal, testEnv, randomUUID());
  check(afterFailure.result.checkout.orderId !== rejectedOrderId, "Only a new request after definitive failure can create a fresh order and Stripe key");
  equal((await rejected.directory.failBillingOrder(afterFailure.result.checkout.orderId)).status, "open", "A bound remote Session cannot be classified as a definitively failed order");
  equal((await billingOverview(testEnv, rejected.directory, principal)).paidCredits, 0, "Neither a rejected nor unpaid replacement order grants event credit");
  for (const rejection of [
    { status: 400, error: { type: "idempotency_error" } },
    { status: 400, error: { type: "invalid_request_error", code: "idempotency_key_in_use" } },
    { status: 400, error: { type: "invalid_request_error", code: "lock_timeout" } },
    { status: 409, error: { type: "invalid_request_error", code: "conflict" } },
    { status: 500, error: { type: "invalid_request_error" } }
  ]) {
    const uncertain = await directoryFixture(); checkoutRejection = rejection;
    const originalRequest = randomUUID();
    await rejects(() => createBillingCheckout(testEnv, uncertain.directory, principal, originalRequest), 503, "Idempotency conflicts, timeouts and provider failures remain uncertain");
    const originalOrder = (await billingOverview(testEnv, uncertain.directory, principal)).latestCheckout;
    equal(originalOrder.status, "creating", "An uncertain response cannot unlock a new checkout order");
    await rejects(() => createBillingCheckout(testEnv, uncertain.directory, principal, randomUUID()), 503, "A different browser UUID still retries the uncertain order");
    equal((await billingOverview(testEnv, uncertain.directory, principal)).latestCheckout.orderId, originalOrder.orderId, "Uncertain failures retain the original Stripe order identity");
    equal(uncertain.db.prepare("SELECT COUNT(*) AS count FROM billing_orders").get().count, 1, "An uncertain failure cannot create a second local purchase");
  }
  checkoutRejection = null;
  const legacyFailedFixture = await directoryFixture(), legacyFailed = await persistLegacyAttempt(legacyFailedFixture);
  legacyCheckoutReplies.set(legacyFailed.key, { body: legacyFailed.body, status: 400,
    error: { type: "invalid_request_error", param: "allowed_payment_method_types", message: "PRIVATE_STRIPE_CACHED_LEGACY_400" } });
  const beforeLegacyFailurePosts = postAttempts.length, beforeLegacyFailureSessions = sessions.size;
  await rejects(() => createBillingCheckout(testEnv, legacyFailedFixture.directory, principal, legacyFailed.requestId), 503, "Same-key compatibility replay recovers the original cached definitive 400");
  equal(postAttempts.slice(beforeLegacyFailurePosts).map(post => post.key), [legacyFailed.key, legacyFailed.key], "Legacy rejection recovery tries exactly twice with the original key");
  equal(postAttempts.at(-1).body, legacyFailed.body, "The second request exactly matches the original immutable legacy body");
  equal((await billingOverview(testEnv, legacyFailedFixture.directory, principal)).latestCheckout.status, "failed", "Original cached rejection permits a new purchase only after its failed state is saved");
  equal(sessions.size, beforeLegacyFailureSessions, "Legacy cached rejection never creates a Session");
  equal((await createBillingCheckout(testEnv, legacyFailedFixture.directory, principal, legacyFailed.requestId)).checkout.status, "failed", "The original legacy UUID remains mapped to its terminal failed order");

  const legacyRemoteFixture = await directoryFixture(), legacyRemote = await persistLegacyAttempt(legacyRemoteFixture);
  const originalSession = { ...clean(afterFailure.session), id: "cs_test_LegacyOriginalSession0001", expires_at: legacyRemote.order.expires_at,
    url: "https://checkout.stripe.com/c/pay/cs_test_LegacyOriginalSession0001", client_reference_id: principal.id,
    metadata: { wevote_order_id: legacyRemote.order.id, wevote_account_id: principal.id } };
  originalSession.payment_intent.id = "pi_LegacyOriginalPayment0001";
  originalSession.payment_intent.metadata = { wevote_order_id: legacyRemote.order.id };
  originalSession.payment_intent.latest_charge.id = "ch_LegacyOriginalCharge0001";
  sessions.set(originalSession.id, originalSession); intents.set(originalSession.payment_intent.id, originalSession.payment_intent);
  charges.set(originalSession.payment_intent.latest_charge.id, { id: originalSession.payment_intent.latest_charge.id,
    payment_intent: originalSession.payment_intent.id, livemode: false, amount_refunded: 0 });
  legacyCheckoutReplies.set(legacyRemote.key, { body: legacyRemote.body, session: originalSession });
  const beforeLegacyRecoveryPosts = postAttempts.length, existingRemoteSessions = sessions.size;
  const restored = await createBillingCheckout(testEnv, legacyRemoteFixture.directory, principal, legacyRemote.requestId);
  equal(restored.checkout.sessionId, originalSession.id, "Compatibility replay binds the previously created remote Session");
  equal(postAttempts.slice(beforeLegacyRecoveryPosts).map(post => post.key), [legacyRemote.key, legacyRemote.key], "Remote Session recovery never creates a fresh Stripe key");
  equal(postAttempts.at(-1).body, legacyRemote.body, "Remote Session recovery replays the exact original body");
  equal(sessions.size, existingRemoteSessions, "Recovering an existing remote Session does not create a second Session");
  equal((await billingOverview(testEnv, legacyRemoteFixture.directory, principal)).paidCredits, 0, "Recovering an unpaid original Session does not grant credit");
  paid(originalSession);
  await reconcileBillingCheckout(testEnv, legacyRemoteFixture.directory, principal, { orderId: legacyRemote.order.id });
  equal((await billingOverview(testEnv, legacyRemoteFixture.directory, principal)).paidCredits, 1, "The recovered original paid Session still fulfills exactly one credit");

  for (const legacyResult of [{ status: 400, error: { type: "idempotency_error" } }, { status: 500, error: { type: "invalid_request_error" } }, { network: true }]) {
    const unresolvedFixture = await directoryFixture(), unresolved = await persistLegacyAttempt(unresolvedFixture);
    legacyCheckoutReplies.set(unresolved.key, { body: unresolved.body, ...legacyResult });
    const beforeUnresolvedPosts = postAttempts.length;
    await rejects(() => createBillingCheckout(testEnv, unresolvedFixture.directory, principal, unresolved.requestId), 503, "A second conflict, provider failure or network error remains uncertain");
    equal(postAttempts.slice(beforeUnresolvedPosts).map(post => post.key), [unresolved.key, unresolved.key], "Legacy compatibility is bounded to one retry using the same original key");
    equal((await billingOverview(testEnv, unresolvedFixture.directory, principal)).latestCheckout.status, "creating", "Uncertain legacy recovery cannot mark the order failed or unlock a new key");
    await rejects(() => createBillingCheckout(testEnv, unresolvedFixture.directory, principal, randomUUID()), 503, "Another client request cannot bypass uncertain legacy recovery");
    equal(postAttempts.slice(beforeUnresolvedPosts).map(post => post.key), Array(4).fill(unresolved.key), "Different client UUIDs keep retrying the same unresolved Stripe key");
    equal((await billingOverview(testEnv, unresolvedFixture.directory, principal)).latestCheckout.orderId, unresolved.order.id, "Different client UUIDs retain the unresolved original order identity");
    equal(unresolvedFixture.db.prepare("SELECT COUNT(*) AS count FROM billing_orders").get().count, 1, "Uncertain compatibility recovery preserves one durable order");
  }
  equal((await billingOverview(testEnv, fixture.directory, other)).paidCredits, 0, "Stripe failures leave balances unchanged");
  for (const status of [301, 302, 303, 307, 308]) {
    const redirectFixture = await directoryFixture();
    fetchFailure = `redirect-${status}`;
    const beforeRedirect = outbound.length;
    try { await createBillingCheckout(testEnv, redirectFixture.directory, principal, randomUUID()); assert.fail("Expected Stripe redirect rejection"); }
    catch (error) {
      check(error.status === 503 && error.code === "stripe_unavailable", "Stripe redirect is a safe retryable provider failure");
      check(!JSON.stringify({ message: error.message, code: error.code }).includes("PRIVATE_STRIPE_REDIRECT") && !error.message.includes("untrusted.example") && !error.message.includes(testEnv.STRIPE_SECRET_KEY), "Redirect body, destination and private credentials are not exposed");
    }
    equal(outbound.length, beforeRedirect + 1, "A rejected Stripe redirect makes one request and never follows Location");
    equal((await billingOverview(testEnv, redirectFixture.directory, principal)).paidCredits, 0, "Redirects cannot grant event credits");
  }
  fetchFailure = null;
  const badPriceFixture = await directoryFixture(); priceChanges = { unit_amount: 1 };
  await rejects(() => createBillingCheckout(testEnv, badPriceFixture.directory, principal, randomUUID()), 503, "Configured Price amount mismatch stops Checkout creation");
  priceChanges = {};
  for (const changes of [{ active: false }, { recurring: { interval: "month" }, type: "recurring" }, { currency: "usd" }, { livemode: true }]) {
    const wrongOffer = await directoryFixture(); priceChanges = changes;
    await rejects(() => createBillingCheckout(testEnv, wrongOffer.directory, principal, randomUUID()), 503, "Inactive, recurring, wrong-currency and wrong-mode Price cannot create checkout");
  }
  priceChanges = {};
  const historic = await directoryFixture();
  const historicPurchase = await purchase(historic); paid(historicPurchase.session);
  historicPurchase.session.line_items.data[0].price.active = false;
  await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: historicPurchase.session.id }), testEnv, historic.directory);
  equal((await billingOverview(testEnv, historic.directory, principal)).paidCredits, 1, "Archiving a sold Price does not block fulfillment of an already paid order");
  const ambiguous = await directoryFixture();
  const uncertainId = randomUUID(), beforeSessions = sessions.size;
  fetchFailure = "post-ambiguous";
  await rejects(() => createBillingCheckout(testEnv, ambiguous.directory, principal, uncertainId), 503, "Lost remote creation response remains an unconfirmed durable order");
  const lostPost = postAttempts.at(-1);
  const uncertainOrder = (await billingOverview(testEnv, ambiguous.directory, principal)).latestCheckout;
  equal(uncertainOrder.status, "creating", "A reloaded dashboard sees the unfinished durable checkout");
  const recovered = await reconcileBillingCheckout(testEnv, ambiguous.directory, principal, { orderId: uncertainOrder.orderId });
  equal(postAttempts.at(-1), lostPost, "Uncertain checkout retries the byte-identical body and Stripe idempotency key");
  equal(sessions.size, beforeSessions + 1, "Uncertain creation recovery produces only one Stripe Session");
  check(recovered.latestCheckout.sessionId && recovered.latestCheckout.status === "open", "Dashboard reconciliation binds the previously created remote checkout");
  const reversedFirst = await directoryFixture();
  const reversalPurchase = await purchase(reversedFirst); paid(reversalPurchase.session);
  const reversalCharge = charges.get(reversalPurchase.session.payment_intent.latest_charge.id); reversalCharge.amount_refunded = 1;
  const reversalIntent = intents.get(reversalCharge.payment_intent);
  const realReversalMetadata = reversalIntent.metadata;
  reversalIntent.metadata = { wevote_order_id: reversalPurchase.result.checkout.orderId };
  reversalIntent.livemode = true;
  await rejects(() => handleBillingWebhook(signedRequest(testEnv, "charge.refunded", { id: reversalCharge.id }), testEnv, reversedFirst.directory), 400, "A purported known-order refund cannot cross test and live mode");
  equal(reversedFirst.db.prepare("SELECT COUNT(*) AS count FROM billing_payment_reversals").get().count, 0, "Wrong-mode refund cannot add a reversal tombstone");
  reversalIntent.livemode = false; reversalIntent.metadata = realReversalMetadata;
  await handleBillingWebhook(signedRequest(testEnv, "charge.refunded", { id: reversalCharge.id }), testEnv, reversedFirst.directory);
  await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: reversalPurchase.session.id }), testEnv, reversedFirst.directory);
  equal((await billingOverview(testEnv, reversedFirst.directory, principal)).paidCredits, 0, "Refund delivered before payment-success cannot mint a future credit");
  const durableFixture = await directoryFixture();
  const durablePurchase = await purchase(durableFixture); paid(durablePurchase.session);
  durableFixture.storage.syncHook = async () => { throw new Error("Synthetic durability failure"); };
  await assert.rejects(() => handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: durablePurchase.session.id }), testEnv, durableFixture.directory)); checks++;
  durableFixture.storage.syncHook = null;
  await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: durablePurchase.session.id }), testEnv, durableFixture.directory);
  equal((await billingOverview(testEnv, durableFixture.directory, principal)).paidCredits, 1, "Retry after unconfirmed durable write grants credit exactly once");
  const durableFree = reservation(principal, 20);
  await durableFixture.directory.reserveSelfRegisteredEvent(principal.id, durableFree);
  const rollbackReservation = reservation(principal, 21);
  durableFixture.storage.sql.fail = query => query.startsWith("INSERT INTO paid_event_reservations");
  await assert.rejects(() => durableFixture.directory.reserveSelfRegisteredEvent(principal.id, rollbackReservation)); checks++;
  durableFixture.storage.sql.fail = null;
  equal((await billingOverview(testEnv, durableFixture.directory, principal)).paidCredits, 1, "SQL reservation failure rolls back without spending credit");
  equal(durableFixture.directory.getCreationReservations(principal.id).length, 1, "Failed paid reservation leaves no partial event intent");
  await durableFixture.directory.reserveSelfRegisteredEvent(principal.id, rollbackReservation);
  equal((await billingOverview(testEnv, durableFixture.directory, principal)).paidCredits, 0, "Retry after SQL rollback spends exactly one credit");

  const modeFixture = await directoryFixture();
  const simulated = await purchase(modeFixture); paid(simulated.session);
  await handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: simulated.session.id }), testEnv, modeFixture.directory);
  const modeFree = reservation(principal, 10, { trial: { voteLimit: 10000, maxDurationHours: 24 } });
  await modeFixture.directory.reserveSelfRegisteredEvent(principal.id, modeFree);
  Object.assign(modeFixture.env, liveEnv);
  equal((await billingOverview(liveEnv, modeFixture.directory, principal)).paidCredits, 0, "Test purchase cannot unlock a live event credit after mode transition");
  const liveReservation = reservation(principal, 11, { trial: { voteLimit: 10000, maxDurationHours: 168 }, entitlement: { kind: "paid-credit" } });
  check((await modeFixture.directory.reserveSelfRegisteredEvent(principal.id, liveReservation)).error, "Separate mode ledgers refuse spending test credits as live credits");
  await rejects(() => handleBillingWebhook(signedRequest(testEnv, "checkout.session.completed", { id: simulated.session.id }), liveEnv, modeFixture.directory), 400, "Test event cannot be delivered as a live webhook");

  const ballotDb = new DatabaseSync(":memory:"); databases.push(ballotDb);
  const ballotSql = { exec(query, ...bindings) { const statement = ballotDb.prepare(query); const reads = /^\s*(SELECT|PRAGMA)\b/i.test(query); const rows = reads ? statement.all(...bindings).map(row => ({ ...row })) : []; if (!reads) statement.run(...bindings); return { toArray: () => rows, one: () => rows[0] }; } };
  const ballotCtx = { storage: { sql: ballotSql, transactionSync(callback) { ballotDb.exec("BEGIN"); try { const result = callback(); ballotDb.exec("COMMIT"); return result; } catch(error) { ballotDb.exec("ROLLBACK"); throw error; } }, async sync() {} } };
  initTrialBallot(ballotSql);
  const ballotNow = Date.now();
  const paidBallot = { lifecycle: "published", ballotVersion: "billing-test", options: [{ id: "o1" }, { id: "o2" }], entitlement: { kind: "paid-credit" },
    trial: { voteLimit: 10000, maxDurationHours: 168 }, opensAt: new Date(ballotNow-1000).toISOString(), closesAt: new Date(ballotNow-1000+168*3600000).toISOString() };
  const ballot = { voterHash: "a".repeat(64), optionId: "o1", ballotVersion: "billing-test" };
  equal((await recordTrialVote(ballotCtx, paidBallot, ballot, ballotNow)).status, 200, "Paid credit permits an authoritative seven-day voting window");
  equal((await recordTrialVote(ballotCtx, { ...paidBallot, closesAt: new Date(ballotNow-1000+192*3600000).toISOString() }, { ...ballot, voterHash: "b".repeat(64) }, ballotNow)).status, 503, "Eight-day paid voting window fails closed");
  equal((await recordTrialVote(ballotCtx, { ...paidBallot, entitlement: undefined, trial: { voteLimit: 10000, maxDurationHours: 168 } }, { ...ballot, voterHash: "c".repeat(64) }, ballotNow)).status, 503, "Unentitled free ballot cannot raise its duration to seven days");
  equal((await recordTrialVote(ballotCtx, { ...paidBallot, entitlement: undefined, trial: { voteLimit: 10000, maxDurationHours: 24 }, closesAt: new Date(ballotNow+25*3600000).toISOString() }, { ...ballot, voterHash: "d".repeat(64) }, ballotNow)).status, 503, "Free trial remains limited to 24 hours");
  equal(readTrialResults(ballotSql, paidBallot).turnout, 1, "Invalid extended limits do not add any ballots");

  // Miniflare intercepts all real workerd outbound requests itself. Restore
  // Node's fetch first so its test transport is not mistaken for Stripe traffic.
  globalThis.fetch = originalFetch;
  const runtimeChecks = await testBillingRuntime();
  checks += runtimeChecks;
  console.log(`Offline Stripe billing checks passed (${checks} assertions, including ${runtimeChecks} real workerd checks).`);
} finally {
  globalThis.fetch = originalFetch;
  for (const database of databases) database.close();
  await rm(workspace, { recursive: true, force: true });
}
