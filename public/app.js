import { applyEventPresentation } from "/presentation.js";

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "phase-label", "poll-id", "close-time", "status-pill", "question-title", "vote-subtitle", "vote-form",
  "options", "turnstile", "vote-button", "vote-message", "turnout", "phase-detail", "countdown",
  "updated-at", "result-area", "result-bars",
].map((id) => [id, $(id)]));

let poll = null;
let ticket = null;
const eventId = new URLSearchParams(location.search).get("event");
const publicEvent = eventId && /^[a-f0-9]{24}$/.test(eventId);
const eventApi = publicEvent ? `/api/events/${eventId}` : null;
let identityReady = false;
let identityLoading = false;
let pollLoading = false;
let transientError = false;
let turnstileToken = null;
let turnstileWidget = null;
let busy = false;
let recorded = false;

if (!eventId) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has("ticket")) {
    ticket = fragment.get("ticket");
    sessionStorage.setItem("wevote-ticket", ticket);
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    ticket = sessionStorage.getItem("wevote-ticket");
  }
}

const recordedKey = publicEvent ? `wevote-recorded:${eventId}` : `wevote-recorded:${ticket}`;

function message(text, kind = "") {
  elements["vote-message"].textContent = text;
  elements["vote-message"].className = `message ${kind}`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-HK", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function renderOptions(options) {
  const box = elements.options;
  box.replaceChildren();
  const legend = document.createElement("legend");
  legend.className = "sr-only";
  legend.textContent = "選擇一個答案";
  box.append(legend);
  for (const option of options) {
    const label = document.createElement("label");
    label.className = "option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "option";
    input.value = option.id;
    input.required = true;
    const text = document.createElement("span");
    text.textContent = option.label;
    label.append(input, text);
    box.append(label);
  }
}

function renderResults(data) {
  const area = elements["result-area"];
  const hasCounts = data.counts !== null && typeof data.counts === "object" && !Array.isArray(data.counts);
  area.hidden = false;
  const title = area.querySelector("h3");
  if (title) title.textContent = hasCounts ? data.phase === "closed" ? "最終結果" : "即時投票分佈" : "各選項結果";
  const list = elements["result-bars"];
  list.replaceChildren();
  if (!hasCounts || data.turnout === 0) {
    const note = document.createElement("p");
    note.className = "card-subtitle";
    note.textContent = !hasCounts ? "各選項結果會於截止後公開。" : data.phase === "closed" ? "未有已記錄投票。" : "暫時未有人投票。";
    list.append(note);
    if (!hasCounts) return;
  }
  for (const option of data.options) {
    const count = data.counts[option.id] || 0;
    const percent = data.turnout ? 100 * count / data.turnout : 0;
    const item = document.createElement("div");
    item.className = "result-item";
    const line = document.createElement("div");
    line.className = "result-line";
    const name = document.createElement("span");
    name.textContent = option.label;
    name.style.minWidth = "0";
    name.style.overflowWrap = "anywhere";
    const figure = document.createElement("span");
    figure.textContent = `${count.toLocaleString("zh-HK")} 票 · ${percent.toFixed(1)}%`;
    figure.style.flexShrink = "0";
    line.append(name, figure);
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    bar.append(fill);
    item.append(line, bar);
    list.append(item);
  }
}

