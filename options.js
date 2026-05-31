import { DEFAULT_OPTIONS } from "./shared/constants.js";
import { formatInteger } from "./shared/utils.js";

const elements = {
  enabled: document.querySelector("#enabled"),
  intervalMinutes: document.querySelector("#intervalMinutes"),
  ownedThreshold: document.querySelector("#ownedThreshold"),
  notifyWhenBelowThreshold: document.querySelector("#notifyWhenBelowThreshold"),
  playSoundOnNotification: document.querySelector("#playSoundOnNotification"),
  autopilotEnabled: document.querySelector("#autopilotEnabled"),
  autoConfirmInvestmentPlan: document.querySelector("#autoConfirmInvestmentPlan"),
  saveButton: document.querySelector("#saveButton"),
  checkNowButton: document.querySelector("#checkNowButton"),
  clearNotificationsButton: document.querySelector("#clearNotificationsButton"),
  refreshProjectOverridesButton: document.querySelector("#refreshProjectOverridesButton"),
  statusText: document.querySelector("#statusText"),
  projectOverridesStatus: document.querySelector("#projectOverridesStatus"),
  projectOverridesList: document.querySelector("#projectOverridesList"),
  globalThresholdPreview: document.querySelector("#globalThresholdPreview"),
  nextCheckText: document.querySelector("#nextCheckText"),
  lastCheckText: document.querySelector("#lastCheckText"),
  feedbackText: document.querySelector("#feedbackText")
};

let nextAlarmTime = null;
let countdownTimerId = null;
let configurableProjects = [];
let projectThresholdOverrides = {};

const PROJECT_OVERRIDES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
  elements.refreshProjectOverridesButton.addEventListener("click", loadConfigurableProjects);
  elements.ownedThreshold.addEventListener("input", updateGlobalThresholdPreview);
  window.addEventListener("beforeunload", () => {
    if (countdownTimerId !== null) {
      clearInterval(countdownTimerId);
      countdownTimerId = null;
    }
  });

  await refreshAlarmStatus();
  await loadConfigurableProjects();
  countdownTimerId = setInterval(renderCountdown, 1000);
}

function renderOptions(options) {
  elements.enabled.checked = options.enabled;
  elements.intervalMinutes.value = String(options.intervalMinutes);
  elements.ownedThreshold.value = String(options.ownedThreshold);
  projectThresholdOverrides = sanitizeProjectThresholdOverrides(options.projectThresholdOverrides);
  elements.notifyWhenBelowThreshold.checked = options.notifyWhenBelowThreshold;
  elements.playSoundOnNotification.checked = options.playSoundOnNotification;
  elements.autopilotEnabled.checked = options.autopilotEnabled;
  elements.autoConfirmInvestmentPlan.checked = options.autoConfirmInvestmentPlan;
  elements.statusText.textContent = options.enabled ? "Surveillance active" : "Surveillance inactive";
  renderProjectThresholdOverrides();
}

function readOptions() {
  return {
    enabled: elements.enabled.checked,
    intervalMinutes: Number(elements.intervalMinutes.value),
    ownedThreshold: Math.max(0, Number(elements.ownedThreshold.value || 0)),
    projectThresholdOverrides: readProjectThresholdOverrides(),
    notifyWhenBelowThreshold: elements.notifyWhenBelowThreshold.checked,
    playSoundOnNotification: elements.playSoundOnNotification.checked,
    autopilotEnabled: elements.autopilotEnabled.checked,
    autoConfirmInvestmentPlan: elements.autoConfirmInvestmentPlan.checked
  };
}

async function loadConfigurableProjects() {
  elements.refreshProjectOverridesButton.disabled = true;
  elements.projectOverridesStatus.textContent = "Chargement des projets configurables...";

  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_CONFIGURABLE_PROJECTS" });
    if (!response?.ok) {
      throw new Error(response?.error || "Chargement indisponible.");
    }

    configurableProjects = Array.isArray(response.projects) ? response.projects : [];
    renderProjectThresholdOverrides();
  } catch (error) {
    configurableProjects = [];
    renderProjectThresholdOverrides();
    elements.projectOverridesStatus.textContent = error.message || "Chargement indisponible.";
  } finally {
    elements.refreshProjectOverridesButton.disabled = false;
  }
}

