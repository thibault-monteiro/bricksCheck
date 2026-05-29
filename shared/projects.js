// Pure project-mapping helpers, extracted from service_worker.js so they can
// be unit-tested in Node without mocking Chrome APIs.

import { APP_ORIGIN } from "./constants.js";
import {
  centsToEuros,
  hasKnownOwnedBricks,
  normalizeOwnedBricks,
  slugify
} from "./utils.js";

/**
 * @typedef {Object} BricksProject
 * @property {string} id
 * @property {string} name
 * @property {number} availableAmount  euros
 * @property {number} availableBricks
 * @property {number} brickPrice       euros
 * @property {number} investedAmount   euros
 * @property {number} targetAmount     euros
 * @property {number|null} ownedBricks null when unknown
 * @property {"api"|"cache"|""} ownedBricksSource
 * @property {string} status
 * @property {string} url
 */

/**
 * @typedef {Object} ConfigurableBricksProject
 * @property {string} id
 * @property {string} name
 * @property {string} status
 * @property {number|null} startsAt
 * @property {number|null} lastSeenAt
 * @property {string} url
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function localizeText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    return value.fr || value.en || Object.values(value).find((text) => typeof text === "string") || "";
  }

  return "";
}

/**
 * @param {string} url
 * @returns {boolean} true if url is a https://app.bricks.co/project/* URL.
 */
export function isProjectUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === APP_ORIGIN && parsed.pathname.startsWith("/project/");
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @returns {string} a safe https://app.bricks.co URL, falling back to the home page.
 */
export function sanitizeBricksUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === APP_ORIGIN ? parsed.href : `${APP_ORIGIN}/`;
  } catch {
    return `${APP_ORIGIN}/`;
  }
}

/**
 * Builds a propertyId -> max brickCount map from a portfolio payload.
 * A property may appear in both `ongoing` and `refunded`; the maximum is kept
 * to avoid overwriting a valid count with 0.
 *
 * @param {*} portfolio
 * @returns {Map<string, number>}
 */
export function buildOwnedBricksByPropertyId(portfolio) {
  const ownedBricksByPropertyId = new Map();
  const projects = [
    ...((portfolio?.ongoing) || []),
    ...((portfolio?.refunded) || [])
  ];

  for (const project of projects) {
    if (!project?.propertyId) {
      continue;
    }
    const incoming = Number(project.brickCount) || 0;
    const previous = ownedBricksByPropertyId.get(project.propertyId) || 0;
    ownedBricksByPropertyId.set(project.propertyId, Math.max(previous, incoming));
  }

  return ownedBricksByPropertyId;
}

/**
 * @param {*} property                raw catalog entry from Bricks API
 * @param {Map<string, number>} ownedBricksByPropertyId
 * @returns {BricksProject | null}    null when the project should be skipped.
 */
export function mapBricksApiProject(property, ownedBricksByPropertyId) {
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
    brickPrice: centsToEuros(brickPriceCents),
    investedAmount: centsToEuros(investedAmountCents),
    targetAmount: centsToEuros(targetAmountCents),
    ownedBricks,
    ownedBricksSource: "api",
    status: "Collecte en cours",
    url: property.id ? `${APP_ORIGIN}/project/${property.id}` : `${APP_ORIGIN}/`
  };
}

/**
 * @param {*} catalog   /projects response
 * @param {*} portfolio /investor/portfolio/properties response (or null)
 * @returns {BricksProject[]}
 */
export function mapBricksApiProjects(catalog, portfolio) {
  const ownedBricksByPropertyId = buildOwnedBricksByPropertyId(portfolio);
  const activeProjects = [
    ...((catalog?.ongoing?.projects) || []),
    ...((catalog?.upcoming?.projects) || [])
  ];

  return activeProjects
    .map((property) => mapBricksApiProject(property, ownedBricksByPropertyId))
    .filter(Boolean);
}

