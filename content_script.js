// Forward auth token from api_bridge (MAIN world) to service worker AND
// execute auto-invest flow when a pendingInvestIntent matches the current page.
//
// Content scripts can't import ES modules, so APP_ORIGIN is duplicated here.
// Keep in sync with shared/constants.js → APP_ORIGIN and manifest matches.
const APP_ORIGIN = "https://app.bricks.co";
const PENDING_INVEST_INTENT_KEY = "pendingInvestIntent";
const PENDING_INVEST_INTENT_TTL_MS = 2 * 60 * 1000;
const AUTO_INVEST_FLOW_TIMEOUT_MS = 15000;

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
      return;
    }
    if (intent.amountEuros <= 0) {
      await clearPendingIntent();
      return;
    }

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
  const investNowButton = await waitForElement(findInvestNowButton, { until: deadline });
  if (!investNowButton) {
    return;
  }
  clickElement(investNowButton);

  // Step 2: wait for the modal's input to appear.
  const input = await waitForElement(findInvestModalInput, { until: deadline });
  if (!input) {
    return;
  }

  // Step 3: fill the amount in euros.
  setReactInputValue(input, String(intent.amountEuros));

  // Step 4: click "Continuer" in the modal. We give the framework a tick
  // to re-render and enable the button after the input event.
  await wait(120);
  const continueButton = await waitForElement(findContinueButton, { until: deadline });
  if (!continueButton) {
    return;
  }
  if (continueButton.disabled) {
    // Try one more tick — React may need an extra microtask.
    await wait(200);
    if (continueButton.disabled) {
      return;
    }
  }
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

function findInvestModalInput() {
  // The modal renders an input with a "€" suffix. We look for a recently-visible
  // input that is NOT a search/select-like field. Heuristic: visible, type
  // text/number/empty, near an "€" symbol or accompanying chip buttons (100€).
  const inputs = document.querySelectorAll("input");
  for (const input of inputs) {
    if (!isVisible(input)) continue;
    const type = (input.getAttribute("type") || "text").toLowerCase();
    if (!["text", "number", "tel", ""].includes(type)) continue;

    // Confirm context by walking up a few levels looking for the modal hints.
    let ancestor = input.parentElement;
    for (let depth = 0; depth < 6 && ancestor; depth += 1) {
      const text = (ancestor.textContent || "").toLowerCase();
      if (text.includes("continuer") && (text.includes("€") || text.includes("brick"))) {
        return input;
      }
      ancestor = ancestor.parentElement;
    }
  }
  return null;
}

function findContinueButton() {
  const buttons = document.querySelectorAll("button, [role='button']");
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
  element.scrollIntoView({ block: "center", inline: "center" });
  element.click();
}

/**
 * Sets the value of a React-controlled input the way React expects (via the
 * native setter on the prototype) and dispatches an `input` event so the
 * framework picks up the change.
 */
function setReactInputValue(input, value) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor && descriptor.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
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
