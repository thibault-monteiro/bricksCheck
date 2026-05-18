// Notification deduplication / cooldown logic, kept as pure helpers so they
// can be tested without Chrome APIs.

export const RENOTIFY_AFTER_MS = 30 * 60 * 1000; // 30 minutes
export const RENOTIFY_ON_INCREASE_RATIO = 1.2;    // re-notify on +20% available bricks
export const NOTIFIED_STATE_PRUNE_MS = 24 * 60 * 60 * 1000; // forget entries after 24h

/**
 * @typedef {Object} NotifiedProjectState
 * @property {number} notifiedAt       epoch ms
 * @property {number} availableBricks  snapshot at notification time
 */

/**
 * Filters a list of matching projects down to those we should actually
 * notify about right now. A project is included if:
 *   - it has never been notified, OR
 *   - the cooldown has elapsed since the last notification, OR
 *   - its available brick count has grown significantly (new tranche).
 *
 * @param {Array<{id?: string, name?: string, availableBricks?: number}>} matches
 * @param {Record<string, NotifiedProjectState>} notifiedStates
 * @param {number} now epoch ms
 * @returns {typeof matches}
 */
export function filterProjectsForNotification(matches, notifiedStates, now = Date.now()) {
  return matches.filter((project) => {
    const key = project.id || project.name;
    if (!key) return true;

    const state = notifiedStates[key];
    if (!state) return true;

    const notifiedAt = Number(state.notifiedAt || 0);
    if (now - notifiedAt > RENOTIFY_AFTER_MS) return true;

    const lastBricks = Number(state.availableBricks || 0);
    const currentBricks = Number(project.availableBricks || 0);
    if (lastBricks > 0 && currentBricks >= lastBricks * RENOTIFY_ON_INCREASE_RATIO) {
      return true;
    }

    return false;
  });
}

/**
 * Returns a new states map updated with the projects that were notified,
 * with stale entries (>24h) pruned.
 *
 * @param {Record<string, NotifiedProjectState>} notifiedStates
 * @param {Array<{id?: string, name?: string, availableBricks?: number}>} notifiedProjects
 * @param {number} now epoch ms
 * @returns {Record<string, NotifiedProjectState>}
 */
export function updateNotifiedStates(notifiedStates, notifiedProjects, now = Date.now()) {
  const next = { ...notifiedStates };

  for (const project of notifiedProjects) {
    const key = project.id || project.name;
    if (!key) continue;
    next[key] = {
      notifiedAt: now,
      availableBricks: Math.max(0, Number(project.availableBricks || 0))
    };
  }

  for (const [key, state] of Object.entries(next)) {
    if (now - Number(state.notifiedAt || 0) > NOTIFIED_STATE_PRUNE_MS) {
      delete next[key];
    }
  }

  return next;
}
