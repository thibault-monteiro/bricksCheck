(() => {
  if (window.__BRICKS_CHECK_API_BRIDGE__) {
    return;
  }

  Object.defineProperty(window, "__BRICKS_CHECK_API_BRIDGE__", {
    configurable: false,
    enumerable: false,
    value: true
  });

  const API_ORIGIN = "https://api.bricks.co";

  window.addEventListener("message", async (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data || {};
    if (data.source !== "BRICKS_CHECK_CONTENT" || data.type !== "FETCH_BRICKS_API_DATA") {
      return;
    }

    const payload = await fetchBricksApiData().catch((error) => ({
      ok: false,
      error: error?.message || String(error)
    }));

    window.postMessage(
      {
        source: "BRICKS_CHECK_PAGE",
        type: "BRICKS_API_DATA_RESULT",
        requestId: data.requestId,
        payload
      },
      window.location.origin
    );
  });

  async function fetchBricksApiData() {
    const auth = readDetectedAuth();
    if (!auth.token) {
      throw new Error("Token Bricks introuvable dans localStorage/sessionStorage.");
    }

    const [catalog, portfolio] = await Promise.all([
      fetchBricksJson("/projects", auth.token),
      fetchBricksJson("/investor/portfolio/properties", auth.token).catch(() => null)
    ]);

    return {
      ok: true,
      catalog,
      portfolio
    };
  }

  async function fetchBricksJson(apiPath, token) {
    const response = await fetch(new URL(apiPath, API_ORIGIN).toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        Authorization: "Bearer " + token
      }
    });

    const text = await response.text();
    let body = text;

    try {
      body = JSON.parse(text);
    } catch {
      // Keep raw text for error reporting.
    }

    if (!response.ok) {
      throw new Error(
        `Bricks API ${response.status} on ${apiPath}: ${typeof body === "string" ? body : JSON.stringify(body)}`
      );
    }

    return body;
  }

  function readDetectedAuth() {
    const result = { email: null, token: null };
    const storages = [window.localStorage, window.sessionStorage];

    const visit = (value) => {
      if (!value || result.token) {
        return;
      }

      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 20 && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
          result.token = trimmed;
          return;
        }

        try {
          visit(JSON.parse(trimmed));
        } catch {
          // Not JSON.
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }

      if (typeof value === "object") {
        if (!result.token && typeof value.token === "string" && value.token.length > 20) {
          result.token = value.token;
        }
        if (!result.email && typeof value.email === "string" && value.email.includes("@")) {
          result.email = value.email;
        }
        Object.values(value).forEach(visit);
      }
    };

    for (const storage of storages) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key) {
          visit(storage.getItem(key));
        }
      }
    }

    return result;
  }
})();
