import { applyEventPresentation } from "/presentation.js";

const reportElements = Object.fromEntries([
  "event-title", "event-question", "load-message", "report-content", "report-phase", "report-turnout",
  "report-visibility", "report-opens", "report-closes", "report-updated", "waiting-results", "waiting-title",
  "waiting-copy", "final-results", "results-rows", "result-total", "export-note", "report-id", "vote-link",
  "csv-button", "print-button", "refresh-button", "results-title", "results-empty", "fullscreen-button", "report-dashboard", "event-presentation",
].map((id) => [id, document.getElementById(id)]));

const reportEventId = new URLSearchParams(location.search).get("event");
const validReportEvent = /^[a-f0-9]{24}$/.test(reportEventId || "");
const reportLabels = { draft: "草稿預覽", pending: "等待開始", open: "投票進行中", closed: "投票已結束" };
const reportTime = new Intl.DateTimeFormat("zh-HK", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "medium" });
let currentReport = null;
let reportLoading = false;

function formatReportTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? reportTime.format(date) : "—";
}

function reportCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function canExportReport() {
  return ["open", "closed"].includes(currentReport?.phase) && hasReportCounts(currentReport);
}

function hasReportCounts(report) {
  return report?.phase !== "draft" && report?.counts !== null && typeof report?.counts === "object" && !Array.isArray(report.counts);
}

function setReportMessage(text, error = false) {
  reportElements["load-message"].textContent = text;
  reportElements["load-message"].className = `message${error ? " bad" : ""}`;
}

function renderReport(data) {
  currentReport = data;
  const closed = data.phase === "closed";
  const canExport = canExportReport();
  const hasCounts = hasReportCounts(data);
  const turnout = reportCount(data.turnout);
  const phase = reportLabels[data.phase] || "讀取活動資料中";
  const pending = data.phase === "pending";
  const pendingCopy = `投票將於 ${formatReportTime(data.opensAt)}（香港時間）開始。${data.resultsVisibility === "live" ? "開始投票後會即時公開各選項票數及百分比。" : "各選項票數及百分比會於截止後公開。"}`;
  document.title = `${data.name} · ${data.phase === "draft" ? "草稿預覽" : pending ? "等待投票開始" : closed ? "最終結果" : "即時結果（未截止）"} · WeVote`;
  reportElements["event-title"].textContent = data.name;
  reportElements["event-question"].textContent = data.question;
  applyEventPresentation(reportElements["event-presentation"], data.presentation, data.name);
  reportElements["report-phase"].textContent = phase;
  reportElements["report-turnout"].textContent = turnout.toLocaleString("zh-HK");
  reportElements["report-visibility"].textContent = data.phase === "draft" ? "活動未發佈，唔接受投票。以下內容只供預覽。" : pending ? pendingCopy : closed
    ? turnout === 0 ? "活動已截止，未有已記錄投票。" : "投票已截止，以下顯示各選項嘅已記錄票數。"
    : `${turnout === 0 ? "呢個活動暫時未有已記錄投票。" : "只計已成功提交嘅投票。"}開啟連結或掃碼唔會計票。每 1 秒自動更新票數${hasCounts ? "。" : "，各選項結果會於截止後公開。"}`;
  reportElements["report-opens"].textContent = formatReportTime(data.opensAt);
  reportElements["report-closes"].textContent = formatReportTime(data.closesAt);
  reportElements["report-updated"].textContent = formatReportTime(data.updatedAt);
  reportElements["report-id"].textContent = reportEventId;
  reportElements["report-content"].hidden = false;
  reportElements["waiting-results"].hidden = hasCounts;
  reportElements["final-results"].hidden = !hasCounts;
  reportElements["csv-button"].disabled = !canExport;
  reportElements["print-button"].disabled = !canExport;
  reportElements["export-note"].textContent = data.phase === "draft" ? "草稿未發佈，暫時未有投票報告。" : canExport ? closed ? "下載完整票數摘要，或使用瀏覽器列印功能另存 PDF。" : "可保存目前票數摘要。活動仍在進行，報告會標示「未截止」及資料更新時間。" : "各選項結果公開後可下載 CSV，或列印及另存 PDF。";
  reportElements["waiting-title"].textContent = data.phase === "draft" ? "草稿預覽" : pending ? "等待投票開始" : data.phase === "closed" ? "結果整理中" : "投票截止後公布結果";
  reportElements["waiting-copy"].textContent = data.phase === "draft" ? "活動未發佈，唔接受投票。主辦方發佈後先會按設定開放投票同顯示結果。" : pending ? pendingCopy : data.phase === "closed" ? "活動已截止，正在讀取最終結果。請稍候。" : "活動進行期間只顯示參與人數。各選項票數及百分比會喺截止後公開。";

  if (hasCounts) {
    reportElements["results-title"].textContent = closed ? "最終投票分佈" : "即時結果（未截止）";
    reportElements["result-total"].textContent = `共 ${turnout.toLocaleString("zh-HK")} 票`;
    reportElements["results-empty"].hidden = turnout !== 0;
    reportElements["results-empty"].textContent = data.phase === "closed" ? "活動已截止，未有已記錄投票。" : "暫時未有人投票。";
    const rows = data.options.map((option) => {
      const count = reportCount(data.counts[option.id]);
      const percent = turnout > 0 ? count / turnout * 100 : 0;
      const row = document.createElement("tr");
      const labelCell = document.createElement("td");
      const label = document.createElement("span");
      label.className = "report-option-label";
      label.textContent = option.label;
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.setAttribute("aria-hidden", "true");
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      bar.append(fill);
      labelCell.append(label, bar);
      const countCell = document.createElement("td");
      countCell.textContent = count.toLocaleString("zh-HK");
      const percentCell = document.createElement("td");
      percentCell.textContent = `${percent.toFixed(1)}%`;
      row.append(labelCell, countCell, percentCell);
      return row;
    });
    reportElements["results-rows"].replaceChildren(...rows);
  }
  setReportMessage("");
}

