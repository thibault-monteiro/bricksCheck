chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SCAN_BRICKS_PAGE") {
    const result = scanProjects();
    sendResponse(result);
    return false;
  }

  if (message?.type === "FETCH_BRICKS_API_PROJECTS") {
    fetchProjectsFromBricksApi()
      .then(sendResponse)
      .catch((error) => {
        console.log("[BricksCheck] API scan failed", error?.message || error);
        sendResponse({ ok: false, projects: [], error: error?.message || String(error) });
      });
    return true;
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

  return { projects: statusNodes.map(extractProjectFromStatus).filter(Boolean), pageReady: true };
}

function scanProjectsPage() {
  const investNodes = [...document.querySelectorAll("button, a, [role='button'], [role='link']")].filter((element) => {
    return normalizeText(element.innerText || element.textContent || "").toLowerCase() === "investir";
  });

  const projects = investNodes.map(extractProjectFromInvestButton).filter(Boolean);

  // Detect if the SPA has fully rendered: check for brick images (incl. lazy-loaded)
  // If cards exist but no brick badges are detectable, the page may not be ready
  const hasAnyKnownBricks = projects.some((p) => p.ownedBricks !== null);
  const pageReady = projects.length === 0 || hasAnyKnownBricks;
  if (!pageReady) {
    console.log('[BricksCheck] Page not ready: found', projects.length, 'cards but all ownedBricks are null (unknown)');
  }

  return { projects, pageReady };
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

// Selector that matches brick badge images, including lazy-loaded variants
const BRICK_IMG_SELECTOR = 'img[src*="/bricks."], img[data-src*="/bricks."], img[loading="lazy"][src*="/bricks."]';

function extractOwnedBricksFromProjectsCard(card, projectName = "") {
  // Le badge bricks (nombre + icône bricks.png) peut être en dehors du "card"
  // trouvé par findProjectCardFromInvestButton (zone texte uniquement).
  // On remonte progressivement dans le DOM pour trouver le conteneur complet.
  let searchRoot = card;
  const searchRoots = [];
  for (let level = 0; level < 4; level++) {
    searchRoots.push({ level, element: searchRoot });
    const brickImages = searchRoot.querySelectorAll(BRICK_IMG_SELECTOR);
    const allImages = searchRoot.querySelectorAll('img');
    const allImgSrcs = [...allImages].map(i => i.src || i.dataset.src || '').slice(0, 5);
    console.log(`[BricksCheck] Level ${level}: tag=<${searchRoot.tagName}> brickImgs=${brickImages.length} totalImgs=${allImages.length} srcs=`, allImgSrcs);

    if (brickImages.length === 1) {
      console.log('[BricksCheck] Found 1 brick img:', brickImages[0].src || brickImages[0].dataset.src);
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

  const badgeFallback = extractValueFromBrickBadgeWithoutImage(searchRoots);
  if (badgeFallback !== null) {
    console.log('[BricksCheck] Badge text fallback =>', badgeFallback);
    return badgeFallback;
  }

  // No brick badge found — return null (unknown) instead of 0.
  // This avoids false notifications when images haven't loaded (background tab).
  console.log('[BricksCheck] No brick badge found for', projectName, '=> ownedBricks: null (unknown)');
  return null;
}

function extractValueFromBrickBadgeWithoutImage(searchRoots) {
  for (const { level, element } of searchRoots) {
    const candidates = [...element.querySelectorAll("p, span")]
      .map((node) => {
        const text = node.textContent?.trim() || "";
        if (!/^\d[\d\s]*$/.test(text)) {
          return null;
        }

        const value = toNumber(text);
        if (value <= 0 || value > 1000) {
          return null;
        }

        const badge = findClosestBrickBadgeContainer(node, element);
        if (!badge) {
          return null;
        }

        return { value, text, badge };
      })
      .filter(Boolean);

    const uniqueValues = [...new Set(candidates.map((candidate) => candidate.value))];
    console.log(
      `[BricksCheck] Badge text fallback level ${level}: candidates=${candidates.length} values=`,
      uniqueValues
    );

    if (uniqueValues.length === 1) {
      return uniqueValues[0];
    }
  }

  return null;
}

function findClosestBrickBadgeContainer(node, root) {
  let current = node.parentElement;

  for (let depth = 0; depth < 4 && current && current !== root.parentElement; depth += 1) {
    if (looksLikeBrickBadgeContainer(current)) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function looksLikeBrickBadgeContainer(element) {
  const className = String(element.className || "");
  const text = normalizeText(element.innerText || element.textContent || "");
  const hasSingleNumericText = /^\d[\d\s]*$/.test(text);
  const hasBadgeShape =
    className.includes("rounded-xs") &&
    className.includes("border") &&
    (className.includes("h-[28]") || className.includes("items-center") || className.includes("gap-2xs"));

  return hasSingleNumericText && hasBadgeShape;
}

async function fetchProjectsFromBricksApi() {
  const payload = await requestBricksApiData();
  if (!payload?.ok) {
    return {
      ok: false,
      projects: [],
      error: payload?.error || "Impossible de recuperer les donnees API Bricks."
    };
  }

  const projects = mapBricksApiProjects(payload.catalog, payload.portfolio);
  console.log("[BricksCheck] API projects =>", projects);

  return {
    ok: true,
    projects,
    source: "api"
  };
}

function requestBricksApiData() {
  return new Promise((resolve) => {
    const requestId = `bricks-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutId = setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      resolve({ ok: false, error: "Timeout API bridge Bricks." });
    }, 20000);

    function handleMessage(event) {
      if (event.source !== window) {
        return;
      }

      const data = event.data || {};
      if (data.source !== "BRICKS_CHECK_PAGE" || data.type !== "BRICKS_API_DATA_RESULT" || data.requestId !== requestId) {
        return;
      }

      clearTimeout(timeoutId);
      window.removeEventListener("message", handleMessage);
      resolve(data.payload || { ok: false, error: "Reponse API bridge invalide." });
    }

    window.addEventListener("message", handleMessage);
    window.postMessage(
      {
        source: "BRICKS_CHECK_CONTENT",
        type: "FETCH_BRICKS_API_DATA",
        requestId
      },
      window.location.origin
    );
  });
}

function mapBricksApiProjects(catalog, portfolio) {
  const ownedBricksByPropertyId = buildOwnedBricksByPropertyId(portfolio);
  const activeProjects = [
    ...((catalog?.ongoing?.projects) || []),
    ...((catalog?.upcoming?.projects) || [])
  ];

  return activeProjects
    .map((property) => mapBricksApiProject(property, ownedBricksByPropertyId))
    .filter(Boolean);
}

function mapBricksApiProject(property, ownedBricksByPropertyId) {
  const name = localizeText(property?.name) || "";
  if (!name) {
    return null;
  }

  const listingStatus = property?.listingStatus || "ongoing";
  if (listingStatus !== "ongoing") {
    return null;
  }

  const startedAt = property?.funding?.startedAt ? new Date(property.funding.startedAt) : null;
  if (startedAt && startedAt.getTime() > Date.now()) {
    return null;
  }

  const brickPriceCents = Number(property?.funding?.brickPrice ?? property?.brickPrice ?? 1000);
  const targetAmountCents = Number(property?.funding?.amountToFundCents ?? 0);
  const purchasedBrickCount = Number(property?.funding?.purchasedBrickCount ?? 0);
  const autoInvestPurchasedBrickCount = Number(property?.funding?.autoInvestPurchasedBrickCount ?? 0);
  const investedAmountCents = (purchasedBrickCount + autoInvestPurchasedBrickCount) * brickPriceCents;
  const availableAmountCents = Math.max(0, targetAmountCents - investedAmountCents);
  const brickPrice = centsToEuros(brickPriceCents) || 10;
  const availableBricks = brickPriceCents > 0 ? Math.floor(availableAmountCents / brickPriceCents) : 0;

  if (availableBricks <= 0 || targetAmountCents <= 0 || property?.hasBricksAvailable === false) {
    return null;
  }

  const ownedBricks =
    normalizeOwnedBricks(property?.ownedBricks) ??
    normalizeOwnedBricks(property?.investorBricks?.owned) ??
    normalizeOwnedBricks(ownedBricksByPropertyId.get(property.id)) ??
    0;

  return {
    id: property.id || slugify(name),
    name,
    availableAmount: centsToEuros(availableAmountCents),
    availableBricks,
    brickPrice,
    investedAmount: centsToEuros(investedAmountCents),
    targetAmount: centsToEuros(targetAmountCents),
    ownedBricks,
    ownedBricksSource: "api",
    status: "Collecte en cours",
    url: property.id ? `https://app.bricks.co/project/${property.id}` : location.href
  };
}

function buildOwnedBricksByPropertyId(portfolio) {
  const ownedBricksByPropertyId = new Map();
  const projects = [
    ...((portfolio?.ongoing) || []),
    ...((portfolio?.refunded) || [])
  ];

  for (const project of projects) {
    if (project?.propertyId) {
      ownedBricksByPropertyId.set(project.propertyId, project.brickCount);
    }
  }

  return ownedBricksByPropertyId;
}

function localizeText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    return value.fr || value.en || Object.values(value).find((text) => typeof text === "string") || "";
  }

  return "";
}

function centsToEuros(value) {
  const cents = Number(value || 0);
  return Number.isFinite(cents) ? Number((cents / 100).toFixed(2)) : 0;
}

function normalizeOwnedBricks(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
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
