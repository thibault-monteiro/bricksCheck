import { DEFAULT_OPTIONS } from "./shared/constants.js";
import { formatInteger, normalizeOwnedBricks } from "./shared/utils.js";

const elements = {
  enabled: document.querySelector("#enabled"),
  openOptionsButton: document.querySelector("#openOptionsButton"),
  statusText: document.querySelector("#statusText"),
  nextCheckText: document.querySelector("#nextCheckText"),
  lastCheckText: document.querySelector("#lastCheckText"),
  availableProjects: document.querySelector("#availableProjects"),
  projectWatchMode: document.querySelector("#projectWatchMode"),
  projectWatchStatus: document.querySelector("#projectWatchStatus"),
  startProjectWatchButton: document.querySelector("#startProjectWatchButton"),
  stopProjectWatchButton: document.querySelector("#stopProjectWatchButton"),
  alertHistory: document.querySelector("#alertHistory"),
  clearHistoryButton: document.querySelector("#clearHistoryButton")
};

let nextAlarmTime = null;
let monitoringEnabled = false;
let countdownTimerId = null;

init();

async function init() {
  elements.enabled.addEventListener("change", toggleMonitoring);
  elements.openOptionsButton.addEventListener("click", openOptions);
  elements.startProjectWatchButton.addEventListener("click", startProjectWatch);
  elements.stopProjectWatchButton.addEventListener("click", stopProjectWatch);
  elements.clearHistoryButton.addEventListener("click", clearAlertHistory);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.alertHistory) {
      renderAlertHistory(changes.alertHistory.newValue || []);
    }
    if (areaName === "local" && changes.projectWatchSession) {
      renderProjectWatch(changes.projectWatchSession.newValue || null);
    }
  });
  window.addEventListener("beforeunload", () => {
    if (countdownTimerId !== null) {
      clearInterval(countdownTimerId);
      countdownTimerId = null;
    }
  });

  await refreshAlarmStatus();
  await refreshProjectWatchStatus();
  await loadAlertHistory();
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

async function startProjectWatch() {
  elements.startProjectWatchButton.disabled = true;
  elements.projectWatchStatus.textContent = "Armement de l'onglet projet...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.runtime.sendMessage({
      type: "START_PROJECT_WATCH",
      tabId: tab?.id,
      url: tab?.url || "",
      title: tab?.title || ""
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Impossible d'armer cet onglet.");
    }

    renderProjectWatch(response.session || null);
  } catch (error) {
    elements.projectWatchStatus.textContent = error.message || "Impossible d'armer cet onglet.";
  } finally {
    elements.startProjectWatchButton.disabled = false;
  }
}

async function stopProjectWatch() {
  elements.stopProjectWatchButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: "STOP_PROJECT_WATCH" });
    if (!response?.ok) {
      throw new Error(response?.error || "Impossible d'arrêter la vigie.");
    }
    renderProjectWatch(response.session || null);
  } catch (error) {
    elements.projectWatchStatus.textContent = error.message || "Impossible d'arrêter la vigie.";
  } finally {
    elements.stopProjectWatchButton.disabled = false;
  }
}

async function refreshProjectWatchStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_PROJECT_WATCH_STATUS" });
    renderProjectWatch(response?.session || null);
  } catch {
    renderProjectWatch(null);
  }
}

function renderProjectWatch(session) {
  if (!session) {
    elements.projectWatchStatus.textContent = "Aucun onglet projet armé.";
    elements.projectWatchMode.textContent = "";
    elements.startProjectWatchButton.hidden = false;
    elements.stopProjectWatchButton.hidden = true;
    return;
  }

  elements.projectWatchMode.textContent = session.autopilot ? "autopilot" : "semi-auto";
  const projectName = session.projectName || "Projet Bricks";
  const amount = formatInteger(session.amountEuros || 0);
  const bricks = formatInteger(session.bricksToInvest || 0);
  const details = `${projectName} - ${bricks} brick(s), ${amount} EUR`;

  if (session.active) {
    elements.projectWatchStatus.textContent = `${details}. ${session.message || "Attente du bouton Investir."}`;
    elements.startProjectWatchButton.hidden = true;
    elements.stopProjectWatchButton.hidden = false;
    return;
  }

  elements.projectWatchStatus.textContent = `${details}. ${session.message || "Vigie inactive."}`;
  elements.startProjectWatchButton.hidden = false;
  elements.stopProjectWatchButton.hidden = true;
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

async function loadAlertHistory() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_ALERT_HISTORY" });
    renderAlertHistory(Array.isArray(response?.history) ? response.history : []);
  } catch {
    renderAlertHistory([]);
  }
}

async function clearAlertHistory() {
  elements.clearHistoryButton.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_ALERT_HISTORY" });
    renderAlertHistory([]);
  } finally {
    elements.clearHistoryButton.disabled = false;
  }
}

function renderAlertHistory(history) {
  elements.alertHistory.replaceChildren();

  if (!history || history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "projects-empty";
    empty.textContent = "Aucune alerte enregistrée pour l'instant.";
    elements.alertHistory.append(empty);
    elements.clearHistoryButton.hidden = true;
    return;
  }

  elements.clearHistoryButton.hidden = false;

  const list = document.createElement("ul");
  list.className = "history-list";

  for (const entry of history.slice(0, 50)) {
    const item = document.createElement("li");
    item.className = "history-item";

    const top = document.createElement("div");
    top.className = "history-top";

    const name = document.createElement(entry.url ? "a" : "span");
    name.className = "project-name";
    name.textContent = entry.projectName || "Projet Bricks";
    if (entry.url) {
      name.href = entry.url;
      name.target = "_blank";
      name.rel = "noopener noreferrer";
    }

    const when = document.createElement("span");
    when.className = "history-when";
    when.textContent = formatRelativeDate(entry.at);
    when.title = new Date(entry.at).toLocaleString("fr-FR");

    top.replaceChildren(name, when);

    const details = document.createElement("span");
    details.className = "project-details";
    const available = Math.max(0, Number(entry.availableBricks || 0));
    const buyable = Math.max(0, Number(entry.buyableBricks || 0));
    const owned = entry.ownedBricks === null || entry.ownedBricks === undefined
      ? null
      : Number(entry.ownedBricks);
    const parts = [];
    parts.push(`${formatInteger(available)} dispo`);
    if (buyable > 0) parts.push(`${formatInteger(buyable)} achetable(s)`);
    if (owned !== null) parts.push(`${formatInteger(owned)} possédée(s)`);
    if (entry.autopilot) parts.push("autopilot");
    details.textContent = parts.join(" · ");

    item.replaceChildren(top, details);
    list.append(item);
  }

  elements.alertHistory.append(list);
}

function formatRelativeDate(timestamp) {
  const diffMs = Date.now() - Number(timestamp);
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return new Date(timestamp).toLocaleString("fr-FR");
  }
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `il y a ${days} j`;
  return new Date(timestamp).toLocaleDateString("fr-FR");
}