async function loadReport() {
  if (!validReportEvent || reportLoading) return;
  reportLoading = true;
  reportElements["refresh-button"].disabled = true;
  reportElements["refresh-button"].textContent = "更新中…";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`/api/events/${reportEventId}/results`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 404 ? "搵唔到呢個活動，請檢查主辦方提供嘅連結。" : "暫時未能讀取活動結果，稍後會再試。");
    const data = await response.json();
    if (!Array.isArray(data.options) || typeof data.name !== "string" || typeof data.question !== "string" || !Number.isSafeInteger(data.turnout) || data.turnout < 0) throw new Error("活動資料未完整，請稍後再試。");
    renderReport(data);
  } catch (error) {
    if (!currentReport) reportElements["event-title"].textContent = "未能載入活動";
    setReportMessage(error.name === "AbortError" ? "連線較慢，稍後會再試。" : error.message || "暫時未能讀取活動結果。", true);
  } finally {
    clearTimeout(timeout);
    reportLoading = false;
    reportElements["refresh-button"].disabled = false;
    reportElements["refresh-button"].textContent = "更新票數";
  }
}

// Quote every cell and neutralise spreadsheet formulas, including leading whitespace.
function reportCsvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

reportElements["csv-button"].addEventListener("click", () => {
  if (!canExportReport()) return;
  const report = currentReport;
  const turnout = reportCount(report.turnout);
  const rows = [
    [report.phase === "closed" ? "WeVote 活動最終結果" : "WeVote 即時結果（未截止）"], ["活動名稱", report.name], ["活動編號", reportEventId], ["投票題目", report.question],
    ["主辦單位", report.presentation?.organizer || ""], ["活動介紹", report.presentation?.description || ""],
    ["開始時間（香港）", formatReportTime(report.opensAt)], ["截止時間（香港）", formatReportTime(report.closesAt)],
    ["資料更新（香港）", formatReportTime(report.updatedAt)], ["匯出時間（香港）", formatReportTime(Date.now())],
    ["狀態", report.phase === "closed" ? reportLabels[report.phase] : `${reportLabels[report.phase]}（未截止）`], ["已記錄票數", turnout], [], ["選項", "票數", "百分比"],
    ...report.options.map((option) => {
      const count = reportCount(report.counts[option.id]);
      return [option.label, count, `${(turnout > 0 ? count / turnout * 100 : 0).toFixed(1)}%`];
    }),
    [], ["Credits", "DAA.HK · Hillman Tam · Keith Li"],
  ];
  const csv = "\uFEFF" + rows.map((row) => row.map(reportCsvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `wevote-${reportEventId}-results.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

reportElements["print-button"].addEventListener("click", () => {
  if (canExportReport()) window.print();
});
reportElements["refresh-button"].addEventListener("click", () => { void loadReport(); });

const dashboard = reportElements["report-dashboard"];
const fullscreenButton = reportElements["fullscreen-button"];
fullscreenButton.hidden = typeof dashboard.requestFullscreen !== "function";
fullscreenButton.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement === dashboard) await document.exitFullscreen();
    else await dashboard.requestFullscreen();
  } catch {
    setReportMessage("瀏覽器未能開啟全屏展示；可以使用瀏覽器嘅全屏功能。", true);
  }
});
document.addEventListener("fullscreenchange", () => {
  const active = document.fullscreenElement === dashboard;
  fullscreenButton.textContent = active ? "離開全屏" : "全屏展示";
  fullscreenButton.setAttribute("aria-pressed", String(active));
});

if (validReportEvent) {
  reportElements["vote-link"].href = `/vote.html?event=${reportEventId}`;
  reportElements["vote-link"].hidden = false;
  void loadReport();
  setInterval(() => {
    if (!document.hidden && (!currentReport || currentReport.phase !== "closed" || !canExportReport())) void loadReport();
  }, 1_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void loadReport();
  });
} else {
  reportElements["event-title"].textContent = "請使用活動結果連結";
  setReportMessage("呢個連結缺少有效活動編號。請由投票活動頁開啟結果，或向主辦方索取連結。", true);
}
