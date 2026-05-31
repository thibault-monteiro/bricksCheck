import { DEFAULT_OPTIONS, AUTH_TOKEN_KEY, API_ORIGIN, APP_ORIGIN } from "./shared/constants.js";
import { formatInteger, hasKnownOwnedBricks } from "./shared/utils.js";
import {
  buildProjectInvestPlan,
  bricksToInvestEuros,
  dedupeProjects,
  getProjectOwnedThreshold,
  isProjectIgnored,
  isProjectUrl,
  mapConfigurableBricksApiProjects,
  mapBricksApiProjects,
  sanitizeBricksUrl,
  sortConfigurableProjects
} from "./shared/projects.js";

const ALARM_NAME = "bricks-check";
const HEARTBEAT_ALARM_NAME = "bricks-heartbeat";
const HEARTBEAT_PERIOD_MINUTES = 0.5;
const CLEAR_NOTIFICATION_ALARM_PREFIX = "bricks-clear-notification:";
const NOTIFICATION_TTL_MINUTES = 0.5;
const OWNED_BRICKS_CACHE_KEY = "ownedBricksByProject";
const OWNED_BRICKS_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_TOKEN_REFRESH_RETRIES = 1;
const PENDING_INVEST_INTENT_KEY = "pendingInvestIntent";
const PENDING_INVEST_INTENT_TTL_MS = 2 * 60 * 1000;
const PROJECT_WATCH_SESSION_KEY = "projectWatchSession";
const LAST_PROJECT_WATCH_KEY = "lastProjectWatch";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const PLAY_SOUND_MESSAGE_TYPE = "BRICKS_PLAY_SOUND";
const ALERT_HISTORY_KEY = "alertHistory";
const ALERT_HISTORY_MAX = 200;
const CONFIGURABLE_PROJECTS_HISTORY_KEY = "configurableProjectsHistory";
const CONFIGURABLE_PROJECTS_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Auto-confirm sweep: when autoConfirmInvestmentPlan is on, periodically open
// the investment-plan page in a background tab (if none is open) so the
// investment_plan.js content script can click "Confirmer". The tab is closed
// again shortly after, unless the user switched to it. This runs independently
// of options.enabled (it's a separate feature toggle).
const AUTO_CONFIRM_ALARM_NAME = "bricks-auto-confirm";
const AUTO_CONFIRM_PERIOD_MINUTES = 360;
const CLOSE_AUTO_CONFIRM_TAB_ALARM_PREFIX = "bricks-close-confirm-tab:";
const AUTO_CONFIRM_TAB_CLOSE_DELAY_MINUTES = 2;

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
  await pruneConfigurableProjectHistory();
  await syncAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await pruneConfigurableProjectHistory();
  await syncAlarm();
});

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

  if (alarm.name === HEARTBEAT_ALARM_NAME) {
    onHeartbeat();
    return;
  }

  if (alarm.name === AUTO_CONFIRM_ALARM_NAME) {
    runAutoConfirmSweep().catch((error) => log("runAutoConfirmSweep failed:", error?.message || error));
    return;
  }

  if (alarm.name.startsWith(CLOSE_AUTO_CONFIRM_TAB_ALARM_PREFIX)) {
    closeAutoConfirmTab(Number(alarm.name.slice(CLOSE_AUTO_CONFIRM_TAB_ALARM_PREFIX.length)));
    return;
  }

  if (alarm.name.startsWith(CLEAR_NOTIFICATION_ALARM_PREFIX)) {
    clearNotificationById(alarm.name.slice(CLEAR_NOTIFICATION_ALARM_PREFIX.length));
  }
});

// chrome.idle wakes the SW immediately when the user unlocks the PC or
// returns from idle, so we don't have to wait up to 30s for the heartbeat
// alarm to notice and resurrect the sub-30s scan chain. We also fire an
// immediate check so the user sees fresh data right after unlocking.
if (chrome.idle?.onStateChanged) {
  chrome.idle.onStateChanged.addListener(async (newState) => {
    if (newState !== "active") return;
    log("Idle state -> active, kicking syncAlarm + runCheck");
    try {
      await syncAlarm();
    } catch (error) {
      log("syncAlarm on idle->active failed:", error?.message || error);
    }
    runCheck().catch((error) => log("Idle wake runCheck failed:", error?.message || error));
  });
}

