import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildProjectInvestPlan,
  bricksToInvestEuros,
  buildOwnedBricksByPropertyId,
  dedupeProjects,
  getProjectDataScore,
  getProjectOwnedThreshold,
  isProjectUrl,
  localizeText,
  mapConfigurableBricksApiProject,
  mapConfigurableBricksApiProjects,
  mapBricksApiProject,
  mapBricksApiProjects,
  normalizeBrickThreshold,
  sanitizeBricksUrl
} from "../shared/projects.js";

describe("localizeText", () => {
  it("returns plain strings as-is", () => {
    assert.equal(localizeText("hello"), "hello");
  });

  it("prefers fr over en", () => {
    assert.equal(localizeText({ fr: "Résidence", en: "Residence" }), "Résidence");
  });

  it("falls back to en when fr is missing", () => {
    assert.equal(localizeText({ en: "Residence" }), "Residence");
  });

  it("falls back to the first available string", () => {
    assert.equal(localizeText({ de: "Wohnsitz" }), "Wohnsitz");
  });

  it("returns empty string for null/undefined", () => {
    assert.equal(localizeText(null), "");
    assert.equal(localizeText(undefined), "");
  });
});

describe("isProjectUrl / sanitizeBricksUrl", () => {
  it("accepts a /project/ URL", () => {
    assert.equal(isProjectUrl("https://app.bricks.co/project/abc"), true);
  });

  it("rejects other origins", () => {
    assert.equal(isProjectUrl("https://evil.example.com/project/abc"), false);
  });

  it("rejects bricks.co with a different path", () => {
    assert.equal(isProjectUrl("https://app.bricks.co/projects"), false);
  });

  it("rejects garbage input", () => {
    assert.equal(isProjectUrl("not a url"), false);
    assert.equal(isProjectUrl(""), false);
  });

  it("sanitizeBricksUrl preserves valid app URLs", () => {
    assert.equal(sanitizeBricksUrl("https://app.bricks.co/anything"), "https://app.bricks.co/anything");
  });

  it("sanitizeBricksUrl falls back to home on wrong origin", () => {
    assert.equal(sanitizeBricksUrl("https://evil.example.com/x"), "https://app.bricks.co/");
  });

  it("sanitizeBricksUrl falls back on garbage", () => {
    assert.equal(sanitizeBricksUrl("not a url"), "https://app.bricks.co/");
  });
});

describe("buildOwnedBricksByPropertyId", () => {
  it("returns an empty map for null portfolio", () => {
    assert.equal(buildOwnedBricksByPropertyId(null).size, 0);
  });

  it("maps propertyId to brickCount", () => {
    const map = buildOwnedBricksByPropertyId({
      ongoing: [{ propertyId: "a", brickCount: 5 }]
    });
    assert.equal(map.get("a"), 5);
  });

  it("keeps the maximum when a property appears in both ongoing and refunded", () => {
    const map = buildOwnedBricksByPropertyId({
      ongoing: [{ propertyId: "a", brickCount: 7 }],
      refunded: [{ propertyId: "a", brickCount: 0 }]
    });
    assert.equal(map.get("a"), 7, "should NOT overwrite 7 with 0");
  });

  it("also keeps max when refunded is higher (edge case)", () => {
    const map = buildOwnedBricksByPropertyId({
      ongoing: [{ propertyId: "a", brickCount: 2 }],
      refunded: [{ propertyId: "a", brickCount: 5 }]
    });
    assert.equal(map.get("a"), 5);
  });

  it("skips entries without propertyId", () => {
    const map = buildOwnedBricksByPropertyId({
      ongoing: [{ brickCount: 5 }, { propertyId: "b", brickCount: 3 }]
    });
    assert.equal(map.size, 1);
    assert.equal(map.get("b"), 3);
  });
});

describe("mapBricksApiProject", () => {
  const baseProperty = () => ({
    id: "prop-1",
    name: { fr: "Résidence Test" },
    listingStatus: "ongoing",
    funding: {
      brickPrice: 1000, // 10 EUR
      amountToFundCents: 100000, // 1000 EUR target
      purchasedBrickCount: 10,   // 100 EUR invested
      autoInvestPurchasedBrickCount: 0,
      startedAt: "2024-01-01T00:00:00Z"
    },
    ownedBricks: 3
  });

  it("maps a valid ongoing project", () => {
    const result = mapBricksApiProject(baseProperty(), new Map());
    assert.ok(result);
    assert.equal(result.id, "prop-1");
    assert.equal(result.name, "Résidence Test");
    assert.equal(result.brickPrice, 10);
    assert.equal(result.targetAmount, 1000);
    assert.equal(result.investedAmount, 100);
    assert.equal(result.availableAmount, 900);
    assert.equal(result.availableBricks, 90);
    assert.equal(result.ownedBricks, 3);
    assert.equal(result.ownedBricksSource, "api");
    assert.equal(result.url, "https://app.bricks.co/project/prop-1");
  });

  it("returns null for unnamed property", () => {
    const property = baseProperty();
    property.name = null;
    assert.equal(mapBricksApiProject(property, new Map()), null);
  });

  it("returns null when listingStatus is not ongoing", () => {
    const property = baseProperty();
    property.listingStatus = "funded";
    assert.equal(mapBricksApiProject(property, new Map()), null);
  });

  it("returns null for future projects", () => {
    const property = baseProperty();
    property.funding.startedAt = new Date(Date.now() + 86400000).toISOString();
    assert.equal(mapBricksApiProject(property, new Map()), null);
  });

  it("returns null when no bricks available", () => {
    const property = baseProperty();
    property.funding.purchasedBrickCount = 100; // fully funded
    assert.equal(mapBricksApiProject(property, new Map()), null);
  });

  it("returns null when hasBricksAvailable is explicitly false", () => {
    const property = baseProperty();
    property.hasBricksAvailable = false;
    assert.equal(mapBricksApiProject(property, new Map()), null);
  });

  it("falls back to portfolio ownership", () => {
    const property = baseProperty();
    delete property.ownedBricks;
    const result = mapBricksApiProject(property, new Map([["prop-1", 12]]));
    assert.equal(result.ownedBricks, 12);
  });

  it("falls back to 0 ownership when nothing known", () => {
    const property = baseProperty();
    delete property.ownedBricks;
    const result = mapBricksApiProject(property, new Map());
    assert.equal(result.ownedBricks, 0);
  });
});

