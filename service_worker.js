import { DEFAULT_OPTIONS, AUTH_TOKEN_KEY, API_ORIGIN, APP_ORIGIN } from "./shared/constants.js";
import { formatInteger, hasKnownOwnedBricks } from "./shared/utils.js";
import {
  bricksToInvestEuros,
  dedupeProjects,
  isProjectUrl,
  mapBricksApiProjects,
  sanitizeBricksUrl
} from "./shared/projects.js";

const ALARM_NAME = "bricks-check";
const CLEAR_NOTIFICATION_ALARM_PREFIX = "bricks-clear-notification:";
const NOTIFICATION_TTL_MINUTES = 0.5;
const OWNED_BRICKS_CACHE_KEY = "ownedBricksByProject";
const OWNED_BRICKS_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_TOKEN_REFRESH_RETRIES = 1;
const PENDING_INVEST_INTENT_KEY = "pendingInvestIntent";
const PENDING_INVEST_INTENT_TTL_MS = 2 * 60 * 1000;
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const PLAY_SOUND_MESSAGE_TYPE = "BRICKS_PLAY_SOUND";

// Toggle to enable console output. Default false in production.
const DEBUG = false;
function log(...args) {
  if (DEBUG) {
    console.log("[BricksCheck]", ...args);
  }
}

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
    log("Auth token cached");
    return false;
  }

  return false;
});

let shortIntervalTimerId = null;

async function syncAlarm() {
  const options = await getOptions();
  await chrome.alarms.clear(ALARM_NAME);
  await clearShortInterval();

  if (!options.enabled) {
    return;
  }

  const intervalMinutes = Number(options.intervalMinutes) || 1;

  if (intervalMinutes < 0.5) {
    // chrome.alarms minimum is 30s; use setTimeout for shorter intervals.
    // Note: setTimeout does not survive service worker suspension on MV3.
    // For sub-30s intervals, ticking may pause until the next event wakes the SW.
    const intervalMs = Math.max(5000, intervalMinutes * 60 * 1000);
    await scheduleShortInterval(intervalMs);
  } else {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 0.1,
      periodInMinutes: intervalMinutes
    });
  }
}

async function scheduleShortInterval(intervalMs) {
  await clearShortInterval();
  const nextCheckAt = Date.now() + intervalMs;
  await chrome.storage.local.set({ nextCheckAt });
  shortIntervalTimerId = setTimeout(async () => {
    await runCheck();
    const options = await getOptions();
    if (options.enabled && Number(options.intervalMinutes) < 0.5) {
      await scheduleShortInterval(intervalMs);
    }
  }, intervalMs);
}

async function clearShortInterval() {
  if (shortIntervalTimerId !== null) {
    clearTimeout(shortIntervalTimerId);
    shortIntervalTimerId = null;
  }
  await chrome.storage.local.remove("nextCheckAt");
}

// Guard against overlapping runCheck calls (e.g., a short alarm firing while
// the previous check is still awaiting the Bricks API). If a runCheck is
// in flight, the second caller gets the same promise back instead of
// triggering a parallel scan and double notifications.
let runCheckInFlight = null;

function runCheck() {
  if (runCheckInFlight) {
    log("runCheck already in flight, reusing pending promise");
    return runCheckInFlight;
  }
  runCheckInFlight = (async () => {
    try {
      return await runCheckInner();
    } finally {
      runCheckInFlight = null;
    }
  })();
  return runCheckInFlight;
}

async function runCheckInner() {
  const options = await getOptions();
  if (!options.enabled) {
    return saveLastCheck({ checkedAt: Date.now(), matches: [], availableProjects: [], skipped: true });
  }

  const projects = await scanOpenBricksTabs();
  if (projects.length === 0) {
    return saveLastCheck({
      checkedAt: Date.now(),
      matches: [],
      availableProjects: [],
      projectCount: 0,
      message: "Aucun projet trouvé. Vérifiez votre connexion sur Bricks.co."
    });
  }

  return handleProjects(projects);
}

async function handleProjects(projects) {
  const options = await getOptions();
  if (!options.enabled) {
    return saveLastCheck({ checkedAt: Date.now(), matches: [], availableProjects: [], skipped: true });
  }

  const matches = projects.filter((project) => shouldNotifyProject(project, options));
  const availableProjects = summarizeAvailableProjects(projects);
  let notificationCount = 0;

  // Notify on every tick that finds matches — bricks come and go fast on
  // Bricks.co, so re-notifying is desired behavior. We clear old notifs
  // first so the OS shows the new banner instead of stacking silently.
  if (matches.length > 0) {
    await clearNotifications();
    notificationCount = await notifyProjects(matches, options);
  }

  const lastCheck = await saveLastCheck({
    checkedAt: Date.now(),
    projectCount: projects.length,
    matches,
    availableProjects,
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
    chrome.storage.local.get(["lastCheck", "nextCheckAt"])
  ]);

  return {
    enabled: options.enabled,
    nextCheckAt: alarm?.scheduledTime || localState.nextCheckAt || null,
    lastCheck: localState.lastCheck || null
  };
}

