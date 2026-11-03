// ===================================================================
// sanitize.js -- validators for anything that becomes a CLI argument
// to the bake (child_process.spawn'd, see jobs/bakeJob.js) or gets
// baked into a path. build-building-tiles.mjs is a developer's CLI with
// no input sanitization of its own -- everything here exists because
// this backend, unlike someone running that script by hand, hands it
// untrusted public input.
// ===================================================================

const HEIGHT_PROPERTY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The GeoJSON property name holding a building's height, as chosen by
 * the uploader (e.g. "height_m", "mean"). Passed to build-building-tiles.mjs
 * as --height-property <value> -- its hand-rolled arg parser treats any
 * value starting with "--" as the start of the NEXT flag instead of this
 * one's argument (see parseArgs in that script), so a value like
 * "--radii-only" would silently inject a different flag entirely rather
 * than erroring. Reject anything that isn't a plain property-name-shaped
 * string before it ever reaches spawn().
 */
export function assertValidHeightProperty(value) {
  if (typeof value !== 'string' || !HEIGHT_PROPERTY_RE.test(value)) {
    throw new Error(`The height property "${value}" can't be used: a property name here may only have letters, digits, "_", "." and "-" (at most 64 characters).`);
  }
  return value;
}

/**
 * The three "generation settings" the uploader reviews/edits before the
 * bake runs -- each just needs to be a finite, positive number; the actual
 * sane range is a matter of taste, not correctness, so this doesn't
 * second-guess a value the uploader deliberately chose to review.
 */
export function assertPositiveNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number, got "${value}"`);
  return n;
}

/**
 * A number that must fall in a range -- for settings whose extremes would
 * harm the server, not just the result (see TILE_SIZE_RANGE_M in city-schema.js).
 * @param {unknown} value @param {string} label - as the uploader sees the field
 * @param {{min: number, max: number}} range - inclusive
 * @returns {number}
 */
export function assertNumberInRange(value, label, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be a number from ${min.toLocaleString('en-IN')} to ${max.toLocaleString('en-IN')}, got "${value}"`);
  return n;
}
