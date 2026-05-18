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

  // Step 6: tick the terms-of-service / acknowledgement checkbox on the
  // confirmation view. Best-effort — if there isn't one within 5s, we stop
  // silently. We never click the final "Investir" button, that's on the user.
  log("step 6: waiting for terms / acknowledgement checkbox");
  const stepDeadline = Math.min(deadline, Date.now() + 5000);
  const termsCheckbox = await waitForElement(findTermsCheckbox, { until: stepDeadline });
  if (!termsCheckbox) {
    log("step 6: no terms checkbox found within 5s (none needed?)");
    dumpCheckboxCandidates();
    return;
  }
  if (isChecked(termsCheckbox)) {
    log("step 6: checkbox already checked");
    return;
  }
  log("step 6 OK, ticking checkbox", termsCheckbox);
  const ok = tickCheckbox(termsCheckbox);
  log("step 6 result: isChecked=", isChecked(termsCheckbox), "tickCheckbox returned=", ok);
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
 * Finds an unchecked checkbox whose surrounding text suggests it is the
 * terms-of-service / acknowledgement checkbox.
 *
 * Bricks runs on React Native Web + Radix, so the "checkbox" may be:
 *   - <input type="checkbox"> (rare here, often hidden)
 *   - element with role="checkbox" (Radix Checkbox button)
 *   - element with aria-checked or data-state="unchecked" (RN Web View
 *     with accessibilityRole="checkbox", custom widgets)
 *
 * We do NOT require the element itself to be visible — styled checkboxes
 * often hide the interactive node and route clicks through a wrapper.
 */
function findTermsCheckbox() {
  const selector = "input[type='checkbox'], [role='checkbox'], [aria-checked], [data-state='unchecked'], [data-state='checked']";
  const candidates = document.querySelectorAll(selector);

  for (const checkbox of candidates) {
    if (isChecked(checkbox)) continue;

    let ancestor = checkbox.parentElement;
    let hasVisibleAncestor = false;
    for (let depth = 0; depth < 8 && ancestor; depth += 1) {
      if (!hasVisibleAncestor && isVisible(ancestor)) {
        hasVisibleAncestor = true;
      }
      const text = (ancestor.textContent || "").toLowerCase();
      if (hasVisibleAncestor && TERMS_KEYWORDS.some((kw) => text.includes(kw))) {
        return checkbox;
      }
      ancestor = ancestor.parentElement;
    }
  }
  return null;
}

/**
 * Ticks a checkbox the way a real user would. Bricks renders checkboxes
 * via React Native Web / Radix, so the interactive node is often a
 * <button role="checkbox"> or <div aria-checked> — calling `.click()`
 * on a hidden underlying <input> is a no-op.
 *
 * Strategy, in order, stopping as soon as `isChecked` becomes true:
 *   1. click the associated <label>
 *   2. click the element directly (works for role=checkbox button)
 *   3. click the closest visible ancestor (the styled wrapper / row)
 *   4. for real <input>, force `.checked` via the native setter
 */
function tickCheckbox(checkbox) {
  if (isChecked(checkbox)) return true;

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

  // 2. Direct click — works for role=checkbox, aria-checked widgets.
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

  // 4. Real <input>: force `.checked = true` via the native setter so
  // React's _valueTracker picks up the change, then fire change.
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
