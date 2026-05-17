const ALARM_NAME = "bricks-check";
const CLEAR_NOTIFICATION_ALARM_PREFIX = "bricks-clear-notification:";
const NOTIFICATION_TTL_MINUTES = 0.5;
const OWNED_BRICKS_CACHE_KEY = "ownedBricksByProject";
const OWNED_BRICKS_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const AUTH_TOKEN_KEY = "bricksAuthToken";
const API_ORIGIN = "https://api.bricks.co";

const DEFAULT_OPTIONS = {
  enabled: false,
  intervalMinutes: 1,
  ownedThreshold: 100,
  notifyWhenBelowThreshold: true
};

chrome.runtime.onInstalled.addListener(async () => {
  const { options } = await chrome.storage.sync.get("options");
  if (!options) {
    await chrome.storage.sync.set({ options: DEFAULT_OPTIONS });
  }
  await syncAlarm();
});

chrome.runtime.onStartup.addListener(syncAlarm);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.options) {
    syncAlarm();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runCheck();
    return;
  }

  if (alarm.name.startsWith(CLEAR_NOTIFICATION_ALARM_PREFIX)) {
    clearNotificationById(alarm.name.slice(CLEAR_NOTIFICATION_ALARM_PREFIX.length));
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  openNotificationProject(notificationId);
});

