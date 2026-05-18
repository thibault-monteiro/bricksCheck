// Forward auth token from api_bridge (MAIN world) to service worker
window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  if (event.origin !== "https://app.bricks.co") {
    return;
  }

  const data = event.data || {};
  if (data.source !== "BRICKS_CHECK_PAGE" || data.type !== "BRICKS_AUTH_TOKEN" || !data.token) {
    return;
  }

  chrome.runtime.sendMessage({ type: "BRICKS_AUTH_TOKEN", token: data.token }).catch(() => {});
});
