const eventPattern = /^[a-f0-9]{24}$/;
const eventId = new URLSearchParams(location.search).get("event");
const fragment = new URLSearchParams(location.hash.slice(1));

// Preserve links issued before the home page and voting page were separated.
if ((eventId && eventPattern.test(eventId)) || fragment.has("ticket")) {
  location.replace(`/vote.html${location.search}${location.hash}`);
} else {
  const form = document.getElementById("join-form");
  const input = document.getElementById("event-input");
  const message = document.getElementById("join-message");

  function showError() {
    message.textContent = "請輸入完整活動連結，或者 24 位活動編號。";
    message.classList.add("is-error");
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }

  function parseEvent(value) {
    if (eventPattern.test(value)) return value;
    try {
      const url = new URL(value, location.origin);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      const id = url.searchParams.get("event");
      return id && eventPattern.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = parseEvent(input.value.trim());
    if (!id) return showError();
    location.assign(`/vote.html?event=${id}`);
  });

  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    message.classList.remove("is-error");
    message.textContent = "掃描活動 QR code，亦可以直接進入投票頁。";
  });

  if (eventId) {
    input.value = eventId;
    showError();
  }

  async function loadOrganizerProviders() {
    const status = document.getElementById("home-auth-message");
    try {
      const response = await fetch("/api/auth/providers", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Provider status unavailable");
      const providers = await response.json();
      const google = providers.google === true;
      const apple = providers.apple === true;
      document.getElementById("home-google-login").hidden = !google;
      document.getElementById("home-apple-login").hidden = !apple;
      document.getElementById("home-auth-providers").hidden = !google && !apple;
      status.textContent = google || apple ? "只需主辦方登入；投票者毋須註冊。" : "Google／Apple 登入尚未設定好，公開註冊暫未開放。管理員仍可用密鑰登入。";
    } catch {
      status.textContent = "暫時未能確認主辦方登入方式，請到管理員入口再試。";
    }
  }
  void loadOrganizerProviders();
}
