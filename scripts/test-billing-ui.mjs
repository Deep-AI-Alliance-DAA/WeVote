#!/usr/bin/env node
// Focused Checkout failure recovery checks. No browser, Stripe or payment.
import assert from "node:assert/strict";
import { createBilling } from "../public/billing.js";

const original = Object.fromEntries(["document", "location", "history", "sessionStorage"].map((key) => [key, globalThis[key]]));
const storage = new Map();
const principal = { id: "a".repeat(24), role: "organizer", selfRegistered: true };
const quota = { limit: 1, used: 1, eventId: "b".repeat(24), paidCredits: 0, remaining: 0, canCreate: false, nextEvent: null };
const offer = { currency: "hkd", amountMinor: 9900, credits: 1, voteLimit: 10000, maxDurationHours: 168, livemode: false };
const failed = { orderId: "12345678-1234-4234-8234-123456789abc", status: "failed", sessionId: null, url: null, expiresAt: 1, livemode: false };
const storageKey = `wevote-checkout-request:${principal.id}`;
const overview = (checkout = null) => ({ principal, creationQuota: { ...quota }, enabled: true, eligible: true, offer, paidCredits: 0, latestCheckout: checkout });
let checks = 0;
const equal = (actual, expected, label) => { assert.equal(actual, expected, label); checks++; };

function harness(initial, checkoutResponses) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, textContent: "", className: "", listeners: {}, setAttribute() {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
    return elements.get(id);
  };
  globalThis.document = { hidden: false, getElementById: element };
  globalThis.location = { href: "https://vote.example/admin.html" };
  globalThis.history = { replaceState() {} };
  globalThis.sessionStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const context = { principal, quota: { ...quota }, version: 1, creationBusy: false, pendingCreation: false };
  const requests = [];
  const navigations = [];
  let billing;
  billing = createBilling({ getContext: () => context,
    async api(path, options = {}) {
      if (path === "/api/admin/billing") return initial;
      assert.equal(path, "/api/admin/billing/checkout");
      requests.push(options.headers["Idempotency-Key"]);
      const result = checkoutResponses.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    async onResponse(data) {
      if (data.principal && data.principal.id !== context.principal.id) { context.principal = data.principal; context.version++; }
      if (data.creationQuota) context.quota = data.creationQuota;
      billing.update();
    }, async onCredited() {}, focusCreate() {}, navigate: (url) => navigations.push(url),
  });
  // Click handlers intentionally start async work without exposing internals.
  async function buy() {
    element("billing-buy").listeners.click();
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  }
  return { billing, element, buy, context, requests, navigations };
}

try {
  storage.clear();
  const rejected = Object.assign(new Error("Safe provider error"), { code: "billing_checkout_failed", status: 503, principal, creationQuota: { ...quota }, billingOverview: overview(failed) });
  const open = { ...failed, orderId: "22345678-1234-4234-8234-123456789abc", status: "open", sessionId: "cs_test_offline", url: "https://checkout.stripe.com/c/pay/offline" };
  const errors = harness(overview(), [rejected, { ...overview(open), checkout: open }]);
  await errors.billing.refresh();
  await errors.buy();
  equal(errors.requests.length, 1, "definitive failure performs one create request");
  equal(storage.has(storageKey), false, "authoritative failed overview retires the purchase request");
  equal(errors.element("billing-buy").hidden, false, "definitive failure permits a new checkout");
  equal(errors.element("billing-buy").textContent, "重新建立結帳", "new request action is explicit");
  equal(errors.element("billing-message").textContent.includes("未有建立付款"), true, "failure message states no payment was created");
  equal(errors.context.quota.paidCredits, 0, "rejected checkout cannot grant a credit");
  equal(errors.navigations.length, 0, "rejected checkout never navigates");
  await errors.buy();
  equal(errors.requests[0] !== errors.requests[1], true, "confirmed failure retries with a new UUID");
  equal(errors.navigations.length, 1, "only a later valid session can navigate to Stripe");
  errors.billing.reset();

  storage.clear();
  const ambiguous = harness(overview(), [new Error("Unknown transport outcome"), new Error("Unknown transport outcome")]);
  await ambiguous.billing.refresh();
  await ambiguous.buy();
  const retained = storage.get(storageKey);
  equal(Boolean(retained), true, "uncertain transport outcome retains the request");
  await ambiguous.buy();
  equal(ambiguous.requests[1], retained, "uncertain retry reuses the same UUID");
  equal(ambiguous.element("billing-buy").textContent, "重試取得同一結帳連結", "uncertain retry keeps the cautious action");
  ambiguous.billing.reset();

  storage.clear();
  storage.set(storageKey, "32345678-1234-4234-8234-123456789abc");
  const replay = harness(overview(), [{ ...overview(failed), checkout: failed }]);
  await replay.billing.refresh();
  await replay.buy();
  equal(storage.has(storageKey), false, "successful failed-order replay also retires the old UUID");
  equal(replay.element("billing-message").textContent.includes("未有新增活動額度"), true, "failed replay preserves the zero-credit explanation");
  replay.billing.reset();

  storage.clear();
  storage.set(storageKey, "42345678-1234-4234-8234-123456789abc");
  const reload = harness(overview(failed), []);
  await reload.billing.refresh();
  equal(storage.has(storageKey), false, "dashboard reload recovers a terminal failure");
  equal(reload.element("billing-buy").textContent, "重新建立結帳", "reload offers a new checkout instead of stale creating state");
  reload.billing.reset();

  console.log(`Billing failure UI checks passed (${checks} assertions). No payments or provider requests.`);
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
}
