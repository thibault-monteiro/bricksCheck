(() => {
  if (window.__BRICKS_CHECK_API_BRIDGE__) {
    return;
  }

  Object.defineProperty(window, "__BRICKS_CHECK_API_BRIDGE__", {
    configurable: false,
    enumerable: false,
    value: true
  });

  // Broadcast the auth token on page load so the extension can cache it
  setTimeout(() => {
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
    }
  }, 1000);

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
