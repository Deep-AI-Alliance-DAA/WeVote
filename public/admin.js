import { mountEventShare } from "./share.js";

const $ = (id) => document.getElementById(id);
const keyStore = "wevote-admin-key";
let adminKey = sessionStorage.getItem(keyStore) || "";
let publicBaseUrl = location.origin;
const justCreated = new Map();
let knownEvents = [];

function note(id, value, kind = "") {
  const element = $(id);
  element.textContent = value;
  element.className = `message ${kind}`;
}

function hkInput(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function hkDisplay(iso) {
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short",
  }).format(new Date(iso));
}

function eventPhase(event) {
  const now = Date.now();
  if (now < Date.parse(event.opensAt)) return ["未開始", "pending"];
  if (now >= Date.parse(event.closesAt)) return ["已截止", "closed"];
  return ["投票中", "open"];
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${adminKey}`, ...(options.headers || {}) },
    cache: "no-store",
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "請稍後再試。");
  return data;
}

function makeShareUrl(id) {
  const url = new URL("/vote.html", publicBaseUrl);
  url.searchParams.set("event", id);
  return url.toString();
}

function renderEvents(events) {
  knownEvents = events;
  const list = $("events-list");
  list.replaceChildren();
  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "admin-muted";
    empty.textContent = "暫時未有活動。";
    list.append(empty);
    return;
  }
  for (const event of events) {
    const url = makeShareUrl(event.id);
    const [label, phase] = eventPhase(event);
    const item = document.createElement("article");
    item.className = "event-item";
    const head = document.createElement("div");
    head.className = "event-head";
    const title = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = event.name;
    const id = document.createElement("span");
    id.className = "event-id";
    id.textContent = `ID ${event.id}`;
    title.append(name, id);
    const status = document.createElement("span");
    status.className = `event-status ${phase}`;
    status.textContent = label;
    head.append(title, status);
    const times = document.createElement("p");
    times.className = "event-times";
    times.textContent = `${hkDisplay(event.opensAt)} 開始 · ${hkDisplay(event.closesAt)} 截止`;
    const share = document.createElement("div");
    mountEventShare(share, { url, name: event.name, question: event.question || "" });
    const tools = document.createElement("div");
    tools.className = "event-tools";
    const report = document.createElement("a");
    report.href = `/results.html?event=${event.id}`;
    report.className = "small-button";
    report.target = "_blank";
    report.rel = "noopener noreferrer";
    report.textContent = "結果／CSV／PDF 報告 ↗";
    const raw = document.createElement("button");
    raw.type = "button";
    raw.className = "small-button";
    raw.textContent = "匯出逐票 CSV";
    raw.disabled = phase !== "closed";
    const progress = document.createElement("p");
    progress.className = "export-progress";
    progress.setAttribute("role", "status");
    raw.addEventListener("click", () => void exportVotes(event, raw, progress));
    tools.append(report, raw);
    item.append(head, times, share, tools, progress);
    list.append(item);
  }
}

async function loadEvents() {
  const data = await api("/api/admin/events");
  publicBaseUrl = data.publicBaseUrl || location.origin;
  const byId = new Map(data.events.map((event) => [event.id, event]));
  for (const [id, event] of justCreated) byId.set(id, event);
  renderEvents([...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  note("events-message", data.hasMore ? "活動數量較多，目前只顯示部分活動。" : "");
}

async function login(key) {
  adminKey = key.trim();
  try {
    await loadEvents();
    sessionStorage.setItem(keyStore, adminKey);
    $("login-panel").hidden = true;
    $("dashboard").hidden = false;
    note("login-message", "");
  } catch (error) {
    adminKey = "";
    sessionStorage.removeItem(keyStore);
    $("login-panel").hidden = false;
    $("dashboard").hidden = true;
    note("login-message", error.message, "bad");
  }
}

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void login($("admin-key").value);
});

$("logout-button").addEventListener("click", () => {
  adminKey = "";
  sessionStorage.removeItem(keyStore);
  $("admin-key").value = "";
  $("dashboard").hidden = true;
  $("login-panel").hidden = false;
});

$("open-now").addEventListener("change", () => {
  $("opens-label").hidden = $("open-now").checked;
  $("opens-at").hidden = $("open-now").checked;
  $("opens-at").required = !$("open-now").checked;
});

$("event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const options = $("event-options").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (options.length < 2 || options.length > 6) return note("create-message", "請填 2–6 個選項，每行一項。", "bad");
  $("create-button").disabled = true;
  note("create-message", "正在建立活動…");
  try {
    const opensAt = $("open-now").checked ? new Date().toISOString() : new Date(`${$("opens-at").value}:00+08:00`).toISOString();
    const closesAt = new Date(`${$("closes-at").value}:00+08:00`).toISOString();
    const data = await api("/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("event-name").value, question: $("event-question").value, options, opensAt, closesAt }),
    });
    publicBaseUrl = data.publicBaseUrl || location.origin;
    justCreated.set(data.event.id, data.event);
    renderEvents([data.event, ...knownEvents.filter((event) => event.id !== data.event.id)]);
    $("event-form").reset();
    $("closes-at").value = hkInput(new Date(Date.now() + 86400_000));
    $("opens-label").hidden = true;
    $("opens-at").hidden = true;
    $("opens-at").required = false;
    note("create-message", data.catalogPending ? "活動已建立，可以分享。活動列表索引暫時延遲，系統會自動重試。" : "活動已建立。請先打開分享連結核對內容，再派 QR code。", "good");
  } catch (error) {
    note("create-message", error instanceof RangeError ? "請填有效嘅香港開始／截止時間。" : error.message, "bad");
  } finally {
    $("create-button").disabled = false;
  }
});

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportVotes(event, button, progress) {
  button.disabled = true;
  progress.textContent = "正在讀取票據，完成後先會下載…";
  const rows = [];
  let completed = 0;
  const controller = new AbortController();
  try {
    // Four bounded readers; download only once every shard has succeeded.
    let nextShard = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (nextShard < 128) {
        const index = nextShard++;
        let after = "";
        do {
          const query = new URLSearchParams({ shard: String(index), after });
          const data = await api(`/api/admin/events/${event.id}/export?${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
          rows.push(...data.rows);
          after = data.next || "";
        } while (after);
        completed++;
        progress.textContent = `已讀取 ${completed}/128 個分區 · ${rows.length.toLocaleString("zh-HK")} 票`;
      }
    }));
    rows.sort((a, b) => a.voter_hash.localeCompare(b.voter_hash));
    const content = "\uFEFF" + [
      ["event_id", "voter_hash", "option_id", "recorded_at_utc"],
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
    progress.textContent = `未有下載：${error.message} 請重新匯出。`;
  } finally {
    button.disabled = false;
  }
}

$("refresh-events").addEventListener("click", async () => {
  $("refresh-events").disabled = true;
  try { await loadEvents(); }
  catch (error) { note("events-message", error.message, "bad"); }
  finally { $("refresh-events").disabled = false; }
});

$("closes-at").value = hkInput(new Date(Date.now() + 86400_000));
$("opens-at").value = hkInput(new Date(Date.now() + 120_000));
if (adminKey) void login(adminKey);
