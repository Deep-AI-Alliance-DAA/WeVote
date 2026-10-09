// Stripe hosted Checkout. Card data stays on Stripe; this Worker stores only
// immutable purchase references and verifies fulfillment before issuing credits.
export const STRIPE_API_VERSION = "2026-09-30.endive";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SESSION = /^cs_(?:test_|live_)?[A-Za-z0-9]{8,256}$/;
const PAYMENT = /^pi_[A-Za-z0-9]{8,256}$/;
const encoder = new TextEncoder();
const BODY_LIMIT = 262144;

export class BillingError extends Error {
  constructor(message, status = 400, code = "billing_error") { super(message); this.status = status; this.code = code; }
}

export function billingConfiguration(env) {
  const keyMode = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/.exec(env.STRIPE_SECRET_KEY || "");
  const amount = String(env.STRIPE_PRICE_AMOUNT || "");
  const allowlist = String(env.STRIPE_TEST_ORGANIZER_IDS || "");
  const ids = allowlist ? allowlist.split(",").map(id => id.trim()) : [];
  let origin;
  try {
    const url = new URL(env.PUBLIC_BASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    origin = url.origin;
  } catch { return null; }
  if (!keyMode || !/^whsec_[A-Za-z0-9]{16,}$/.test(env.STRIPE_WEBHOOK_SECRET || "") ||
      !/^price_[A-Za-z0-9]+$/.test(env.STRIPE_PRICE_ID || "") || !/^[1-9]\d*$/.test(amount) ||
      !Number.isSafeInteger(Number(amount)) || Number(amount) > 100000000 || !/^[a-z]{3}$/.test(env.STRIPE_PRICE_CURRENCY || "") ||
      ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{24}$/.test(id)) ||
      (keyMode[1] === "test" ? !ids.length : ids.length > 0)) return null;
  return { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, priceId: env.STRIPE_PRICE_ID,
    amountMinor: Number(amount), currency: env.STRIPE_PRICE_CURRENCY, livemode: keyMode[1] === "live", origin };
}

export function billingEligible(principal, env) {
  const config = billingConfiguration(env);
  if (!config || !principal?.selfRegistered || principal.role !== "organizer" || principal.disabled) return false;
  return config.livemode || String(env.STRIPE_TEST_ORGANIZER_IDS).split(",").map(id => id.trim()).includes(principal.id);
}

async function boundedText(response, webhook = false) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) { await reader.cancel(); throw new BillingError(webhook ? "付款通知過大。" : "付款服務回應過大，請稍後再試。", webhook ? 413 : 503); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new BillingError(webhook ? "付款通知格式無效。" : "付款服務回應無效。", webhook ? 400 : 503); }
}