/**
 * @param {*} property raw catalog entry from Bricks API.
 * @param {{ source?: "ongoing"|"upcoming", now?: number, lastSeenAt?: number }} options
 * @returns {ConfigurableBricksProject | null}
 */
export function mapConfigurableBricksApiProject(property, options = {}) {
  const name = localizeText(property?.name) || "";
  if (!name) {
    return null;
  }

  const now = Number(options.now || Date.now());
  const startedAt = property?.funding?.startedAt ? new Date(property.funding.startedAt) : null;
  const startsAt = startedAt && Number.isFinite(startedAt.getTime()) ? startedAt.getTime() : null;
  const isUpcoming = options.source === "upcoming" || (startsAt !== null && startsAt > now);

  return {
    id: property.id || slugify(name),
    name,
    status: isUpcoming ? "Prochainement" : "Collecte en cours",
    startsAt,
    lastSeenAt: Number(options.lastSeenAt || now),
    url: property.id ? `${APP_ORIGIN}/project/${property.id}` : `${APP_ORIGIN}/`
  };
}

/**
 * Returns projects worth exposing in settings.
 *
 * @param {*} catalog /projects response
 * @param {{ now?: number }} options
 * @returns {ConfigurableBricksProject[]}
 */
export function mapConfigurableBricksApiProjects(catalog, options = {}) {
  const now = Number(options.now || Date.now());
  const configurableProjects = [
    ...((catalog?.ongoing?.projects) || []).map((property) => ({ property, source: "ongoing" })),
    ...((catalog?.upcoming?.projects) || []).map((property) => ({ property, source: "upcoming" }))
  ];

  const projectByKey = new Map();
  for (const entry of configurableProjects) {
    const project = mapConfigurableBricksApiProject(entry.property, { source: entry.source, now, lastSeenAt: now });
    if (!project) {
      continue;
    }

    const key = project.id || project.name;
    if (!key) {
      continue;
    }

    const previousProject = projectByKey.get(key);
    if (!previousProject || getConfigurableProjectStatusRank(project) < getConfigurableProjectStatusRank(previousProject)) {
      projectByKey.set(key, project);
    }
  }

  return sortConfigurableProjects([...projectByKey.values()]);
}

/**
 * @param {ConfigurableBricksProject} project
 * @returns {number}
 */
export function getConfigurableProjectStatusRank(project) {
  if (project?.status === "Collecte en cours") return 0;
  if (project?.status === "Collecte récente") return 1;
  if (project?.status === "Prochainement") return 2;
  return 3;
}

/**
 * @param {ConfigurableBricksProject[]} projects
 * @returns {ConfigurableBricksProject[]}
 */
export function sortConfigurableProjects(projects) {
  return [...projects].sort((left, right) => {
    const byStatus = getConfigurableProjectStatusRank(left) - getConfigurableProjectStatusRank(right);
    if (byStatus !== 0) {
      return byStatus;
    }

    const leftTime = left.status === "Prochainement"
      ? left.startsAt || Number.MAX_SAFE_INTEGER
      : -(left.lastSeenAt || 0);
    const rightTime = right.status === "Prochainement"
      ? right.startsAt || Number.MAX_SAFE_INTEGER
      : -(right.lastSeenAt || 0);
    return leftTime - rightTime || left.name.localeCompare(right.name, "fr");
  });
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeBrickThreshold(value) {
  const rawValue = value && typeof value === "object" ? value.threshold : value;
  const threshold = Number(rawValue);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return null;
  }
  return Math.floor(threshold);
}

/**
 * @param {BricksProject|ConfigurableBricksProject} project
 * @param {*} options
 * @returns {number}
 */
export function getProjectOwnedThreshold(project, options) {
  const overrides = options?.projectThresholdOverrides || {};
  const keys = [project?.id, project?.name].filter(Boolean);

  for (const key of keys) {
    const overrideThreshold = normalizeBrickThreshold(overrides[key]);
    if (overrideThreshold !== null) {
      return overrideThreshold;
    }
  }

  return normalizeBrickThreshold(options?.ownedThreshold) ?? 0;
}

