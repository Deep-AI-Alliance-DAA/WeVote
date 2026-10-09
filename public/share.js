import { qrcode } from "/vendor/qrcode.mjs";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeShareLinks(url, name, question) {
  const caption = [name, question].filter(Boolean).join("\n");
  return [
    ["WhatsApp", `https://wa.me/?${new URLSearchParams({ text: `${caption}\n${url}` })}`],
    ["Facebook", `https://www.facebook.com/sharer/sharer.php?${new URLSearchParams({ u: url })}`],
    ["X", `https://twitter.com/intent/tweet?${new URLSearchParams({ text: caption.slice(0, 180), url })}`],
  ];
}

function paintQr(canvas, qr, scale = 4) {
  // Four clear modules on all sides are part of the QR, also in exported artwork.
  const quiet = 4;
  const modules = qr.getModuleCount();
  canvas.width = canvas.height = (modules + quiet * 2) * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("呢個瀏覽器未能產生 QR 圖。請複製活動連結。");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#17283c";
  for (let row = 0; row < modules; row++) {
    for (let column = 0; column < modules; column++) {
      if (qr.isDark(row, column)) context.fillRect((column + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
  }
  return canvas;
}

function wrappedText(context, value, maxWidth, maxLines) {
  const characters = Array.from(String(value).replace(/\s+/g, " ").trim());
  const lines = [];
  let line = "";
  for (let index = 0; index < characters.length; index++) {
    const next = line + characters[index];
    if (context.measureText(next).width <= maxWidth || !line) {
      line = next;
      continue;
    }
    if (lines.length === maxLines - 1) {
      while (line && context.measureText(`${line}…`).width > maxWidth) line = Array.from(line).slice(0, -1).join("");
      lines.push(`${line}…`);
      return lines;
    }
    lines.push(line.trim());
    line = characters[index].trimStart();
  }
  if (line) lines.push(line);
  return lines;
}

function makeQrArtwork(qr, { url, name, question }) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1480;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("呢個瀏覽器未能產生 QR 圖。請複製活動連結。");
  const fonts = '"PingFang TC", "Microsoft JhengHei", system-ui, sans-serif';
  context.fillStyle = "#f7f8f5";
  context.fillRect(0, 0, 1080, 1480);
  context.fillStyle = "#17283c";
  context.font = `800 43px ${fonts}`;
  context.fillText("WeVote", 80, 105);
  // A restrained pen stroke echoes the hand-drawn interface.
  context.strokeStyle = "#be8e78";
  context.lineWidth = 3;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(81, 124);
  context.bezierCurveTo(144, 120, 220, 126, 251, 120);
  context.stroke();
  context.fillStyle = "#537486";
  context.font = `600 23px ${fonts}`;
  context.fillText("活動投票 · EVENT VOTE", 80, 180);
  context.fillStyle = "#17283c";
  context.font = `700 52px ${fonts}`;
  wrappedText(context, name, 920, 3).forEach((line, index) => context.fillText(line, 80, 252 + index * 63));
  context.fillStyle = "#5f7380";
  context.font = `400 28px ${fonts}`;
  wrappedText(context, question, 920, 2).forEach((line, index) => context.fillText(line, 80, 431 + index * 39));

  const modules = qr.getModuleCount() + 8;
  const scale = Math.max(1, Math.floor(730 / modules));
  const qrCanvas = paintQr(document.createElement("canvas"), qr, scale);
  const qrLeft = Math.floor((1080 - qrCanvas.width) / 2);
  context.imageSmoothingEnabled = false;
  context.drawImage(qrCanvas, qrLeft, 520);
  context.textAlign = "center";
  context.fillStyle = "#214760";
  context.font = `700 34px ${fonts}`;
  context.fillText("掃碼參與投票", 540, 1310);
  context.fillStyle = "#5f7380";
  context.font = `400 23px ${fonts}`;
  wrappedText(context, url, 920, 2).forEach((line, index) => context.fillText(line, 540, 1360 + index * 30));
  context.strokeStyle = "#d6e0e2";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(80, 1414);
  context.lineTo(1000, 1414);
  context.stroke();
  context.font = `500 21px ${fonts}`;
  context.fillText("DAA.HK · Hillman Tam · Keith Li", 540, 1450);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("QR 圖未能產生，請再試。")), "image/png");
  });
}