function renderProjectThresholdOverrides() {
  updateGlobalThresholdPreview();
  elements.projectOverridesList.replaceChildren();

  const rows = getProjectOverrideRows();
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "project-overrides-empty";
    empty.textContent = "Aucun projet en collecte ou prochainement détecté.";
    elements.projectOverridesList.append(empty);
    if (!elements.projectOverridesStatus.textContent || elements.projectOverridesStatus.textContent.includes("Chargement")) {
      elements.projectOverridesStatus.textContent = "Aucun projet en collecte ou prochainement détecté.";
    }
    return;
  }

  updateProjectOverridesStatus(
    rows.length,
    rows.filter((project) => projectThresholdOverrides[project.id]).length
  );

  for (const project of rows) {
    const override = projectThresholdOverrides[project.id];
    const row = document.createElement("article");
    row.className = "project-override";
    row.dataset.projectId = project.id;
    row.dataset.projectName = project.name;
    row.dataset.projectUrl = project.url || "";
    row.dataset.projectStatus = project.status || "Prochainement";
    row.dataset.projectLastSeenAt = String(project.lastSeenAt || "");

    const info = document.createElement("div");
    info.className = "project-override-info";

    const name = document.createElement(project.url ? "a" : "span");
    name.className = "project-override-name";
    name.textContent = project.name || "Projet Bricks";
    if (project.url) {
      name.href = project.url;
      name.target = "_blank";
      name.rel = "noopener noreferrer";
    }

    const meta = document.createElement("span");
    meta.className = "project-override-meta";
    meta.textContent = formatProjectMeta(project);

    info.replaceChildren(name, meta);

    const field = document.createElement("label");
    field.className = "project-override-field";

    const label = document.createElement("span");
    label.textContent = "Max";

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.placeholder = `${formatInteger(readGlobalThreshold())}`;
    input.value = override && override.threshold !== null ? String(override.threshold) : "";

    const ignoreField = document.createElement("label");
    ignoreField.className = "project-override-ignore";

    const ignoreInput = document.createElement("input");
    ignoreInput.type = "checkbox";
    ignoreInput.checked = Boolean(override?.ignored);

    const ignoreLabel = document.createElement("span");
    ignoreLabel.textContent = "Ignorer";

    ignoreField.replaceChildren(ignoreInput, ignoreLabel);

    const onRowChange = () => {
      applyIgnoredState(row, ignoreInput.checked, input);
      projectThresholdOverrides = readProjectThresholdOverrides();
      updateProjectOverridesStatus(rows.length);
      renderProjectOverrideStatusPreview(row, input);
    };

    input.addEventListener("input", onRowChange);
    ignoreInput.addEventListener("change", onRowChange);

    field.replaceChildren(label, input);

    const preview = document.createElement("span");
    preview.className = "project-override-preview";

    row.replaceChildren(info, field, ignoreField, preview);
    applyIgnoredState(row, ignoreInput.checked, input);
    renderProjectOverrideStatusPreview(row, input);
    elements.projectOverridesList.append(row);
  }
}

function updateProjectOverridesStatus(rowCount = getProjectOverrideRows().length, activeOverrideCount = countVisibleProjectOverrides()) {
  elements.projectOverridesStatus.textContent =
    activeOverrideCount > 0
      ? `${activeOverrideCount} objectif(s) personnalisé(s).`
      : `${rowCount} projet(s) configurable(s) détecté(s).`;
}

function countVisibleProjectOverrides() {
  return [...elements.projectOverridesList.querySelectorAll('.project-override input[type="number"]')]
    .filter((input) => normalizeProjectThresholdInput(input.value) !== null)
    .length;
}

function getProjectOverrideRows() {
  const byId = new Map();

  for (const project of configurableProjects) {
    if (!project?.id) {
      continue;
    }
    byId.set(project.id, project);
  }

  for (const [id, override] of Object.entries(projectThresholdOverrides)) {
    if (byId.has(id)) {
      continue;
    }

    const updatedAt = Number(override.updatedAt || 0);
    if (!updatedAt || Date.now() - updatedAt > PROJECT_OVERRIDES_MAX_AGE_MS) {
      continue;
    }

    byId.set(id, {
      id,
      name: override.name || "Projet Bricks",
      status: override.status || "Objectif enregistré",
      lastSeenAt: Number(override.lastSeenAt || 0) || null,
      startsAt: null,
      url: override.url || ""
    });
  }

  return [...byId.values()].sort((left, right) => {
    const leftPinned = projectThresholdOverrides[left.id] ? 0 : 1;
    const rightPinned = projectThresholdOverrides[right.id] ? 0 : 1;
    const byStatus = getProjectStatusRank(left) - getProjectStatusRank(right);
    const leftStartsAt = left.startsAt || Number.MAX_SAFE_INTEGER;
    const rightStartsAt = right.startsAt || Number.MAX_SAFE_INTEGER;
    const leftSeenAt = left.lastSeenAt ? -Number(left.lastSeenAt) : 0;
    const rightSeenAt = right.lastSeenAt ? -Number(right.lastSeenAt) : 0;
    return leftPinned - rightPinned || byStatus || leftSeenAt - rightSeenAt || leftStartsAt - rightStartsAt || left.name.localeCompare(right.name, "fr");
  });
}