let lastCloseRefresh = 0;
function renderCountdown() {
  if (!poll) return;
  const delta = new Date(poll.closesAt).getTime() - Date.now();
  if (delta <= 0) {
    updateButton();
    elements.countdown.textContent = "已截止";
    if (poll.phase === "open" && Date.now() - lastCloseRefresh > 10_000) {
      lastCloseRefresh = Date.now();
      void loadPoll();
    }
    return;
  }
  const seconds = Math.floor(delta / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  elements.countdown.textContent = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function updateButton() {
  elements["vote-button"].disabled = busy || recorded || poll?.phase !== "open" || Date.now() >= Date.parse(poll.closesAt) || !(publicEvent ? identityReady : ticket) || !turnstileToken || !elements.options.querySelector("input:checked");
}

function renderPoll(data) {
  const first = !poll || poll.pollId !== data.pollId;
  poll = data;
  const canVote = publicEvent ? identityReady : Boolean(ticket);
  if (canVote) recorded = sessionStorage.getItem(recordedKey) === "yes";
  if (first) {
    renderOptions(data.options);
    if (canVote && !recorded && data.phase === "open") void loadTurnstile(data.turnstileSiteKey);
  }
  elements["poll-id"].textContent = data.name || data.pollId;
  if (publicEvent) {
    document.title = `${data.name} · WeVote`;
    $("page-title").textContent = data.name;
    const introCopy = document.querySelector(".intro-copy");
    if (introCopy) introCopy.textContent = data.counts !== null ? "選擇你支持嘅選項，確認後即時記錄。活動票數及分佈會定時更新。" : "選擇你支持嘅選項，確認後即時記錄。各選項結果會喺截止後公開。";
    const reportLink = $("event-results-link");
    if (reportLink) { reportLink.href = `/results.html?event=${eventId}`; reportLink.hidden = false; }
  }
  applyEventPresentation($("event-presentation"), data.presentation, data.name || data.question);
  elements["close-time"].textContent = formatTime(data.closesAt);
  elements["question-title"].textContent = data.question;
  elements.turnout.textContent = data.turnout.toLocaleString("zh-HK");
  const turnoutNote = document.querySelector(".live-footnote");
  if (turnoutNote) {
    if (data.phase === "closed") turnoutNote.textContent = data.turnout === 0 ? "活動已截止，未有已記錄投票。開啟連結或掃碼唔會計票。" : "只計已成功提交嘅投票。正式結果已喺下方公布。";
    else if (data.phase === "pending") turnoutNote.textContent = "活動未開始。開啟連結或掃碼唔會計票，成功提交投票後先會記錄。";
    else turnoutNote.textContent = `${data.turnout === 0 ? "呢個活動暫時未有已記錄投票。" : "只計已成功提交嘅投票，唔包括開啟連結或掃碼次數。"}票數約每 10 秒更新，剛提交可能要稍等。`;
  }
  elements["updated-at"].textContent = new Intl.DateTimeFormat("zh-HK", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(data.updatedAt));
  const labels = { pending: "等待開始", open: "投票進行中", closed: "投票已結束" };
  elements["phase-label"].textContent = labels[data.phase];
  elements["status-pill"].textContent = labels[data.phase];
  elements["phase-detail"].textContent = labels[data.phase];
  elements["vote-form"].hidden = data.phase !== "open" || !canVote || recorded;
  if (data.phase === "pending") elements["vote-subtitle"].textContent = `投票將於 ${formatTime(data.opensAt)} 開始。`;
  else if (data.phase === "closed") elements["vote-subtitle"].textContent = "投票已截止，多謝參與。";
  else if (!canVote) elements["vote-subtitle"].textContent = publicEvent ? "正在準備投票識別，請稍候。" : "請使用主辦方派發嘅獨立投票連結進入。";
  else if (recorded) elements["vote-subtitle"].textContent = "你嘅投票已經記錄。";
  else elements["vote-subtitle"].textContent = "揀一個選項，通過驗證後確認。提交後唔可以更改。";
  if (data.phase === "open" && canVote && !recorded && turnstileWidget === null) void loadTurnstile(data.turnstileSiteKey);
  if (publicEvent) document.getElementById("privacy-note").textContent = "同一瀏覽器每個活動只記錄一票；清除瀏覽器資料仍可能再次投票。公開結果唔會顯示個人選擇。";
  renderResults(data);
  renderCountdown();
  updateButton();
}

async function loadTurnstile(sitekey) {
  if (turnstileWidget !== null || document.getElementById("turnstile-script")) return;
  const script = document.createElement("script");
  script.id = "turnstile-script";
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.onload = () => {
    turnstileWidget = window.turnstile.render(elements.turnstile, {
      sitekey,
      action: "vote",
      callback: (token) => { turnstileToken = token; updateButton(); },
      "expired-callback": () => { turnstileToken = null; updateButton(); },
      "error-callback": () => { turnstileToken = null; updateButton(); },
    });
  };
  script.onerror = () => message("安全驗證未能載入，請重新整理頁面。", "bad");
  document.head.append(script);
}

async function loadPoll() {
  if (pollLoading || (eventId && !publicEvent)) return;
  pollLoading = true;
  try {
    // Keep the shared edge snapshot, but avoid adding a separate browser cache delay.
    const response = await fetch(publicEvent ? `${eventApi}/results` : "/api/results", { cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 404 ? "搵唔到呢個活動，請檢查主辦方提供嘅連結。" : "目前未能讀取投票資料。");
    const data = await response.json();
    if (!Number.isSafeInteger(data.turnout) || data.turnout < 0) throw new Error("參與票數未能讀取，稍後會再試。");
    renderPoll(data);
    if (transientError && !busy && !recorded) { message(""); transientError = false; }
    if (publicEvent && poll.phase !== "closed" && !identityReady) void loadIdentity();
  } catch (error) {
    message(error.message || "目前未能讀取投票資料。", "bad");
    transientError = true;
  } finally {
    pollLoading = false;
  }
}

async function loadIdentity() {
  if (!publicEvent || identityReady || identityLoading || poll?.phase === "closed") return;
  identityLoading = true;
  try {
    const response = await fetch(`${eventApi}/identity`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("目前未能準備投票識別，稍後會再試。");
    identityReady = true;
    if (poll) renderPoll(poll);
  } catch (error) {
    message(error.message || "目前未能準備投票識別。", "bad");
    transientError = true;
  } finally {
    identityLoading = false;
  }
}

elements.options.addEventListener("change", updateButton);
elements["vote-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const choice = elements.options.querySelector("input:checked");
  if (!choice || !turnstileToken || !(publicEvent ? identityReady : ticket) || busy || poll?.phase !== "open" || Date.now() >= Date.parse(poll.closesAt)) return;
  busy = true;
  updateButton();
  message("正在保存你嘅投票…");
  try {
    const response = await fetch(publicEvent ? `${eventApi}/vote` : "/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ...(publicEvent ? {} : { ticket }), optionId: choice.value, turnstileToken }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "投票未能送出。");
    recorded = true;
    sessionStorage.setItem(recordedKey, "yes");
    elements["vote-form"].hidden = true;
    elements["vote-subtitle"].textContent = "你嘅投票已經記錄。";
    message(result.duplicate ? "呢張票之前已經記錄，毋須重複提交。" : "投票成功！多謝參與。參與票數會喺下一輪更新。", "good");
    void loadPoll();
    // The immediate GET can still return the shared snapshot from before this vote.
    setTimeout(() => { if (!document.hidden) void loadPoll(); }, 12_000);
  } catch (error) {
    message(error.message || "投票未能送出，請再試。", "bad");
    turnstileToken = null;
    if (turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
  } finally {
    busy = false;
    updateButton();
  }
});

if (eventId && !publicEvent) {
  elements["question-title"].textContent = "活動連結無效";
  elements["vote-subtitle"].textContent = "請向主辦方索取正確嘅投票連結。";
  message("活動編號格式錯誤。", "bad");
} else {
  void loadPoll();
}
setInterval(() => {
  if (!document.hidden && poll?.phase !== "closed") void loadPoll();
}, 11_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void loadPoll(); });
setInterval(renderCountdown, 1000);
