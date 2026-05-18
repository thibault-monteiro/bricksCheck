// Forward auth token from api_bridge (MAIN world) to service worker AND
// execute auto-invest flow when a pendingInvestIntent matches the current page.
//
// Content scripts can't import ES modules, so APP_ORIGIN is duplicated here.
// Keep in sync with shared/constants.js → APP_ORIGIN and manifest matches.
const APP_ORIGIN = "https://app.bricks.co";
const PENDING_INVEST_INTENT_KEY = "pendingInvestIntent";
const PENDING_INVEST_INTENT_TTL_MS = 2 * 60 * 1000;
const AUTO_INVEST_FLOW_TIMEOUT_MS = 15000;

// Set to true to log each step of the auto-invest flow to the page console.
// Useful while the heuristics are stabilising; safe to flip off in prod.
const DEBUG = true;
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
    if (!intent) {
      return;
    }
    if (!matchesCurrentProject(intent.projectId)) {
      log("intent does not match current project", intent.projectId, "vs", location.pathname);
      return;
    }
    if (intent.amountEuros <= 0) {
      log("intent has zero amount, clearing");
      await clearPendingIntent();
      return;
    }

    log("intent matches, starting auto-invest", intent);
    // Consume the intent immediately so we never replay it.
    await clearPendingIntent();
    await runAutoInvest(intent);
  } catch (error) {
    console.warn("[BricksCheck] auto-invest failed:", error?.message || error);
  }
})();

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

function matchesCurrentProject(projectId) {
  if (!projectId) return false;
  const match = location.pathname.match(/^\/project\/([^/]+)/);
  return match ? match[1] === projectId : false;
}

async function runAutoInvest(intent) {
  const deadline = Date.now() + AUTO_INVEST_FLOW_TIMEOUT_MS;

  // Step 1: click "Investir maintenant" (the big page-level button).
  log("step 1: looking for 'Investir maintenant' button");
  const investNowButton = await waitForElement(findInvestNowButton, { until: deadline });
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
