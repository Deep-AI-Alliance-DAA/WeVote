// Exercise the actual billing helper in workerd. Every Stripe outbound request
// is intercepted by Miniflare; no operator secrets or real payments are used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import { STRIPE_API_VERSION } from "../src/billing.js";

export async function testBillingRuntime() {
  const origin = "https://billing-runtime.example";
  const accountId = "a".repeat(24);
  const key = `rk_test_${"a".repeat(40)}`;
  const environment = { PUBLIC_BASE_URL: origin, STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: `whsec_${"b".repeat(40)}`,
    STRIPE_PRICE_ID: "price_RuntimeDisposable", STRIPE_PRICE_AMOUNT: "9900", STRIPE_PRICE_CURRENCY: "hkd", STRIPE_TEST_ORGANIZER_IDS: accountId };
  let checks = 0;
  const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  let priceCalls = 0; let sessionCalls = 0;
  let redirectAt = null; let redirectStatus = 307;
  const entry = `
    import { createBillingCheckout, BillingError } from "./src/billing.js";
    const env = ${JSON.stringify(environment)};
    const principal = { id: ${JSON.stringify(accountId)}, role: "organizer", selfRegistered: true, disabled: false };
    export default { async fetch(request) {
      let order;
      const directory = {
        async prepareBillingOrder(id, input) {
          order = { id: input.orderId, account_id: id, request_id: input.requestId, price_id: input.priceId,
            amount_minor: input.amountMinor, currency: input.currency, livemode: Number(input.livemode),
            origin: input.origin, status: "creating", expires_at: input.expiresAt };
          return { order };
        },
        async bindBillingSession(id, input) {
          order = { ...order, status: "open", session_id: input.sessionId, checkout_url: input.url };
          return order;
        },
        async getBillingSummary() { return { paidCredits: 0, latestCheckout: order }; },
        async getCreationQuota() { return { limit: 1, used: 1, eventId: null, paidCredits: 0, remaining: 0, canCreate: false, nextEvent: null }; }
      };
      try { return Response.json(await createBillingCheckout(env, directory, principal, request.headers.get("Idempotency-Key"))); }
      catch (error) {
        if (!(error instanceof BillingError)) throw error;
        return Response.json({ error: error.message, code: error.code }, { status: error.status });
      }
    } };
  `;
  const bundle = await build({ stdin: { contents: entry, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "billing-runtime.mjs" },
    bundle: true, format: "esm", platform: "browser", write: false, logLevel: "silent" });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-10-09", script: bundle.outputFiles[0].text,
    log: new Log(LogLevel.ERROR),
    async outboundService(request) {
      const url = new URL(request.url);
      equal(url.origin, "https://api.stripe.com", "workerd never forwards Stripe credentials to a redirect destination");
      equal(request.headers.get("Authorization"), `Bearer ${key}`, "only a disposable test key is used");
      equal(request.headers.get("Stripe-Version"), STRIPE_API_VERSION, "runtime pins the approved Stripe API version");
      if (url.pathname === "/v1/prices/price_RuntimeDisposable") {
        priceCalls++;
        equal(request.method, "GET", "runtime retrieves the authoritative price");
        if (redirectAt === "price") return new Response("PRIVATE_REDIRECT_BODY", { status: redirectStatus, headers: { Location: "https://untrusted.example/steal" } });
        return Response.json({ id: "price_RuntimeDisposable", active: true, type: "one_time", recurring: null, unit_amount: 9900, currency: "hkd", livemode: false });
      }
      equal(url.pathname, "/v1/checkout/sessions", "runtime only creates the configured Checkout Session");
      sessionCalls++;
      equal(request.method, "POST", "runtime creates Checkout server-side");
      const form = new URLSearchParams(await request.text());
      equal(form.get("line_items[0][price]"), environment.STRIPE_PRICE_ID, "runtime selects the fixed server price");
      equal(form.get("line_items[0][quantity]"), "1", "runtime buys one event credit");
      equal(form.get("managed_payments[enabled]"), "false", "runtime explicitly creates standard merchant Checkout without Managed Payments");
      equal(form.get("allowed_payment_method_types[0]"), "card", "runtime uses the current Stripe API payment-method parameter");
      equal(request.headers.get("Idempotency-Key"), `wevote-order-${form.get("metadata[wevote_order_id]")}`, "runtime uses a persisted-order Stripe key");
      if (redirectAt === "session") return new Response("PRIVATE_REDIRECT_BODY", { status: redirectStatus, headers: { Location: "https://untrusted.example/steal" } });
      return Response.json({ id: "cs_test_RuntimeDisposable0001", livemode: false, mode: "payment", expires_at: Number(form.get("expires_at")), url: "https://checkout.stripe.com/c/pay/cs_test_RuntimeDisposable0001" });
    },
  }));
  try {
    const submit = () => runtime.dispatchFetch(`${origin}/checkout`, { method: "POST", redirect: "manual", headers: { "Idempotency-Key": randomUUID() } });
    const opened = await submit();
    equal(opened.status, 200, "real workerd accepts Stripe price and Checkout fetches");
    const data = await opened.json();
    equal(data.checkout.status, "open", "real runtime returns the verified hosted Checkout URL");
    equal(data.checkout.livemode, false, "test-mode Checkout is explicit");
    equal(priceCalls, 1, "runtime makes one price request");
    equal(sessionCalls, 1, "runtime makes one Checkout request");
    for (const stage of ["price", "session"]) {
      redirectAt = stage;
      for (const status of [301, 302, 303, 307, 308]) {
        redirectStatus = status;
        const beforePrices = priceCalls; const beforeSessions = sessionCalls;
        const redirected = await submit();
        equal(redirected.status, 503, `workerd rejects ${status} ${stage} redirect`);
        const failure = await redirected.json();
        equal(failure.code, "stripe_unavailable", "redirect failure remains a safe retryable billing error");
        equal(JSON.stringify(failure).includes("PRIVATE_REDIRECT_BODY"), false, "redirect response content is never exposed");
        equal(priceCalls - beforePrices, 1, "redirect attempt does not repeat or follow price requests");
        equal(sessionCalls - beforeSessions, stage === "price" ? 0 : 1, "redirect never produces an extra Checkout request");
      }
    }
    return checks;
  } finally { await runtime.dispose(); }
}
