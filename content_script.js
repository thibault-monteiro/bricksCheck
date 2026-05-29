// Forward auth token from api_bridge (MAIN world) to service worker AND
// execute auto-invest flow when a pendingInvestIntent matches the current page.
//
// Content scripts can't import ES modules, so APP_ORIGIN is duplicated here.
// Keep in sync with shared/constants.js → APP_ORIGIN and manifest matches.
const APP_ORIGIN = "https://app.bricks.co";
const PENDING_INVEST_INTENT_KEY = "pendingInvestIntent";
const PENDING_INVEST_INTENT_TTL_MS = 2 * 60 * 1000;
const AUTO_INVEST_FLOW_TIMEOUT_MS = 15000;
const PROJECT_WATCH_SESSION_KEY = "projectWatchSession";

// Set to true to log each step of the auto-invest flow to the page console.
// Useful while the heuristics are stabilising; safe to flip off in prod.
const DEBUG = false;
function log(...args) {
  if (DEBUG) console.log("[BricksCheck]", ...args);
}

// --- Token relay -----------------------------------------------------------

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  if (event.origin !== APP_ORIGIN) {
    return;
  }

  const data = event.data || {};
  if (data.source !== "BRICKS_CHECK_PAGE" || data.type !== "BRICKS_AUTH_TOKEN" || !data.token) {
    return;
  }

  chrome.runtime.sendMessage({ type: "BRICKS_AUTH_TOKEN", token: data.token }).catch(() => {});
});

// --- Auto-invest flow ------------------------------------------------------

(async () => {
  try {
    const intent = await readPendingIntent();
    if (intent) {
      if (!matchesCurrentProject(intent.projectId)) {
        log("intent does not match current project", intent.projectId, "vs", location.pathname);
      } else if (intent.amountEuros <= 0) {
        log("intent has zero amount, clearing");
        await clearPendingIntent();
      } else {
        log("intent matches, starting auto-invest", intent);
        // Consume the intent immediately so we never replay it.
        await clearPendingIntent();
        await runAutoInvest(intent);
        return;
      }
    }

    await startProjectWatchFromStorage();
  } catch (error) {
    console.warn("[BricksCheck] auto-invest failed:", error?.message || error);
  }
})();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PROJECT_WATCH_SESSION_UPDATED") {
    startProjectWatch(message.session)
      .then((started) => sendResponse({ ok: true, started }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PROJECT_WATCH_STOPPED") {
    stopProjectWatchWatcher();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function readPendingIntent() {
  const { [PENDING_INVEST_INTENT_KEY]: intent } = await chrome.storage.local.get(PENDING_INVEST_INTENT_KEY);
  if (!intent || typeof intent !== "object") {
    return null;
  }
  if (Date.now() - Number(intent.createdAt || 0) > PENDING_INVEST_INTENT_TTL_MS) {
    log("intent expired, clearing");
    await clearPendingIntent();
    return null;
  }
  return intent;
}

async function clearPendingIntent() {
  await chrome.storage.local.remove(PENDING_INVEST_INTENT_KEY);
}

let projectWatchState = null;

async function startProjectWatchFromStorage() {
  const { [PROJECT_WATCH_SESSION_KEY]: session } = await chrome.storage.local.get(PROJECT_WATCH_SESSION_KEY);
  await startProjectWatch(session);
}

async function startProjectWatch(session) {
  if (!isUsableProjectWatchSession(session)) {
    stopProjectWatchWatcher();
    return false;
  }

  if (!matchesCurrentProject(session.projectId)) {
    log("project watch does not match current page", session.projectId, "vs", location.pathname);
    stopProjectWatchWatcher();
    return false;
  }

  stopProjectWatchWatcher();
  projectWatchState = {
    session,
    stopped: false,
    attemptInFlight: false,
    observer: null,
    intervalId: null
  };

  attachProjectWatchObservers(projectWatchState);
  window.addEventListener("pagehide", stopProjectWatchWatcher, { once: true });

  showWatchIndicator(session);
  log("project watch armed", session);
  void attemptProjectWatchBuy();
  return true;
}

function attachProjectWatchObservers(state) {
  const attempt = () => {
    void attemptProjectWatchBuy();
  };
  state.observer = new MutationObserver(attempt);
  state.observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ["aria-disabled", "class", "disabled", "style"]
  });
  state.intervalId = setInterval(attempt, 250);
}

