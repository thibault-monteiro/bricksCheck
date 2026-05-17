const DEFAULT_OPTIONS = {
  enabled: false,
  intervalMinutes: 1,
  ownedThreshold: 100,
  notifyWhenBelowThreshold: true
};

const elements = {
  enabled: document.querySelector("#enabled"),
  openOptionsButton: document.querySelector("#openOptionsButton"),
  statusText: document.querySelector("#statusText"),
  nextCheckText: document.querySelector("#nextCheckText"),
  lastCheckText: document.querySelector("#lastCheckText"),
  availableProjects: document.querySelector("#availableProjects")
};

let nextAlarmTime = null;
let monitoringEnabled = false;
let countdownTimerId = null;

init();

async function init() {
  elements.enabled.addEventListener("change", toggleMonitoring);
  elements.openOptionsButton.addEventListener("click", openOptions);

  await refreshAlarmStatus();
  countdownTimerId = setInterval(renderCountdown, 1000);
}

async function openOptions() {
  if (chrome.runtime.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
}

async function toggleMonitoring() {
  const enabled = elements.enabled.checked;
  elements.enabled.disabled = true;

  try {
    const { options = DEFAULT_OPTIONS } = await chrome.storage.sync.get({
      options: DEFAULT_OPTIONS
    });
    const nextOptions = { ...DEFAULT_OPTIONS, ...options, enabled };
    await chrome.storage.sync.set({ options: nextOptions });
    await chrome.runtime.sendMessage({ type: "OPTIONS_UPDATED" });
    monitoringEnabled = enabled;
    elements.statusText.textContent = enabled ? "Surveillance active" : "Surveillance inactive";
    await refreshAlarmStatus();
  } catch {
    elements.enabled.checked = monitoringEnabled;
    elements.statusText.textContent = "Statut indisponible";
  } finally {
    elements.enabled.disabled = false;
  }
}

async function refreshAlarmStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    monitoringEnabled = Boolean(response?.enabled);
    elements.enabled.checked = monitoringEnabled;
    nextAlarmTime = response?.nextCheckAt || null;
    elements.statusText.textContent = monitoringEnabled ? "Surveillance active" : "Surveillance inactive";
    renderLastCheck(response?.lastCheck || null);
  } catch {
    monitoringEnabled = false;
    elements.enabled.checked = false;
    nextAlarmTime = null;
    elements.statusText.textContent = "Statut indisponible";
  }

  renderCountdown();
}

function renderCountdown() {
  if (!monitoringEnabled) {
    elements.nextCheckText.textContent = "Prochaine vérification: surveillance inactive";
    return;
  }

  if (!nextAlarmTime) {
    elements.nextCheckText.textContent = "Prochaine vérification: en attente";
    return;
  }

  const remainingMs = Math.max(0, nextAlarmTime - Date.now());
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const formatted = minutes > 0 ? `${minutes} min ${String(seconds).padStart(2, "0")} s` : `${seconds} s`;
  elements.nextCheckText.textContent = `Prochaine vérification: dans ${formatted}`;

  if (remainingMs === 0) {
    refreshAlarmStatus();
  }
}

function renderLastCheck(lastCheck) {
  if (!lastCheck) {
    elements.lastCheckText.textContent = "Aucune vérification effectuée.";
    renderAvailableProjects(null);
    return;
  }

  const checkedAt = new Date(lastCheck.checkedAt).toLocaleString("fr-FR");
  const count = lastCheck.matches?.length || 0;
  const notificationCount = lastCheck.notificationCount || 0;
  const notification =
    notificationCount > 0
      ? ` ${notificationCount} notification(s) envoyée(s).`
      : lastCheck.notificationSent
        ? " Notification envoyée."
        : "";
  const suffix = lastCheck.message ? ` ${lastCheck.message}` : notification || " Pas de notification envoyée.";
  elements.lastCheckText.textContent = `${checkedAt} - ${count} projet(s) correspondant aux réglages.${suffix}`;
  renderAvailableProjects(lastCheck);
}

function renderAvailableProjects(lastCheck) {
  if (!lastCheck || lastCheck.skipped) {
    elements.availableProjects.hidden = true;
    elements.availableProjects.replaceChildren();
    return;
  }

  const projects = getAvailableProjects(lastCheck);
  const title = document.createElement("p");
  title.className = "projects-title";
  title.textContent = `Collectes avec briques disponibles (${projects.length})`;

  if (projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "projects-empty";
    empty.textContent = "Aucun projet en collecte avec briques disponibles.";
    elements.availableProjects.replaceChildren(title, empty);
    elements.availableProjects.hidden = false;
    return;
  }

  const list = document.createElement("ul");
  list.className = "projects-list";

  for (const project of projects) {
    const item = document.createElement("li");
    item.className = "project";

    const name = document.createElement(project.url ? "a" : "span");
    name.className = "project-name";
    name.textContent = project.name || "Projet Bricks";
    if (project.url) {
      name.href = project.url;
      name.target = "_blank";
      name.rel = "noopener noreferrer";
    }

    const details = document.createElement("span");
    details.className = "project-details";
    const availableBricks = Math.max(0, Number(project.availableBricks || 0));
    const ownedBricks = normalizeOwnedBricks(project.ownedBricks);
    details.textContent =
      ownedBricks === null
        ? `${formatInteger(availableBricks)} dispo`
        : `${formatInteger(availableBricks)} dispo · ${formatInteger(ownedBricks)} possédée(s)`;

    item.replaceChildren(name, details);
    list.append(item);
  }

  elements.availableProjects.replaceChildren(title, list);
  elements.availableProjects.hidden = false;
}

function getAvailableProjects(lastCheck) {
  const projects = Array.isArray(lastCheck.availableProjects)
    ? lastCheck.availableProjects
    : Array.isArray(lastCheck.matches)
      ? lastCheck.matches
      : [];

  return projects.filter((project) => Number(project.availableBricks || 0) > 0);
}

function normalizeOwnedBricks(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
}

function formatInteger(value) {
  return new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}
