// Forward auth token from api_bridge (MAIN world) to service worker.
// Content scripts can't import ES modules, so APP_ORIGIN is duplicated here.
// Keep in sync with shared/constants.js → APP_ORIGIN and manifest matches.
const APP_ORIGIN = "https://app.bricks.co";

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
