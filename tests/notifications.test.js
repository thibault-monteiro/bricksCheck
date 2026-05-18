import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RENOTIFY_AFTER_MS,
  RENOTIFY_ON_INCREASE_RATIO,
  NOTIFIED_STATE_PRUNE_MS,
  filterProjectsForNotification,
  updateNotifiedStates
} from "../shared/notifications.js";

const NOW = 1_700_000_000_000;

const project = (overrides = {}) => ({
  id: "p1",
  name: "Project",
  availableBricks: 50,
  ...overrides
});

describe("filterProjectsForNotification", () => {
  it("notifies a never-seen project", () => {
    const result = filterProjectsForNotification([project()], {}, NOW);
    assert.equal(result.length, 1);
  });

  it("skips a project notified just now", () => {
    const states = { p1: { notifiedAt: NOW - 1000, availableBricks: 50 } };
    const result = filterProjectsForNotification([project()], states, NOW);
    assert.equal(result.length, 0);
  });

  it("re-notifies after the cooldown elapses", () => {
    const states = { p1: { notifiedAt: NOW - RENOTIFY_AFTER_MS - 1, availableBricks: 50 } };
    const result = filterProjectsForNotification([project()], states, NOW);
    assert.equal(result.length, 1);
  });

  it("re-notifies when available bricks grew by +20%", () => {
    const states = { p1: { notifiedAt: NOW - 1000, availableBricks: 50 } };
    const grown = project({ availableBricks: Math.ceil(50 * RENOTIFY_ON_INCREASE_RATIO) });
    const result = filterProjectsForNotification([grown], states, NOW);
    assert.equal(result.length, 1);
  });

  it("does not re-notify on tiny growth", () => {
    const states = { p1: { notifiedAt: NOW - 1000, availableBricks: 50 } };
    const slightlyGrown = project({ availableBricks: 55 }); // +10%
    const result = filterProjectsForNotification([slightlyGrown], states, NOW);
    assert.equal(result.length, 0);
  });

  it("notifies projects with no key (fallback)", () => {
    const result = filterProjectsForNotification([{ availableBricks: 5 }], {}, NOW);
    assert.equal(result.length, 1);
  });
});

describe("updateNotifiedStates", () => {
  it("records new entries", () => {
    const result = updateNotifiedStates({}, [project()], NOW);
    assert.equal(result.p1.notifiedAt, NOW);
    assert.equal(result.p1.availableBricks, 50);
  });

  it("overwrites old entries with fresh data", () => {
    const old = { p1: { notifiedAt: NOW - 10000, availableBricks: 10 } };
    const result = updateNotifiedStates(old, [project({ availableBricks: 99 })], NOW);
    assert.equal(result.p1.notifiedAt, NOW);
    assert.equal(result.p1.availableBricks, 99);
  });

  it("prunes entries older than 24h", () => {
    const old = {
      p1: { notifiedAt: NOW - NOTIFIED_STATE_PRUNE_MS - 1, availableBricks: 10 },
      p2: { notifiedAt: NOW - 1000, availableBricks: 5 }
    };
    const result = updateNotifiedStates(old, [], NOW);
    assert.equal(result.p1, undefined);
    assert.ok(result.p2);
  });

  it("does not mutate the input", () => {
    const states = { p1: { notifiedAt: NOW - 1000, availableBricks: 5 } };
    const before = JSON.stringify(states);
    updateNotifiedStates(states, [project()], NOW);
    assert.equal(JSON.stringify(states), before);
  });
});