chrome.notifications.onClosed.addListener((notificationId) => {
  deleteNotificationLink(notificationId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPTIONS_UPDATED") {
    syncAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "CHECK_NOW") {
    runCheck()
      .then((lastCheck) => sendResponse({ ok: true, lastCheck }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_STATUS") {
    getStatus()
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLEAR_NOTIFICATIONS") {
    clearNotifications()
      .then((clearedCount) => sendResponse({ ok: true, clearedCount }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "BRICKS_AUTH_TOKEN" && message.token) {
    chrome.storage.local.set({ [AUTH_TOKEN_KEY]: message.token });
    console.log("[BricksCheck] Auth token cached");
    return false;
  }

  return false;
});

async function syncAlarm() {
  const options = await getOptions();
  await chrome.alarms.clear(ALARM_NAME);

  if (!options.enabled) {
    return;
  }

  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: Math.max(0.5, options.intervalMinutes)
  });
}

async function runCheck() {
  const options = await getOptions();
  if (!options.enabled) {
    return saveLastCheck({ checkedAt: Date.now(), matches: [], skipped: true });
  }

  const projects = await scanOpenBricksTabs();
  if (projects.length === 0) {
    return saveLastCheck({
      checkedAt: Date.now(),
      matches: [],
      projectCount: 0,
      message: "Aucun projet trouvé. Vérifiez votre connexion sur Bricks.co."
    });
  }

  return handleProjects(projects);
}

async function handleProjects(projects) {
  const options = await getOptions();
  if (!options.enabled) {
    return saveLastCheck({ checkedAt: Date.now(), matches: [], skipped: true });
  }

  const matches = projects.filter((project) => shouldNotifyProject(project, options));
  const shouldNotify = matches.length > 0;
  let notificationCount = 0;

  if (shouldNotify) {
    await clearNotifications();
    notificationCount = await notifyProjects(matches, options);
  }

  const lastCheck = await saveLastCheck({
    checkedAt: Date.now(),
    projectCount: projects.length,
    matches,
    notificationSent: notificationCount > 0,
    notificationCount
  });

  return lastCheck;
}

async function getOptions() {
  const { options = DEFAULT_OPTIONS } = await chrome.storage.sync.get({
    options: DEFAULT_OPTIONS
  });
  return { ...DEFAULT_OPTIONS, ...options };
}

async function getStatus() {
  const [options, alarm, localState] = await Promise.all([
    getOptions(),
    chrome.alarms.get(ALARM_NAME),
    chrome.storage.local.get("lastCheck")
  ]);

  return {
    enabled: options.enabled,
    nextCheckAt: alarm?.scheduledTime || null,
    lastCheck: localState.lastCheck || null
  };
}

async function scanOpenBricksTabs() {
  const token = await getCachedToken();
  if (!token) {
    console.log("[BricksCheck] No cached token, opening Bricks tab to get one");
    const refreshed = await refreshTokenFromTab();
    if (!refreshed) {
      await notifyApiFailure("Aucun token Bricks. Connectez-vous sur Bricks.co.");
      return [];
    }
    return scanOpenBricksTabs();
  }

  const result = await fetchBricksApiDirect(token);
  if (result.ok) {
    return applyOwnedBricksCache(dedupeProjects(result.projects));
  }

  // Token may be expired — try to refresh it from a tab
  if (result.httpStatus === 401 || result.httpStatus === 403) {
    console.log("[BricksCheck] Token expired, refreshing from tab");
    await chrome.storage.local.remove(AUTH_TOKEN_KEY);
    const refreshed = await refreshTokenFromTab();
    if (refreshed) {
      const retryToken = await getCachedToken();
      if (retryToken) {
        const retry = await fetchBricksApiDirect(retryToken);
        if (retry.ok) {
          return applyOwnedBricksCache(dedupeProjects(retry.projects));
        }
      }
    }
  }

  console.log("[BricksCheck] API scan failed, notifying user");
  await notifyApiFailure(result.error);
  return [];
}

async function getCachedToken() {
  const { [AUTH_TOKEN_KEY]: token } = await chrome.storage.local.get(AUTH_TOKEN_KEY);
  return token || null;
}

async function refreshTokenFromTab() {
  const existingTabs = await chrome.tabs.query({ url: "https://app.bricks.co/*" });
  let tab;

  if (existingTabs.length > 0) {
    tab = existingTabs[0];
    await chrome.tabs.reload(tab.id);
  } else {
    tab = await chrome.tabs.create({ url: "https://app.bricks.co/", active: false });
  }

  await waitForTabComplete(tab.id);
  await wait(3000);

  const newToken = await getCachedToken();
  return Boolean(newToken);
}

async function fetchBricksApiDirect(token) {
  try {
    const [catalog, portfolio] = await Promise.all([
      fetchBricksJson("/projects", token),
      fetchBricksJson("/investor/portfolio/properties", token).catch(() => null)
    ]);

    const projects = mapBricksApiProjects(catalog, portfolio);
    console.log("[BricksCheck] API direct scan =>", projects.length, "projects");
    return { ok: true, projects };
  } catch (error) {
    const httpStatus = error.httpStatus || 0;
    return { ok: false, projects: [], error: error.message, httpStatus };
  }
}

async function fetchBricksJson(apiPath, token) {
  const response = await fetch(new URL(apiPath, API_ORIGIN).toString(), {
    method: "GET",
    headers: { Authorization: "Bearer " + token }
  });

  if (!response.ok) {
    const error = new Error(`Bricks API ${response.status} on ${apiPath}`);
    error.httpStatus = response.status;
    throw error;
  }

  return response.json();
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
    url: property.id ? `https://app.bricks.co/project/${property.id}` : "https://app.bricks.co/"
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

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function notifyApiFailure(errorMessage) {
  const notificationId = `bricks-api-error-${Date.now()}`;

  // Ouvrir un onglet Bricks pour rafraîchir la session
  const existingTabs = await chrome.tabs.query({ url: "https://app.bricks.co/*" });
  if (existingTabs.length > 0) {
    await chrome.tabs.reload(existingTabs[0].id);
  } else {
    await chrome.tabs.create({ url: "https://app.bricks.co/" });
  }

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon-128.png"),
    title: "Bricks Check — Erreur API",
    message: `Impossible de récupérer les projets. ${errorMessage || "Reconnectez-vous sur Bricks.co."}`,
    priority: 2
  });

  await trackNotification(notificationId);
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(cleanup, 20000);

    function cleanup() {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      resolve();
    }

    function handleUpdate(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
      }
    }

    chrome.tabs.onUpdated.addListener(handleUpdate);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldNotifyProject(project, options) {
  const hasAvailableBricks = Number(project.availableBricks) > 0;
  if (!hasAvailableBricks) {
    return false;
  }

  if (!options.notifyWhenBelowThreshold) {
    return true;
  }

  // ownedBricks === null means we couldn't detect the badge (e.g. background tab).
  // Don't notify — better to miss than send a false alarm.
  if (project.ownedBricks === null || project.ownedBricks === undefined) {
    return false;
  }

  return Number(project.ownedBricks) < Number(options.ownedThreshold);
}

async function notifyProjects(matches, options) {
  let createdCount = 0;

  for (const project of matches) {
    const notificationId = `bricks-${Date.now()}-${createdCount}-${project.id || "project"}`;
    const ownedBricks = Math.max(0, Number(project.ownedBricks || 0));
    const availableBricks = Math.max(0, Number(project.availableBricks || 0));
    const missingBricks = Math.max(0, Number(options.ownedThreshold) - ownedBricks);
    const buyableBricks = Math.min(missingBricks, availableBricks);
    const title = project.name;
    const message =
      buyableBricks > 0
        ? `Achetez-en ${formatInteger(buyableBricks)} (${formatInteger(ownedBricks)}/${formatInteger(options.ownedThreshold)}, ${formatInteger(availableBricks)} dispo)`
        : `${formatInteger(availableBricks)} ${availableBricks > 1 ? "briques" : "brique"} disponibles`;

    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title,
      message,
      priority: 2
    });

    await trackNotification(notificationId);
    await saveNotificationTarget(notificationId, {
      projectName: project.name,
      tabId: project.tabId,
      url: isProjectUrl(project.url) ? project.url : ""
    });
    createdCount += 1;
  }

  return createdCount;
}

