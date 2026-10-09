const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "phase-label", "poll-id", "close-time", "status-pill", "question-title", "vote-subtitle", "vote-form",
  "options", "turnstile", "vote-button", "vote-message", "turnout", "phase-detail", "countdown",
  "updated-at", "result-area", "result-bars",
].map((id) => [id, $(id)]));

let poll = null;
let ticket = null;
let turnstileToken = null;
let turnstileWidget = null;
let busy = false;
let recorded = false;

const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has("ticket")) {
  ticket = fragment.get("ticket");
  sessionStorage.setItem("wevote-ticket", ticket);
  history.replaceState(null, "", location.pathname + location.search);
} else {
  ticket = sessionStorage.getItem("wevote-ticket");
}

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
  area.hidden = data.phase !== "closed" || !data.counts;
  if (area.hidden) return;
  const list = elements["result-bars"];
  list.replaceChildren();
  for (const option of data.options) {
    const count = data.counts[option.id] || 0;
    const percent = data.turnout ? 100 * count / data.turnout : 0;
    const item = document.createElement("div");
    item.className = "result-item";
    const line = document.createElement("div");
    line.className = "result-line";
    const name = document.createElement("span");
    name.textContent = option.label;
    const figure = document.createElement("span");
    figure.textContent = `${count.toLocaleString("zh-HK")} 票 · ${percent.toFixed(1)}%`;
    line.append(name, figure);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${percent}%`;
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
  elements["vote-button"].disabled = busy || recorded || !turnstileToken || !elements.options.querySelector("input:checked");
}

function renderPoll(data) {
  const first = !poll || poll.pollId !== data.pollId;
  poll = data;
  if (first) {
    renderOptions(data.options);
    recorded = ticket ? sessionStorage.getItem(`wevote-recorded:${ticket}`) === "yes" : false;
    if (ticket && !recorded && data.phase === "open") void loadTurnstile(data.turnstileSiteKey);
  }
  elements["poll-id"].textContent = data.pollId;
  elements["close-time"].textContent = formatTime(data.closesAt);
  elements["question-title"].textContent = data.question;
  elements.turnout.textContent = data.turnout.toLocaleString("zh-HK");
  elements["updated-at"].textContent = new Intl.DateTimeFormat("zh-HK", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(data.updatedAt));
  const labels = { pending: "等待開始", open: "投票進行中", closed: "投票已結束" };
  elements["phase-label"].textContent = labels[data.phase];
  elements["status-pill"].textContent = labels[data.phase];
  elements["phase-detail"].textContent = labels[data.phase];
  elements["vote-form"].hidden = data.phase !== "open" || !ticket || recorded;
  if (data.phase === "pending") elements["vote-subtitle"].textContent = `投票將於 ${formatTime(data.opensAt)} 開始。`;
  else if (data.phase === "closed") elements["vote-subtitle"].textContent = "投票已截止，多謝參與。";
  else if (!ticket) elements["vote-subtitle"].textContent = "請使用主辦方派發嘅獨立投票連結進入。";
  else if (recorded) elements["vote-subtitle"].textContent = "你嘅投票已經記錄。";
  else elements["vote-subtitle"].textContent = "揀一個選項，通過驗證後確認。提交後唔可以更改。";
  if (data.phase === "open" && ticket && !recorded && turnstileWidget === null) void loadTurnstile(data.turnstileSiteKey);
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
  try {
    const response = await fetch("/api/results");
    if (!response.ok) throw new Error("目前未能讀取投票資料。");
    renderPoll(await response.json());
  } catch (error) {
    message(error.message || "目前未能讀取投票資料。", "bad");
  }
}

elements.options.addEventListener("change", updateButton);
elements["vote-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const choice = elements.options.querySelector("input:checked");
  if (!choice || !turnstileToken || !ticket || busy) return;
  busy = true;
  updateButton();
  message("正在保存你嘅投票…");
  try {
    const response = await fetch("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, optionId: choice.value, turnstileToken }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "投票未能送出。");
    recorded = true;
    sessionStorage.setItem(`wevote-recorded:${ticket}`, "yes");
    elements["vote-form"].hidden = true;
    elements["vote-subtitle"].textContent = "你嘅投票已經記錄。";
    message(result.duplicate ? "呢張票之前已經記錄，毋須重複提交。" : "投票成功！多謝參與。", "good");
    void loadPoll();
  } catch (error) {
    message(error.message || "投票未能送出，請再試。", "bad");
    turnstileToken = null;
    if (turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
  } finally {
    busy = false;
    updateButton();
  }
});

void loadPoll();
setInterval(loadPoll, 11_000);
setInterval(renderCountdown, 1000);
