// Shared pure helpers reused across service worker, popup, and options pages.

// Combining diacritical marks block: U+0300..U+036F.
// Built via RegExp constructor so the source uses escape sequences
// rather than literal combining characters (more portable / linter-friendly).
const DIACRITICS_REGEX = new RegExp("[\\u0300-\\u036f]", "g");

const INTEGER_FORMATTER = new Intl.NumberFormat("fr-FR", {
  maximumFractionDigits: 0
});

/**
 * @param {unknown} value
 * @returns {string} lowercase ASCII slug, e.g. "résidence île-de-france" -> "residence-ile-de-france"
 */
export function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(DIACRITICS_REGEX, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * @param {unknown} value
 * @returns {number | null} finite non-negative number, or null when unknown / invalid.
 */
export function normalizeOwnedBricks(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasKnownOwnedBricks(value) {
  return normalizeOwnedBricks(value) !== null;
}

/**
 * @param {unknown} value
 * @returns {string} value formatted with fr-FR locale and no decimals.
 */
export function formatInteger(value) {
  return INTEGER_FORMATTER.format(Number(value || 0));
}

/**
 * @param {unknown} value cents
 * @returns {number} euros, rounded to 2 decimals.
 */
export function centsToEuros(value) {
  const cents = Number(value || 0);
  return Number.isFinite(cents) ? Number((cents / 100).toFixed(2)) : 0;
}
