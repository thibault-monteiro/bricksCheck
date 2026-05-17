const DEFAULT_OPTIONS = {
  enabled: false,
  intervalMinutes: 1,
  ownedThreshold: 100,
  notifyWhenBelowThreshold: true,
  reloadBeforeCheck: true
};

const elements = {
  enabled: document.querySelector("#enabled"),
  intervalMinutes: document.querySelector("#intervalMinutes"),
  ownedThreshold: document.querySelector("#ownedThreshold"),
  notifyWhenBelowThreshold: document.querySelector("#notifyWhenBelowThreshold"),
  reloadBeforeCheck: document.querySelector("#reloadBeforeCheck"),
  saveButton: document.querySelector("#saveButton"),
  checkNowButton: document.querySelector("#checkNowButton"),
  statusText: document.querySelector("#statusText"),
  nextCheckText: document.querySelector("#nextCheckText"),
  lastCheckText: document.querySelector("#lastCheckText")
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

  await refreshAlarmStatus();
  countdownTimerId = setInterval(renderCountdown, 1000);
}

function renderOptions(options) {
  elements.enabled.checked = options.enabled;
  elements.intervalMinutes.value = String(options.intervalMinutes);
  elements.ownedThreshold.value = String(options.ownedThreshold);
  elements.notifyWhenBelowThreshold.checked = options.notifyWhenBelowThreshold;
  elements.reloadBeforeCheck.checked = options.reloadBeforeCheck;
  elements.statusText.textContent = options.enabled ? "Surveillance active" : "Surveillance inactive";
}

function readOptions() {
  return {
    enabled: elements.enabled.checked,
    intervalMinutes: Number(elements.intervalMinutes.value),
    ownedThreshold: Math.max(0, Number(elements.ownedThreshold.value || 0)),
    notifyWhenBelowThreshold: elements.notifyWhenBelowThreshold.checked,
    reloadBeforeCheck: elements.reloadBeforeCheck.checked
  };
}

async function saveOptions() {
  const options = readOptions();
  elements.saveButton.disabled = true;

  try {
    await chrome.storage.sync.set({ options });
    await chrome.runtime.sendMessage({ type: "OPTIONS_UPDATED" });
    renderOptions(options);
    elements.lastCheckText.textContent = "Réglages enregistrés.";
    await refreshAlarmStatus();
  } finally {
    elements.saveButton.disabled = false;
  }
}

async function checkNow() {
  elements.checkNowButton.disabled = true;
  elements.lastCheckText.textContent = "Vérification en cours...";

  try {
    await saveOptions();
    const response = await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
    if (!response?.ok) {
      elements.lastCheckText.textContent = response?.error || "La vérification a échoué.";
      return;
    }

    renderLastCheck(response.lastCheck);
    await refreshAlarmStatus();
  } finally {
    elements.checkNowButton.disabled = false;
  }
}

async function refreshAlarmStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    nextAlarmTime = response?.nextCheckAt || null;
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
  const notificationCount = lastCheck.notificationCount || 0;
  const notification =
    notificationCount > 0
      ? ` ${notificationCount} notification(s) envoyée(s).`
      : lastCheck.notificationSent
        ? " Notification envoyée."
        : "";
  const suffix = lastCheck.message ? ` ${lastCheck.message}` : notification || " Pas de notification envoyée.";
  elements.lastCheckText.textContent = `${checkedAt} - ${count} projet(s) correspondant aux réglages.${suffix}`;
}
