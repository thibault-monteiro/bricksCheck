chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SCAN_BRICKS_PAGE") {
    sendResponse({ projects: scanProjects() });
  }

  if (message?.type === "CLICK_BRICKS_PROJECT") {
    sendResponse({ clicked: clickProjectByName(message.projectName || "") });
  }

  return false;
});

function scanProjects() {
  const statusNodes = [...document.querySelectorAll("body *")].filter((element) => {
    return getOwnText(element).toLowerCase().includes("collecte en cours");
  });

  return statusNodes.map(extractProjectFromStatus).filter(Boolean);
}

function extractProjectFromStatus(statusNode) {
  const card = findCard(statusNode);
  if (!card) {
    return null;
  }

  const text = normalizeText(card.innerText || card.textContent || "");
  const ownedBricks = extractOwnedBricks(text);
  const name = extractProjectName(text);

  if (!name) {
    return null;
  }

  return {
    id: slugify(name),
    name,
    availableBricks: 1,
    ownedBricks,
    status: "Collecte en cours",
    url: findProjectUrl(card)
  };
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

function extractOwnedBricks(text) {
  const brickMatch = text.match(/(\d[\d\s]*)\s*(?:🧱|brique)/i);
  if (brickMatch) {
    return toNumber(brickMatch[1]);
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const numericLines = lines
    .filter((line) => /^\d[\d\s]*$/.test(line))
    .map(toNumber)
    .filter((value) => value > 0);

  if (numericLines.length > 0) {
    return numericLines[0];
  }

  const compactText = text.replace(/\s+/g, " ");
  const numberBeforeTitle = compactText.match(/Collecte en cours\s+(\d[\d\s]*)\s+[A-ZÀ-Ÿ]/);
  return numberBeforeTitle ? toNumber(numberBeforeTitle[1]) : 0;
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

function findProjectUrl(card) {
  const links = collectNearbyLinks(card);
  const projectLink = links.find((link) => {
    try {
      return new URL(link.getAttribute("href"), location.href).pathname.startsWith("/project/");
    } catch {
      return false;
    }
  });
  if (projectLink) {
    return new URL(projectLink.getAttribute("href"), location.href).href;
  }

  return links[0] ? new URL(links[0].getAttribute("href"), location.href).href : location.href;
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

function clickProjectByName(projectName) {
  const wantedName = normalizeProjectName(projectName);
  if (!wantedName) {
    return false;
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
