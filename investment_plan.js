// Auto-confirms pending automatic investments on the legacy investment-plan
// page. This runs INSIDE the cross-origin app-legacy.bricks.co iframe that the
// app.bricks.co shell embeds — the main content_script.js cannot reach it.
//
// Safety: does nothing unless options.autoConfirmInvestmentPlan is explicitly
// enabled (off by default). Only clicks the "Confirmer" / "Confirmer N briques"
// button (anchored match, never a "Confirmer la suppression/le retrait/…"
// look-alike); a disabled button (e.g. one gated behind an unchecked terms box)
// is skipped, so the flow fails closed and the user finishes it manually.
//
// Content scripts can't import ES modules, so the few constants are inlined.
// Keep in sync with shared/constants.js.

const DEBUG = false;
function log(...args) {
  if (DEBUG) console.log("[BricksCheck/invest-plan]", ...args);
}

// Only act on the investment-plan route, never on other legacy pages.
if (location.pathname.includes("investment-plan")) {
  const CONFIRM_COOLDOWN_MS = 4000;
  const INITIAL_SCAN_WINDOW_MS = 15000;
  const INITIAL_SCAN_INTERVAL_MS = 1000;
  // Words that disqualify a button even if it starts with "confirmer" — skip
  // actions and, defensively, any destructive/withdrawal verbs.
  const SKIP_WORDS = [
    "passe", "tour", "annul", "refus", "plus tard", "modifier", "retour",
    "supprim", "suppress", "retrait", "virement", "désactiv", "résili"
  ];

  let lastConfirmAt = 0;

  async function isEnabled() {
    try {
      const { options } = await chrome.storage.sync.get("options");
      return Boolean(options && options.autoConfirmInvestmentPlan);
    } catch (error) {
      log("isEnabled failed:", error?.message || error);
      return false;
    }
  }

  function normalizedText(element) {
    return (element.innerText || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0;
  }

  function isDisabled(element) {
    if (element.disabled) return true;
    if (element.getAttribute("aria-disabled") === "true") return true;
    if (element.getAttribute("data-disabled") === "true") return true;
    if (element.getAttribute("data-state") === "disabled") return true;
    return false;
  }

  function clickElement(element) {
    try {
      element.scrollIntoView({ block: "center", inline: "center" });
    } catch {
      // ignore
    }
    element.click();
  }

  // Finds a visible, enabled "Confirmer" button. Returns null if none is safe
  // to click (none present, disabled, or it looks like a skip/cancel/destructive
  // action). The accepted text is anchored to the bare "Confirmer" or
  // "Confirmer <number>…" CTA, so look-alikes like "Confirmer la suppression"
  // are never matched.
  function findConfirmButton() {
    const candidates = document.querySelectorAll('button, [role="button"], a[role="button"]');
    for (const candidate of candidates) {
      if (!isVisible(candidate) || isDisabled(candidate)) continue;
      const text = normalizedText(candidate);
      if (SKIP_WORDS.some((word) => text.includes(word))) continue;
      if (text === "confirmer" || /^confirmer\s+\d/.test(text)) return candidate;
    }
    return null;
  }

  async function maybeAutoConfirm() {
    if (Date.now() - lastConfirmAt < CONFIRM_COOLDOWN_MS) return;
    if (!(await isEnabled())) return;

    const button = findConfirmButton();
    if (!button) return;

    lastConfirmAt = Date.now();
    const detail = normalizedText(button).slice(0, 60);
    log("auto-confirming pending investment:", detail);
    clickElement(button);

    chrome.runtime
      .sendMessage({ type: "INVESTMENT_PLAN_CONFIRMED", detail })
      .catch(() => {});
  }

  // The legacy app renders asynchronously, so poll for a short window on load…
  const startedAt = Date.now();
  const initialScan = setInterval(() => {
    if (Date.now() - startedAt > INITIAL_SCAN_WINDOW_MS) {
      clearInterval(initialScan);
      return;
    }
    maybeAutoConfirm();
  }, INITIAL_SCAN_INTERVAL_MS);

  // …and keep watching for SPA re-renders (e.g. the next pending card appearing
  // after one is confirmed). Debounced so React re-renders don't spam.
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      maybeAutoConfirm();
    }, 800);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener(
    "pagehide",
    () => {
      observer.disconnect();
      clearInterval(initialScan);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    },
    { once: true }
  );

  // First attempt right away in case the card is already rendered.
  maybeAutoConfirm();
}