async function scanOpenBricksTabs(retryCount = 0) {
  const token = await getCachedToken();
  if (!token) {
    if (retryCount >= MAX_TOKEN_REFRESH_RETRIES) {
      log("No token after retry, giving up");
      await notifyApiFailure("Aucun token Bricks. Connectez-vous sur Bricks.co.");
      return [];
    }

    log("No cached token, opening Bricks tab to get one");
    const refreshed = await refreshTokenFromTab();
    if (!refreshed) {
      await notifyApiFailure("Aucun token Bricks. Connectez-vous sur Bricks.co.");
      return [];
    }
    return scanOpenBricksTabs(retryCount + 1);
  }

  const result = await fetchBricksApiDirect(token);
  if (result.ok) {
    return applyOwnedBricksCache(dedupeProjects(result.projects));
  }

  if ((result.httpStatus === 401 || result.httpStatus === 403) && retryCount < MAX_TOKEN_REFRESH_RETRIES) {
    log("Token expired, refreshing from tab");
    await chrome.storage.local.remove(AUTH_TOKEN_KEY);
    const refreshed = await refreshTokenFromTab();
    if (refreshed) {
      return scanOpenBricksTabs(retryCount + 1);
    }
  }

  log("API scan failed, notifying user");
  await notifyApiFailure(result.error);
  return [];
}

async function getCachedToken() {
  const { [AUTH_TOKEN_KEY]: token } = await chrome.storage.local.get(AUTH_TOKEN_KEY);
  return token || null;
}

async function refreshTokenFromTab() {
  const existingTabs = await chrome.tabs.query({ url: `${APP_ORIGIN}/*` });
  let tab;

  if (existingTabs.length > 0) {
    tab = existingTabs[0];
    await chrome.tabs.reload(tab.id);
  } else {
    tab = await chrome.tabs.create({ url: `${APP_ORIGIN}/`, active: false });
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
    log("API direct scan =>", projects.length, "projects");
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

/**
 * Plays a short audible "ding-dong" so the user can catch a notification
 * even when Windows is in fullscreen mode (which suppresses toast banners).
 *
 * Off by default — gated on `options.playSoundOnNotification`. MV3 service
 * workers can't use the Web Audio API directly, so we route playback
 * through an offscreen document with the AUDIO_PLAYBACK reason.
 *
 * Best-effort: failures here never block the notification.
 */
async function playNotificationSound() {
  try {
    const options = await getOptions();
    if (!options.playSoundOnNotification) return;
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: PLAY_SOUND_MESSAGE_TYPE });
  } catch (error) {
    log("playNotificationSound failed:", error?.message || error);
  }
}

let ensureOffscreenInFlight = null;

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  // Coalesce concurrent calls — createDocument throws if invoked twice in parallel.
  if (!ensureOffscreenInFlight) {
    ensureOffscreenInFlight = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play a sound when a Bricks notification fires so the user notices it in fullscreen."
      })
      .finally(() => {
        ensureOffscreenInFlight = null;
      });
  }
  await ensureOffscreenInFlight;
}

async function notifyApiFailure(errorMessage) {
  const notificationId = `bricks-api-error-${generateUniqueId()}`;

  const existingTabs = await chrome.tabs.query({ url: `${APP_ORIGIN}/*` });
  if (existingTabs.length > 0) {
    await chrome.tabs.reload(existingTabs[0].id);
  } else {
    await chrome.tabs.create({ url: `${APP_ORIGIN}/` });
  }

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon-128.png"),
    title: "Bricks Check — Erreur API",
    message: `Impossible de récupérer les projets. ${errorMessage || "Reconnectez-vous sur Bricks.co."}`,
    priority: 2
  });
  playNotificationSound();

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

function generateUniqueId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function shouldNotifyProject(project, options) {
  const hasAvailableBricks = Number(project.availableBricks) > 0;
  if (!hasAvailableBricks) {
    return false;
  }

  if (!options.notifyWhenBelowThreshold) {
    return true;
  }

  if (project.ownedBricks === null || project.ownedBricks === undefined) {
    return false;
  }

  return Number(project.ownedBricks) < Number(options.ownedThreshold);
}