function getProjectStatusRank(project) {
  if (project.status === "Collecte en cours") return 0;
  if (project.status === "Collecte récente") return 1;
  if (project.status === "Prochainement") return 2;
  return 3;
}

function applyIgnoredState(row, ignored, input) {
  row.classList.toggle("is-ignored", ignored);
  input.disabled = ignored;
}

function renderProjectOverrideStatusPreview(row, input) {
  const preview = row.querySelector(".project-override-preview");
  const ignoreInput = row.querySelector('input[type="checkbox"]');
  if (ignoreInput?.checked) {
    preview.textContent = "Ignoré";
    return;
  }
  const threshold = normalizeProjectThresholdInput(input.value);
  preview.textContent =
    threshold === null
      ? `Global: ${formatInteger(readGlobalThreshold())}`
      : `Objectif: ${formatInteger(threshold)}`;
}

function updateGlobalThresholdPreview() {
  elements.globalThresholdPreview.textContent = `${formatInteger(readGlobalThreshold())} bricks`;
  for (const row of elements.projectOverridesList.querySelectorAll(".project-override")) {
    const input = row.querySelector("input");
    if (input && input.value === "") {
      input.placeholder = `${formatInteger(readGlobalThreshold())}`;
      renderProjectOverrideStatusPreview(row, input);
    }
  }
}

function readGlobalThreshold() {
  return Math.max(0, Math.floor(Number(elements.ownedThreshold.value || 0)));
}

function readProjectThresholdOverrides() {
  const next = {};
  const rows = elements.projectOverridesList.querySelectorAll(".project-override");

  for (const row of rows) {
    const input = row.querySelector('input[type="number"]');
    const ignoreInput = row.querySelector('input[type="checkbox"]');
    const projectId = row.dataset.projectId;
    if (!input || !projectId) {
      continue;
    }

    const threshold = normalizeProjectThresholdInput(input.value);
    const ignored = Boolean(ignoreInput?.checked);
    if (threshold === null && !ignored) {
      delete next[projectId];
      continue;
    }

    next[projectId] = {
      threshold,
      ignored,
      name: row.dataset.projectName || "Projet Bricks",
      status: row.dataset.projectStatus || "Prochainement",
      lastSeenAt: Number(row.dataset.projectLastSeenAt || 0) || null,
      url: row.dataset.projectUrl || "",
      updatedAt: Date.now()
    };
  }

  return sanitizeProjectThresholdOverrides(next);
}

function sanitizeProjectThresholdOverrides(overrides) {
  if (!overrides || typeof overrides !== "object") {
    return {};
  }

  const sanitized = {};
  for (const [projectId, override] of Object.entries(overrides)) {
    if (!projectId) {
      continue;
    }
    const threshold = normalizeProjectThresholdInput(
      override && typeof override === "object" ? override.threshold : override
    );
    const ignored = Boolean(override && typeof override === "object" && override.ignored);
    if (threshold === null && !ignored) {
      continue;
    }

    sanitized[projectId] = {
      threshold,
      ignored,
      name: override?.name || "Projet Bricks",
      status: override?.status || "Objectif enregistré",
      lastSeenAt: Number(override?.lastSeenAt || 0) || null,
      url: override?.url || "",
      updatedAt: Number(override?.updatedAt || 0) || Date.now()
    };
  }
  return sanitized;
}

function normalizeProjectThresholdInput(value) {
  if (value === "") {
    return null;
  }
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return null;
  }
  return Math.floor(threshold);
}

function formatProjectMeta(project) {
  const parts = [project.status || "Prochainement"];
  if (project.status === "Prochainement" && project.startsAt) {
    parts.push(new Date(project.startsAt).toLocaleString("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }));
  } else if (project.lastSeenAt) {
    parts.push(`vu ${formatSeenAt(project.lastSeenAt)}`);
  }
  return parts.join(" · ");
}

function formatSeenAt(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) {
    return "récemment";
  }

  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return `aujourd'hui ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  }

  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short"
  });
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
    await loadConfigurableProjects();
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
