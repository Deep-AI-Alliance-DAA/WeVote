import { mountEventShare } from "./share.js";
import { createOnboarding } from "./onboarding.js?v=20261009-onboarding";
import { createBilling } from "./billing.js?v=20261009-billing";

const $ = (id) => document.getElementById(id);
const roleLabels = { owner: "擁有人", admin: "管理員 · 全部活動", organizer: "活動管理員" };
const justCreated = new Map();
const eventShareMounts = new WeakMap();
const pendingRequests = new Set();
let principal = null;
let sessionVersion = 0;
let publicBaseUrl = location.origin;
let knownEvents = [];
let accounts = [];
let accountsLoaded = false;
let shareTools = [];
let loginBusy = false;
let creationQuota = null;
let creationBusy = false;
let pendingCreation = null;
const pendingCreationKey = "wevote-pending-event";
let onboardingReady = false;
const onboarding = createOnboarding({ getSteps: onboardingSteps, storagePrefix: "wevote-guide:v1:" });
const billing = createBilling({ api, getContext: () => ({ principal, quota: creationQuota, version: sessionVersion, creationBusy, pendingCreation: Boolean(pendingCreation) }),
  onResponse: async (data) => { await adoptResponsePrincipal(data); },
  onCredited: async () => { await loadEvents(); },
  focusCreate: () => { $("event-name").scrollIntoView({ behavior: "smooth", block: "center" }); $("event-name").focus({ preventScroll: true }); },
});

function onboardingContext() {
  if (!principal) return "login";
  if (creationQuota?.limit !== 1) return "dashboard-unlimited";
  return "dashboard-trial";
}

function showOnboarding(automatic = false) {
  if (!onboardingReady || onboarding.isOpen()) return;
  onboarding.start({ key: onboardingContext(), automatic });
}

function onboardingSteps() {
  if (!principal) return [{
    target: $("login-title"),
    title: "先登入，開一場投票。",
    body: "主辦方用可用嘅登入方式或管理員密鑰登入，就可以管理活動。參加者只需要活動連結或 QR code，毋須登入。",
  }];
  const limited = creationQuota?.limit === 1;
  const used = limited && !creationQuota.canCreate;
  const unavailable = !creationQuota;
  const firstEvent = $("events-list").querySelector(".event-item");
  const steps = [];
  if (pendingCreation) {
    steps.push({ target: $("retry-create-button"), title: "先確認上次建立結果。", body: "上次提交未確認完成。請用「重試建立同一活動」核對結果，系統會沿用已儲存嘅內容，避免重複建立同重複使用活動額度。" });
  } else if (used || unavailable) {
    steps.push({ target: $("creation-quota"), title: used ? "繼續管理已有活動。" : "先確認活動配額。", body: used
      ? "免費活動額度已使用。你仍然可以編輯、發佈、分享同查看已有活動；儲存草稿亦計入一個活動嘅配額。"
      : "暫時未能確認活動配額，請重新整理或稍後再試。導覽唔會建立活動，亦唔會更改你已填嘅內容。" });
  } else {
    steps.push({ target: $("event-name"), title: "寫低題目同選項。", body: limited
      ? `${creationQuota.used === 0 ? "先使用免費試用活動。" : "建立活動會使用 1 個已購額度。"}先準備活動名稱、問題同 2–20 個選項；投票上限同期間以本頁配額資料為準，草稿亦會使用額度。`
      : "填活動名稱、投票問題同 2–20 個選項。團隊管理帳戶可以建立多個活動，每場都會有自己嘅連結。" });
    steps.push({ target: $("event-selection-mode"), title: "揀單選，或者多選。", body: "單選每張投票揀一項；多選可以設定每張最多揀幾項。每張成功提交嘅投票只計一次，免費試用嘅 10,000 張額度亦以投票張數計算。活動開始後投票方式會鎖定。" });
    steps.push({ target: $("closes-at"), title: "設定時間同結果公開方式。", body: "開始／截止時間用香港時間。可以先儲存草稿核對內容，再發佈；結果可即時公開，或截止後先公開。導覽只作介紹，唔會幫你提交活動。" });
  }
  if (!$("billing-panel").hidden) steps.push({ target: $("billing-panel"), title: "需要再開活動？", body: "免費活動用完後，可以按本頁顯示嘅價格另購活動額度，喺 Stripe 安全結帳。返回頁面後先核對付款結果，確認額度入帳先建立新活動；管理員毋須購買額度。" });
  steps.push({ target: firstEvent?.querySelector(".event-share") || $("events-title"), title: "分享同一條連結或 QR code。", body: "建立後，呢度會列出你可管理嘅活動。可以複製連結、下載 QR 圖，或開啟社交分享；Instagram 可用下載嘅 QR 圖發佈 Story。草稿連結只供預覽，發佈後先接受投票。" });
  steps.push({ target: firstEvent?.querySelector(".event-tools") || $("events-title"), title: "睇即時結果，帶走報告。", body: "每場活動嘅「結果／CSV／PDF 報告」會開啟 dashboard；投票期間約每 1 秒查詢更新，公開內容跟活動設定。可下載票數摘要或列印報告，逐票 CSV 喺截止後提供。" });
  if (principal.role === "owner") steps.push({ target: $("accounts-title"), title: "分配畀團隊一齊管理。", body: "擁有人可新增團隊帳戶、設定權限，再喺活動內分配管理員。個人管理密鑰要私下交畀相關人士；唔好放喺公開投票連結。" });
  return steps;
}

