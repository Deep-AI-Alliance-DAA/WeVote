const eventThemes = new Set(["ink", "ocean", "forest", "terracotta"]);
const renderedPresentation = new WeakMap();

/** Render approved event branding without accepting HTML or arbitrary CSS. */
export function applyEventPresentation(container, presentation = {}, eventName = "") {
  const config = presentation && typeof presentation === "object" ? presentation : {};
  const theme = eventThemes.has(config.theme) ? config.theme : "ink";
  document.body.dataset.theme = theme;
  if (!container) return;

  const organizer = typeof config.organizer === "string" ? config.organizer.slice(0, 100) : "";
  const description = typeof config.description === "string" ? config.description.slice(0, 1000) : "";
  let logoUrl = "";
  if (typeof config.logoUrl === "string" && config.logoUrl) {
    try {
      const parsed = new URL(config.logoUrl);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) logoUrl = parsed.href;
    } catch { /* An invalid logo does not prevent voting or results. */ }
  }
  const signature = JSON.stringify([theme, organizer, description, logoUrl, eventName]);
  if (renderedPresentation.get(container) === signature) return;
  renderedPresentation.set(container, signature);
  container.replaceChildren();
  container.hidden = !organizer && !description && !logoUrl;
  if (container.hidden) return;

  if (logoUrl) {
    const image = document.createElement("img");
    image.className = "event-presentation-logo";
    image.width = 72;
    image.height = 72;
    image.alt = organizer || (eventName ? `${eventName} 標誌` : "活動標誌");
    image.referrerPolicy = "no-referrer";
    image.decoding = "async";
    image.addEventListener("error", () => {
      image.hidden = true;
      if (!organizer && !description) container.hidden = true;
    }, { once: true });
    image.src = logoUrl;
    container.append(image);
  }
  if (organizer || description) {
    const copy = document.createElement("div");
    copy.className = "event-presentation-copy";
    if (organizer) {
      const label = document.createElement("p");
      label.className = "event-organizer-label";
      label.textContent = "主辦單位";
      const value = document.createElement("p");
      value.className = "event-organizer";
      value.textContent = organizer;
      copy.append(label, value);
    }
    if (description) {
      const text = document.createElement("p");
      text.className = "event-description";
      text.textContent = description;
      copy.append(text);
    }
    container.append(copy);
  }
}