async function stripeRequest(config, path, { method = "GET", form, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${config.secretKey}`, "Stripe-Version": STRIPE_API_VERSION };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let response;
  try {
    response = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers,
      ...(form ? { body: form.toString() } : {}), redirect: "manual", signal: AbortSignal.timeout(10000) });
    // workerd supports follow/manual. Manual plus an explicit rejection also
    // ensures a redirect can never forward the Stripe Authorization header.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new BillingError("付款服務回應無效，請稍後重試同一張訂單。", 503, "stripe_unavailable");
    }
    const text = await boundedText(response);
    if (!response.ok) {
      let providerError;
      try { providerError = JSON.parse(text)?.error; } catch { /* Unrecognized failures remain uncertain. */ }
      if (method === "POST" && path === "checkout/sessions" && response.status === 400 && providerError?.type === "idempotency_error") {
        throw new BillingError("付款訂單正等待確認，請重試同一張訂單。", 503, "billing_idempotency_conflict");
      }
      // Only a definitive rejection of Session creation permits a new order.
      // Idempotency conflicts, lock/timeouts and provider failures must keep
      // the original key because a remote Session might already exist.
      if (method === "POST" && path === "checkout/sessions" && response.status === 400 &&
          providerError?.type === "invalid_request_error" &&
          !/(?:idempotency|conflict|timeout|lock)/i.test(`${providerError.code || ""} ${providerError.param || ""}`)) {
        throw new BillingError("付款服務拒絕咗呢張結帳訂單，請重新建立結帳。", 503, "billing_checkout_failed");
      }
      throw new BillingError("付款服務暫時未能完成請求，請重試同一張訂單。", 503, "stripe_unavailable");
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError("付款服務暫時未能完成請求，請重試同一張訂單。", 503, "stripe_unavailable");
  }
}

function checkoutView(order) {
  return order ? { orderId: order.id, sessionId: order.session_id || null, url: order.status === "open" ? order.checkout_url : null,
    status: order.status, expiresAt: order.expires_at, livemode: Boolean(order.livemode) } : null;
}

function offerView(config) {
  return config ? { currency: config.currency, amountMinor: config.amountMinor,
    credits: 1, voteLimit: 10000, maxDurationHours: 168, livemode: config.livemode } : null;
}

// Public pricing uses only a complete live configuration. Test mode, private
// Stripe identifiers, account balances and purchase state stay off this route.
export function publicBillingOffer(env) {
  const config = billingConfiguration(env);
  return config?.livemode ? { enabled: true, offer: offerView(config) } : { enabled: false, offer: null };
}

export async function billingOverview(env, directory, principal) {
  const config = billingConfiguration(env);
  const eligible = billingEligible(principal, env);
  const summary = await directory.getBillingSummary(principal.id);
  return { enabled: Boolean(config), eligible, offer: offerView(config),
    paidCredits: summary?.paidCredits || 0, latestCheckout: config ? checkoutView(summary?.latestCheckout) : null, principal,
    creationQuota: await directory.getCreationQuota(principal.id) };
}

function requireConfiguration(env, principal) {
  const config = billingConfiguration(env);
  if (!config) throw new BillingError("Stripe 付款尚未啟用。", 503, "billing_disabled");
  if (!billingEligible(principal, env)) throw new BillingError("呢個帳戶暫時未能購買活動額度。", 403, "billing_ineligible");
  return config;
}

function checkPrice(price, order, requireActive = false) {
  if (price?.id !== order.price_id || (requireActive && price.active !== true) || price.type !== "one_time" || price.recurring ||
      price.unit_amount !== order.amount_minor || price.currency !== order.currency || price.livemode !== Boolean(order.livemode)) {
    throw new BillingError("Stripe 價格設定同活動方案不符，請聯絡管理員。", 503, "billing_price_mismatch");
  }
}

export async function createBillingCheckout(env, directory, principal, requestId) {
  const config = requireConfiguration(env, principal);
  if (!UUID.test(requestId || "")) throw new BillingError("請使用有效嘅訂單重試識別。", 400, "billing_idempotency_required");
  const result = await directory.prepareBillingOrder(principal.id, { requestId, orderId: crypto.randomUUID(), priceId: config.priceId,
    amountMinor: config.amountMinor, currency: config.currency, livemode: config.livemode,
    expiresAt: Math.floor(Date.now() / 1000) + 3600, origin: config.origin });
  if (result?.error === "too_many_requests") throw new BillingError("呢張訂單重試次數太多，請檢查原有結帳，唔好建立新付款請求。", 429, "billing_rate_limited");
  if (result?.error) throw new BillingError("呢個帳戶暫時未能購買活動額度。", 403, "billing_ineligible");
  let order = result.order;
  if (order.status === "creating" && order.expires_at > Math.floor(Date.now() / 1000)) {
    checkPrice(await stripeRequest(config, `prices/${encodeURIComponent(order.price_id)}`), order, true);
    const form = new URLSearchParams({ mode: "payment", "line_items[0][price]": order.price_id, "line_items[0][quantity]": "1",
      "managed_payments[enabled]": "false", "allowed_payment_method_types[0]": "card", client_reference_id: order.account_id,
      "metadata[wevote_order_id]": order.id, "metadata[wevote_account_id]": order.account_id,
      "payment_intent_data[metadata][wevote_order_id]": order.id,
      expires_at: String(order.expires_at),
      success_url: `${order.origin}/admin.html?billing=success&order_id=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${order.origin}/admin.html?billing=cancelled&order_id=${order.id}` });
    let session;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        session = await stripeRequest(config, "checkout/sessions", { method: "POST", form, idempotencyKey: `wevote-order-${order.id}` });
        break;
      } catch (error) {
        if (attempt === 0 && error instanceof BillingError && error.code === "billing_idempotency_conflict") {
          // An earlier release omitted this one field. Replay that canonical
          // legacy body once under the SAME saved order/key to recover either
          // its remote Session or its cached rejection. Never replace a key
          // merely because Stripe reports different request parameters.
          form.delete("managed_payments[enabled]");
          continue;
        }
        if (error instanceof BillingError && error.code === "billing_checkout_failed") await directory.failBillingOrder(order.id);
        throw error;
      }
    }
    if (!SESSION.test(session?.id || "") || session.livemode !== Boolean(order.livemode) || session.mode !== "payment" ||
        session.expires_at !== order.expires_at || !checkoutUrl(session.url)) throw new BillingError("付款服務回應無效，請重試同一張訂單。", 503);
    order = await directory.bindBillingSession(order.id, { sessionId: session.id, url: session.url, expiresAt: session.expires_at });
  } else if (order.status === "creating") {
    // An ambiguous creation may already exist remotely. Never recreate it with
    // a fresh key after Stripe's idempotency retention window.
    order = await directory.reviewBillingOrder(order.id);
  }
  const checkout = checkoutView(order);
  return { ...await billingOverview(env, directory, principal), checkout, latestCheckout: checkout };
}

function checkoutUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.username && !url.password; }
  catch { return false; }
}

async function retrieveSession(config, sessionId) {
  if (!SESSION.test(sessionId || "")) throw new BillingError("付款識別無效。", 400);
  return stripeRequest(config, `checkout/sessions/${encodeURIComponent(sessionId)}?expand%5B0%5D=line_items.data.price&expand%5B1%5D=payment_intent.latest_charge`);
}

async function fulfillSession(config, directory, session, expectedOrderId) {
  const orderId = session?.metadata?.wevote_order_id;
  if (!UUID.test(orderId || "") || (expectedOrderId && orderId !== expectedOrderId)) throw new BillingError("付款訂單不符。", 400);
  const order = await directory.getBillingOrder(orderId);
  if (!order || session.id !== (order.session_id || session.id) || session.livemode !== Boolean(order.livemode) || config.livemode !== Boolean(order.livemode) ||
      session.mode !== "payment" || session.client_reference_id !== order.account_id || session.metadata.wevote_account_id !== order.account_id) {
    throw new BillingError("付款訂單不符。", 400);
  }
  if (session.status === "expired") return directory.expireBillingOrder(order.id);
  if (session.status !== "complete" || session.payment_status !== "paid") return order;
  const lines = session.line_items;
  if (session.currency !== order.currency || session.amount_total !== order.amount_minor || session.amount_subtotal !== order.amount_minor ||
      !lines || lines.has_more || !Array.isArray(lines.data) || lines.data.length !== 1 || lines.data[0].quantity !== 1) {
    throw new BillingError("付款方案不符。", 400);
  }
  checkPrice(lines.data[0].price, order);
  const payment = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!PAYMENT.test(payment || "")) throw new BillingError("付款紀錄無效。", 400);
  let intent = session.payment_intent;
  if (!intent || typeof intent !== "object" || !intent.latest_charge || typeof intent.latest_charge !== "object") {
    intent = await stripeRequest(config, `payment_intents/${encodeURIComponent(payment)}?expand%5B0%5D=latest_charge`);
  }
  if (intent.id !== payment || intent.livemode !== config.livemode || intent.status !== "succeeded" || intent.amount !== order.amount_minor ||
      intent.currency !== order.currency || intent.metadata?.wevote_order_id !== order.id) {
    throw new BillingError("付款紀錄無效。", 400);
  }
  if (intent.latest_charge?.amount_refunded > 0) {
    await directory.revokeBillingPayment({ paymentIntent: payment, livemode: config.livemode });
  }
  return directory.fulfillBillingOrder({ orderId: order.id, sessionId: session.id, paymentIntent: payment, livemode: config.livemode });
}

export async function reconcileBillingCheckout(env, directory, principal, input) {
  const config = requireConfiguration(env, principal);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 ||
      !(Object.hasOwn(input, "orderId") ? UUID.test(input.orderId || "") : Object.hasOwn(input, "sessionId") && SESSION.test(input.sessionId || ""))) {
    throw new BillingError("請提供一個有效嘅訂單或付款識別。", 400);
  }
  let order = await directory.getOwnedBillingOrder(principal.id, input);
  if (!order) throw new BillingError("找不到呢個帳戶嘅付款訂單。", 404);
  if (order.session_id) order = await fulfillSession(config, directory, await retrieveSession(config, order.session_id), order.id);
  else if (order.expires_at <= Math.floor(Date.now() / 1000)) order = await directory.reviewBillingOrder(order.id);
  else if (order.status === "creating") {
    // Reloading after an ambiguous create response still recovers the exact
    // persisted request. This creates a Checkout URL, never a payment charge.
    await createBillingCheckout(env, directory, principal, order.request_id);
    order = await directory.getBillingOrder(order.id);
  }
  const checkout = checkoutView(order);
  return { ...await billingOverview(env, directory, principal), status: order.status, latestCheckout: checkout };
}

export async function verifyStripeWebhook(raw, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof raw !== "string" || !raw || encoder.encode(raw).byteLength > BODY_LIMIT || typeof header !== "string" || header.length > 4096 || !secret) {
    throw new BillingError("付款通知驗證失敗。", 400, "billing_signature_invalid");
  }
  const values = header.split(",").map(value => value.trim().split("="));
  const timestamps = values.filter(([key]) => key === "t");
  const signatures = values.filter(([key, value]) => key === "v1" && /^[a-f0-9]{64}$/.test(value || "")).map(([, value]) => value);
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0][1] || "") || !signatures.length) throw new BillingError("付款通知驗證失敗。", 400, "billing_signature_invalid");
  const time = Number(timestamps[0][1]);
  if (!Number.isSafeInteger(time) || Math.abs(nowSeconds - time) > 300) throw new BillingError("付款通知已過期。", 400, "billing_signature_invalid");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const payload = encoder.encode(`${timestamps[0][1]}.${raw}`);
  let valid = false;
  for (const signature of signatures) {
    const bytes = Uint8Array.from(signature.match(/../g), value => Number.parseInt(value, 16));
    if (await crypto.subtle.verify("HMAC", key, bytes, payload)) valid = true;
  }
  if (!valid) throw new BillingError("付款通知驗證失敗。", 400, "billing_signature_invalid");
  try { return JSON.parse(raw); } catch { throw new BillingError("付款通知格式無效。", 400); }
}

export async function handleBillingWebhook(request, env, directory) {
  const config = billingConfiguration(env);
  if (!config) throw new BillingError("Stripe 付款尚未啟用。", 503, "billing_disabled");
  if (Number(request.headers.get("Content-Length") || 0) > BODY_LIMIT) throw new BillingError("付款通知過大。", 413);
  const raw = await boundedText(request, true);
  const event = await verifyStripeWebhook(raw, request.headers.get("Stripe-Signature"), config.webhookSecret);
  if (typeof event?.id !== "string" || !/^evt_[A-Za-z0-9]+$/.test(event.id) || event.livemode !== config.livemode) throw new BillingError("付款通知環境不符。", 400);
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired", "checkout.session.async_payment_failed"].includes(event.type)) {
    const session = await retrieveSession(config, event.data?.object?.id);
    // A Stripe account may run several applications. A valid notification for
    // another application's session must not create credits or retry forever.
    const orderId = session?.metadata?.wevote_order_id;
    if (!UUID.test(orderId || "") || !await directory.getBillingOrder(orderId)) return { received: true };
    if (event.type === "checkout.session.async_payment_failed" && session.payment_status !== "paid") {
      const order = await directory.getBillingOrder(orderId);
      if (!order || session.livemode !== config.livemode || Boolean(order.livemode) !== config.livemode || session.mode !== "payment" || session.client_reference_id !== order.account_id ||
          session.metadata.wevote_account_id !== order.account_id || (order.session_id && order.session_id !== session.id)) throw new BillingError("付款訂單不符。", 400);
      await directory.expireBillingOrder(order.id);
    } else await fulfillSession(config, directory, session);
  } else if (event.type === "charge.refunded") {
    const chargeId = event.data?.object?.id;
    if (!/^ch_[A-Za-z0-9]{8,256}$/.test(chargeId || "")) throw new BillingError("退款通知無效。", 400);
    const charge = await stripeRequest(config, `charges/${encodeURIComponent(chargeId)}`);
    if (charge.id !== chargeId || charge.livemode !== config.livemode || !(charge.amount_refunded > 0)) throw new BillingError("退款通知無效。", 400);
    // Legacy direct Charges from another application have no PaymentIntent.
    // Our Checkout purchases always have one, so this verified refund cannot
    // affect a WeVote order and should not cause repeated webhook deliveries.
    if (charge.payment_intent === null) return { received: true };
    if (!PAYMENT.test(charge.payment_intent || "")) throw new BillingError("退款通知無效。", 400);
    let order = await directory.getBillingOrderByPayment(charge.payment_intent, config.livemode);
    if (!order) {
      // Refund notifications can arrive before Checkout fulfillment. The
      // PaymentIntent metadata was set by our server during session creation.
      const intent = await stripeRequest(config, `payment_intents/${encodeURIComponent(charge.payment_intent)}`);
      const orderId = intent.metadata?.wevote_order_id;
      if (!UUID.test(orderId || "")) return { received: true };
      order = await directory.getBillingOrder(orderId);
      if (!order) return { received: true };
      if (intent.id !== charge.payment_intent || intent.livemode !== config.livemode || Boolean(order.livemode) !== config.livemode) throw new BillingError("退款訂單不符。", 400);
    }
    await directory.revokeBillingPayment({ paymentIntent: charge.payment_intent, livemode: config.livemode });
  }
  return { received: true };
}
