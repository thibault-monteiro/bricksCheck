const ALARM_NAME = "bricks-check";

const DEFAULT_OPTIONS = {
  enabled: false,
  intervalMinutes: 1,
  ownedThreshold: 100,
  notifyWhenBelowThreshold: true,
  reloadBeforeCheck: true
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

  if (message?.type === "PAGE_SCAN_RESULT") {
    handleProjects(message.projects || [])
      .then((lastCheck) => sendResponse({ ok: true, lastCheck }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
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
    periodInMinutes: Math.max(1, options.intervalMinutes)
  });
}

async function runCheck() {
  const options = await getOptions();
  if (!options.enabled) {
    return saveLastCheck({ checkedAt: Date.now(), matches: [], skipped: true });
  }

  const projects = await scanOpenBricksTabs({ reloadBeforeCheck: options.reloadBeforeCheck });
  if (projects.length === 0) {
    return saveLastCheck({
      checkedAt: Date.now(),
      matches: [],
      projectCount: 0,
      message: "Aucun onglet app.bricks.co lisible. Ouvrez la page Projets Bricks."
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

async function scanOpenBricksTabs({ reloadBeforeCheck = true } = {}) {
  const tabs = await chrome.tabs.query({ url: "https://app.bricks.co/*" });
  if (tabs.length === 0) {
    return [];
  }

  if (reloadBeforeCheck) {
    await Promise.all(tabs.map((tab) => reloadTabAndWait(tab.id)));
  }

  const projectLists = await Promise.all(
    tabs.map(async (tab) => {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_BRICKS_PAGE" });
        return (response?.projects || []).map((project) => ({
          ...project,
          tabId: tab.id
        }));
      } catch {
        return [];
      }
    })
  );

  return dedupeProjects(projectLists.flat());
}

async function reloadTabAndWait(tabId) {
  await chrome.tabs.reload(tabId);
  await waitForTabComplete(tabId);
  await wait(1500);
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

  return Number(project.ownedBricks || 0) < Number(options.ownedThreshold);
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
  const [{ notificationLinks = {} }, activeNotifications] = await Promise.all([
    chrome.storage.local.get("notificationLinks"),
    chrome.notifications.getAll()
  ]);
  const notificationIds = [...new Set([...Object.keys(notificationLinks), ...Object.keys(activeNotifications)])];
  let clearedCount = 0;

  await Promise.all(
    notificationIds.map(async (notificationId) => {
      if (await chrome.notifications.clear(notificationId)) {
        clearedCount += 1;
      }
    })
  );

  await chrome.storage.local.set({ notificationLinks: {} });
  return clearedCount;
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

async function deleteNotificationLink(notificationId) {
  const { notificationLinks = {} } = await chrome.storage.local.get("notificationLinks");
  if (!notificationLinks[notificationId]) {
    return;
  }

  delete notificationLinks[notificationId];
  await chrome.storage.local.set({ notificationLinks });
}

async function openNotificationProject(notificationId) {
  const { notificationLinks = {} } = await chrome.storage.local.get("notificationLinks");
  const target = normalizeNotificationTarget(notificationLinks[notificationId]);
  await deleteNotificationLink(notificationId);
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