describe("mapBricksApiProjects", () => {
  it("merges ongoing and upcoming", () => {
    const catalog = {
      ongoing: { projects: [{ id: "a", name: "A", listingStatus: "ongoing", funding: { brickPrice: 1000, amountToFundCents: 10000, purchasedBrickCount: 0 } }] },
      upcoming: { projects: [{ id: "b", name: "B", listingStatus: "ongoing", funding: { brickPrice: 1000, amountToFundCents: 10000, purchasedBrickCount: 0 } }] }
    };
    const result = mapBricksApiProjects(catalog, null);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((p) => p.id).sort(), ["a", "b"]);
  });

  it("handles empty/missing catalog", () => {
    assert.deepEqual(mapBricksApiProjects(null, null), []);
    assert.deepEqual(mapBricksApiProjects({}, null), []);
    assert.deepEqual(mapBricksApiProjects({ ongoing: {} }, null), []);
  });
});

describe("mapConfigurableBricksApiProjects", () => {
  it("maps upcoming projects for per-project settings", () => {
    const startsAt = new Date(Date.now() + 86400000).toISOString();
    const result = mapConfigurableBricksApiProject({
      id: "upcoming-1",
      name: { fr: "Résidence Bientôt" },
      funding: { startedAt: startsAt }
    });

    assert.ok(result);
    assert.equal(result.id, "upcoming-1");
    assert.equal(result.name, "Résidence Bientôt");
    assert.equal(result.status, "Prochainement");
    assert.equal(result.url, "https://app.bricks.co/project/upcoming-1");
    assert.equal(result.startsAt, new Date(startsAt).getTime());
  });

  it("maps current ongoing projects for per-project settings", () => {
    const startsAt = new Date(Date.now() - 86400000).toISOString();
    const result = mapConfigurableBricksApiProject({
      id: "ongoing-1",
      name: "Résidence Ouverte",
      funding: { startedAt: startsAt }
    }, { source: "ongoing" });

    assert.ok(result);
    assert.equal(result.id, "ongoing-1");
    assert.equal(result.status, "Collecte en cours");
  });

  it("returns ongoing and upcoming entries", () => {
    const futureStart = new Date(Date.now() + 86400000).toISOString();
    const pastStart = new Date(Date.now() - 86400000).toISOString();
    const catalog = {
      ongoing: {
        projects: [
          { id: "future", name: "Future", funding: { startedAt: futureStart } },
          { id: "current", name: "Current", funding: { startedAt: pastStart } }
        ]
      },
      upcoming: {
        projects: [
          { id: "upcoming", name: "Upcoming", funding: { startedAt: futureStart } }
        ]
      }
    };

    const result = mapConfigurableBricksApiProjects(catalog);
    assert.deepEqual(result.map((project) => project.id).sort(), ["current", "future", "upcoming"]);
    assert.equal(result.find((project) => project.id === "current").status, "Collecte en cours");
  });
});

describe("project threshold overrides", () => {
  it("normalizes brick thresholds", () => {
    assert.equal(normalizeBrickThreshold({ threshold: 50 }), 50);
    assert.equal(normalizeBrickThreshold("42.9"), 42);
    assert.equal(normalizeBrickThreshold(-1), null);
    assert.equal(normalizeBrickThreshold("not a number"), null);
  });

  it("uses per-project overrides before the global threshold", () => {
    const project = { id: "p1", name: "Project" };
    const options = {
      ownedThreshold: 100,
      projectThresholdOverrides: {
        p1: { threshold: 50 }
      }
    };

    assert.equal(getProjectOwnedThreshold(project, options), 50);
  });

  it("falls back to the global threshold", () => {
    const project = { id: "p2", name: "Project" };
    const options = {
      ownedThreshold: 100,
      projectThresholdOverrides: {
        p1: { threshold: 50 }
      }
    };

    assert.equal(getProjectOwnedThreshold(project, options), 100);
  });
});

