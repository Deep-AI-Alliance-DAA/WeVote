import { mountEventShare } from "./share.js";

const $ = (id) => document.getElementById(id);
const roleLabels = { owner: "擁有人", admin: "管理員 · 全部活動", organizer: "活動管理員" };
const justCreated = new Map();
const pendingRequests = new Set();
let principal = null;
let sessionVersion = 0;
let publicBaseUrl = location.origin;
let knownEvents = [];
let accounts = [];
let accountsLoaded = false;
let shareTools = [];
let loginBusy = false;

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
  sessionVersion++;
  pendingRequests.forEach((controller) => controller.abort());
  pendingRequests.clear();
  principal = null;
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
      throw error;
    }
    return data;
  } finally { pendingRequests.delete(controller); }
}

function send(path, method, body) {
  return api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  $("opens-label").hidden = true;
  $("opens-at").hidden = true;
  $("opens-at").required = false;
}

function eventPhase(event) {
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
  block.append(node("summary", "", "編輯活動內容同外觀"));
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
      item.querySelector(".event-results-mode").textContent = event.resultsVisibility === "live" ? "結果：即時公開" : "結果：截止後公開";
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
    const editable = eventPhase(detail)[1] === "pending";
    section.append(node("p", "event-setting-help", editable ? "開始前可以修改名稱、題目同選項。開始後內容會鎖定。" : "活動已開始，名稱、題目同選項已鎖定。"));
    const form = node("form", "event-editor-form");
    const name = editorField(form, "活動名稱", "input", { type: "text", value: detail.name, required: true, maxLength: 100, disabled: !editable });
    const question = editorField(form, "投票問題", "textarea", { value: detail.question, required: true, maxLength: 300, rows: 3, disabled: !editable });
    const labels = detail.options.map((option) => typeof option === "string" ? option : option.label).join("\n");
    const options = editorField(form, "選項 · 每行一項，2–20 項", "textarea", { value: labels, required: true, rows: Math.min(8, Math.max(3, detail.options.length)), disabled: !editable });
    const status = node("p", "event-access-status");
    status.setAttribute("role", "status");
    if (editable) {
      const save = node("button", "small-button", "儲存活動內容");
      save.type = "submit";
      form.append(save);
      form.addEventListener("submit", async (submit) => {
        submit.preventDefault();
        const version = sessionVersion;
        const labels = options.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        if (labels.length < 2 || labels.length > 20 || labels.some((label) => label.length > 100)) {
          status.textContent = "請填 2–20 個選項，每項最多 100 字。";
          return;
        }
        save.disabled = true;
        status.textContent = "正在儲存內容…";
        try {
          const data = await send(`/api/admin/events/${event.id}`, "PATCH", { name: name.value.trim(), question: question.value.trim(), options: labels });
          if (stale(version)) return;
          // Display settings have their own authoritative storage and can be
          // newer than the raw ballot config returned after a content edit.
          const display = { resultsVisibility: event.resultsVisibility, presentation: event.presentation };
          Object.assign(event, data.event, display);
          renderEvents(knownEvents);
          note("events-message", "活動內容已更新，分享連結同 QR code 繼續有效。", "good");
        } catch (error) { if (!cancelled(error) && !stale(version)) status.textContent = error.message; }
        finally { save.disabled = false; }
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
    form.append(node("p", "event-setting-help", "使用可公開讀取嘅圖片網址；留空即可移除 Logo。"));
    const save = node("button", "small-button", "儲存公開時間同外觀");
    save.type = "submit";
    const status = node("p", "event-access-status");
    status.setAttribute("role", "status");
    form.append(save);
    form.addEventListener("submit", async (submit) => {
      submit.preventDefault();
      const version = sessionVersion;
      const logoUrl = logo.value.trim();
      if (logoUrl) {
        try {
          const url = new URL(logoUrl);
          if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid logo URL");
        } catch { status.textContent = "請填有效嘅 HTTPS 圖片網址，或者留空。"; return; }
      }
      save.disabled = true;
      status.textContent = "正在儲存設定…";
      try {
        const nextPresentation = { theme: theme.value, organizer: organizer.value.trim(), description: description.value.trim(), logoUrl };
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
    title.append(node("h3", "", event.name), node("span", "event-id", `ID ${event.id}`));
    head.append(title, node("span", `event-status ${phase}`, label));
    const times = node("p", "event-times", `${hkDisplay(event.opensAt)} 開始 · ${hkDisplay(event.closesAt)} 截止`);
    const share = node("div");
    shareTools.push(mountEventShare(share, { url: makeShareUrl(event.id), name: event.name, question: event.question || "" }));
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
    item.append(head, times, resultMode, share, tools, progress);
    appendResultSettings(item, event);
    if (principal?.role === "owner") appendEventAccess(item, event);
    list.append(item);
  }
}

async function loadEvents() {
  const data = await api("/api/admin/events");
  if (data.principal) {
    if (principal && (principal.id !== data.principal.id || principal.role !== data.principal.role)) {
      // A different tab may have changed the shared cookie session or role.
      // Discard cached records before adopting the newly authenticated user.
      clearSession();
      setPrincipal(data.principal);
      $("login-panel").hidden = true;
      $("dashboard").hidden = false;
      if (principal.role === "owner") {
        try { await loadAccounts(); }
        catch (error) { if (!cancelled(error)) note("accounts-message", error.message, "bad"); }
      }
      if (!principal) return;
    } else setPrincipal(data.principal);
  }
  publicBaseUrl = data.publicBaseUrl || location.origin;
  const byId = new Map(data.events.map((event) => [event.id, event]));
  for (const [id, event] of justCreated) {
    if (byId.has(id)) justCreated.delete(id);
    else byId.set(id, event);
  }
  renderEvents([...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  note("events-message", data.hasMore ? "活動數量較多，目前只顯示部分活動。" : "");
}

function setPrincipal(value) {
  principal = value;
  $("current-user-name").textContent = value.name;
  $("current-user-role").textContent = roleLabels[value.role] || "管理帳戶";
  $("accounts-panel").hidden = value.role !== "owner";
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

async function openDashboard(value) {
  setPrincipal(value);
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
    await openDashboard(data.principal);
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

$("open-now").addEventListener("change", () => {
  $("opens-label").hidden = $("open-now").checked;
  $("opens-at").hidden = $("open-now").checked;
  $("opens-at").required = !$("open-now").checked;
});

$("event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const version = sessionVersion;
  const options = $("event-options").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (options.length < 2 || options.length > 20) return note("create-message", "請填 2–20 個選項，每行一項。", "bad");
  $("create-button").disabled = true;
  note("create-message", "正在建立活動…");
  try {
    const opensAt = $("open-now").checked ? new Date().toISOString() : new Date(`${$("opens-at").value}:00+08:00`).toISOString();
    const closesAt = new Date(`${$("closes-at").value}:00+08:00`).toISOString();
    const data = await send("/api/admin/events", "POST", {
      name: $("event-name").value, question: $("event-question").value, options, opensAt, closesAt,
      resultsVisibility: $("results-visibility").value,
    });
    if (stale(version)) return;
    publicBaseUrl = data.publicBaseUrl || location.origin;
    justCreated.set(data.event.id, data.event);
    renderEvents([data.event, ...knownEvents.filter((item) => item.id !== data.event.id)]);
    $("event-form").reset();
    resetEventTimes();
    note("create-message", data.catalogPending ? "活動已建立，可以分享。活動列表索引暫時延遲，系統會自動重試。" : "活動已建立。請先打開分享連結核對內容，再派 QR code。", "good");
  } catch (error) { if (!cancelled(error) && !stale(version)) note("create-message", error instanceof RangeError ? "請填有效嘅香港開始／截止時間。" : error.message, "bad"); }
  finally { $("create-button").disabled = false; }
});

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
        progress.textContent = `已讀取 ${completed}/128 個分區 · ${rows.length.toLocaleString("zh-HK")} 票`;
      }
    }));
    if (stale(version)) return;
    rows.sort((a, b) => a.voter_hash.localeCompare(b.voter_hash));
    const content = "\uFEFF" + [["event_id", "voter_hash", "option_id", "recorded_at_utc"],
      ...rows.map((row) => [event.id, row.voter_hash, row.option_id, new Date(row.created_at).toISOString()]),
    ].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blobUrl = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `wevote-${event.id}-votes.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    progress.textContent = `已匯出 ${rows.length.toLocaleString("zh-HK")} 票。檔案含匿名識別，請妥善保存。`;
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
    await openDashboard(data.principal || data);
  } catch (error) {
    if (!cancelled(error) && error.status !== 401) note("login-message", "暫時未能確認登入狀態，請稍後再試。", "bad");
  } finally { if (!stale(version)) setLoginBusy(false); }
}

resetEventTimes();
void bootstrap();