/** Mount an event's public sharing tools. All QR generation stays in this browser. */
export function mountEventShare(container, { url, name = "WeVote 活動", question = "" }) {
  const root = element("section", "event-share");
  root.setAttribute("aria-label", "分享活動投票");
  const status = element("p", "event-share-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const timers = new Set();
  const objectUrls = new Set();
  let active = true;
  const destroy = () => {
    active = false;
    timers.forEach(clearTimeout);
    objectUrls.forEach((value) => URL.revokeObjectURL(value));
    root.remove();
  };
  const say = (message, failed = false) => {
    status.textContent = message;
    status.classList.toggle("is-error", failed);
  };
  let publicUrl;
  try {
    publicUrl = new URL(url, location.origin);
    if (!["https:", "http:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) throw new Error("Invalid public URL");
  } catch {
    say("活動連結無效，未能建立分享工具。", true);
    root.append(status);
    container.replaceChildren(root);
    return { destroy };
  }
  const details = { url: publicUrl.href, name: String(name || "WeVote 活動"), question: String(question || "") };
  const eventId = publicUrl.searchParams.get("event");
  const filename = `wevote-${/^[a-f0-9]{24}$/.test(eventId || "") ? eventId : "event"}-qr.png`;
  const qr = qrcode(0, "M");
  try {
    qr.addData(details.url);
    qr.make();
  } catch {
    say("活動連結過長，未能建立 QR 圖。請直接分享活動連結。", true);
    root.append(status);
    container.replaceChildren(root);
    return { destroy };
  }

  const overview = element("div", "event-share-overview");
  const figure = element("figure", "event-share-qr");
  const preview = document.createElement("canvas");
  preview.setAttribute("role", "img");
  preview.setAttribute("aria-label", `${details.name} 嘅投票 QR code`);
  try { paintQr(preview, qr); } catch (error) { say(error.message, true); }
  figure.append(preview, element("figcaption", "", "掃碼參與投票"));
  const info = element("div", "event-share-info");
  info.append(element("h4", "event-share-title", "分享活動"));
  const linkField = element("input", "event-share-url");
  linkField.type = "text";
  linkField.value = details.url;
  linkField.readOnly = true;
  linkField.setAttribute("aria-label", "公開活動投票連結");
  linkField.addEventListener("click", () => linkField.select());
  info.append(linkField);

  function button(label, action, prominent = false) {
    const node = element("button", `event-share-button${prominent ? " is-primary" : ""}`, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }

  async function copyLink() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(details.url);
      else {
        linkField.focus();
        linkField.select();
        if (!document.execCommand("copy")) throw new Error("Copy unavailable");
      }
      say("活動連結已複製，可以貼去訊息或社交平台。");
    } catch {
      linkField.focus();
      linkField.select();
      say("請複製上面已選取嘅活動連結；手機可長按連結欄。", true);
    }
  }

  async function shareLink() {
    if (!navigator.share) { await copyLink(); return; }
    try {
      await navigator.share({ title: details.name, text: details.question || details.name, url: details.url });
      say("已開啟系統分享。");
    } catch (error) {
      if (error.name === "AbortError") say("已取消分享。");
      else { await copyLink(); }
    }
  }

  const linkActions = element("div", "event-share-actions");
  linkActions.append(button("複製連結", copyLink), button("分享連結", shareLink, true));
  const socialActions = element("div", "event-share-actions event-share-social");
  for (const [label, href] of makeShareLinks(details.url, details.name, details.question)) {
    const anchor = element("a", "event-share-button", label);
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.setAttribute("aria-label", `分享到 ${label}（新視窗）`);
    socialActions.append(anchor);
  }
  info.append(linkActions, socialActions);
  overview.append(figure, info);

  let blobPromise;
  const getBlob = () => {
    if (!blobPromise) blobPromise = makeQrArtwork(qr, details).catch((error) => { blobPromise = null; throw error; });
    return blobPromise;
  };
  function downloadBlob(blob) {
    if (!active) return;
    const objectUrl = URL.createObjectURL(blob);
    objectUrls.add(objectUrl);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      objectUrls.delete(objectUrl);
      timers.delete(timer);
    }, 20_000);
    timers.add(timer);
  }
  const qrButtons = [];
  async function useQr(mode) {
    qrButtons.forEach((node) => { node.disabled = true; });
    say("正在準備 QR 圖…");
    try {
      const blob = await getBlob();
      if (!active) return;
      if (mode === "share") {
        try {
          const data = { files: [new File([blob], filename, { type: "image/png" })] };
          if (navigator.share && navigator.canShare?.(data)) {
            await navigator.share(data);
            say("已開啟 QR 圖分享。");
            return;
          }
        } catch (error) {
          if (error.name === "AbortError") { say("已取消分享。"); return; }
        }
        downloadBlob(blob);
        say("瀏覽器未能直接分享圖片，已下載 QR 圖；可以自行上載或傳送。");
      } else {
        downloadBlob(blob);
        say(mode === "instagram" ? "已下載 QR 圖。上載 IG Story／貼文；Story 可加入活動連結貼紙。" : "已下載 QR 圖，包含活動名稱及投票連結。");
      }
    } catch (error) {
      say(error.message || "未能產生 QR 圖，請複製活動連結。", true);
    } finally {
      qrButtons.forEach((node) => { node.disabled = false; });
    }
  }
  const qrActions = element("div", "event-share-actions event-share-downloads");
  qrButtons.push(button("下載 QR 圖", () => useQr("download")), button("分享 QR 圖", () => useQr("share")), button("IG／下載圖", () => useQr("instagram")));
  qrActions.append(...qrButtons);
  root.append(overview, qrActions, element("p", "event-share-instagram", "Instagram：下載 QR 圖，再上載 IG Story／貼文；Story 加活動連結。"), status);
  container.replaceChildren(root);
  return { destroy };
}