describe("bricksToInvestEuros", () => {
  it("multiplies bricks by default 10 EUR price", () => {
    assert.equal(bricksToInvestEuros(5), 50);
    assert.equal(bricksToInvestEuros(100), 1000);
  });

  it("uses the provided brickPrice", () => {
    assert.equal(bricksToInvestEuros(3, 20), 60);
  });

  it("rounds to integer euros", () => {
    assert.equal(bricksToInvestEuros(2, 10.5), 21);
    assert.equal(bricksToInvestEuros(3, 10.4), 31); // 31.2 -> 31
  });

  it("returns 0 for zero or negative bricks", () => {
    assert.equal(bricksToInvestEuros(0), 0);
    assert.equal(bricksToInvestEuros(-5), 0);
  });

  it("falls back to 10 EUR when brickPrice is invalid", () => {
    assert.equal(bricksToInvestEuros(5, 0), 50);
    assert.equal(bricksToInvestEuros(5, -1), 50);
    assert.equal(bricksToInvestEuros(5, NaN), 50);
  });
});

describe("buildProjectInvestPlan", () => {
  const catalog = {
    ongoing: {
      projects: [
        {
          id: "p1",
          name: { fr: "Résidence Armée" },
          funding: { brickPrice: 1000 },
          ownedBricks: 12
        }
      ]
    }
  };

  it("targets a single brick for a catalog project (grab mode)", () => {
    const plan = buildProjectInvestPlan("p1", catalog, null);

    assert.ok(plan);
    assert.equal(plan.projectId, "p1");
    assert.equal(plan.projectName, "Résidence Armée");
    assert.equal(plan.ownedBricks, 12);
    assert.equal(plan.bricksToInvest, 1);
    assert.equal(plan.brickPrice, 10);
    assert.equal(plan.amountEuros, 10);
    assert.equal(plan.url, "https://app.bricks.co/project/p1");
    assert.ok(!("ownedThreshold" in plan));
  });

  it("reads owned bricks from the portfolio when the catalog lacks them", () => {
    const withoutOwnedBricks = {
      ongoing: {
        projects: [
          {
            id: "p1",
            name: "Projet Portfolio",
            funding: { brickPrice: 1000 }
          }
        ]
      }
    };
    const plan = buildProjectInvestPlan(
      "p1",
      withoutOwnedBricks,
      { ongoing: [{ propertyId: "p1", brickCount: 7 }] }
    );

    assert.equal(plan.ownedBricks, 7);
    assert.equal(plan.bricksToInvest, 1);
  });

  it("arms a full project absent from the catalog using portfolio + name hint", () => {
    const plan = buildProjectInvestPlan(
      "full-1",
      catalog,
      { ongoing: [{ propertyId: "full-1", brickCount: 1 }] },
      { nameHint: "Hôtel Bastide des Oliviers" }
    );

    assert.ok(plan);
    assert.equal(plan.projectId, "full-1");
    assert.equal(plan.projectName, "Hôtel Bastide des Oliviers");
    assert.equal(plan.ownedBricks, 1);
    assert.equal(plan.bricksToInvest, 1);
    assert.equal(plan.brickPrice, 10);
    assert.equal(plan.amountEuros, 10);
    assert.equal(plan.url, "https://app.bricks.co/project/full-1");
  });

  it("falls back to a generic name when the absent project has no hint", () => {
    const plan = buildProjectInvestPlan("full-2", catalog, null);

    assert.ok(plan);
    assert.equal(plan.projectName, "Projet Bricks");
    assert.equal(plan.ownedBricks, 0);
    assert.equal(plan.bricksToInvest, 1);
  });

  it("returns null only when the project id is empty", () => {
    assert.equal(buildProjectInvestPlan("", catalog, null), null);
  });
});

describe("dedupeProjects / getProjectDataScore", () => {
  const project = (overrides = {}) => ({
    id: "p1",
    name: "Project",
    availableAmount: 1000,
    availableBricks: 50,
    brickPrice: 10,
    investedAmount: 500,
    targetAmount: 1500,
    ownedBricks: 0,
    ownedBricksSource: "api",
    status: "Collecte en cours",
    url: "https://app.bricks.co/project/p1",
    ...overrides
  });

  it("keeps a single entry per id", () => {
    const result = dedupeProjects([project(), project()]);
    assert.equal(result.length, 1);
  });

  it("keeps the highest-scoring duplicate", () => {
    const richer = project({ ownedBricks: 5 });
    const poorer = project({ ownedBricks: 0, url: "" });
    const result = dedupeProjects([poorer, richer]);
    assert.equal(result[0].ownedBricks, 5);
  });

  it("skips projects without an id or name", () => {
    const result = dedupeProjects([project({ id: "", name: "" }), project()]);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "p1");
  });

  it("getProjectDataScore rewards richer data", () => {
    const rich = project({ ownedBricks: 5 });
    const poor = project({ ownedBricks: 0, url: "", availableAmount: 0, targetAmount: 0, availableBricks: 0 });
    assert.ok(getProjectDataScore(rich) > getProjectDataScore(poor));
  });
});