function summarizeAvailableProjects(projects) {
  return projects
    .filter((project) => Number(project.availableBricks || 0) > 0)
    .map((project) => ({
      id: project.id || project.name || "",
      name: project.name || "Projet Bricks",
      availableBricks: Math.max(0, Number(project.availableBricks || 0)),
      ownedBricks: hasKnownOwnedBricks(project.ownedBricks) ? Number(project.ownedBricks) : null,
      ownedBricksSource: project.ownedBricksSource || "",
      url: isProjectUrl(project.url) ? sanitizeBricksUrl(project.url) : ""
    }))
    .sort((left, right) => {
      const byAvailableBricks = right.availableBricks - left.availableBricks;
      return byAvailableBricks || left.name.localeCompare(right.name, "fr");
    });
}

async function notifyProjects(matches, options) {
  let createdCount = 0;
  const seenIds = new Set();

  for (const project of matches) {
    const dedupeKey = project.id || project.name;
    if (dedupeKey && seenIds.has(dedupeKey)) {
      continue;
    }
    if (dedupeKey) {
      seenIds.add(dedupeKey);
    }

    const notificationId = `bricks-${generateUniqueId()}`;
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
    playNotificationSound();

    await trackNotification(notificationId);
    await saveNotificationTarget(notificationId, {
      projectName: project.name,
      projectId: project.id || "",
      url: isProjectUrl(project.url) ? project.url : "",
      bricksToInvest: buyableBricks,
      brickPrice: Number(project.brickPrice) || 10
    });
    createdCount += 1;

    if (options.autopilotEnabled && buyableBricks > 0) {
      log("Autopilot: triggering buy for", project.name);
      await openNotificationProject(notificationId, { autopilot: true });
    }
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

async function openNotificationProject(notificationId, { autopilot = false } = {}) {
  const { notificationLinks = {} } = await chrome.storage.local.get("notificationLinks");
  const target = normalizeNotificationTarget(notificationLinks[notificationId]);

  // Record an auto-invest intent if we have a target with a positive brick count.
  // The content script will pick it up when the project page loads. When
  // `autopilot` is true the content script also clicks the final "Investir X €"
  // button, so the buy happens entirely without user input.
  if (target?.projectId && target.bricksToInvest > 0) {
    await chrome.storage.local.set({
      [PENDING_INVEST_INTENT_KEY]: {
        projectId: target.projectId,
        bricksToInvest: target.bricksToInvest,
        brickPrice: target.brickPrice,
        amountEuros: bricksToInvestEuros(target.bricksToInvest, target.brickPrice),
        autopilot,
        createdAt: Date.now()
      }
    });
    log("Stored invest intent", target.projectId, target.bricksToInvest, "bricks", { autopilot });
  }

  // Open the tab BEFORE clearing state, so a failure to open does not lose the target.
  // Autopilot opens in the background to avoid stealing focus; manual notification
  // clicks open in the foreground because the user explicitly asked to see the page.
  const openActive = !autopilot;
  let opened = true;
  if (target?.url) {
    try {
      await chrome.tabs.create({ url: target.url, active: openActive });
    } catch (error) {
      log("Failed to open project tab", error);
      opened = false;
    }
  } else if (target) {
    try {
      await chrome.tabs.create({ url: `${APP_ORIGIN}/projects`, active: openActive });
    } catch (error) {
      log("Failed to open projects listing", error);
      opened = false;
    }
  }

  if (opened) {
    await deleteNotificationState(notificationId);
    await chrome.notifications.clear(notificationId);
  }
}

function getClearNotificationAlarmName(notificationId) {
  return `${CLEAR_NOTIFICATION_ALARM_PREFIX}${notificationId}`;
}

function normalizeNotificationTarget(rawTarget) {
  if (!rawTarget) {
    return null;
  }

  if (typeof rawTarget === "string") {
    return {
      projectName: "",
      projectId: "",
      url: "",
      bricksToInvest: 0,
      brickPrice: 10
    };
  }

  return {
    projectName: rawTarget.projectName || "",
    projectId: rawTarget.projectId || "",
    url: isProjectUrl(rawTarget.url) ? sanitizeBricksUrl(rawTarget.url) : "",
    bricksToInvest: Math.max(0, Number(rawTarget.bricksToInvest) || 0),
    brickPrice: Number(rawTarget.brickPrice) > 0 ? Number(rawTarget.brickPrice) : 10
  };
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

    log("Using cached ownedBricks for", project.name, "=>", cached.ownedBricks);
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
