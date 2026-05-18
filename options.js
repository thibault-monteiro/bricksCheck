import { DEFAULT_OPTIONS } from "./shared/constants.js";

const elements = {
  enabled: document.querySelector("#enabled"),
  intervalMinutes: document.querySelector("#intervalMinutes"),
  ownedThreshold: document.querySelector("#ownedThreshold"),
  notifyWhenBelowThreshold: document.querySelector("#notifyWhenBelowThreshold"),
  saveButton: document.querySelector("#saveButton"),
  checkNowButton: document.querySelector("#checkNowButton"),
  clearNotificationsButton: document.querySelector("#clearNotificationsButton"),
  statusText: document.querySelector("#statusText"),
  nextCheckText: document.querySelector("#nextCheckText"),
  lastCheckText: document.querySelector("#lastCheckText"),
  feedbackText: document.querySelector("#feedbackText")
};

let nextAlarmTime = null;
let countdownTimerId = null;

init();

async function init() {
  const { options = DEFAULT_OPTIONS } = await chrome.storage.sync.get({
    options: DEFAULT_OPTIONS
  });
  const { lastCheck } = await chrome.storage.local.get("lastCheck");

  renderOptions({ ...DEFAULT_OPTIONS, ...options });
  renderLastCheck(lastCheck);

  elements.saveButton.addEventListener("click", saveOptions);
  elements.checkNowButton.addEventListener("click", checkNow);
  elements.clearNotificationsButton.addEventListener("click", clearNotifications);
  window.addEventListener("beforeunload", () => {
    if (countdownTimerId !== null) {
      clearInterval(countdownTimerId);
      countdownTimerId = null;
    }
  });

  await refreshAlarmStatus();
  countdownTimerId = setInterval(renderCountdown, 1000);
}

function renderOptions(options) {
  elements.enabled.checked = options.enabled;
  elements.intervalMinutes.value = String(options.intervalMinutes);
  elements.ownedThreshold.value = String(options.ownedThreshold);
  elements.notifyWhenBelowThreshold.checked = options.notifyWhenBelowThreshold;
  elements.statusText.textContent = options.enabled ? "Surveillance active" : "Surveillance inactive";
}

function readOptions() {
  return {
    enabled: elements.enabled.checked,
    intervalMinutes: Number(elements.intervalMinutes.value),
    ownedThreshold: Math.max(0, Number(elements.ownedThreshold.value || 0)),
    notifyWhenBelowThreshold: elements.notifyWhenBelowThreshold.checked
  };
}

async function saveOptions() {
  const options = readOptions();
  elements.saveButton.disabled = true;

  try {
    await chrome.storage.sync.set({ options });
    await chrome.runtime.sendMessage({ type: "OPTIONS_UPDATED" });
    renderOptions(options);
    elements.feedbackText.textContent = "Réglages enregistrés.";
    await refreshAlarmStatus();
    return true;
  } catch (error) {
    elements.feedbackText.textContent = error.message || "L'enregistrement a échoué.";
    return false;
  } finally {
    elements.saveButton.disabled = false;
  }
}

async function checkNow() {
  elements.checkNowButton.disabled = true;
  elements.feedbackText.textContent = "Vérification en cours...";

  try {
    const saved = await saveOptions();
    if (!saved) {
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
    if (!response?.ok) {
      elements.feedbackText.textContent = response?.error || "La vérification a échoué.";
      return;
    }

    renderLastCheck(response.lastCheck);
    elements.feedbackText.textContent = "Vérification terminée.";
    await refreshAlarmStatus();
  } finally {
    elements.checkNowButton.disabled = false;
  }
}

async function clearNotifications() {
  elements.clearNotificationsButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: "CLEAR_NOTIFICATIONS" });
    if (!response?.ok) {
      elements.feedbackText.textContent = response?.error || "La purge des notifications a échoué.";
      return;
    }

    const clearedCount = response.clearedCount || 0;
    elements.feedbackText.textContent =
      clearedCount > 0
        ? `${clearedCount} notification(s) purgée(s).`
        : "Aucune notification active à purger.";
  } finally {
    elements.clearNotificationsButton.disabled = false;
  }
}

async function refreshAlarmStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    nextAlarmTime = response?.nextCheckAt || null;
    elements.statusText.textContent = response?.enabled ? "Surveillance active" : "Surveillance inactive";
    if (response?.lastCheck) {
      renderLastCheck(response.lastCheck);
    }
  } catch {
    nextAlarmTime = null;
  }

  renderCountdown();
}

function renderCountdown() {
  if (!elements.enabled.checked) {
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
    return;
  }

  const checkedAt = new Date(lastCheck.checkedAt).toLocaleString("fr-FR");
  const count = lastCheck.matches?.length || 0;
  const availableCount = lastCheck.availableProjects?.length || 0;
  const notificationCount = lastCheck.notificationCount || 0;
  const notification =
    notificationCount > 0
      ? ` ${notificationCount} notification(s) envoyée(s).`
      : lastCheck.notificationSent
        ? " Notification envoyée."
        : "";
  const suffix = lastCheck.message ? ` ${lastCheck.message}` : notification || " Pas de notification envoyée.";
  elements.lastCheckText.textContent =
    `${checkedAt} - ${count} projet(s) correspondant aux réglages, ${availableCount} collecte(s) avec briques disponibles.${suffix}`;
}