/**
 * Computes the euro amount to put in the Bricks invest modal given a
 * project's brick price (euros per brick) and a number of bricks.
 * The Bricks invest input is in euros, not bricks.
 *
 * @param {number} bricks
 * @param {number} brickPriceEuros default 10
 * @returns {number} integer euros, clamped to >= 0.
 */
export function bricksToInvestEuros(bricks, brickPriceEuros = 10) {
  const numBricks = Number(bricks) || 0;
  const numPrice = Number(brickPriceEuros) > 0 ? Number(brickPriceEuros) : 10;
  if (numBricks <= 0) return 0;
  return Math.round(numBricks * numPrice);
}

/**
 * Builds the investment intent for a specific Bricks project from the catalog
 * and portfolio API payloads.
 *
 * This is used by the project-tab watch mode, where the user arms a specific
 * already-open project before the Bricks page enables its invest button. The
 * goal is a "grab": as soon as the button becomes clickable, buy a single
 * brick (the spot that just freed up), so the plan always targets 1 brick.
 *
 * A watched project is often 100% funded and therefore absent from the live
 * /projects catalog (only collecting projects are listed). In that case we
 * still arm the grab from the portfolio (the user owns at least one brick) and
 * the tab title, instead of failing with "project not found".
 *
 * @param {string} projectId
 * @param {*} catalog /projects response
 * @param {*} portfolio /investor/portfolio/properties response (or null)
 * @param {{ nameHint?: string }} options
 * @returns {{
 *   projectId: string,
 *   projectName: string,
 *   url: string,
 *   ownedBricks: number,
 *   bricksToInvest: number,
 *   brickPrice: number,
 *   amountEuros: number
 * } | null}
 */
export function buildProjectInvestPlan(projectId, catalog, portfolio, options = {}) {
  if (!projectId) {
    return null;
  }

  const projects = [
    ...((catalog?.ongoing?.projects) || []),
    ...((catalog?.upcoming?.projects) || [])
  ];
  const property = projects.find((candidate) => candidate?.id === projectId);
  const ownedBricksByPropertyId = buildOwnedBricksByPropertyId(portfolio);
  const ownedFromPortfolio = normalizeOwnedBricks(ownedBricksByPropertyId.get(projectId)) ?? 0;
  const nameHint = typeof options.nameHint === "string" ? options.nameHint.trim() : "";

  if (!property) {
    return {
      projectId,
      projectName: nameHint || "Projet Bricks",
      url: `${APP_ORIGIN}/project/${projectId}`,
      ownedBricks: ownedFromPortfolio,
      bricksToInvest: 1,
      brickPrice: 10,
      amountEuros: 10
    };
  }

  const name = localizeText(property?.name) || nameHint || "Projet Bricks";
  const ownedBricks =
    normalizeOwnedBricks(property?.ownedBricks) ??
    normalizeOwnedBricks(property?.investorBricks?.owned) ??
    normalizeOwnedBricks(ownedBricksByPropertyId.get(property.id)) ??
    0;
  const brickPriceCents = Number(property?.funding?.brickPrice ?? property?.brickPrice ?? 1000);
  const brickPrice = centsToEuros(brickPriceCents > 0 ? brickPriceCents : 1000);

  return {
    projectId: property.id || projectId,
    projectName: name,
    url: `${APP_ORIGIN}/project/${property.id || projectId}`,
    ownedBricks,
    bricksToInvest: 1,
    brickPrice,
    amountEuros: brickPrice
  };
}

/**
 * @param {BricksProject} project
 * @returns {number} higher score = richer data; used to pick the best duplicate.
 */
export function getProjectDataScore(project) {
  let score = 0;
  if (hasKnownOwnedBricks(project.ownedBricks) && Number(project.ownedBricks) > 0) {
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

/**
 * @param {BricksProject[]} projects
 * @returns {BricksProject[]} one entry per id/name, keeping the highest-scoring.
 */
export function dedupeProjects(projects) {
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