function note(id, value, kind = "") {
  const element = $(id);
  element.textContent = value;
  element.className = `message ${kind}`;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function action(label, callback) {
  const button = node("button", "small-button", label);
  button.type = "button";
  button.addEventListener("click", callback);
  return button;
}

function stale(version) { return version !== sessionVersion; }
function cancelled(error) { return error.name === "AbortError"; }
function disposeShares() { shareTools.forEach((tool) => tool.destroy()); shareTools = []; }

function clearAccountKey() {
  $("account-new-key").value = "";
  $("account-key-title").textContent = "新登入密鑰";
  $("account-key-message").textContent = "";
  $("account-key-panel").hidden = true;
}

function clearSession() {
  onboarding.dismiss();
  billing.reset();
  sessionVersion++;
  pendingRequests.forEach((controller) => controller.abort());
  pendingRequests.clear();
  principal = null;
  creationQuota = null;
  creationBusy = false;
  clearPendingCreation();
  knownEvents = [];
  accounts = [];
  accountsLoaded = false;
  justCreated.clear();
  disposeShares();
  publicBaseUrl = location.origin;
  clearAccountKey();
  $("events-list").replaceChildren();
  $("accounts-list").replaceChildren();
  $("current-user-name").textContent = "";
  $("current-user-role").textContent = "";
  $("accounts-panel").hidden = true;
  $("dashboard").hidden = true;
  $("login-panel").hidden = false;
  $("admin-key").value = "";
  $("account-form").reset();
  $("event-form").reset();
  resetEventTimes();
  for (const id of ["accounts-message", "events-message", "create-message"]) note(id, "");
  // Remove keys saved by versions predating the HttpOnly session.
  try { sessionStorage.removeItem("wevote-admin-key"); } catch { /* Storage may be unavailable. */ }
  setLoginBusy(false);
}

async function api(path, options = {}) {
  const version = sessionVersion;
  const controller = new AbortController();
  pendingRequests.add(controller);
  try {
    const response = await fetch(path, {
      ...options,
      headers: options.headers || {},
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, options.signal || AbortSignal.timeout(30_000)]),
    });
    const data = await response.json();
    if (stale(version)) throw new DOMException("Session changed", "AbortError");
    if (!response.ok) {
      if (response.status === 401 && principal) {
        clearSession();
        note("login-message", "登入狀態已失效，請重新登入。", "bad");
      }
      const error = new Error(data.error || "請稍後再試。");
      error.status = response.status;
      error.code = data.code;
      error.creationQuota = data.creationQuota;
      error.principal = data.principal;
      // Billing failures can include a durable terminal checkout state. Keep
      // that overview so the billing UI can safely retire its old request ID.
      error.billingOverview = path.startsWith("/api/admin/billing") ? data : null;
      throw error;
    }
    return data;
  } finally { pendingRequests.delete(controller); }
}

function send(path, method, body) {
  return api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function clearPendingCreation() {
  pendingCreation = null;
  try { sessionStorage.removeItem(pendingCreationKey); } catch { /* Retry still works in memory. */ }
}

function rememberPendingCreation(payload) {
  pendingCreation = { accountId: principal.id, requestId: crypto.randomUUID(), payload: JSON.stringify(payload), kind: creationQuota?.nextEvent?.kind || "free-trial" };
  try { sessionStorage.setItem(pendingCreationKey, JSON.stringify(pendingCreation)); } catch { /* Retry still works in memory. */ }
}

function restorePendingCreation() {
  if (!creationQuota) return;
  if (creationQuota.limit !== 1) { clearPendingCreation(); return; }
  if (pendingCreation) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingCreationKey) || "null");
    if (!saved) return;
    const payload = JSON.parse(saved.payload);
    if (saved.accountId !== principal.id || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(saved.requestId)
      || typeof payload.name !== "string" || payload.name.length > 100 || typeof payload.question !== "string" || payload.question.length > 300
      || !Array.isArray(payload.options) || payload.options.length < 2 || payload.options.length > 20
      || payload.options.some((option) => typeof option !== "string" || option.length > 200)
      || (payload.maxChoices !== undefined && (!Number.isSafeInteger(payload.maxChoices) || payload.maxChoices < 1 || payload.maxChoices > payload.options.length))
      || !Number.isFinite(Date.parse(payload.opensAt)) || !Number.isFinite(Date.parse(payload.closesAt))
      || !["draft", "published"].includes(payload.lifecycle) || !["live", "after-close"].includes(payload.resultsVisibility)) {
      clearPendingCreation();
      return;
    }
    pendingCreation = saved;
    $("event-name").value = payload.name;
    $("event-question").value = payload.question;
    $("event-options").value = payload.options.join("\n");
    $("event-selection-mode").value = (payload.maxChoices ?? 1) > 1 ? "multiple" : "single";
    $("event-max-choices").value = String((payload.maxChoices ?? 1) > 1 ? payload.maxChoices : 2);
    $("save-draft").checked = payload.lifecycle === "draft";
    $("open-now").checked = false;
    $("opens-at").value = hkInput(new Date(payload.opensAt));
    $("closes-at").value = hkInput(new Date(payload.closesAt));
    $("results-visibility").value = payload.resultsVisibility;
    syncCreateTiming();
    note("create-message", "上次建立未確認完成。重試會提交同一份內容，唔會另開一場活動。", "bad");
  } catch { clearPendingCreation(); }
}

function syncCreateAvailability() {
  const limited = creationQuota?.limit === 1;
  const used = limited && creationQuota.used >= 1;
  const exhausted = limited && !creationQuota.canCreate;
  const unknown = principal?.selfRegistered === true && principal.role === "organizer" && !creationQuota;
  const retry = Boolean(pendingCreation && limited);
  $("create-fields").disabled = !principal || creationBusy || retry || exhausted || unknown;
  $("create-button").disabled = !principal || creationBusy || exhausted || unknown;
  $("create-button").hidden = retry;
  $("retry-create-button").hidden = !retry;
  $("retry-create-button").disabled = !principal || creationBusy;
  $("event-form").setAttribute("aria-busy", String(creationBusy));
  $("creation-quota").hidden = !limited && !unknown;
  $("quota-event-link").hidden = !used;
  billing.update();
  if (!limited && !unknown) return;
  const policy = creationQuota?.nextEvent;
  $("creation-quota-title").textContent = unknown ? "正在確認活動配額…" : used ? `免費活動已使用 · 另購額度 ${creationQuota.paidCredits} 個` : "免費試用 · 可建立 1 個活動";
  $("creation-quota-message").textContent = used
    ? policy ? `建立新活動會使用 1 個已購額度，最多 ${policy.voteLimit.toLocaleString("zh-HK")} 張有效投票，投票期間最長 ${policy.maxDurationHours / 24} 日。儲存草稿亦會使用額度；免費活動配額唔會重置。`
      : "你仍然可以編輯、發佈同分享已有活動。每個帳戶只有一個免費活動；可用購買選項會喺下方顯示。"
    : "最多 10,000 張有效投票，投票期間最長 24 小時。儲存草稿亦會使用活動配額。";
}

function setCreationQuota(value) {
  creationQuota = null;
  if (value?.limit === 1 && [0, 1].includes(value.used)) {
    const paidCredits = value.paidCredits ?? 0;
    const remaining = 1 - value.used + paidCredits;
    const next = value.nextEvent ?? (value.used === 0 ? { kind: "free-trial", voteLimit: 10_000, maxDurationHours: 24 } : null);
    const validNext = next && next.kind === (value.used === 0 ? "free-trial" : "paid-credit") && Number.isSafeInteger(next.voteLimit) && next.voteLimit > 0 && next.voteLimit <= 10_000
      && Number.isSafeInteger(next.maxDurationHours) && next.maxDurationHours > 0 && next.maxDurationHours <= 2160;
    if (Number.isSafeInteger(paidCredits) && paidCredits >= 0 && Number.isSafeInteger(remaining) && (value.remaining === undefined || value.remaining === remaining)) {
      creationQuota = { limit: 1, used: value.used, eventId: value.eventId || null, paidCredits, remaining,
        canCreate: remaining > 0 && Boolean(validNext) && value.canCreate !== false, nextEvent: validNext ? next : null };
    }
  } else if (value?.limit === null || !principal?.selfRegistered || principal.role !== "organizer") {
    creationQuota = { limit: null, used: 0, eventId: null, paidCredits: 0, remaining: null, canCreate: true, nextEvent: null };
  }
  syncCreateAvailability();
}

