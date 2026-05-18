import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  centsToEuros,
  formatInteger,
  hasKnownOwnedBricks,
  normalizeOwnedBricks,
  slugify
} from "../shared/utils.js";

describe("slugify", () => {
  it("removes diacritics and lowercases", () => {
    assert.equal(slugify("Résidence Île-de-France"), "residence-ile-de-france");
  });

  it("collapses runs of separators", () => {
    assert.equal(slugify("  hello   world  "), "hello-world");
  });

  it("handles purely non-alphanumeric input", () => {
    assert.equal(slugify("---"), "");
  });

  it("stringifies numbers", () => {
    assert.equal(slugify(42), "42");
  });
});

describe("normalizeOwnedBricks / hasKnownOwnedBricks", () => {
  it("returns null for null/undefined", () => {
    assert.equal(normalizeOwnedBricks(null), null);
    assert.equal(normalizeOwnedBricks(undefined), null);
    assert.equal(hasKnownOwnedBricks(null), false);
  });

  it("returns the numeric value for non-negative numbers", () => {
    assert.equal(normalizeOwnedBricks(0), 0);
    assert.equal(normalizeOwnedBricks(42), 42);
    assert.equal(hasKnownOwnedBricks(0), true);
  });

  it("rejects negative numbers", () => {
    assert.equal(normalizeOwnedBricks(-1), null);
  });

  it("rejects NaN / Infinity", () => {
    assert.equal(normalizeOwnedBricks(NaN), null);
    assert.equal(normalizeOwnedBricks(Infinity), null);
  });
});

describe("centsToEuros", () => {
  it("converts cents to euros", () => {
    assert.equal(centsToEuros(100), 1);
    assert.equal(centsToEuros(150), 1.5);
    assert.equal(centsToEuros(12345), 123.45);
  });

  it("returns 0 for nullish/invalid input", () => {
    assert.equal(centsToEuros(null), 0);
    assert.equal(centsToEuros(undefined), 0);
    assert.equal(centsToEuros("abc"), 0);
  });
});

describe("formatInteger", () => {
  it("formats with fr-FR thousand separators", () => {
    // fr-FR uses a non-breaking space U+202F as thousands separator
    // (depending on ICU version: U+00A0 or U+202F). Just check the digits.
    const formatted = formatInteger(12345);
    assert.match(formatted, /^12[\s  ]345$/);
  });

  it("rounds to no decimals", () => {
    assert.equal(formatInteger(1.7), "2");
  });

  it("treats nullish as 0", () => {
    assert.equal(formatInteger(null), "0");
    assert.equal(formatInteger(undefined), "0");
  });
});
