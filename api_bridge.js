(() => {
  if (window.__BRICKS_CHECK_API_BRIDGE__) {
    return;
  }

  Object.defineProperty(window, "__BRICKS_CHECK_API_BRIDGE__", {
    configurable: false,
    enumerable: false,
    value: true
  });

  const JWT_PATTERN = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const TOKEN_KEY_HINTS = ["accesstoken", "access_token", "idtoken", "id_token", "authtoken", "auth_token", "token", "bearer", "jwt", "auth"];

  function isLikelyJwt(value) {
    return typeof value === "string" && JWT_PATTERN.test(value.trim());
  }

  function looksLikeTokenKey(key) {
    if (typeof key !== "string") {
      return false;
    }
    const lowered = key.toLowerCase();
    return TOKEN_KEY_HINTS.some((hint) => lowered.includes(hint));
  }

  function readDetectedAuth() {
    const result = { email: null, token: null };
    const storages = [window.localStorage, window.sessionStorage];

    const visit = (value, parentKey) => {
      if (!value || result.token) {
        return;
      }

      if (typeof value === "string") {
        const trimmed = value.trim();

        if (isLikelyJwt(trimmed)) {
          result.token = trimmed;
          return;
        }

        try {
          visit(JSON.parse(trimmed), parentKey);
        } catch {
          // Not JSON.
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, parentKey));
        return;
      }

      if (typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (!result.token && typeof child === "string" && isLikelyJwt(child)) {
            result.token = child.trim();
          } else if (!result.token && typeof child === "string" && looksLikeTokenKey(key) && child.trim().length > 20) {
            // Fallback: opaque token under a token-named key.
            result.token = child.trim();
          }

          if (!result.email && typeof child === "string" && child.includes("@") && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(child)) {
            result.email = child;
          }

          visit(child, key);
        }
      }
    };

    for (const storage of storages) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key) {
          visit(storage.getItem(key), key);
        }
      }
    }

    return result;
  }

  // Broadcast the auth token on page load so the extension can cache it.
  // Retry a few times because the SPA may populate storage asynchronously.
  let attempts = 0;
  const maxAttempts = 8;
  const retryDelayMs = 750;

  const tryBroadcast = () => {
    attempts += 1;
    const auth = readDetectedAuth();
    if (auth.token) {
      window.postMessage(
        {
          source: "BRICKS_CHECK_PAGE",
          type: "BRICKS_AUTH_TOKEN",
          token: auth.token
        },
        window.location.origin
      );
      return;
    }

    if (attempts < maxAttempts) {
      setTimeout(tryBroadcast, retryDelayMs);
    }
  };

  setTimeout(tryBroadcast, 500);
})();