chrome.notifications.onClicked.addListener((notificationId) => {
  openNotificationProject(notificationId);
});

chrome.notifications.onClosed.addListener((notificationId) => {
  deleteNotificationLink(notificationId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearProjectWatchForTab(tabId).catch((error) => log("clearProjectWatchForTab failed:", error?.message || error));
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

  if (message?.type === "GET_CONFIGURABLE_PROJECTS") {
    getConfigurableProjects()
      .then((projects) => sendResponse({ ok: true, projects }))
      .catch((error) => sendResponse({ ok: false, error: error.message, projects: [] }));
    return true;
  }

  if (message?.type === "GET_ALERT_HISTORY") {
    getAlertHistory()
      .then((history) => sendResponse({ ok: true, history }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLEAR_ALERT_HISTORY") {
    chrome.storage.local
      .set({ [ALERT_HISTORY_KEY]: [] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "START_PROJECT_WATCH") {
    startProjectWatch(message)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "STOP_PROJECT_WATCH") {
    stopProjectWatch("Arrêt manuel")
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_PROJECT_WATCH_STATUS") {
    getProjectWatchStatus()
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: error.message, session: null }));
    return true;
  }

  if (message?.type === "PROJECT_WATCH_BUY_STARTED") {
    markProjectWatchBuying(message, _sender)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PROJECT_WATCH_BUY_ATTEMPTED") {
    markProjectWatchAttempted(message, _sender)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PROJECT_WATCH_REARMED") {
    reactivateProjectWatch(message, _sender)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "INVESTMENT_PLAN_CONFIRMED") {
    notifyInvestmentPlanConfirmed(message.detail).catch((error) =>
      log("notifyInvestmentPlanConfirmed failed:", error?.message || error)
    );
    return false;
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
  await syncAutoConfirmAlarm(options);
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(HEARTBEAT_ALARM_NAME);
  await clearShortInterval();

  if (!options.enabled) {
    return;
  }

  const intervalMinutes = Number(options.intervalMinutes) || 1;

  if (intervalMinutes < 0.5) {
    // chrome.alarms minimum is 30s; use setTimeout for shorter intervals.
    // setTimeout does not survive SW suspension or system sleep — the
    // heartbeat alarm below covers that case.
    const intervalMs = Math.max(5000, intervalMinutes * 60 * 1000);
    await scheduleShortInterval(intervalMs);
  } else {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 0.1,
      periodInMinutes: intervalMinutes
    });
  }

  // Heartbeat: a periodic chrome.alarms tick that survives SW discard
  // and system sleep. On each fire we resurrect the sub-30s timer chain
  // if it died (e.g. SW was discarded after Windows modern standby, or a
  // runCheck error broke the chain).
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, {
    delayInMinutes: HEARTBEAT_PERIOD_MINUTES,
    periodInMinutes: HEARTBEAT_PERIOD_MINUTES
  });
}

async function scheduleShortInterval(intervalMs) {
  await clearShortInterval();
  const nextCheckAt = Date.now() + intervalMs;
  await chrome.storage.local.set({ nextCheckAt });
  shortIntervalTimerId = setTimeout(async () => {
    // Mark the timer slot empty BEFORE running the check, so the heartbeat
    // can detect a dead chain if runCheck or rescheduling throws.
    shortIntervalTimerId = null;
    try {
      await runCheck();
    } catch (error) {
      log("runCheck threw in short-interval chain, continuing:", error?.message || error);
    }
    // Always reschedule if still configured for short intervals — a transient
    // error (network blip, token refresh failure, etc.) must not kill the loop.
    try {
      const options = await getOptions();
      if (options.enabled && Number(options.intervalMinutes) < 0.5) {
        await scheduleShortInterval(intervalMs);
      }
    } catch (error) {
      log("Failed to reschedule short interval, heartbeat will recover:", error?.message || error);
    }
  }, intervalMs);
}

async function onHeartbeat() {
  try {
    const options = await getOptions();
    if (!options.enabled) {
      return;
    }
    const intervalMinutes = Number(options.intervalMinutes) || 1;
    // Only the sub-30s mode uses an in-memory setTimeout chain that can be
    // lost. The chrome.alarms-based mode survives discard natively.
    if (intervalMinutes < 0.5 && shortIntervalTimerId === null) {
      log("Heartbeat: short-interval chain is dead, resurrecting");
      await syncAlarm();
      // Fire a check immediately so the user sees fresh data after
      // returning from a long sleep, rather than waiting up to intervalMs.
      runCheck().catch((error) => log("Heartbeat runCheck failed:", error?.message || error));
    }
  } catch (error) {
    log("onHeartbeat failed:", error?.message || error);
  }
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

    await updateConfigurableProjectHistory(mapConfigurableBricksApiProjects(catalog));
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

async function getConfigurableProjects() {
  const token = await getCachedToken();
  if (!token) {
    const storedProjects = await pruneConfigurableProjectHistory();
    if (storedProjects.length > 0) {
      return storedProjects;
    }
    throw new Error("Connectez-vous sur Bricks.co pour charger les projets configurables.");
  }

  const catalog = await fetchBricksJson("/projects", token);
  return updateConfigurableProjectHistory(mapConfigurableBricksApiProjects(catalog));
}

async function updateConfigurableProjectHistory(projects, now = Date.now()) {
  const { [CONFIGURABLE_PROJECTS_HISTORY_KEY]: storedHistory = {} } = await chrome.storage.local.get(
    CONFIGURABLE_PROJECTS_HISTORY_KEY
  );
  const nextHistory = storedHistory && typeof storedHistory === "object" ? { ...storedHistory } : {};
  const currentProjectIds = new Set();

  for (const project of projects) {
    const key = project?.id || project?.name;
    if (!key) {
      continue;
    }

    currentProjectIds.add(key);
    const previousProject = nextHistory[key] || {};
    nextHistory[key] = {
      ...previousProject,
      id: key,
      name: project.name || previousProject.name || "Projet Bricks",
      status: project.status || previousProject.status || "Projet récent",
      startsAt: project.startsAt ?? previousProject.startsAt ?? null,
      lastSeenAt: now,
      url: isProjectUrl(project.url) ? sanitizeBricksUrl(project.url) : previousProject.url || "",
      updatedAt: now
    };
  }

  const prunedProjects = await savePrunedConfigurableProjectHistory(nextHistory, now);
  return markStaleConfigurableProjects(prunedProjects, currentProjectIds);
}

async function pruneConfigurableProjectHistory(now = Date.now()) {
  const { [CONFIGURABLE_PROJECTS_HISTORY_KEY]: storedHistory = {} } = await chrome.storage.local.get(
    CONFIGURABLE_PROJECTS_HISTORY_KEY
  );
  const projects = await savePrunedConfigurableProjectHistory(
    storedHistory && typeof storedHistory === "object" ? storedHistory : {},
    now
  );
  return markStaleConfigurableProjects(projects);
}

async function savePrunedConfigurableProjectHistory(history, now) {
  const prunedHistory = {};
  for (const [key, project] of Object.entries(history)) {
    const lastSeenAt = Number(project?.lastSeenAt || project?.updatedAt || 0);
    if (!key || !lastSeenAt || now - lastSeenAt > CONFIGURABLE_PROJECTS_HISTORY_MAX_AGE_MS) {
      continue;
    }

    prunedHistory[key] = {
      id: project.id || key,
      name: project.name || "Projet Bricks",
      status: project.status || "Projet récent",
      startsAt: Number(project.startsAt || 0) || null,
      lastSeenAt,
      url: isProjectUrl(project.url) ? sanitizeBricksUrl(project.url) : ""
    };
  }

  const projects = sortConfigurableProjects(Object.values(prunedHistory));
  await chrome.storage.local.set({ [CONFIGURABLE_PROJECTS_HISTORY_KEY]: prunedHistory });
  await pruneProjectThresholdOverrides(projects, now);
  return projects;
}

function markStaleConfigurableProjects(projects, currentProjectIds = new Set()) {
  return sortConfigurableProjects(projects.map((project) => {
    if (currentProjectIds.has(project.id) || project.status !== "Collecte en cours") {
      return project;
    }

    return {
      ...project,
      status: "Collecte récente"
    };
  }));
}

async function pruneProjectThresholdOverrides(recentProjects, now = Date.now()) {
  const { options = DEFAULT_OPTIONS } = await chrome.storage.sync.get({ options: DEFAULT_OPTIONS });
  const currentOptions = { ...DEFAULT_OPTIONS, ...options };
  const overrides = currentOptions.projectThresholdOverrides || {};
  const recentProjectIds = new Set(recentProjects.map((project) => project.id).filter(Boolean));
  const nextOverrides = {};

  for (const [projectId, override] of Object.entries(overrides)) {
    const updatedAt = Number(override?.updatedAt || 0);
    if (recentProjectIds.has(projectId) || (updatedAt && now - updatedAt <= CONFIGURABLE_PROJECTS_HISTORY_MAX_AGE_MS)) {
      nextOverrides[projectId] = override;
    }
  }

  if (Object.keys(nextOverrides).length !== Object.keys(overrides).length) {
    await chrome.storage.sync.set({
      options: {
        ...currentOptions,
        projectThresholdOverrides: nextOverrides
      }
    });
  }
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

async function notifyInvestmentPlanConfirmed(detail) {
  const notificationId = `bricks-invest-confirmed-${generateUniqueId()}`;
  const clean = String(detail || "").replace(/^confirmer\s*/, "").trim();
  const suffix = clean ? ` (${clean})` : "";

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon-128.png"),
    title: "Bricks Check — Investissement confirmé",
    message: `Un investissement automatique en attente a été validé${suffix}.`,
    priority: 2
  });
  playNotificationSound();

  await trackNotification(notificationId);
}

// Keeps the auto-confirm sweep alarm in sync with the toggle. Created with a
// fixed period only when absent, so toggling unrelated options (which also
// fires syncAlarm) never resets the sweep cadence.
async function syncAutoConfirmAlarm(options) {
  if (!options.autoConfirmInvestmentPlan) {
    await chrome.alarms.clear(AUTO_CONFIRM_ALARM_NAME);
    return;
  }
  const existing = await chrome.alarms.get(AUTO_CONFIRM_ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(AUTO_CONFIRM_ALARM_NAME, {
      delayInMinutes: 0.1,
      periodInMinutes: AUTO_CONFIRM_PERIOD_MINUTES
    });
  }
}

// Opens the investment-plan page in a background tab so the iframe content
// script can click "Confirmer". No-op if the page is already open (the content
// script there is already watching) or if the toggle was turned off since the
// alarm was created. A follow-up alarm closes the tab we opened.
async function runAutoConfirmSweep() {
  const options = await getOptions();
  if (!options.autoConfirmInvestmentPlan) {
    await chrome.alarms.clear(AUTO_CONFIRM_ALARM_NAME);
    return;
  }

  const existingTabs = await chrome.tabs.query({ url: `${APP_ORIGIN}/investment-plan*` });
  if (existingTabs.length > 0) {
    log("Auto-confirm sweep: investment-plan already open, leaving it to the content script");
    return;
  }

  const tab = await chrome.tabs.create({ url: `${APP_ORIGIN}/investment-plan`, active: false });
  log("Auto-confirm sweep: opened background investment-plan tab", tab?.id);
  if (tab?.id != null) {
    // Key the close alarm to this tab id so we only ever auto-close the tab we
    // opened, never an investment-plan tab the user opened themselves.
    chrome.alarms.create(`${CLOSE_AUTO_CONFIRM_TAB_ALARM_PREFIX}${tab.id}`, {
      delayInMinutes: AUTO_CONFIRM_TAB_CLOSE_DELAY_MINUTES
    });
  }
}

// Closes a sweep-opened investment-plan tab, but only while it is still a
// background Bricks tab. If the user switched to it or navigated elsewhere, we
// leave it alone.
async function closeAutoConfirmTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.active !== true && typeof tab.url === "string" && tab.url.startsWith(APP_ORIGIN)) {
      await chrome.tabs.remove(tabId);
      log("Auto-confirm sweep: closed background investment-plan tab", tabId);
    } else {
      log("Auto-confirm sweep: tab is active or navigated away, leaving open", tabId);
    }
  } catch (error) {
    log("Auto-confirm sweep: tab already gone or inaccessible", tabId, error?.message || error);
  }
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
  if (isProjectIgnored(project, options)) {
    return false;
  }

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

  return Number(project.ownedBricks) < getProjectOwnedThreshold(project, options);
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
    const ownedThreshold = getProjectOwnedThreshold(project, options);
    const missingBricks = Math.max(0, ownedThreshold - ownedBricks);
    const buyableBricks = Math.min(missingBricks, availableBricks);
    const title = project.name;
    const message =
      buyableBricks > 0
        ? `Achetez-en ${formatInteger(buyableBricks)} (${formatInteger(ownedBricks)}/${formatInteger(ownedThreshold)}, ${formatInteger(availableBricks)} dispo)`
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
    await recordAlertHistory({
      at: Date.now(),
      projectName: project.name || "Projet Bricks",
      projectId: project.id || "",
      availableBricks,
      ownedBricks: hasKnownOwnedBricks(project.ownedBricks) ? Number(project.ownedBricks) : null,
      ownedThreshold,
      buyableBricks,
      url: isProjectUrl(project.url) ? sanitizeBricksUrl(project.url) : "",
      autopilot: Boolean(options.autopilotEnabled && buyableBricks > 0)
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

async function startProjectWatch(message) {
  const target = await normalizeProjectWatchTarget(message);
  const options = await getOptions();
  const plan = await fetchProjectInvestPlan(target.projectId, target.nameHint);

  if (!plan) {
    throw new Error("Projet introuvable dans l'API Bricks.");
  }

  if (isProjectIgnored({ id: plan.projectId, name: plan.projectName }, options)) {
    throw new Error("Projet ignoré — retirez l'ignore dans les objectifs pour l'acheter.");
  }

  // Objective cap: when the "below threshold" mode is on, the armed watch must
  // not push the owned-brick count past the per-project (or global) objective.
  // null = no cap (threshold mode off, or objective of 0/unset → the user armed
  // this tab deliberately to grab, so don't block them with an empty objective).
  const rawThreshold = options.notifyWhenBelowThreshold
    ? getProjectOwnedThreshold({ id: plan.projectId, name: plan.projectName }, options)
    : null;
  const ownedThreshold = rawThreshold !== null && rawThreshold > 0 ? rawThreshold : null;
  if (ownedThreshold !== null && Number(plan.ownedBricks) >= ownedThreshold) {
    throw new Error(`Objectif déjà atteint (${plan.ownedBricks}/${ownedThreshold} briques). Vigie non armée.`);
  }

  const now = Date.now();
  const session = {
    active: true,
    status: "watching",
    tabId: target.tabId,
    projectId: plan.projectId,
    projectName: plan.projectName,
    url: isProjectUrl(target.url) ? sanitizeBricksUrl(target.url) : plan.url,
    ownedBricks: plan.ownedBricks,
    ownedThreshold,
    bricksToInvest: plan.bricksToInvest,
    brickPrice: plan.brickPrice,
    amountEuros: plan.amountEuros,
    autopilot: Boolean(options.autopilotEnabled),
    createdAt: now,
    attached: false,
    message: "Onglet projet armé."
  };

  await chrome.storage.local.set({
    [PROJECT_WATCH_SESSION_KEY]: session,
    [LAST_PROJECT_WATCH_KEY]: session
  });

  const attached = await notifyProjectWatchTab(session);
  const attachedSession = {
    ...session,
    attached,
    message: attached
      ? "Onglet projet armé, attente du bouton Investir."
      : "Onglet projet armé. Recharge initiale lancée pour injecter la vigie."
  };

  await chrome.storage.local.set({
    [PROJECT_WATCH_SESSION_KEY]: attachedSession,
    [LAST_PROJECT_WATCH_KEY]: attachedSession
  });
  return attachedSession;
}

async function normalizeProjectWatchTarget(message) {
  const tabId = Number(message?.tabId || 0);
  if (!tabId) {
    throw new Error("Ouvrez d'abord l'onglet du projet Bricks à surveiller.");
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = message?.url || tab?.url || "";
  const projectId = getProjectIdFromUrl(url);
  if (!projectId) {
    throw new Error("Ouvrez un onglet https://app.bricks.co/project/... puis relancez la vigie.");
  }

  const nameHint = (message?.title || tab?.title || "").replace(/\s*[|·-]\s*Bricks.*$/i, "").trim();
  return { tabId, url, projectId, nameHint };
}

function getProjectIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== APP_ORIGIN) {
      return "";
    }
    const match = parsed.pathname.match(/^\/project\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

async function fetchProjectInvestPlan(projectId, nameHint = "", retryCount = 0) {
  const token = await getCachedToken();
  if (!token) {
    if (retryCount >= MAX_TOKEN_REFRESH_RETRIES) {
      throw new Error("Aucun token Bricks. Connectez-vous sur Bricks.co.");
    }
    const refreshed = await refreshTokenFromTab();
    if (!refreshed) {
      throw new Error("Aucun token Bricks. Connectez-vous sur Bricks.co.");
    }
    return fetchProjectInvestPlan(projectId, nameHint, retryCount + 1);
  }

  try {
    const [catalog, portfolio] = await Promise.all([
      fetchBricksJson("/projects", token),
      fetchBricksJson("/investor/portfolio/properties", token).catch(() => null)
    ]);
    await updateConfigurableProjectHistory(mapConfigurableBricksApiProjects(catalog));
    return buildProjectInvestPlan(projectId, catalog, portfolio, { nameHint });
  } catch (error) {
    const httpStatus = error.httpStatus || 0;
    if ((httpStatus === 401 || httpStatus === 403) && retryCount < MAX_TOKEN_REFRESH_RETRIES) {
      await chrome.storage.local.remove(AUTH_TOKEN_KEY);
      const refreshed = await refreshTokenFromTab();
      if (refreshed) {
        return fetchProjectInvestPlan(projectId, nameHint, retryCount + 1);
      }
    }
    throw error;
  }
}

async function notifyProjectWatchTab(session) {
  try {
    await chrome.tabs.sendMessage(session.tabId, {
      type: "PROJECT_WATCH_SESSION_UPDATED",
      session
    });
    return true;
  } catch (error) {
    log("Project watch content script unavailable, reloading tab once:", error?.message || error);
    try {
      await chrome.tabs.reload(session.tabId);
    } catch (reloadError) {
      log("Project watch initial reload failed:", reloadError?.message || reloadError);
    }
    return false;
  }
}

async function stopProjectWatch(reason = "Vigie arrêtée") {
  const session = await readProjectWatchSession({ includeInactive: true });
  if (!session) {
    return null;
  }

  const stoppedSession = {
    ...session,
    active: false,
    status: "stopped",
    stoppedAt: Date.now(),
    message: reason
  };

  await chrome.storage.local.set({
    [PROJECT_WATCH_SESSION_KEY]: stoppedSession,
    [LAST_PROJECT_WATCH_KEY]: stoppedSession
  });

  try {
    await chrome.tabs.sendMessage(session.tabId, { type: "PROJECT_WATCH_STOPPED" });
  } catch {
    // The tab may have been closed/reloaded already.
  }

  return stoppedSession;
}

async function clearProjectWatchForTab(tabId) {
  const session = await readProjectWatchSession({ includeInactive: false });
  if (!session || Number(session.tabId) !== Number(tabId)) {
    return;
  }
  await stopProjectWatch("Onglet fermé.");
}

async function getProjectWatchStatus() {
  const session = await readProjectWatchSession({ includeInactive: true });
  if (!session) {
    return null;
  }

  return session;
}

async function markProjectWatchBuying(message, sender) {
  const session = await assertProjectWatchSender(message, sender);
  const buyingSession = {
    ...session,
    active: false,
    status: "buying",
    triggeredAt: Date.now(),
    message: session.autopilot
      ? "Bouton détecté, achat automatique lancé."
      : "Bouton détecté, préparation de l'investissement lancée."
  };

  await chrome.storage.local.set({
    [PROJECT_WATCH_SESSION_KEY]: buyingSession,
    [LAST_PROJECT_WATCH_KEY]: buyingSession
  });
  return buyingSession;
}

async function markProjectWatchAttempted(message, sender) {
  const session = await assertProjectWatchSender(message, sender, { includeInactive: true });
  const attemptedSession = {
    ...session,
    active: false,
    status: message?.autopilot ? "attempted" : "readyToConfirm",
    attemptedAt: Date.now(),
    message: message?.autopilot
      ? "Clic final tenté par l'autopilot."
      : "Investissement préparé, confirmation finale laissée à l'utilisateur."
  };

  await chrome.storage.local.set({
    [PROJECT_WATCH_SESSION_KEY]: attemptedSession,
    [LAST_PROJECT_WATCH_KEY]: attemptedSession
  });
  return attemptedSession;
}

async function reactivateProjectWatch(message, sender) {
  const session = await assertProjectWatchSender(message, sender, { includeInactive: true });
  const now = Date.now();

  // Count the buy we just made (optimistic: we don't re-fetch the portfolio).
  const ownedBricks = Number(session.ownedBricks || 0) + 1;
  const cap = session.ownedThreshold;

  // Objective reached → disarm instead of re-arming, so the watch never pushes
  // the owned count past the user's objective.
  if (cap !== null && cap !== undefined && ownedBricks >= cap) {
    const reachedSession = {
      ...session,
      active: false,
      status: "objectiveReached",
      ownedBricks,
      stoppedAt: now,
      message: `Objectif atteint (${ownedBricks}/${cap} briques). Vigie désarmée.`
    };
    await chrome.storage.local.set({
      [PROJECT_WATCH_SESSION_KEY]: reachedSession,
      [LAST_PROJECT_WATCH_KEY]: reachedSession
    });
    return reachedSession;
  }

  const rearmedSession = {
    ...session,
    active: true,
    status: "watching",
    attached: true,
    rearmedAt: now,
    ownedBricks,
    message: "Achat effectué, vigie ré-armée — en attente du prochain créneau."
  };

  await chrome.storage.local.set({
    [PROJECT_WATCH_SESSION_KEY]: rearmedSession,
    [LAST_PROJECT_WATCH_KEY]: rearmedSession
  });
  return rearmedSession;
}

async function assertProjectWatchSender(message, sender, { includeInactive = false } = {}) {
  const session = await readProjectWatchSession({ includeInactive });
  if (!session) {
    throw new Error("Aucune vigie projet active.");
  }
  if (Number(sender?.tab?.id) !== Number(session.tabId)) {
    throw new Error("Message de vigie reçu depuis un autre onglet.");
  }
  if (message?.projectId && message.projectId !== session.projectId) {
    throw new Error("Message de vigie reçu depuis un autre projet.");
  }
  return session;
}

async function readProjectWatchSession({ includeInactive = false } = {}) {
  const { [PROJECT_WATCH_SESSION_KEY]: session } = await chrome.storage.local.get(PROJECT_WATCH_SESSION_KEY);
  if (!session || typeof session !== "object") {
    return null;
  }
  if (!includeInactive && !session.active) {
    return null;
  }
  return session;
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

async function getAlertHistory() {
  const { [ALERT_HISTORY_KEY]: history = [] } = await chrome.storage.local.get(ALERT_HISTORY_KEY);
  return Array.isArray(history) ? history : [];
}

async function recordAlertHistory(entry) {
  try {
    const history = await getAlertHistory();
    const next = [entry, ...history].slice(0, ALERT_HISTORY_MAX);
    await chrome.storage.local.set({ [ALERT_HISTORY_KEY]: next });
  } catch (error) {
    log("recordAlertHistory failed:", error?.message || error);
  }
}