function hkInput(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function hkDisplay(iso) {
  return new Intl.DateTimeFormat("zh-HK", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function resetEventTimes() {
  $("closes-at").value = hkInput(new Date(Date.now() + 86400_000));
  $("opens-at").value = hkInput(new Date(Date.now() + 120_000));
  syncCreateTiming();
}

function syncCreateTiming() {
  const draft = $("save-draft").checked;
  if (draft) $("open-now").checked = false;
  $("open-now").disabled = draft;
  const immediate = !draft && $("open-now").checked;
  $("opens-label").hidden = immediate;
  $("opens-at").hidden = immediate;
  $("opens-at").required = !immediate;
  $("draft-help").hidden = !draft;
  $("create-button").textContent = draft ? "儲存草稿 ↗" : "建立 event ↗";
  syncCreateChoices();
  syncCreateAvailability();
}

function optionLabels(value) {
  return value.split(/\r?\n/).map((label) => label.trim()).filter(Boolean);
}

function ballotMaxChoices(event) {
  return Number.isSafeInteger(event.maxChoices) && event.maxChoices >= 1 && event.maxChoices <= 20 ? event.maxChoices : 1;
}

function selectionSummary(event) {
  const maxChoices = ballotMaxChoices(event);
  return maxChoices > 1 ? `多選 · 每張可選 1–${maxChoices} 項，每張投票只計一次` : "單選 · 每張投票只可選 1 項";
}

function syncChoiceControls(mode, max, field, options, help, locked = false) {
  const multiple = mode.value === "multiple";
  const count = optionLabels(options.value).length;
  const cap = Math.max(2, Math.min(20, count));
  field.hidden = !multiple;
  max.disabled = locked || !multiple;
  max.required = multiple;
  max.max = String(cap);
  if (Number(max.value) > cap) max.value = String(cap);
  const text = multiple
    ? `每張投票可選 1 至設定上限嘅項目，上限唔可多過 ${cap} 項。${count < 2 ? "請先填至少 2 個選項。" : ""}每張投票只計一次；結果百分比合計可以超過 100%。`
    : "每張投票只可選 1 項；成功提交先會記錄。";
  if (help.textContent !== text) help.textContent = text;
}

function syncCreateChoices() {
  syncChoiceControls($("event-selection-mode"), $("event-max-choices"), $("event-max-choices-field"), $("event-options"), $("event-choice-help"));
}

function readMaxChoices(mode, max, optionCount) {
  if (mode.value === "single") return 1;
  const value = Number(max.value);
  if (mode.value !== "multiple" || !Number.isSafeInteger(value) || value < 2 || value > 20 || value > optionCount) {
    throw new Error(`多選上限必須係 2–${Math.min(20, optionCount)} 之間嘅整數，唔可多過選項數目。`);
  }
  return value;
}

function hkTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new RangeError("請填有效嘅香港開始／截止時間。");
  const date = new Date(`${value}:00+08:00`);
  if (!Number.isFinite(date.getTime()) || hkInput(date) !== value) throw new RangeError("請填有效嘅香港開始／截止時間。");
  return date.toISOString();
}

function eventPhase(event) {
  if (event.lifecycle === "draft") return ["草稿 · 未發佈", "draft"];
  const now = Date.now();
  if (now < Date.parse(event.opensAt)) return ["未開始", "pending"];
  if (now >= Date.parse(event.closesAt)) return ["已截止", "closed"];
  return ["投票中", "open"];
}

function makeShareUrl(id) {
  const url = new URL("/vote.html", publicBaseUrl);
  url.searchParams.set("event", id);
  return url.toString();
}

function refreshEventCard(item, event) {
  const [label, phase] = eventPhase(event);
  item.querySelector(".event-title").textContent = event.name;
  const badge = item.querySelector(".event-status");
  badge.textContent = label;
  badge.className = `event-status ${phase}`;
  item.querySelector(".event-times").textContent = `${phase === "draft" ? "預定 " : ""}${hkDisplay(event.opensAt)} 開始 · ${hkDisplay(event.closesAt)} 截止`;
  const selection = item.querySelector(".event-selection-summary");
  if (selection) selection.textContent = selectionSummary(event);
  const draftNote = item.querySelector(".event-draft-note");
  if (draftNote) draftNote.hidden = phase !== "draft";
  const share = eventShareMounts.get(item);
  if (share) {
    const index = shareTools.indexOf(share.tool);
    share.tool.destroy();
    share.tool = mountEventShare(share.container, { url: makeShareUrl(event.id), name: event.name, question: event.question || "" });
    if (index >= 0) shareTools[index] = share.tool;
    else shareTools.push(share.tool);
  }
}

function visibilitySelect(value) {
  const select = node("select", "event-setting-select");
  for (const [id, label] of [["live", "即時公開"], ["after-close", "截止後公開"]]) {
    const option = node("option", "", label);
    option.value = id;
    select.append(option);
  }
  select.value = value === "live" ? "live" : "after-close";
  return select;
}

function editorField(form, text, tag = "input", attributes = {}) {
  const label = node("label", "event-editor-label", text);
  const input = node(tag);
  Object.assign(input, attributes);
  label.append(input);
  form.append(label);
  return input;
}

function appendResultSettings(item, event) {
  const block = node("details", "event-editor");
  const summary = node("summary", "", event.lifecycle === "draft" ? "編輯草稿／發佈活動" : "編輯活動內容同外觀");
  block.append(summary);
  const body = node("div", "event-editor-body");
  const loading = node("p", "event-setting-help", "展開後載入活動設定。");
  loading.setAttribute("role", "status");
  body.append(loading);
  block.append(body);
  item.append(block);
  let loaded = false;
  let loadingNow = false;

  async function loadEditor() {
    if (loaded || loadingNow || !block.open) return;
    loadingNow = true;
    const version = sessionVersion;
    loading.textContent = "正在載入設定…";
    try {
      const data = await api(`/api/admin/events/${event.id}`);
      if (stale(version)) return;
      loaded = true;
      const detail = data.event;
      const presentation = data.presentation || detail.presentation || {};
      event.resultsVisibility = data.resultsVisibility || detail.resultsVisibility;
      event.presentation = presentation;
      event.maxChoices = ballotMaxChoices(detail);
      item.querySelector(".event-results-mode").textContent = event.resultsVisibility === "live" ? "結果：即時公開" : "結果：截止後公開";
      item.querySelector(".event-selection-summary").textContent = selectionSummary(event);
      body.replaceChildren();
      buildContentEditor(detail);
      buildAppearanceEditor(data.resultsVisibility || detail.resultsVisibility, presentation);
    } catch (error) {
      if (!cancelled(error) && !stale(version)) loading.textContent = `${error.message} 收起後再展開，可以重試。`;
    } finally { loadingNow = false; }
  }

  function buildContentEditor(detail) {
    const section = node("section", "event-editor-section");
    section.append(node("h4", "", "活動內容"));
    let isDraft = detail.lifecycle === "draft";
    let working = false;
    const editable = isDraft || eventPhase(detail)[1] === "pending";
    const help = node("p", "event-setting-help", isDraft ? "草稿可修改內容、投票方式及預定時間。先儲存修改，核對後再發佈。" : editable ? "開始前可以修改名稱、題目、選項同投票方式。開始後內容會鎖定。" : "活動已開始，名稱、題目、選項同投票方式已鎖定。");
    section.append(help);
    const form = node("form", "event-editor-form");
    const name = editorField(form, "活動名稱", "input", { type: "text", value: detail.name, required: true, maxLength: 100, disabled: !editable });
    const question = editorField(form, "投票問題", "textarea", { value: detail.question, required: true, maxLength: 300, rows: 3, disabled: !editable });
    const labels = detail.options.map((option) => typeof option === "string" ? option : option.label).join("\n");
    const options = editorField(form, "選項 · 每行一項，2–20 項", "textarea", { value: labels, required: true, rows: Math.min(8, Math.max(3, detail.options.length)), disabled: !editable });
    const mode = editorField(form, "投票方式", "select", { id: `event-selection-mode-${event.id}`, disabled: !editable });
    for (const [value, text] of [["single", "單選 · 每張投票揀一項"], ["multiple", "多選 · 每張投票可揀幾項"]]) {
      const option = node("option", "", text);
      option.value = value;
      mode.append(option);
    }
    const initialMax = ballotMaxChoices(detail);
    mode.value = initialMax > 1 ? "multiple" : "single";
    const max = editorField(form, "每張投票最多可選 · 唔可多過選項數目", "input", { id: `event-max-choices-${event.id}`, type: "number", min: "2", max: "20", step: "1", value: String(initialMax > 1 ? initialMax : 2) });
    const maxField = max.parentElement;
    const choiceHelp = node("p", "event-setting-help");
    choiceHelp.id = `event-choice-help-${event.id}`;
    choiceHelp.setAttribute("aria-live", "polite");
    mode.setAttribute("aria-describedby", choiceHelp.id);
    max.setAttribute("aria-describedby", choiceHelp.id);
    form.append(choiceHelp);
    const opens = isDraft ? editorField(form, "預定開始時間 · 香港時間", "input", { type: "datetime-local", value: hkInput(new Date(detail.opensAt)), required: true }) : null;
    const closes = isDraft ? editorField(form, "截止時間 · 香港時間", "input", { type: "datetime-local", value: hkInput(new Date(detail.closesAt)), required: true }) : null;
    function syncEditorChoices() {
      const unlocked = !working && (isDraft || eventPhase(detail)[1] === "pending");
      for (const input of [name, question, options, mode]) input.disabled = !unlocked;
      if (opens) opens.disabled = working || !isDraft;
      if (closes) closes.disabled = working || !isDraft;
      syncChoiceControls(mode, max, maxField, options, choiceHelp, !unlocked);
    }
    syncEditorChoices();
    mode.addEventListener("change", syncEditorChoices);
    options.addEventListener("input", syncEditorChoices);
    max.addEventListener("input", syncEditorChoices);
    form.addEventListener("focusin", syncEditorChoices);
    const status = node("p", "event-access-status");
    status.setAttribute("role", "status");
    if (editable) {
      const save = node("button", "small-button", "儲存活動內容");
      save.type = "submit";
      form.append(save);
      function contentBody() {
        if (!isDraft && eventPhase(detail)[1] !== "pending") { syncEditorChoices(); throw new Error("活動已開始，題目、選項同投票方式已鎖定。"); }
        const labels = optionLabels(options.value);
        if (!name.value.trim() || !question.value.trim()) throw new Error("請填活動名稱同投票問題。");
        if (labels.length < 2 || labels.length > 20 || labels.some((label) => label.length > 100)) throw new Error("請填 2–20 個選項，每項最多 100 字。");
        const value = { name: name.value.trim(), question: question.value.trim(), options: labels, maxChoices: readMaxChoices(mode, max, labels.length) };
        if (isDraft) {
          value.opensAt = hkTime(opens.value);
          value.closesAt = hkTime(closes.value);
          if (Date.parse(value.closesAt) <= Date.parse(value.opensAt)) throw new Error("截止時間必須遲過開始時間。");
        }
        return value;
      }
      let savedState;
      try { savedState = JSON.stringify(contentBody()); } catch { savedState = ""; }
      const publish = isDraft ? action("發佈活動", async () => {
        if (working || !isDraft) return;
        try {
          if (JSON.stringify(contentBody()) !== savedState) { status.textContent = "有未儲存嘅修改。請先按「儲存活動內容」，再發佈；已填資料會保留。"; return; }
          if (Date.parse(hkTime(closes.value)) <= Date.now()) { status.textContent = "截止時間已過。請先修改並儲存香港開始／截止時間，再發佈。"; return; }
        } catch (error) { status.textContent = error.message; return; }
        const version = sessionVersion;
        working = true;
        syncEditorChoices();
        save.disabled = true;
        publish.disabled = true;
        status.textContent = "正在發佈活動…";
        try {
          const data = await send(`/api/admin/events/${event.id}/publish`, "POST", {});
          if (stale(version)) return;
          const display = { resultsVisibility: event.resultsVisibility, presentation: event.presentation };
          Object.assign(event, data.event, display);
          Object.assign(detail, data.event, display);
          isDraft = false;
          opens.disabled = true;
          closes.disabled = true;
          publish.hidden = true;
          const pending = eventPhase(event)[1] === "pending";
          syncEditorChoices();
          help.textContent = pending ? "活動已發佈，開始前仍可修改名稱、題目、選項同投票方式。預定時間已鎖定。" : "活動已發佈並開始，名稱、題目、選項同投票方式已鎖定。";
          summary.textContent = "編輯活動內容同外觀";
          refreshEventCard(item, event);
          status.textContent = pending ? "已發佈。到預定開始時間後接受投票，分享連結同 QR code 繼續有效。" : "已發佈，現正接受投票。分享連結同 QR code 繼續有效。";
        } catch (error) { if (!cancelled(error) && !stale(version)) status.textContent = error.message; }
        finally {
          working = false;
          syncEditorChoices();
          save.disabled = !isDraft && eventPhase(event)[1] !== "pending";
          publish.disabled = false;
        }
      }) : null;
      if (publish) {
        form.append(publish, node("p", "event-setting-help", "發佈會沿用已儲存嘅預定時間。開始時間已到就即刻接受投票；未到就等待開始。截止時間必須仍然有效。"));
      }
      form.addEventListener("submit", async (submit) => {
        submit.preventDefault();
        if (working) return;
        const version = sessionVersion;
        let value;
        try { value = contentBody(); } catch (error) { status.textContent = error.message; return; }
        working = true;
        syncEditorChoices();
        save.disabled = true;
        if (publish) publish.disabled = true;
        status.textContent = "正在儲存內容…";
        try {
          const data = await send(`/api/admin/events/${event.id}`, "PATCH", value);
          if (stale(version)) return;
          // Display settings have their own authoritative storage and can be
          // newer than the raw ballot config returned after a content edit.
          const display = { resultsVisibility: event.resultsVisibility, presentation: event.presentation };
          Object.assign(event, data.event, display);
          Object.assign(detail, data.event, display);
          savedState = JSON.stringify(contentBody());
          refreshEventCard(item, event);
          status.textContent = "活動內容已更新，分享連結同 QR code 繼續有效。";
        } catch (error) { if (!cancelled(error) && !stale(version)) status.textContent = error.message; }
        finally { working = false; syncEditorChoices(); save.disabled = !isDraft && eventPhase(event)[1] !== "pending"; if (publish) publish.disabled = false; }
      });
    }
    section.append(form, status);
    body.append(section);
  }

  function buildAppearanceEditor(currentVisibility, presentation) {
    const section = node("section", "event-editor-section");
    section.append(node("h4", "", "公開時間與外觀"));
    const form = node("form", "event-editor-form");
    const visibilityLabel = node("label", "event-editor-label", "公開結果時間");
    const visibility = visibilitySelect(currentVisibility);
    visibilityLabel.append(visibility);
    form.append(visibilityLabel, node("p", "event-setting-help", "改為截止後公開，唔會收回已經公開嘅結果。"));
    const theme = editorField(form, "色調", "select");
    for (const [value, label] of [["ink", "墨藍 · Ink"], ["ocean", "海洋 · Ocean"], ["forest", "森林 · Forest"], ["terracotta", "陶土 · Terracotta"]]) {
      const option = node("option", "", label);
      option.value = value;
      theme.append(option);
    }
    theme.value = ["ink", "ocean", "forest", "terracotta"].includes(presentation.theme) ? presentation.theme : "ink";
    const organizer = editorField(form, "主辦方名稱", "input", { type: "text", value: presentation.organizer || "", maxLength: 100, placeholder: "例：DAA.HK" });
    const description = editorField(form, "活動介紹", "textarea", { value: presentation.description || "", maxLength: 1000, rows: 4, placeholder: "介紹活動背景、投票安排或參與須知" });
    const logo = editorField(form, "Logo 圖片網址 · HTTPS", "input", { type: "url", value: presentation.logoUrl || "", maxLength: 2048, placeholder: "https://example.com/logo.png" });
    const cover = editorField(form, "封面圖片網址 · HTTPS", "input", { type: "url", value: presentation.coverUrl || "", maxLength: 2048, placeholder: "https://example.com/event-poster.jpg" });
    form.append(node("p", "event-setting-help", "使用可公開讀取嘅圖片網址；封面會以寬版海報顯示。留空即可移除圖片。"));
    const save = node("button", "small-button", "儲存公開時間同外觀");
    save.type = "submit";
    const status = node("p", "event-access-status");
    status.setAttribute("role", "status");
    form.append(save);
    form.addEventListener("submit", async (submit) => {
      submit.preventDefault();
      const version = sessionVersion;
      const logoUrl = logo.value.trim();
      const coverUrl = cover.value.trim();
      for (const imageUrl of [logoUrl, coverUrl]) {
        if (!imageUrl) continue;
        try {
          const url = new URL(imageUrl);
          if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid logo URL");
        } catch { status.textContent = "請填有效嘅 HTTPS 圖片網址，或者留空。"; return; }
      }
      save.disabled = true;
      status.textContent = "正在儲存設定…";
      try {
        const nextPresentation = { theme: theme.value, organizer: organizer.value.trim(), description: description.value.trim(), logoUrl, coverUrl };
        const data = await send(`/api/admin/events/${event.id}/settings`, "PATCH", { resultsVisibility: visibility.value, presentation: nextPresentation });
        if (stale(version)) return;
        event.resultsVisibility = data.resultsVisibility || visibility.value;
        event.presentation = data.presentation || nextPresentation;
        item.querySelector(".event-results-mode").textContent = event.resultsVisibility === "live" ? "結果：即時公開" : "結果：截止後公開";
        status.textContent = "設定已更新，投票頁同結果頁會喺下次更新時生效。";
      } catch (error) { if (!cancelled(error) && !stale(version)) status.textContent = error.message; }
      finally { save.disabled = false; }
    });
    section.append(form, status);
    body.append(section);
  }

  block.addEventListener("toggle", () => { if (block.open) void loadEditor(); });
}

function appendEventAccess(item, event) {
  const block = node("details", "event-access");
  block.append(node("summary", "", "分配活動管理員"));
  const owner = accounts.find((account) => account.id === event.ownerId);
  const ownerName = event.ownerId === principal.id ? principal.name : owner?.name || "原建立者";
  block.append(node("p", "event-setting-help", `建立者：${ownerName}。分配設定唔會更改活動擁有權。`));
  if (!accountsLoaded) {
    block.append(node("p", "event-setting-help", "帳戶名單未能載入，請先重新整理帳戶。"));
    item.append(block);
    return;
  }
  const organizers = accounts.filter((account) => account.role === "organizer" && !account.disabled && account.id !== event.ownerId);
  if (!organizers.length) {
    block.append(node("p", "event-setting-help", "暫時未有其他啟用中嘅活動管理員。儲存空白分配會移除現有分配。"));
  }
  const fieldset = node("fieldset", "event-assignees");
  fieldset.append(node("legend", "sr-only", "揀選獲分配嘅活動管理員"));
  const choices = organizers.map((account) => {
    const label = node("label", "check-row");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = account.id;
    input.checked = (event.assigneeIds || []).includes(account.id);
    label.append(input, node("span", "", account.name));
    fieldset.append(label);
    return input;
  });
  const status = node("p", "event-access-status");
  status.setAttribute("role", "status");
  const save = action("儲存分配", async () => {
    const version = sessionVersion;
    const accountIds = choices.filter((input) => input.checked).map((input) => input.value);
    save.disabled = true;
    status.textContent = "正在儲存…";
    try {
      await send(`/api/admin/events/${event.id}/access`, "PUT", { accountIds });
      if (stale(version)) return;
      event.assigneeIds = accountIds;
      status.textContent = "活動分配已更新。";
    } catch (error) { if (!cancelled(error) && !stale(version)) status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  block.append(fieldset, save, status);
  item.append(block);
}

function renderEvents(events) {
  knownEvents = events;
  disposeShares();
  const list = $("events-list");
  list.replaceChildren();
  if (!events.length) { list.append(node("p", "admin-muted", "暫時未有可管理嘅活動。")); return; }
  for (const event of events) {
    const [label, phase] = eventPhase(event);
    const item = node("article", "event-item");
    const head = node("div", "event-head");
    const title = node("div");
    title.append(node("h3", "event-title", event.name), node("span", "event-id", `ID ${event.id}`));
    head.append(title, node("span", `event-status ${phase}`, label));
    const times = node("p", "event-times", `${phase === "draft" ? "預定 " : ""}${hkDisplay(event.opensAt)} 開始 · ${hkDisplay(event.closesAt)} 截止`);
    const share = node("div");
    const shareTool = mountEventShare(share, { url: makeShareUrl(event.id), name: event.name, question: event.question || "" });
    shareTools.push(shareTool);
    eventShareMounts.set(item, { container: share, tool: shareTool });
    const tools = node("div", "event-tools");
    const report = node("a", "small-button", "結果／CSV／PDF 報告 ↗");
    report.href = `/results.html?event=${event.id}`;
    report.target = "_blank";
    report.rel = "noopener noreferrer";
    const progress = node("p", "export-progress");
    progress.setAttribute("role", "status");
    const raw = action("匯出逐票 CSV", () => void exportVotes(event, raw, progress));
    raw.disabled = phase !== "closed";
    tools.append(report, raw);
    const resultMode = node("p", "event-results-mode", event.resultsVisibility === "live" ? "結果：即時公開" : "結果：截止後公開");
    const selection = node("p", "event-selection-summary", selectionSummary(event));
    const draftNote = node("p", "event-draft-note", "草稿只供預覽，發佈前唔接受投票。請展開「編輯草稿／發佈活動」核對內容同時間，再發佈。" );
    draftNote.hidden = phase !== "draft";
    item.append(head, times, resultMode, selection, draftNote, share, tools, progress);
    appendResultSettings(item, event);
    if (principal?.role === "owner") appendEventAccess(item, event);
    list.append(item);
  }
}

async function loadEvents() {
  const data = await api("/api/admin/events");
  const version = await adoptResponsePrincipal(data);
  if (version === null || stale(version)) return;
  publicBaseUrl = data.publicBaseUrl || location.origin;
  const byId = new Map(data.events.map((event) => [event.id, event]));
  for (const [id, event] of justCreated) {
    if (byId.has(id)) justCreated.delete(id);
    else byId.set(id, event);
  }
  renderEvents([...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  const reservation = Array.isArray(data.creationReservations) && pendingCreation ? data.creationReservations.find(item => item.requestId === pendingCreation.requestId && byId.has(item.eventId)) : null;
  if (reservation) {
    clearPendingCreation();
    $("event-form").reset();
    resetEventTimes();
    note("create-message", "上次建立嘅同一活動已喺下方列出，可以繼續管理。", "good");
  }
  note("events-message", data.hasMore ? "活動數量較多，目前只顯示部分活動。" : "");
  showOnboarding(true);
}

function setPrincipal(value, quota) {
  principal = value;
  $("current-user-name").textContent = value.name;
  $("accounts-panel").hidden = value.role !== "owner";
  setCreationQuota(quota);
  $("current-user-role").textContent = value.role === "organizer" && creationQuota?.limit === 1 ? "主辦方" : roleLabels[value.role] || "管理帳戶";
  restorePendingCreation();
}

async function adoptResponsePrincipal(data, creating = false) {
  const changed = data.principal && principal && (principal.id !== data.principal.id
    || principal.role !== data.principal.role || Boolean(principal.selfRegistered) !== Boolean(data.principal.selfRegistered));
  if (changed) {
    // Cookie sessions are shared between tabs. Never carry an old account's
    // records or unconfirmed create request into the newly authenticated one.
    clearSession();
    $("login-panel").hidden = true;
    $("dashboard").hidden = false;
    $("retry-logout").hidden = true;
    note("login-message", "");
  }
  if (data.principal) setPrincipal(data.principal, data.creationQuota);
  if (creating) { creationBusy = true; syncCreateAvailability(); }
  const version = sessionVersion;
  if (changed && principal?.role === "owner") {
    try { await loadAccounts(); }
    catch (error) { if (!cancelled(error) && !stale(version)) note("accounts-message", error.message, "bad"); }
  }
  if (changed && principal) void billing.refresh();
  return principal && !stale(version) ? version : null;
}

function showAccountKey(account, key) {
  clearAccountKey();
  $("account-key-title").textContent = `${account.name} · 新登入密鑰`;
  $("account-new-key").value = key;
  $("account-key-panel").hidden = false;
  $("account-new-key").focus();
  $("account-new-key").select();
}

function replaceAccount(account) {
  accounts = [account, ...accounts.filter((item) => item.id !== account.id)];
  renderAccounts();
  renderEvents(knownEvents);
}

function renderAccounts() {
  const list = $("accounts-list");
  list.replaceChildren();
  if (!accounts.length) { list.append(node("p", "admin-muted", "未有團隊帳戶。新增後可以私下派發登入密鑰。")); return; }
  for (const account of accounts) {
    const item = node("article", "account-item");
    const heading = node("div", "account-item-heading");
    const identity = node("div");
    identity.append(node("h4", "", account.name), node("span", "account-id", `ID ${account.id}`));
    heading.append(identity, node("span", `account-status${account.disabled ? " is-disabled" : ""}`, account.disabled ? "已停用" : "啟用中"));
    item.append(heading);
    if (account.role === "owner") { item.append(node("p", "admin-muted", "擁有人")); list.append(item); continue; }
    const controls = node("div", "account-controls");
    const roleLabel = node("label", "sr-only", `${account.name} 嘅權限`);
    const role = node("select");
    for (const [id, label] of [["organizer", "活動管理員"], ["admin", "管理員 · 全部活動"]]) {
      const option = node("option", "", label);
      option.value = id;
      role.append(option);
    }
    role.value = account.role;
    roleLabel.append(role);
    roleLabel.className = "account-role-control";
    const status = node("p", "account-action-status");
    status.setAttribute("role", "status");
    async function update(button, path, method, body, rotating = false) {
      const version = sessionVersion;
      const buttons = controls.querySelectorAll("button");
      buttons.forEach((element) => { element.disabled = true; });
      status.textContent = "正在更新…";
      try {
        const data = await send(path, method, body);
        if (stale(version)) return;
        replaceAccount(data.account);
        if (rotating) showAccountKey(data.account, data.key);
        note("accounts-message", rotating ? "已更換密鑰，舊密鑰及登入狀態已失效。" : "帳戶設定已更新。", "good");
      } catch (error) { if (!cancelled(error) && !stale(version)) status.textContent = error.message; }
      finally { buttons.forEach((element) => { element.disabled = false; }); }
    }
    const saveRole = action("儲存權限", () => void update(saveRole, `/api/admin/accounts/${account.id}`, "PATCH", { role: role.value, disabled: Boolean(account.disabled) }));
    const toggle = action(account.disabled ? "重新啟用" : "停用帳戶", () => void update(toggle, `/api/admin/accounts/${account.id}`, "PATCH", { role: account.role, disabled: !account.disabled }));
    const rotate = action("更換登入密鑰", () => void update(rotate, `/api/admin/accounts/${account.id}/rotate`, "POST", {}, true));
    controls.append(roleLabel, saveRole, toggle, rotate);
    item.append(controls, status);
    list.append(item);
  }
}

async function loadAccounts() {
  if (principal?.role !== "owner") return;
  const data = await api("/api/admin/accounts");
  accounts = data.accounts;
  accountsLoaded = true;
  renderAccounts();
}

async function openDashboard(value, quota) {
  setPrincipal(value, quota);
  $("login-panel").hidden = true;
  $("dashboard").hidden = false;
  $("retry-logout").hidden = true;
  note("login-message", "");
  if (principal.role === "owner") {
    try { await loadAccounts(); }
    catch (error) { if (!cancelled(error)) note("accounts-message", error.message, "bad"); }
  }
  if (principal) {
    try { await loadEvents(); }
    catch (error) { if (!cancelled(error)) note("events-message", error.message, "bad"); }
  }
  if (principal) await billing.refresh();
  showOnboarding(true);
}

function setLoginBusy(value) {
  loginBusy = value;
  $("login-button").disabled = value;
  $("admin-key").disabled = value;
}

async function login(key) {
  if (loginBusy) return;
  clearSession();
  const version = sessionVersion;
  setLoginBusy(true);
  note("login-message", "正在登入…");
  try {
    const data = await send("/api/admin/login", "POST", { key: key.trim() });
    await openDashboard(data.principal, data.creationQuota);
  } catch (error) {
    if (!cancelled(error)) note("login-message", error.message, "bad");
  } finally { if (!stale(version)) setLoginBusy(false); }
}

async function logout() {
  clearSession();
  const version = sessionVersion;
  setLoginBusy(true);
  $("retry-logout").hidden = true;
  note("login-message", "正在登出…");
  try {
    await send("/api/admin/logout", "POST", {});
    note("login-message", "已登出。", "good");
  } catch (error) {
    if (!cancelled(error)) {
      note("login-message", "本頁資料已清除，暫時未能確認伺服器登出。請重試登出。", "bad");
      $("retry-logout").hidden = false;
    }
  } finally { if (!stale(version)) setLoginBusy(false); }
}

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = $("admin-key").value;
  $("admin-key").value = "";
  void login(key);
});

async function submitEvent() {
  if (!principal || creationBusy) return;
  let version = sessionVersion;
  let payload;
  try {
    if (pendingCreation) {
      payload = JSON.parse(pendingCreation.payload);
    } else {
      if (!creationQuota || !creationQuota.canCreate) return;
      const options = optionLabels($("event-options").value);
      if (options.length < 2 || options.length > 20) throw new Error("請填 2–20 個選項，每行一項。");
      const lifecycle = $("save-draft").checked ? "draft" : "published";
      const opensAt = $("open-now").checked && lifecycle === "published" ? new Date().toISOString() : hkTime($("opens-at").value);
      const closesAt = hkTime($("closes-at").value);
      if (Date.parse(closesAt) <= Date.parse(opensAt)) throw new Error("截止時間必須遲過開始時間。");
      if (creationQuota.limit === 1 && Date.parse(closesAt) - Date.parse(opensAt) > creationQuota.nextEvent.maxDurationHours * 3600_000) throw new Error(`呢個活動額度嘅投票期間最長 ${creationQuota.nextEvent.maxDurationHours} 小時，請調整截止時間。`);
      payload = {
        name: $("event-name").value, question: $("event-question").value, options, opensAt, closesAt,
        resultsVisibility: $("results-visibility").value, lifecycle, maxChoices: readMaxChoices($("event-selection-mode"), $("event-max-choices"), options.length),
      };
      if (creationQuota.limit === 1) rememberPendingCreation(payload);
    }
  } catch (error) {
    note("create-message", error.message, "bad");
    return;
  }
  creationBusy = true;
  syncCreateAvailability();
  note("create-message", pendingCreation ? "正在確認同一活動嘅建立結果…" : "正在建立活動…");
  try {
    const headers = { "Content-Type": "application/json" };
    if (pendingCreation) headers["Idempotency-Key"] = pendingCreation.requestId;
    const data = await api("/api/admin/events", { method: "POST", headers, body: pendingCreation?.payload || JSON.stringify(payload) });
    if (stale(version)) return;
    const responseVersion = await adoptResponsePrincipal(data, true);
    if (responseVersion === null || stale(responseVersion)) return;
    version = responseVersion;
    if (!data.event || !/^[a-f0-9]{24}$/.test(data.event.id)) throw new Error("未能確認活動建立結果。");
    clearPendingCreation();
    setCreationQuota(data.creationQuota || null);
    publicBaseUrl = data.publicBaseUrl || location.origin;
    justCreated.set(data.event.id, data.event);
    renderEvents([data.event, ...knownEvents.filter((item) => item.id !== data.event.id)]);
    $("event-form").reset();
    resetEventTimes();
    note("create-message", payload.lifecycle === "draft" ? "草稿已儲存。連結只供預覽，發佈前唔接受投票；核對內容同預定時間後再發佈。" : data.catalogPending ? "活動已建立，可以分享。活動列表索引暫時延遲，系統會自動重試。" : "活動已建立。請先打開分享連結核對內容，再派 QR code。", "good");
    void billing.refresh();
  } catch (error) {
    if (stale(version)) return;
    const responseVersion = await adoptResponsePrincipal(error, true);
    if (responseVersion === null || stale(responseVersion)) return;
    version = responseVersion;
    if (error.creationQuota) setCreationQuota(error.creationQuota);
    if ([400, 422].includes(error.status) || error.code === "creation_quota_exhausted") {
      clearPendingCreation();
      note("create-message", error.message, "bad");
      if (error.code === "creation_quota_exhausted") {
        try { await loadEvents(); }
        catch (refreshError) { if (!cancelled(refreshError) && !stale(version)) note("events-message", "請重新整理活動，查看已建立嘅活動。", "bad"); }
      }
    } else if (pendingCreation) {
      note("create-message", error.code === "idempotency_conflict"
        ? "同一建立請求嘅內容未能確認一致。請重新整理活動列表，核對已建立嘅活動；本頁保留原本內容，唔會另開活動。"
        : "暫時未能確認活動有冇建立。請按「重試建立同一活動」；系統會用同一請求同內容，避免重複建立。", "bad");
    } else if (!cancelled(error)) note("create-message", error.message, "bad");
  } finally {
    if (!stale(version)) { creationBusy = false; syncCreateAvailability(); }
  }
}
$("logout-button").addEventListener("click", () => void logout());
$("retry-logout").addEventListener("click", () => void logout());
$("dismiss-account-key").addEventListener("click", clearAccountKey);
$("copy-account-key").addEventListener("click", async () => {
  const version = sessionVersion;
  try {
    await navigator.clipboard.writeText($("account-new-key").value);
    if (!stale(version)) $("account-key-message").textContent = "密鑰已複製，請私下交畀相關人士。";
  } catch {
    if (!stale(version)) {
      $("account-new-key").focus();
      $("account-new-key").select();
      $("account-key-message").textContent = "請複製上面已選取嘅密鑰。";
    }
  }
});

$("account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const version = sessionVersion;
  $("create-account-button").disabled = true;
  clearAccountKey();
  note("accounts-message", "正在新增帳戶…");
  try {
    const data = await send("/api/admin/accounts", "POST", { name: $("account-name").value.trim(), role: $("account-role").value });
    if (stale(version)) return;
    accountsLoaded = true;
    replaceAccount(data.account);
    showAccountKey(data.account, data.key);
    $("account-form").reset();
    note("accounts-message", "帳戶已建立，請保存今次顯示嘅登入密鑰。", "good");
  } catch (error) { if (!cancelled(error) && !stale(version)) note("accounts-message", error.message, "bad"); }
  finally { $("create-account-button").disabled = false; }
});

$("refresh-accounts").addEventListener("click", async () => {
  const version = sessionVersion;
  $("refresh-accounts").disabled = true;
  try { await loadAccounts(); if (!stale(version)) { renderEvents(knownEvents); note("accounts-message", ""); } }
  catch (error) { if (!cancelled(error) && !stale(version)) note("accounts-message", error.message, "bad"); }
  finally { $("refresh-accounts").disabled = false; }
});

$("open-now").addEventListener("change", syncCreateTiming);
$("save-draft").addEventListener("change", syncCreateTiming);
$("event-selection-mode").addEventListener("change", syncCreateChoices);
$("event-options").addEventListener("input", syncCreateChoices);
$("event-max-choices").addEventListener("input", syncCreateChoices);

$("event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitEvent();
});
$("retry-create-button").addEventListener("click", () => void submitEvent());

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportVotes(event, button, progress) {
  const version = sessionVersion;
  button.disabled = true;
  progress.textContent = "正在讀取票據，完成後先會下載…";
  const rows = [];
  let completed = 0;
  const controller = new AbortController();
  try {
    let nextShard = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (nextShard < 128) {
        const index = nextShard++;
        let after = "";
        do {
          const query = new URLSearchParams({ shard: String(index), after });
          const data = await api(`/api/admin/events/${event.id}/export?${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
          if (stale(version)) throw new DOMException("Session changed", "AbortError");
          rows.push(...data.rows);
          after = data.next || "";
        } while (after);
        completed++;
        progress.textContent = `已讀取 ${completed}/128 個分區 · ${rows.length.toLocaleString("zh-HK")} 張投票`;
      }
    }));
    if (stale(version)) return;
    rows.sort((a, b) => a.voter_hash.localeCompare(b.voter_hash));
    const content = "\uFEFF" + [["event_id", "voter_hash", "option_id", "recorded_at_utc", "option_ids_json"],
      ...rows.map((row) => [event.id, row.voter_hash, row.option_id, new Date(row.created_at).toISOString(), JSON.stringify(Array.isArray(row.option_ids) ? row.option_ids : row.option_id ? [row.option_id] : [])]),
    ].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blobUrl = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `wevote-${event.id}-votes.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    progress.textContent = `已匯出 ${rows.length.toLocaleString("zh-HK")} 張投票。檔案含匿名識別，請妥善保存。`;
  } catch (error) {
    controller.abort();
    if (!cancelled(error) && !stale(version)) progress.textContent = `未有下載：${error.message} 請重新匯出。`;
  } finally { button.disabled = false; }
}

$("refresh-events").addEventListener("click", async () => {
  const version = sessionVersion;
  $("refresh-events").disabled = true;
  try { await loadEvents(); }
  catch (error) { if (!cancelled(error) && !stale(version)) note("events-message", error.message, "bad"); }
  finally { $("refresh-events").disabled = false; }
});

function readAuthCallback() {
  const url = new URL(location.href);
  const auth = url.searchParams.get("auth");
  if (!auth) return null;
  if (auth === "error") {
    const messages = { login_failed: "登入未完成，請再試。若果持續失敗，請聯絡主辦平台。" };
    note("auth-callback-message", messages[url.searchParams.get("reason")] || "登入未完成，請再試。", "bad");
  } else if (auth === "success") note("auth-callback-message", "正在確認登入狀態…");
  url.searchParams.delete("auth");
  url.searchParams.delete("reason");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return auth === "success" ? "success" : null;
}

async function loadAuthProviders() {
  try {
    const response = await fetch("/api/auth/providers", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Provider status unavailable");
    const providers = await response.json();
    const google = providers.google === true;
    const apple = providers.apple === true;
    $("google-login").hidden = !google;
    $("apple-login").hidden = !apple;
    $("auth-providers").hidden = !google && !apple;
    $("auth-provider-message").textContent = google || apple
      ? "主辦方首次登入會建立帳戶。登入狀態有效 8 小時；用完請登出。"
      : "Google／Apple 登入尚未設定好，公開註冊暫未開放。已有管理員可以用密鑰登入。";
    if (!google && !apple) $("staff-login").open = true;
  } catch {
    $("auth-provider-message").textContent = "暫時未能確認 Google／Apple 登入方式，請重新整理再試。管理員仍可用密鑰登入。";
    $("staff-login").open = true;
  }
}

async function bootstrap() {
  let legacyKey = "";
  try {
    legacyKey = sessionStorage.getItem("wevote-admin-key") || "";
    sessionStorage.removeItem("wevote-admin-key");
  } catch { /* Cookie login still works when browser storage is unavailable. */ }
  if (legacyKey) { await login(legacyKey); return; }
  const version = sessionVersion;
  setLoginBusy(true);
  try {
    const data = await api("/api/admin/me");
    await openDashboard(data.principal || data, data.creationQuota);
  } catch (error) {
    if (!cancelled(error) && error.status === 401 && authCallback === "success") note("auth-callback-message", "未能確認登入狀態，請重新登入。", "bad");
    if (!cancelled(error) && error.status !== 401) note("login-message", "暫時未能確認登入狀態，請稍後再試。", "bad");
  } finally { if (!stale(version)) setLoginBusy(false); }
}

resetEventTimes();
const authCallback = readAuthCallback();
$("onboarding-help").addEventListener("click", () => showOnboarding());
void Promise.allSettled([loadAuthProviders(), bootstrap()]).then(() => {
  onboardingReady = true;
  $("onboarding-help").disabled = false;
  showOnboarding(true);
});
