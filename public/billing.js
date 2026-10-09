const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SESSION = /^cs_(?:test|live)_[a-zA-Z0-9_]{1,220}$/;
const STATES = new Set(["creating", "open", "paid", "expired", "refunded", "review", "failed"]);
const FAILED_MESSAGE = "伺服器已確認上次結帳未有建立付款，未有新增活動額度。你可以重新建立結帳。";

export function checkoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.port && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function formatOffer(offer) {
  if (!offer || typeof offer.currency !== "string" || !/^[a-z]{3}$/.test(offer.currency) ||
      !Number.isSafeInteger(offer.amountMinor) || offer.amountMinor <= 0 || offer.amountMinor > 100_000_000 ||
      offer.credits !== 1 || !Number.isSafeInteger(offer.voteLimit) || offer.voteLimit < 1 ||
      !Number.isSafeInteger(offer.maxDurationHours) || offer.maxDurationHours < 1 || offer.maxDurationHours > 2160 || typeof offer.livemode !== "boolean") return null;
  try {
    // The initial product is HKD; its amount is always supplied by the server.
    if (offer.currency !== "hkd") return null;
    const price = new Intl.NumberFormat("zh-HK", { style: "currency", currency: "HKD" }).format(offer.amountMinor / 100);
    const duration = offer.maxDurationHours % 24 === 0 ? `${offer.maxDurationHours / 24} 日` : `${offer.maxDurationHours} 小時`;
    return `${price} 一次付款 · 1 個活動 · 最多 ${offer.voteLimit.toLocaleString("zh-HK")} 張有效投票 · 最長 ${duration}`;
  } catch { return null; }
}