async function clearNotifications() {
  const [{ notificationLinks = {}, notificationIds = [] }, activeNotifications] = await Promise.all([
    chrome.storage.local.get(["notificationLinks", "notificationIds"]),
    chrome.notifications.getAll()
  ]);
  const idsToClear = [...new Set([...notificationIds, ...Object.keys(notificationLinks), ...Object.keys(activeNotifications)])];
  let clearedCount = 0;

  await Promise.all(
    idsToClear.map(async (notificationId) => {
      if (await chrome.notifications.clear(notificationId)) {
        clearedCount += 1;
      }
      await chrome.alarms.clear(getClearNotificationAlarmName(notificationId));
    })
  );

  await chrome.storage.local.set({ notificationLinks: {}, notificationIds: [] });
  return clearedCount;
}

async function clearNotificationById(notificationId) {
  await chrome.notifications.clear(notificationId);
  await deleteNotificationState(notificationId);
}

async function saveLastCheck(lastCheck) {
  await chrome.storage.local.set({ lastCheck });
  return lastCheck;
}

async function saveNotificationTarget(notificationId, target) {
  const { notificationLinks = {} } = await chrome.storage.local.get("notificationLinks");
  await chrome.storage.local.set({
    notificationLinks: {
      ...notificationLinks,
      [notificationId]: target
    }
  });
}

async function trackNotification(notificationId) {
  const { notificationIds = [] } = await chrome.storage.local.get("notificationIds");
  await chrome.storage.local.set({
    notificationIds: [...new Set([...notificationIds, notificationId])]
  });
  chrome.alarms.create(getClearNotificationAlarmName(notificationId), {
    delayInMinutes: NOTIFICATION_TTL_MINUTES
  });
}

async function deleteNotificationLink(notificationId) {
  const { notificationLinks = {} } = await chrome.storage.local.get("notificationLinks");
  if (!notificationLinks[notificationId]) {
    return;
  }

  delete notificationLinks[notificationId];
  await chrome.storage.local.set({ notificationLinks });
}

async function deleteNotificationState(notificationId) {
  const { notificationLinks = {}, notificationIds = [] } = await chrome.storage.local.get([
    "notificationLinks",
    "notificationIds"
  ]);
  delete notificationLinks[notificationId];
  await chrome.storage.local.set({
    notificationLinks,
    notificationIds: notificationIds.filter((id) => id !== notificationId)
  });
  await chrome.alarms.clear(getClearNotificationAlarmName(notificationId));
}

async function openNotificationProject(notificationId) {
  const { notificationLinks = {} } = await chrome.storage.local.get("notificationLinks");
  const target = normalizeNotificationTarget(notificationLinks[notificationId]);
  await deleteNotificationState(notificationId);
  await chrome.notifications.clear(notificationId);

  if (!target) {
    return;
  }

  if (target.url) {
    await chrome.tabs.create({ url: target.url });
    return;
  }

  await openProjectFromNewBricksTab(target.projectName);
}

