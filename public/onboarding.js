const seenTours = new Set();
let tourSequence = 0;

/**
 * A first-use tour whose steps are read from the current page when it starts.
 * Keys must be fixed UI contexts, never account IDs, credentials or user data.
 */
export function createOnboarding({ getSteps, storagePrefix = "wevote:onboarding:v1:" }) {
  if (typeof getSteps !== "function") throw new TypeError("getSteps must be a function");

  const id = `wevote-tour-${++tourSequence}`;
  const dialog = document.createElement("dialog");
  dialog.className = "onboarding-dialog";
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-body`);
  const highlight = document.createElement("div");
  highlight.className = "onboarding-highlight";
  highlight.setAttribute("aria-hidden", "true");
  highlight.hidden = true;
  const card = document.createElement("div");
  card.className = "onboarding-card";
  const header = document.createElement("div");
  header.className = "onboarding-header";
  const progress = document.createElement("p");
  progress.className = "onboarding-progress";
  progress.setAttribute("role", "status");
  progress.setAttribute("aria-live", "polite");
  progress.setAttribute("aria-atomic", "true");
  const close = makeButton("跳過導覽", "onboarding-skip");
  header.append(progress, close);
  const title = document.createElement("h2");
  title.id = `${id}-title`;
  title.className = "onboarding-title";
  title.tabIndex = -1;
  const body = document.createElement("p");
  body.id = `${id}-body`;
  body.className = "onboarding-body";
  const footer = document.createElement("div");
  footer.className = "onboarding-actions";
  const previous = makeButton("上一步", "onboarding-previous");
  const next = makeButton("下一步", "onboarding-next");
  footer.append(previous, next);
  card.append(header, title, body, footer);
  dialog.append(highlight, card);

  let active = false;
  let steps = [];
  let stepIndex = 0;
  let activeStorageKey = "";
  let priorFocus = null;
  let priorScroll = null;
  let animationFrame = null;
  let fallbackBackdrop = null;

  close.addEventListener("click", () => dismiss({ remember: true }));
  previous.addEventListener("click", () => showStep(stepIndex - 1));
  next.addEventListener("click", () => {
    if (stepIndex === steps.length - 1) dismiss({ remember: true });
    else showStep(stepIndex + 1);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss({ remember: true });
  });
  dialog.addEventListener("close", () => {
    // A previous close event can be queued while a new context already starts.
    if (active && !dialog.open) dismiss({ remember: true });
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss({ remember: true });
    } else if (event.key === "Tab") {
      const controls = [close, previous, next].filter((control) => !control.hidden && !control.disabled);
      const index = controls.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) {
        event.preventDefault();
        controls[0]?.focus();
      }
    }
  });

  function makeButton(text, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    return button;
  }

  function visibleTarget(target) {
    if (!target || target.nodeType !== 1 || !target.isConnected || target.ownerDocument !== document) return false;
    if (target.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (!target.getClientRects().length) return false;
    for (let element = target; element; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hasSeen(key) {
    if (seenTours.has(key)) return true;
    try { return window.localStorage.getItem(key) === "seen"; } catch { return false; }
  }

  function remember() {
    if (!activeStorageKey) return;
    seenTours.add(activeStorageKey);
    try { window.localStorage.setItem(activeStorageKey, "seen"); } catch { /* Tour state is optional. */ }
  }

  function schedulePosition() {
    if (!active || animationFrame !== null) return;
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = null;
      if (active) position();
    });
  }

  function position() {
    const viewport = window.visualViewport;
    const bounds = {
      left: viewport?.offsetLeft || 0,
      top: viewport?.offsetTop || 0,
      width: viewport?.width || window.innerWidth,
      height: viewport?.height || window.innerHeight,
    };
    const margin = Math.min(16, bounds.width / 20);
    const right = bounds.left + bounds.width;
    const bottom = bounds.top + bounds.height;
    dialog.style.width = `${Math.max(0, Math.min(390, bounds.width - margin * 2))}px`;
    card.style.maxHeight = `${Math.max(0, bounds.height - margin * 2)}px`;
    const target = steps[stepIndex]?.target;
    const anchored = visibleTarget(target);
    const rect = anchored ? target.getBoundingClientRect() : null;
    highlight.hidden = !anchored;
    if (rect) {
      const left = Math.max(bounds.left + 4, rect.left - 5);
      const top = Math.max(bounds.top + 4, rect.top - 5);
      const clippedRight = Math.min(right - 4, rect.right + 5);
      const clippedBottom = Math.min(bottom - 4, rect.bottom + 5);
      highlight.style.left = `${left}px`;
      highlight.style.top = `${top}px`;
      highlight.style.width = `${Math.max(0, clippedRight - left)}px`;
      highlight.style.height = `${Math.max(0, clippedBottom - top)}px`;
      highlight.hidden = clippedRight <= left || clippedBottom <= top;
    }

    const width = dialog.getBoundingClientRect().width;
    const height = card.getBoundingClientRect().height;
    let left = bounds.left + (bounds.width - width) / 2;
    let top = bounds.top + (bounds.height - height) / 2;
    let placement = "center";
    if (rect) {
      const gap = 18;
      if (bounds.width >= 610 && rect.right + gap + width <= right - margin) {
        left = rect.right + gap;
        top = rect.top;
        placement = "right";
      } else if (bounds.width >= 610 && rect.left - gap - width >= bounds.left + margin) {
        left = rect.left - gap - width;
        top = rect.top;
        placement = "left";
      } else if (rect.bottom + gap + height <= bottom - margin) {
        left = rect.left + (rect.width - width) / 2;
        top = rect.bottom + gap;
        placement = "below";
      } else if (rect.top - gap - height >= bounds.top + margin) {
        left = rect.left + (rect.width - width) / 2;
        top = rect.top - gap - height;
        placement = "above";
      } else {
        // A large section may fill the viewport; keep its outline visible and
        // place the explanation where every control remains reachable.
        top = bottom - margin - height;
        placement = "center";
      }
    }
    dialog.dataset.placement = placement;
    dialog.style.left = `${Math.max(bounds.left + margin, Math.min(left, right - width - margin))}px`;
    dialog.style.top = `${Math.max(bounds.top + margin, Math.min(top, bottom - height - margin))}px`;
  }

  function showStep(index) {
    if (!active || index < 0 || index >= steps.length) return;
    stepIndex = index;
    const step = steps[index];
    progress.textContent = `快速導覽 · ${index + 1} / ${steps.length}`;
    title.textContent = step.title;
    body.textContent = step.body;
    previous.hidden = index === 0;
    next.textContent = index === steps.length - 1 ? "開始使用" : "下一步";
    close.textContent = index === steps.length - 1 ? "關閉導覽" : "跳過導覽";
    if (visibleTarget(step.target)) {
      step.target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    }
    position();
    title.focus({ preventScroll: true });
    schedulePosition();
  }

  function containFallbackFocus(event) {
    if (active && fallbackBackdrop && !dialog.contains(event.target)) title.focus({ preventScroll: true });
  }

  function start({ key, automatic = false } = {}) {
    if (active || typeof key !== "string" || !/^[a-z0-9._-]{1,80}$/i.test(key)) return false;
    const storageKey = `${storagePrefix}${key}`;
    if (automatic && hasSeen(storageKey)) return false;
    let requestedSteps;
    try { requestedSteps = getSteps(); } catch { return false; }
    if (!Array.isArray(requestedSteps)) return false;
    const validSteps = requestedSteps.filter((step) => step && typeof step.title === "string" && typeof step.body === "string");
    steps = validSteps.filter((step) => step.target == null || visibleTarget(step.target));
    if (!steps.length && validSteps.length) steps = [{ ...validSteps[0], target: null }];
    if (!steps.length) return false;

    activeStorageKey = storageKey;
    priorFocus = document.activeElement;
    priorScroll = { left: window.scrollX, top: window.scrollY };
    document.body.append(dialog);
    active = true;
    if (typeof dialog.showModal === "function") {
      try { dialog.showModal(); } catch {
        active = false;
        dialog.remove();
        return false;
      }
    } else {
      fallbackBackdrop = document.createElement("div");
      fallbackBackdrop.className = "onboarding-fallback-backdrop";
      fallbackBackdrop.setAttribute("aria-hidden", "true");
      document.body.insertBefore(fallbackBackdrop, dialog);
      dialog.classList.add("onboarding-fallback");
      dialog.setAttribute("open", "");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      document.addEventListener("focusin", containFallbackFocus, true);
    }
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
    window.visualViewport?.addEventListener("resize", schedulePosition);
    window.visualViewport?.addEventListener("scroll", schedulePosition);
    showStep(0);
    return true;
  }

  function dismiss({ remember: shouldRemember = false } = {}) {
    if (!active) return;
    if (shouldRemember) remember();
    active = false;
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    animationFrame = null;
    window.removeEventListener("resize", schedulePosition);
    window.removeEventListener("scroll", schedulePosition, true);
    window.visualViewport?.removeEventListener("resize", schedulePosition);
    window.visualViewport?.removeEventListener("scroll", schedulePosition);
    document.removeEventListener("focusin", containFallbackFocus, true);
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    dialog.removeAttribute("open");
    dialog.remove();
    fallbackBackdrop?.remove();
    fallbackBackdrop = null;
    highlight.hidden = true;
    if (priorScroll) window.scrollTo({ ...priorScroll, behavior: "instant" });
    if (visibleTarget(priorFocus) && typeof priorFocus.focus === "function") priorFocus.focus({ preventScroll: true });
    priorFocus = null;
    priorScroll = null;
    steps = [];
    activeStorageKey = "";
  }

  return { start, dismiss, isOpen: () => active };
}
