chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SCAN_BRICKS_PAGE") {
    sendResponse({ projects: scanProjects() });
    return false;
  }

  if (message?.type === "CLICK_BRICKS_PROJECT") {
    sendResponse({ clicked: clickProjectByName(message.projectName || "") });
    return false;
  }

  return false;
});

function scanProjects() {
  if (location.pathname.startsWith("/projects")) {
    return scanProjectsPage();
  }

  const statusNodes = [...document.querySelectorAll("body *")].filter((element) => {
    return getOwnText(element).toLowerCase().includes("collecte en cours");
  });

  return statusNodes.map(extractProjectFromStatus).filter(Boolean);
}

function scanProjectsPage() {
  const investNodes = [...document.querySelectorAll("button, a, [role='button'], [role='link']")].filter((element) => {
    return normalizeText(element.innerText || element.textContent || "").toLowerCase() === "investir";
  });

  return investNodes.map(extractProjectFromInvestButton).filter(Boolean);
}

function extractProjectFromInvestButton(investNode) {
  const card = findProjectCardFromInvestButton(investNode);
  if (!card) {
    console.log('[BricksCheck] No card found for invest button');
    return null;
  }

  const text = normalizeText(card.innerText || card.textContent || "");
  const funding = extractFundingAmounts(text);
  const name = extractProjectsPageProjectName(text);
  console.log('[BricksCheck] Card found for:', name, '| card tag:', card.tagName, '| card HTML length:', card.innerHTML.length);
  const ownedBricks = extractOwnedBricksFromProjectsCard(card, name);
  console.log('[BricksCheck] Result for', name, '=> ownedBricks:', ownedBricks);

  if (!name || !funding) {
    return null;
  }

  const availableAmount = Math.max(0, funding.targetAmount - funding.investedAmount);
  const availableBricks = Math.floor(availableAmount / 10);

  return {
    id: slugify(name),
    name,
    availableAmount,
    availableBricks,
    brickPrice: 10,
    investedAmount: funding.investedAmount,
    targetAmount: funding.targetAmount,
    ownedBricks,
    status: "Collecte en cours",
    url: findProjectUrl(card)
  };
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

function extractProjectFromStatus(statusNode) {
  const card = findCard(statusNode);
  if (!card) {
    return null;
  }

  const text = normalizeText(card.innerText || card.textContent || "");
  const funding = extractFundingAmounts(text);
  const availableAmount = funding ? Math.max(0, funding.targetAmount - funding.investedAmount) : 0;
  const name = extractProjectName(text);

  if (!name) {
    return null;
  }

  const ownedBricks = extractOwnedBricksFromProjectsCard(card, name) || extractOwnedBricks(text, name);

  return {
    id: slugify(name),
    name,
    availableAmount,
    availableBricks: funding ? Math.floor(availableAmount / 10) : 0,
    brickPrice: 10,
    investedAmount: funding?.investedAmount || 0,
    targetAmount: funding?.targetAmount || 0,
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

function extractOwnedBricks(text, projectName = "") {
  const brickMatch = text.match(/(\d[\d\s]*)\s*(?:🧱|brique)/i);
  if (brickMatch) {
    return toNumber(brickMatch[1]);
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const projectLineIndex = lines.findIndex((line) => {
    const normalizedLine = normalizeProjectName(line);
    const normalizedProjectName = normalizeProjectName(projectName);
    return normalizedProjectName && (normalizedLine === normalizedProjectName || normalizedLine.includes(normalizedProjectName));
  });

  if (projectLineIndex > 0) {
    const preTitleNumbers = lines
      .slice(0, projectLineIndex)
      .filter((line) => /^\d[\d\s]*$/.test(line))
      .map(toNumber)
      .filter((value) => value > 0 && value <= 1000);

    if (preTitleNumbers.length > 0) {
      return preTitleNumbers[preTitleNumbers.length - 1];
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previousLine = lines[index - 1] || "";
    const nextLine = lines[index + 1] || "";
    if (/^\d[\d\s]*$/.test(line) && /(?:🧱|brique)/i.test(`${previousLine} ${nextLine}`)) {
      return toNumber(line);
    }
  }

  return 0;
}

function extractOwnedBricksFromProjectsCard(card, projectName = "") {
  // Le badge bricks (nombre + icône bricks.png) peut être en dehors du "card"
  // trouvé par findProjectCardFromInvestButton (zone texte uniquement).
  // On remonte progressivement dans le DOM pour trouver le conteneur complet.
  let searchRoot = card;
  for (let level = 0; level < 4; level++) {
    const brickImages = searchRoot.querySelectorAll('img[src*="/bricks."]');
    const allImages = searchRoot.querySelectorAll('img');
    const allImgSrcs = [...allImages].map(i => i.src).slice(0, 5);
    console.log(`[BricksCheck] Level ${level}: tag=<${searchRoot.tagName}> brickImgs=${brickImages.length} totalImgs=${allImages.length} srcs=`, allImgSrcs);

    if (brickImages.length === 1) {
      console.log('[BricksCheck] Found 1 brick img:', brickImages[0].src);
      const value = extractValueNearBrickImage(brickImages[0]);
      console.log('[BricksCheck] extractValueNearBrickImage =>', value);
      if (value > 0) return value;
    } else if (brickImages.length > 1) {
      console.log('[BricksCheck] Too many brick imgs, stopping');
      break;
    }

    if (!searchRoot.parentElement) break;
    searchRoot = searchRoot.parentElement;
  }

  // Fallback texte : lignes avant le nom du projet
  const text = normalizeText(card.innerText || card.textContent || "");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const nameLineIndex = findProjectNameLineIndex(lines, projectName);

  if (nameLineIndex <= 0) {
    return 0;
  }

  const valuesBeforeName = lines
    .slice(0, nameLineIndex)
    .map((line) => line.match(/^\s*(\d{1,3})\s*$/))
    .filter(Boolean)
    .map((match) => toNumber(match[1]))
    .filter((value) => value > 0 && value <= 1000);

  return valuesBeforeName.length > 0 ? valuesBeforeName[valuesBeforeName.length - 1] : 0;
}

function extractValueNearBrickImage(img) {
  // Remonte depuis l'img pour trouver le <p> avec le nombre de briques
  // DOM attendu : div.badge > p "50" + div > div(bg) + img
  let container = img.parentElement;
  for (let depth = 0; depth < 3 && container; depth++) {
    const p = container.querySelector("p");
    console.log(`[BricksCheck] extractValue depth=${depth} tag=<${container.tagName}> p=${p ? '"' + p.textContent.trim() + '"' : 'null'} containerHTML=${container.outerHTML.slice(0, 200)}`);
    if (p && /^\s*\d+\s*$/.test(p.textContent)) {
      const value = toNumber(p.textContent.trim());
      console.log('[BricksCheck] Found numeric p:', value, 'passes filter:', value > 0 && value <= 1000);
      if (value > 0 && value <= 1000) {
        return value;
      }
    }
    container = container.parentElement;
  }
  console.log('[BricksCheck] extractValueNearBrickImage: no value found after 3 levels');
  return 0;
}

function findProjectNameLineIndex(lines, projectName = "") {
  const normalizedProjectName = normalizeProjectName(projectName);
  return lines.findIndex((line) => {
    const normalizedLine = normalizeProjectName(line);
    if (!normalizedLine || /^\d/.test(line)) {
      return false;
    }
    if (normalizedProjectName) {
      return (
        normalizedLine === normalizedProjectName ||
        normalizedLine.includes(normalizedProjectName) ||
        normalizedProjectName.includes(normalizedLine)
      );
    }
    return /[a-zA-ZÀ-ÿ]{4,}/.test(line);
  });
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
