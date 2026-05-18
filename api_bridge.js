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

  /**
   * Walks localStorage / sessionStorage looking for a Bricks JWT.
   * Returns the first JWT-shaped string, or as fallback any 20+ char string
   * found under a clearly token-named key.
   */
  function findToken() {
    const storages = [window.localStorage, window.sessionStorage];
    let found = null;

    const visit = (value) => {
      if (found || value == null) {
        return;
      }

      if (typeof value === "string") {
        const trimmed = value.trim();
        if (isLikelyJwt(trimmed)) {
          found = trimmed;
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
        for (const item of value) {
          if (found) return;
          visit(item);
        }
        return;
      }

      if (typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (found) return;

          if (typeof child === "string") {
            const trimmed = child.trim();
            if (isLikelyJwt(trimmed)) {
              found = trimmed;
              return;
            }
            if (looksLikeTokenKey(key) && trimmed.length > 20) {
              // Fallback: opaque token under a token-named key.
              found = trimmed;
              return;
            }
          }

          visit(child);
          if (found) return;
        }
      }
    };

    for (const storage of storages) {
      if (found) break;
      for (let index = 0; index < storage.length; index += 1) {
        if (found) break;
        const key = storage.key(index);
        if (key) {
          visit(storage.getItem(key));
        }
      }
    }

    return found;
  }

  // Broadcast the auth token on page load so the extension can cache it.
  // Retry a few times because the SPA may populate storage asynchronously.
  let attempts = 0;
  const maxAttempts = 8;
  const retryDelayMs = 750;

  const tryBroadcast = () => {
    attempts += 1;
    const token = findToken();
    if (token) {
      window.postMessage(
        {
          source: "BRICKS_CHECK_PAGE",
          type: "BRICKS_AUTH_TOKEN",
          token
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
