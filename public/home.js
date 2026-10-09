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
}
