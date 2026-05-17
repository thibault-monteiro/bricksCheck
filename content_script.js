chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CLICK_BRICKS_PROJECT") {
    sendResponse({ clicked: clickProjectByName(message.projectName || "") });
    return false;
  }

  return false;
});

// Forward auth token from api_bridge (MAIN world) to service worker
window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data || {};
  if (data.source !== "BRICKS_CHECK_PAGE" || data.type !== "BRICKS_AUTH_TOKEN" || !data.token) {
    return;
  }

  chrome.runtime.sendMessage({ type: "BRICKS_AUTH_TOKEN", token: data.token }).catch(() => {});
});

function clickProjectByName(projectName) {
  const wantedName = normalizeProjectName(projectName);
  if (!wantedName) {
    return false;
  }

  if (location.pathname.startsWith("/projects")) {
    const investNodes = [...document.querySelectorAll("button, a, [role='button'], [role='link']")].filter((element) => {
      return normalizeText(element.innerText || element.textContent || "").toLowerCase() === "investir";
    });

    for (const investNode of investNodes) {
      const card = findProjectCardFromInvestButton(investNode);
      if (!card) {
        continue;
      }

      const text = normalizeText(card.innerText || card.textContent || "");
      const cardName = normalizeProjectName(extractProjectsPageProjectName(text));
      const namesMatch = cardName === wantedName || cardName.includes(wantedName) || wantedName.includes(cardName);

      if (!namesMatch) {
        continue;
      }

      const clickable = findClickableElement(card);
      clickable.scrollIntoView({ block: "center", inline: "center" });
      clickable.click();
      return true;
    }
  }

  const statusNodes = [...document.querySelectorAll("body *")].filter((element) => {
    return getOwnText(element).toLowerCase().includes("collecte en cours");
  });

  for (const statusNode of statusNodes) {
    const card = findCard(statusNode);
    if (!card) {
      continue;
    }

    const text = normalizeText(card.innerText || card.textContent || "");
    const cardName = normalizeProjectName(extractProjectName(text));
    const namesMatch = cardName === wantedName || cardName.includes(wantedName) || wantedName.includes(cardName);

    if (!namesMatch) {
      continue;
    }

    const clickable = findClickableElement(card);
    clickable.scrollIntoView({ block: "center", inline: "center" });
    clickable.click();
    return true;
  }

  return false;
}

function findProjectCardFromInvestButton(investNode) {
  let current = investNode;

  for (let depth = 0; depth < 8 && current?.parentElement; depth += 1) {
    current = current.parentElement;
    const text = normalizeText(current.innerText || current.textContent || "");
    const hasInvestButton = text.toLowerCase().includes("investir");
    const hasFundingAmounts = Boolean(extractFundingAmounts(text));
    const hasRate = /\b\d{1,2}(?:[,.]\d{1,2})?\s*%\s*\/\s*an\b/i.test(text);

    if (hasInvestButton && hasFundingAmounts && hasRate) {
      return current;
    }
  }

  return null;
}

function findCard(statusNode) {
  let current = statusNode;

  for (let depth = 0; depth < 8 && current?.parentElement; depth += 1) {
    current = current.parentElement;
    const text = normalizeText(current.innerText || current.textContent || "");
    const hasStatus = text.toLowerCase().includes("collecte en cours");
    const hasProgress = /\b\d{1,3}\s*%/.test(text);
    const hasProjectName = extractProjectName(text).length > 0;

    if (hasStatus && hasProgress && hasProjectName) {
      return current;
    }
  }

  return statusNode.closest("a, article, li, [role='group']") || statusNode.parentElement;
}

function findClickableElement(card) {
  const links = collectNearbyLinks(card);
  const projectLink = links.find((link) => {
    try {
      return new URL(link.getAttribute("href"), location.href).pathname.startsWith("/project/");
    } catch {
      return false;
    }
  });

  return projectLink || links[0] || card.closest("button, [role='button'], [role='link']") || card;
}

function collectNearbyLinks(card) {
  const links = [];

  if (card.matches("a[href]")) {
    links.push(card);
  }

  links.push(...card.querySelectorAll("a[href]"));

  let current = card.parentElement;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current.matches("a[href]")) {
      links.push(current);
    }

    current = current.parentElement;
  }

  return [...new Set(links)];
}

function extractProjectsPageProjectName(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/investir/i.test(line))
    .filter((line) => !/rendement/i.test(line))
    .filter((line) => !/horizon/i.test(line))
    .filter((line) => !/^\d{1,2}(?:[,.]\d{1,2})?\s*%\s*\/\s*an$/i.test(line))
    .filter((line) => !/^\d+\s*an/i.test(line))
    .filter((line) => !/^\d+\s*mois/i.test(line))
    .filter((line) => !/^\/?\s*\d[\d\s]*(?:,\d+)?\s*€$/.test(line))
    .filter((line) => !/^\d[\d\s]*$/.test(line))
    .filter((line) => !/^\d[\d\s]*(?:🧱|brique)$/i.test(line));

  return lines.find((line) => /[a-zA-ZÀ-ÿ]{4,}/.test(line)) || "";
}

function extractProjectName(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/collecte en cours/i.test(line))
    .filter((line) => !/objectif atteint/i.test(line))
    .filter((line) => !/^\d{1,3}\s*%$/.test(line))
    .filter((line) => !/^\d[\d\s]*$/.test(line))
    .filter((line) => !/^\d[\d\s]*(?:🧱|brique)$/i.test(line));

  return lines.find((line) => /[a-zA-ZÀ-ÿ]{4,}/.test(line)) || "";
}

function extractFundingAmounts(text) {
  const amounts = [...text.matchAll(/\/?\s*(\d[\d\s]*(?:,\d+)?)\s*€/g)].map((match) => {
    return {
      raw: match[0],
      value: toNumber(match[1]),
      isTarget: match[0].trim().startsWith("/")
    };
  });

  for (let index = 0; index < amounts.length - 1; index += 1) {
    const current = amounts[index];
    const next = amounts[index + 1];
    if (next.isTarget && current.value > 0 && next.value > current.value) {
      return {
        investedAmount: current.value,
        targetAmount: next.value
      };
    }
  }

  return null;
}

function getOwnText(element) {
  return [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join(" ")
    .trim();
}

function normalizeText(value) {
  return value
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function toNumber(value) {
  const parsed = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeProjectName(value) {
  return slugify(String(value).replace(/\.\.\.$/, ""));
}