function detachProjectWatchObservers(state) {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
}

function isUsableProjectWatchSession(session) {
  if (!session || typeof session !== "object") {
    return false;
  }
  if (!session.active) {
    return false;
  }
  if (Number(session.expiresAt || 0) <= Date.now()) {
    return false;
  }
  return Number(session.amountEuros || 0) > 0 && Number(session.bricksToInvest || 0) > 0;
}

async function attemptProjectWatchBuy() {
  const state = projectWatchState;
  if (!state || state.stopped || state.attemptInFlight) {
    return;
  }
  if (!isUsableProjectWatchSession(state.session) || !matchesCurrentProject(state.session.projectId)) {
    stopProjectWatchWatcher();
    return;
  }

  const investNowButton = findEnabledInvestNowButton();
  if (!investNowButton) {
    return;
  }

  state.attemptInFlight = true;
  // Pause the watchers during the buy flow (avoid re-entrancy) but keep the
  // session + on-page indicator alive so we can re-arm afterwards.
  detachProjectWatchObservers(state);
  log("project watch detected enabled invest button", investNowButton);

  try {
    await chrome.runtime.sendMessage({
      type: "PROJECT_WATCH_BUY_STARTED",
      projectId: state.session.projectId
    });
  } catch (error) {
    log("PROJECT_WATCH_BUY_STARTED failed:", error?.message || error);
  }

  await runAutoInvest(state.session);

  try {
    await chrome.runtime.sendMessage({
      type: "PROJECT_WATCH_BUY_ATTEMPTED",
      projectId: state.session.projectId,
      autopilot: Boolean(state.session.autopilot)
    });
  } catch (error) {
    log("PROJECT_WATCH_BUY_ATTEMPTED failed:", error?.message || error);
  }

  // Autopilot completes the purchase on its own, so we re-arm to grab another
  // brick if one frees up later. Semi-auto leaves the final click to the user,
  // so we stop (re-arming would fight the user's own modal interaction).
  if (state.session.autopilot) {
    await rearmAfterBuy();
  } else {
    stopProjectWatchWatcher();
  }
}

/**
 * After an autopilot purchase, wait for the buy opportunity to close (the
 * "Investir" button no longer clickable) and then re-arm the watch, so the
 * user gets at most one grab per availability window without ever re-clicking
 * "Armer". Bails if the watch was stopped or expired meanwhile.
 */
async function rearmAfterBuy() {
  // 1) Wait for the current availability window to close.
  if (!(await waitForInvestButtonIdle())) return;

  // 2) Ask the SW to re-activate the session for the next window.
  let freshSession = null;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "PROJECT_WATCH_REARMED",
      projectId: projectWatchState.session.projectId
    });
    freshSession = response?.session || null;
  } catch (error) {
    log("PROJECT_WATCH_REARMED failed:", error?.message || error);
  }

  if (!projectWatchState || projectWatchState.stopped) {
    return;
  }

  // 3) The REARM round-trip is async; the button may have re-enabled meanwhile.
  // Re-confirm the window is closed so re-arming never instantly re-buys the
  // same window — the next grab must come from a fresh enable edge seen by the
  // observer, not from whatever state the button happens to be in right now.
  if (!(await waitForInvestButtonIdle())) return;

  await startProjectWatch(freshSession || { ...projectWatchState.session, active: true });
}

// Resolves true once the "Investir" button is no longer clickable (the buy
// window has closed) so the watch can safely re-arm; resolves false if the
// watch was torn down or the session expired while waiting.
async function waitForInvestButtonIdle() {
  while (true) {
    if (!projectWatchState || projectWatchState.stopped) return false;
    if (!isUsableProjectWatchSession(projectWatchState.session)) return false;
    if (!findEnabledInvestNowButton()) return true;
    await wait(500);
  }
}