function getClearNotificationAlarmName(notificationId) {
  return `${CLEAR_NOTIFICATION_ALARM_PREFIX}${notificationId}`;
}

async function openProjectFromNewBricksTab(projectName) {
  const tab = await chrome.tabs.create({ url: "https://app.bricks.co/projects" });
  await waitForTabComplete(tab.id);
  await wait(1500);

  if (!projectName) {
    return;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "CLICK_BRICKS_PROJECT",
        projectName
      });

      if (response?.clicked) {
        return;
      }
    } catch {
      // The content script may not be ready yet.
    }

    await wait(1000);
  }
}

function normalizeNotificationTarget(rawTarget) {
  if (!rawTarget) {
    return null;
  }

  if (typeof rawTarget === "string") {
    return {
      projectName: "",
      tabId: null,
      url: ""
    };
  }

  return {
    projectName: rawTarget.projectName || "",
    tabId: rawTarget.tabId || null,
    url: isProjectUrl(rawTarget.url) ? sanitizeBricksUrl(rawTarget.url) : ""
  };
}

function sanitizeBricksUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://app.bricks.co" ? parsed.href : "https://app.bricks.co/";
  } catch {
    return "https://app.bricks.co/";
  }
}

function isProjectUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://app.bricks.co" && parsed.pathname.startsWith("/project/");
  } catch {
    return false;
  }
}

function formatInteger(value) {
  return new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

async function applyOwnedBricksCache(projects) {
  const { [OWNED_BRICKS_CACHE_KEY]: ownedBricksByProject = {} } = await chrome.storage.local.get(OWNED_BRICKS_CACHE_KEY);
  const now = Date.now();
  const nextCache = { ...ownedBricksByProject };
  let cacheChanged = false;

  const hydratedProjects = projects.map((project) => {
    const key = project.id || project.name;
    if (!key) {
      return project;
    }

    if (hasKnownOwnedBricks(project.ownedBricks)) {
      nextCache[key] = {
        name: project.name,
        ownedBricks: Number(project.ownedBricks),
        updatedAt: now
      };
      cacheChanged = true;
      return project;
    }

    const cached = nextCache[key];
    if (!cached || now - Number(cached.updatedAt || 0) > OWNED_BRICKS_CACHE_MAX_AGE_MS) {
      return project;
    }

    console.log("[BricksCheck] Using cached ownedBricks for", project.name, "=>", cached.ownedBricks);
    return {
      ...project,
      ownedBricks: cached.ownedBricks,
      ownedBricksSource: "cache"
    };
  });

  const prunedCache = Object.fromEntries(
    Object.entries(nextCache).filter(([, cached]) => now - Number(cached.updatedAt || 0) <= OWNED_BRICKS_CACHE_MAX_AGE_MS)
  );

  if (cacheChanged || Object.keys(prunedCache).length !== Object.keys(nextCache).length) {
    await chrome.storage.local.set({ [OWNED_BRICKS_CACHE_KEY]: prunedCache });
  }

  return hydratedProjects;
}

function hasKnownOwnedBricks(value) {
  if (value === null || value === undefined) {
    return false;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0;
}

function dedupeProjects(projects) {
  const projectByKey = new Map();

  for (const project of projects) {
    const key = project.id || project.name;
    if (!key) {
      continue;
    }

    const previousProject = projectByKey.get(key);
    if (!previousProject || getProjectDataScore(project) > getProjectDataScore(previousProject)) {
      projectByKey.set(key, project);
    }
  }

  return [...projectByKey.values()];
}

function getProjectDataScore(project) {
  let score = 0;
  if (project.ownedBricks !== null && project.ownedBricks !== undefined && Number(project.ownedBricks) > 0) {
    score += 3;
  }
  if (Number(project.availableBricks || 0) > 1) {
    score += 2;
  }
  if (Number(project.availableAmount || 0) > 0 && Number(project.targetAmount || 0) > 0) {
    score += 2;
  }
  if (isProjectUrl(project.url)) {
    score += 1;
  }
  return score;
}