export function createBilling({ api, getContext, onResponse, onCredited, focusCreate, navigate = (url) => location.assign(url) }) {
  const $ = (id) => document.getElementById(id);
  const elements = Object.fromEntries(["billing-panel", "billing-balance", "billing-offer", "billing-test-label", "billing-test-note", "billing-buy", "billing-resume", "billing-use-credit", "billing-check", "billing-message"].map(id => [id, $(id)]));
  let signature = "";
  let generation = 0;
  let overview = null;
  let busy = false;
  let requestId = null;
  let message = "";
  let bad = false;
  let timer = null;
  let pollingDeadline = 0;
  let returnTarget = null;
  let returned = false;

  const returnUrl = new URL(location.href);
  const marker = returnUrl.searchParams.get("billing");
  if (["success", "cancelled"].includes(marker)) {
    const orderId = returnUrl.searchParams.get("order_id");
    const sessionId = returnUrl.searchParams.get("session_id");
    returnTarget = UUID.test(orderId || "") ? { orderId } : SESSION.test(sessionId || "") ? { sessionId } : null;
    returned = true;
  }

  function bounded(context = getContext()) {
    return context.principal?.selfRegistered === true && context.principal.role === "organizer" && context.quota?.limit === 1;
  }
  function storageKey() { return `wevote-checkout-request:${getContext().principal?.id || ""}`; }
  function saveRequest() {
    try { if (requestId) sessionStorage.setItem(storageKey(), requestId); else sessionStorage.removeItem(storageKey()); } catch { /* The in-memory ID still prevents duplicate submits. */ }
  }
  function clearRequest() { requestId = null; saveRequest(); }
  function stopPolling() { clearTimeout(timer); timer = null; pollingDeadline = 0; }
  function reset() {
    generation++;
    signature = "";
    overview = null;
    busy = false;
    requestId = null;
    message = "";
    bad = false;
    stopPolling();
    elements["billing-panel"].hidden = true;
    elements["billing-message"].textContent = "";
  }
  function update() {
    const context = getContext();
    const key = context.principal ? `${context.principal.id}:${context.principal.role}:${context.version}` : "";
    if (key !== signature) {
      reset();
      signature = key;
      try { const saved = sessionStorage.getItem(storageKey()); if (UUID.test(saved || "")) requestId = saved; } catch { /* Browser storage is optional. */ }
    }
    render();
  }
  function ticket() { return { generation, signature }; }
  function current(value) {
    const context = getContext();
    return value.generation === generation && value.signature === signature && signature === `${context.principal?.id}:${context.principal?.role}:${context.version}`;
  }
  function setMessage(value, error = false) {
    message = value;
    bad = error;
    render();
  }
  function render() {
    const context = getContext();
    const offerText = formatOffer(overview?.offer);
    const checkout = overview?.latestCheckout;
    const credits = context.quota?.paidCredits || 0;
    const freeUsed = context.quota?.used === 1;
    const show = bounded(context) && (freeUsed || credits > 0 || returned || Boolean(checkout));
    elements["billing-panel"].hidden = !show;
    if (!show) return;
    const enabled = overview?.enabled === true && overview.eligible === true && Boolean(offerText);
    const unfinished = ["creating", "open", "review"].includes(checkout?.status);
    const canBuy = enabled && freeUsed && credits === 0 && !unfinished;
    const canResume = enabled && checkout?.status === "open" && Boolean(checkoutUrl(checkout.url));
    const blocked = busy || context.creationBusy || context.pendingCreation;
    elements["billing-panel"].setAttribute("aria-busy", String(busy));
    elements["billing-balance"].textContent = `另購活動額度：${credits.toLocaleString("zh-HK")} 個。${freeUsed ? "免費活動額度已使用，原有活動仍可繼續管理。" : "你仍有 1 個免費活動，建立時會先使用免費額度。"}`;
    elements["billing-offer"].hidden = !enabled;
    elements["billing-offer"].textContent = offerText ? `${offerText}。儲存草稿亦會使用 1 個額度。` : "";
    elements["billing-test-label"].hidden = !enabled || overview.offer.livemode;
    elements["billing-test-note"].hidden = !enabled || overview.offer.livemode;
    elements["billing-buy"].hidden = !canBuy;
    elements["billing-buy"].disabled = blocked;
    elements["billing-buy"].textContent = requestId ? "重試取得同一結帳連結" : checkout?.status === "failed" ? "重新建立結帳" : "前往 Stripe 安全結帳";
    elements["billing-resume"].hidden = !canResume;
    elements["billing-resume"].disabled = blocked;
    elements["billing-use-credit"].hidden = credits < 1;
    elements["billing-use-credit"].disabled = blocked;
    elements["billing-check"].disabled = busy || context.creationBusy;
    let status = message;
    if (!status && context.pendingCreation) status = "請先確認上次活動建立結果，再處理付款。";
    if (!status && overview && !enabled) status = "呢個帳戶暫未開放另購活動額度。已有活動仍可繼續管理。";
    if (!status && !overview) status = "正在確認付款功能同活動額度…";
    if (!status && checkout?.status === "paid") status = credits > 0 ? "付款已確認，活動額度已入帳。" : "上次付款已確認，額度已用於活動。";
    if (!status && checkout?.status === "open") status = "呢筆結帳尚未完成，可繼續同一結帳，或檢查付款狀態。";
    if (!status && checkout?.status === "creating") status = "正在確認結帳連結，請稍候。";
    if (!status && checkout?.status === "review") status = "呢筆結帳需要平台核對。請聯絡平台，暫時唔好重複付款。";
    if (!status && checkout?.status === "expired") status = "上次結帳已過期，未有新增活動額度。";
    if (!status && checkout?.status === "failed") status = FAILED_MESSAGE;
    if (!status && checkout?.status === "refunded") status = "呢筆付款已退款；可用額度以最新配額為準。";
    elements["billing-message"].textContent = status;
    elements["billing-message"].className = `message${bad || checkout?.status === "failed" ? " bad" : ""}`;
  }

  async function apply(data, captured) {
    if (!current(captured)) return false;
    await onResponse(data);
    if (!current(captured)) return false;
    if (typeof data.enabled !== "boolean" || typeof data.eligible !== "boolean" || !Number.isSafeInteger(data.paidCredits) || data.paidCredits < 0 ||
        (data.enabled && data.offer !== null && !formatOffer(data.offer)) || (data.latestCheckout && !STATES.has(data.latestCheckout.status))) {
      throw new Error("暫時未能核對付款資料，請重新檢查。" );
    }
    overview = data;
    if (["paid", "expired", "refunded", "failed"].includes(data.latestCheckout?.status)) clearRequest();
    render();
    return true;
  }

  async function adoptError(error, captured) {
    if (!current(captured)) return false;
    if (error.billingOverview) {
      try { return await apply(error.billingOverview, captured); }
      catch { return current(captured); }
    }
    if (error.principal) await onResponse(error);
    return current(captured);
  }

  function clearReturnUrl() {
    returnTarget = null;
    returned = false;
    const url = new URL(location.href);
    for (const name of ["billing", "order_id", "session_id"]) url.searchParams.delete(name);
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function refresh() {
    update();
    if (!bounded() || busy) return;
    const captured = ticket();
    busy = true;
    message = "";
    bad = false;
    render();
    let target;
    try {
      if (!await apply(await api("/api/admin/billing"), captured)) return;
      target = returnTarget;
    } catch (error) {
      if (await adoptError(error, captured) && error.name !== "AbortError") setMessage(overview?.latestCheckout?.status === "failed" ? FAILED_MESSAGE : "暫時未能確認付款或額度，請檢查狀態後先決定是否付款。", true);
    }
    finally { if (current(captured)) { busy = false; render(); } }
    if (current(captured) && target) await reconcile(target, true);
    else if (current(captured) && overview?.latestCheckout?.status === "creating" && UUID.test(overview.latestCheckout.orderId || "")) {
      pollingDeadline ||= Date.now() + 30_000;
      schedulePoll({ orderId: overview.latestCheckout.orderId });
    }
  }

  function schedulePoll(target) {
    if (Date.now() >= pollingDeadline) {
      stopPolling();
      setMessage("付款確認未完成。請稍後按「檢查付款及額度」，暫時唔好再次付款。", true);
      return;
    }
    timer = setTimeout(() => { if (!document.hidden) void reconcile(target, false); else schedulePoll(target); }, 2000);
  }

  async function reconcile(target, automatic = false) {
    update();
    if (!bounded() || busy || !target) return;
    const captured = ticket();
    busy = true;
    message = "正在向伺服器核對付款，返回頁面唔代表付款已完成。";
    bad = false;
    render();
    try {
      const data = await api("/api/admin/billing/reconcile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target) });
      if (!await apply(data, captured)) return;
      message = "";
      if (automatic) clearReturnUrl();
      const status = data.status || data.latestCheckout?.status;
      if (status === "paid") {
        stopPolling();
        try { await onCredited(); }
        catch (error) {
          if (current(captured) && error.name !== "AbortError") setMessage("付款同額度已確認，暫時未能重新整理活動列表。請稍後再整理，毋須再次付款。", true);
        }
      } else if (status === "creating") {
        pollingDeadline ||= Date.now() + 30_000;
        schedulePoll(target);
      } else stopPolling();
    } catch (error) {
      stopPolling();
      if (await adoptError(error, captured) && error.name !== "AbortError") setMessage(overview?.latestCheckout?.status === "failed" ? FAILED_MESSAGE : "暫時未能確認付款結果。請稍後再檢查，唔好重複付款。", true);
    } finally { if (current(captured)) { busy = false; render(); } }
  }

  async function purchase() {
    update();
    const context = getContext();
    if (!bounded(context) || busy || context.creationBusy || context.pendingCreation || context.quota.used !== 1 || context.quota.paidCredits > 0 ||
        !overview?.enabled || !overview.eligible || !formatOffer(overview.offer) || ["creating", "open", "review"].includes(overview.latestCheckout?.status)) return;
    requestId ||= crypto.randomUUID();
    saveRequest();
    const captured = ticket();
    busy = true;
    setMessage("正在建立安全結帳連結…");
    try {
      const data = await api("/api/admin/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId }, body: "{}" });
      if (!await apply(data, captured)) return;
      const checkout = data.checkout || data.latestCheckout;
      const url = checkout?.status === "open" ? checkoutUrl(checkout.url) : null;
      if (url) navigate(url);
      else if (checkout?.status === "creating") {
        message = "正在確認同一筆結帳，請稍候。";
        pollingDeadline = Date.now() + 30_000;
        schedulePoll({ orderId: checkout.orderId });
      } else if (checkout?.status === "failed") setMessage(FAILED_MESSAGE, true);
      else message = "結帳狀態已更新，請先檢查付款及額度。";
    } catch (error) {
      if (await adoptError(error, captured) && error.name !== "AbortError") setMessage(overview?.latestCheckout?.status === "failed" ? FAILED_MESSAGE : "未能確認結帳連結。重試會沿用同一請求，請先檢查付款狀態，避免重複付款。", true);
    } finally { if (current(captured)) { busy = false; render(); } }
  }

  elements["billing-buy"].addEventListener("click", () => void purchase());
  elements["billing-resume"].addEventListener("click", () => {
    const context = getContext();
    const url = checkoutUrl(overview?.latestCheckout?.url);
    if (!busy && !context.creationBusy && !context.pendingCreation && overview?.enabled && overview.eligible && overview.latestCheckout?.status === "open" && url) navigate(url);
  });
  elements["billing-use-credit"].addEventListener("click", () => {
    const context = getContext();
    if (!busy && !context.creationBusy && !context.pendingCreation && context.quota?.paidCredits > 0) focusCreate();
  });
  elements["billing-check"].addEventListener("click", () => {
    const orderId = overview?.latestCheckout?.orderId;
    void (returnTarget ? reconcile(returnTarget, true) : UUID.test(orderId || "") ? reconcile({ orderId }) : refresh());
  });
  return { update, reset, refresh };
}