function stopProjectWatchWatcher() {
  hideWatchIndicator();

  const state = projectWatchState;
  if (!state) {
    return;
  }

  state.stopped = true;
  if (state.observer) {
    state.observer.disconnect();
  }
  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
  }
  projectWatchState = null;
}

const WATCH_BADGE_ID = "bricks-check-watch-badge";
const WATCH_TITLE_PREFIX = "🟢 ";
let watchTitleObserver = null;

// Visual cue, in the watched tab, that the project watch is armed: a floating
// pill in the page + a 🟢 prefix in the tab title (so the tab is spottable in
// the tab strip without switching to it). Both are removed when the watch
// stops, fires, or expires.
function showWatchIndicator(session) {
  if (!document.getElementById(WATCH_BADGE_ID)) {
    const badge = document.createElement("div");
    badge.id = WATCH_BADGE_ID;
    badge.textContent = `🟢 Bricks Check · vigie armée${session?.projectName ? ` · ${session.projectName}` : ""}`;
    badge.style.cssText = [
      "position:fixed !important",
      "bottom:16px !important",
      "right:16px !important",
      "z-index:2147483647 !important",
      "display:block !important",
      "background:#0f6b4f !important",
      "color:#fff !important",
      "font:600 13px/1.3 system-ui,-apple-system,sans-serif !important",
      "padding:8px 14px !important",
      "border-radius:9999px !important",
      "box-shadow:0 2px 10px rgba(0,0,0,.35) !important",
      "pointer-events:none !important",
      "user-select:none !important",
      "max-width:60vw !important",
      "white-space:nowrap !important",
      "overflow:hidden !important",
      "text-overflow:ellipsis !important"
    ].join(";");
    (document.body || document.documentElement).appendChild(badge);
  }

  applyWatchTitlePrefix();
  if (!watchTitleObserver) {
    const titleEl = document.querySelector("title");
    if (titleEl) {
      watchTitleObserver = new MutationObserver(applyWatchTitlePrefix);
      watchTitleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  }
}

function applyWatchTitlePrefix() {
  if (!document.title.startsWith(WATCH_TITLE_PREFIX)) {
    document.title = WATCH_TITLE_PREFIX + document.title;
  }
}

function hideWatchIndicator() {
  const badge = document.getElementById(WATCH_BADGE_ID);
  if (badge) {
    badge.remove();
  }
  if (watchTitleObserver) {
    watchTitleObserver.disconnect();
    watchTitleObserver = null;
  }
  if (document.title.startsWith(WATCH_TITLE_PREFIX)) {
    document.title = document.title.slice(WATCH_TITLE_PREFIX.length);
  }
}

function matchesCurrentProject(projectId) {
  if (!projectId) return false;
  const match = location.pathname.match(/^\/project\/([^/]+)/);
  return match ? match[1] === projectId : false;
}

async function runAutoInvest(intent) {
  const deadline = Date.now() + AUTO_INVEST_FLOW_TIMEOUT_MS;

  // Step 1: click "Investir maintenant" (the big page-level button).
  log("step 1: looking for 'Investir maintenant' button");
  const investNowButton = await waitForElement(findEnabledInvestNowButton, { until: deadline });
  if (!investNowButton) {
    log("step 1 FAILED: button not found");
    return;
  }
  log("step 1 OK, clicking", investNowButton);
  clickElement(investNowButton);

  // Step 2: wait for the modal, then its input.
  log("step 2: waiting for invest modal");
  const modal = await waitForElement(findInvestModal, { until: deadline });
  if (!modal) {
    log("step 2 FAILED: modal not found");
    return;
  }
  log("step 2 OK, modal found", modal);

  log("step 3: waiting for amount input inside modal");
  const input = await waitForElement(() => findInvestModalInput(modal), { until: deadline });
  if (!input) {
    log("step 3 FAILED: input not found inside modal");
    return;
  }
  log("step 3 OK, input found", input);

  // Step 4: fill the amount in euros.
  log("step 4: filling input with", intent.amountEuros);
  const filled = setInputValueRobust(input, String(intent.amountEuros));
  log("step 4 result: filled=", filled, "current value=", input.value);

  // Step 5: click "Continuer" in the modal. Give the framework a tick to
  // re-render and enable the button after the input event.
  await wait(200);
  log("step 5: looking for 'Continuer' button");
  const continueButton = await waitForElement(() => findContinueButton(modal), { until: deadline });
  if (!continueButton) {
    log("step 5 FAILED: button not found");
    return;
  }
  if (continueButton.disabled) {
    log("step 5: button still disabled, waiting extra 300ms");
    await wait(300);
    if (continueButton.disabled) {
      log("step 5 FAILED: button still disabled after wait");
      return;
    }
  }
  log("step 5 OK, clicking 'Continuer'", continueButton);
  clickElement(continueButton);

  // Step 6: tick the terms-of-service / acknowledgement checkbox on the
  // confirmation view. Best-effort — if there isn't one within 5s, we stop
  // silently. We never click the final "Investir" button unless autopilot
  // is on.
  log("step 6: waiting for terms / acknowledgement checkbox");
  const stepDeadline = Math.min(deadline, Date.now() + 5000);
  const termsCheckbox = await waitForElement(findTermsCheckbox, { until: stepDeadline });
  if (!termsCheckbox) {
    log("step 6: no terms checkbox found within 5s (none needed?)");
    dumpCheckboxCandidates();
    return;
  }
  if (!isChecked(termsCheckbox)) {
    log("step 6 OK, ticking checkbox", termsCheckbox);
    const ok = tickCheckbox(termsCheckbox);
    log("step 6 result: isChecked=", isChecked(termsCheckbox), "tickCheckbox returned=", ok);
  } else {
    log("step 6: checkbox already checked");
  }

  // Step 7: autopilot only — click the now-enabled "Investir X €" button.
  // We give React a moment to flip aria-disabled off, then poll for an
  // enabled button matching the amount label.
  if (!intent.autopilot) {
    return;
  }
  log("step 7: autopilot — waiting for final 'Investir X €' button to enable");
  await wait(300);
  const investDeadline = Math.min(deadline, Date.now() + 5000);
  const finalInvestButton = await waitForElement(() => findFinalInvestButton(modal), { until: investDeadline });
  if (!finalInvestButton) {
    log("step 7 FAILED: final invest button never became clickable");
    return;
  }
  log("step 7 OK, clicking final 'Investir' button", finalInvestButton);
  clickElement(finalInvestButton);

  // Step 8: close the success / confirmation popup so the page returns to the
  // project view, leaving the watch free to re-arm and grab another brick.
  await wait(600);
  await closeConfirmationPopup(Date.now() + 5000);
}

/**
 * Best-effort close of the post-purchase confirmation popup: click a close /
 * dismiss control if we can find one, then press Escape as a fallback for
 * dialog libraries that close on Escape.
 */
async function closeConfirmationPopup(until) {
  const closeButton = await waitForElement(findCloseButton, { until });
  if (closeButton) {
    log("step 8: closing confirmation popup", closeButton);
    clickElement(closeButton);
    await wait(300);
  } else {
    log("step 8: no close button found, falling back to Escape");
  }
  if (findVisibleDialog()) {
    pressEscape();
  }
}

const CLOSE_LABEL_KEYWORDS = ["fermer", "close", "terminer", "c'est noté", "cest note"];

function findVisibleDialog() {
  const dialogs = document.querySelectorAll("[role='dialog'], dialog, [aria-modal='true']");
  for (const dialog of dialogs) {
    if (isVisible(dialog)) return dialog;
  }
  return null;
}

function findCloseButton() {
  const dialog = findVisibleDialog();
  const root = dialog || document;
  const buttons = root.querySelectorAll("button, [role='button'], [aria-label]");
  for (const button of buttons) {
    if (!isVisible(button) || isDisabled(button)) continue;
    const label = (button.getAttribute("aria-label") || "").toLowerCase();
    const text = normalizedText(button);
    if (CLOSE_LABEL_KEYWORDS.some((kw) => label.includes(kw) || text === kw)) {
      return button;
    }
    if (text === "×" || text === "✕" || label.includes("×")) {
      return button;
    }
  }
  return null;
}

function pressEscape() {
  const targets = [document.activeElement, document.body, document];
  for (const target of targets) {
    if (!target) continue;
    const init = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }
}

/**
 * Finds the final "Investir X €" submit button inside the modal,
 * provided it is enabled. Used only in autopilot mode. The regex
 * deliberately requires a digit after "Investir " so we don't pick
 * up the page-level "Investir maintenant" button or the "Continuer"
 * label.
 */
function findFinalInvestButton(modal) {
  const root = modal || document;
  const buttons = root.querySelectorAll("button, [role='button']");
  for (const button of buttons) {
    if (!isVisible(button)) continue;
    if (button.disabled || button.getAttribute("aria-disabled") === "true") continue;
    const text = normalizedText(button);
    if (/^investir\s+\d/.test(text)) {
      return button;
    }
  }
  return null;
}

/**
 * Logs every element in the DOM that looks remotely like a checkbox so
 * we can see, in the real Bricks page, what wrapper they actually use.
 * Helps debug "no terms checkbox found" without round-tripping with the
 * user every time.
 */
function dumpCheckboxCandidates() {
  const candidates = document.querySelectorAll(
    "input[type='checkbox'], [role='checkbox'], [aria-checked], [data-state='checked'], [data-state='unchecked']"
  );
  log("DEBUG: checkbox-like candidates in DOM:", candidates.length);
  candidates.forEach((el, i) => {
    const row = el.closest("[role='dialog'], section, form, div");
    const snippet = (row?.textContent || "").replace(/\s+/g, " ").slice(0, 120);
    log(`  [${i}] tag=${el.tagName} role=${el.getAttribute("role")} aria-checked=${el.getAttribute("aria-checked")} data-state=${el.getAttribute("data-state")} visible=${isVisible(el)} nearbyText="${snippet}"`, el);
  });
}

// --- DOM helpers -----------------------------------------------------------

function findInvestNowButton() {
  const buttons = document.querySelectorAll("button, [role='button'], a");
  for (const button of buttons) {
    if (isVisible(button) && normalizedText(button) === "investir maintenant") {
      return button;
    }
  }
  return null;
}

function findEnabledInvestNowButton() {
  const button = findInvestNowButton();
  return button && !isDisabled(button) ? button : null;
}

function isDisabled(element) {
  if (!element) return true;
  if (element.disabled === true) return true;
  if (element.getAttribute("aria-disabled") === "true") return true;
  const className = typeof element.className === "string" ? element.className.toLowerCase() : "";
  return className.includes("disabled");
}

/**
 * Returns the visible Bricks invest dialog, identified by:
 *   - role=dialog / aria-modal=true, OR
 *   - fallback: a smallish element containing both "Investir" and "Continuer".
 */
function findInvestModal() {
  const dialogs = document.querySelectorAll("[role='dialog'], dialog, [aria-modal='true']");
  for (const dialog of dialogs) {
    if (!isVisible(dialog)) continue;
    const text = (dialog.textContent || "").toLowerCase();
    if (text.includes("investir") && text.includes("continuer")) {
      return dialog;
    }
  }

  // Fallback: any visible element under 1000 chars containing both labels.
  const all = document.querySelectorAll("body *");
  let best = null;
  let bestLen = Infinity;
  for (const el of all) {
    if (!isVisible(el)) continue;
    const text = (el.textContent || "");
    const lower = text.toLowerCase();
    if (!lower.includes("investir") || !lower.includes("continuer")) continue;
    if (text.length < bestLen && text.length < 1000) {
      best = el;
      bestLen = text.length;
    }
  }
  return best;
}

/**
 * Within an invest modal, returns the primary amount input — the first
 * visible non-checkbox/radio/hidden input. The "Utiliser mon solde Bricks"
 * toggle is a checkbox, so it's skipped naturally.
 */
function findInvestModalInput(modal) {
  if (!modal) return null;
  const inputs = modal.querySelectorAll("input");
  for (const input of inputs) {
    if (!isVisible(input)) continue;
    const type = (input.getAttribute("type") || "text").toLowerCase();
    if (["checkbox", "radio", "submit", "button", "hidden", "file"].includes(type)) continue;
    return input;
  }
  return null;
}

// Keywords identifying the terms / acknowledgement row.
const TERMS_KEYWORDS = [
  "en cochant", "condition", "cgv", "accepte", "règles", "regles",
  "lu et", "pris connaissance", "j'accepte", "jaccepte"
];

/**
 * True if an element looks checked, across the various conventions used
 * by React Native Web, Radix, and plain HTML inputs.
 */
function isChecked(el) {
  if (!el) return false;
  if (el.checked === true) return true;
  const aria = el.getAttribute && el.getAttribute("aria-checked");
  if (aria === "true") return true;
  const dataState = el.getAttribute && el.getAttribute("data-state");
  if (dataState === "checked") return true;
  return false;
}

/**
 * Finds the terms-of-service / acknowledgement checkbox. Tries, in order:
 *
 *   A. Strict checkbox semantics — <input type=checkbox>, [role=checkbox],
 *      [aria-checked], [data-state] — whose surrounding text matches a
 *      terms keyword.
 *   B. React Native Web Pressable — a [tabindex="0"] row whose own text
 *      starts with "En cochant" / similar. Bricks uses this pattern: no
 *      role, no aria-checked, the visual box is a sibling <div>, and the
 *      "checked" state lives entirely in React state. We can still click
 *      the row; we just can't verify the checked-state afterwards.
 */
function findTermsCheckbox() {
  // Path A: strict checkbox semantics.
  const strictSelector = "input[type='checkbox'], [role='checkbox'], [aria-checked], [data-state='unchecked'], [data-state='checked']";
  const strict = document.querySelectorAll(strictSelector);
  for (const checkbox of strict) {
    if (isChecked(checkbox)) continue;
    if (ancestorTextMatchesTerms(checkbox)) return checkbox;
  }

  // Path B: RN Web Pressable row.
  const pressables = document.querySelectorAll("[tabindex='0']");
  for (const press of pressables) {
    if (!isVisible(press)) continue;
    const text = (press.textContent || "").toLowerCase();
    if (text.length > 300) continue; // row, not the whole modal
    if (!TERMS_KEYWORDS.some((kw) => text.includes(kw))) continue;
    return press;
  }

  return null;
}

function ancestorTextMatchesTerms(el) {
  let ancestor = el.parentElement;
  let hasVisibleAncestor = false;
  for (let depth = 0; depth < 8 && ancestor; depth += 1) {
    if (!hasVisibleAncestor && isVisible(ancestor)) hasVisibleAncestor = true;
    const text = (ancestor.textContent || "").toLowerCase();
    if (hasVisibleAncestor && TERMS_KEYWORDS.some((kw) => text.includes(kw))) {
      return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

/**
 * True if `el` has any explicit "checkbox" semantics we can read back to
 * verify the toggle worked. False for RN Web Pressables which expose no
 * checked-state to the DOM.
 */
function hasReadableCheckedState(el) {
  if (el instanceof HTMLInputElement && el.type === "checkbox") return true;
  const role = el.getAttribute && el.getAttribute("role");
  if (role === "checkbox") return true;
  if (el.hasAttribute && (el.hasAttribute("aria-checked") || el.hasAttribute("data-state"))) return true;
  return false;
}

/**
 * Ticks a checkbox or terms-row Pressable.
 *
 * For RN Web Pressables (no readable checked-state), we click once and
 * trust. Clicking twice would untoggle.
 *
 * For semantic checkboxes (input / role=checkbox / aria-checked), we try
 * multiple strategies and stop as soon as `isChecked` becomes true:
 *   1. associated <label>
 *   2. direct click (works for role=checkbox button)
 *   3. closest visible ancestor (the styled wrapper)
 *   4. native setter on `.checked` for real <input>
 */
function tickCheckbox(checkbox) {
  if (isChecked(checkbox)) return true;

  if (!hasReadableCheckedState(checkbox)) {
    log("tickCheckbox: pressable (no checked-state to read), single click", checkbox);
    clickElement(checkbox);
    return true;
  }

  // 1. Associated label.
  const id = checkbox.id;
  let label = null;
  if (id) {
    label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
  }
  if (!label && typeof checkbox.closest === "function") {
    label = checkbox.closest("label");
  }
  if (label && isVisible(label)) {
    log("tickCheckbox: clicking label", label);
    clickElement(label);
    if (isChecked(checkbox)) return true;
  }

  // 2. Direct click.
  log("tickCheckbox: clicking element directly", checkbox);
  clickElement(checkbox);
  if (isChecked(checkbox)) return true;

  // 3. Visible ancestor / row wrapper.
  let ancestor = checkbox.parentElement;
  for (let depth = 0; depth < 5 && ancestor; depth += 1) {
    if (isVisible(ancestor) && ancestor !== label) {
      log("tickCheckbox: clicking visible ancestor", ancestor);
      clickElement(ancestor);
      if (isChecked(checkbox)) return true;
      break;
    }
    ancestor = ancestor.parentElement;
  }

  // 4. Real <input>: force `.checked = true` via the native setter.
  if (checkbox instanceof HTMLInputElement) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      if (descriptor && descriptor.set) {
        descriptor.set.call(checkbox, true);
      } else {
        checkbox.checked = true;
      }
      checkbox.dispatchEvent(new Event("input", { bubbles: true }));
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      log("tickCheckbox: forced .checked via native setter, checked=", checkbox.checked);
    } catch (error) {
      log("tickCheckbox: native setter failed:", error?.message || error);
    }
  }

  return isChecked(checkbox);
}

function findContinueButton(modal) {
  const root = modal || document;
  const buttons = root.querySelectorAll("button, [role='button']");
  for (const button of buttons) {
    if (!isVisible(button)) continue;
    const text = normalizedText(button);
    if (text === "continuer" || text.startsWith("continuer")) {
      return button;
    }
  }
  return null;
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

function clickElement(element) {
  try {
    element.scrollIntoView({ block: "center", inline: "center" });
  } catch {
    // ignore
  }
  element.click();
}

/**
 * Sets an input value the way modern frameworks expect:
 *   1. focus the input and select any existing value,
 *   2. use the native HTMLInputElement.value setter so React's internal
 *      _valueTracker sees the change,
 *   3. dispatch input + change events,
 *   4. if the value did NOT stick (some libs intercept the setter), fall
 *      back to selecting all and execCommand("insertText", ...) which
 *      simulates a real keystroke at the document level.
 *
 * Returns true if `input.value` ends up matching `value`.
 */
function setInputValueRobust(input, value) {
  try {
    input.focus();
  } catch {
    // ignore
  }

  // 1. Try the native setter.
  try {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (error) {
    log("native setter failed:", error?.message || error);
  }

  if (input.value === value) {
    return true;
  }

  // 2. Fallback: select all + execCommand insertText. Works around masked
  // currency inputs that ignore the prototype setter.
  try {
    input.focus();
    if (typeof input.setSelectionRange === "function") {
      input.setSelectionRange(0, input.value.length);
    } else {
      input.select?.();
    }
    const ok = document.execCommand && document.execCommand("insertText", false, value);
    log("execCommand insertText returned", ok, "value now=", input.value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (error) {
    log("execCommand fallback failed:", error?.message || error);
  }

  return input.value === value;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `finder` every 200ms until it returns a truthy value or `until`
 * (epoch ms) is reached. Returns null on timeout.
 */
async function waitForElement(finder, { until }) {
  while (Date.now() < until) {
    try {
      const found = finder();
      if (found) return found;
    } catch {
      // Ignore and retry.
    }
    await wait(200);
  }
  return null;
}
