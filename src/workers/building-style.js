// @ts-check
// ===================================================================
// Per-building styling: buildingJitterFrac, buildingJitter,
// buildingHeightLightness, buildingTypeKey and their tuning constants.
// Pure functions/constants only, so this file is safe to import from
// wherever tiles are built (building-tile-builder.js bakes these colors
// into the geometry, in the browser's worker and in the offline bake
// alike) and from the main thread (RoadLayer.js uses the same jitter).
// ===================================================================

export const HEIGHT_LIGHTNESS_MIN_H = 3;
export const HEIGHT_LIGHTNESS_MAX_H = 60;
export const HEIGHT_LIGHTNESS_MIN_FACTOR = 0.8;
export const HEIGHT_LIGHTNESS_MAX_FACTOR = 1.2;

export const ROOF_JITTER_RANGE = [0.95, 1.05];
export const WALL_JITTER_RANGE = [0.85, 1.15];
export const WALL_GRADIENT_BASE = 0.82;
export const WINDOW_TILE_M = 3.0;

/**
 * Deterministic pseudo-random draw in [0, 1) from a building's own id, so a
 * building keeps the same shade across reloads, re-bakes and tiers (a random
 * shade per load would make the city flicker between visits). A building with
 * no id at all falls back to Math.random(): it gets *a* shade, just not a
 * stable one -- there is nothing stable to derive it from.
 * @param {string|number|null|undefined} seed
 * @returns {number}
 */
export function buildingJitterFrac(seed) {
  const s = String(seed ?? Math.random());
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000;
}

/** Maps a jitter fraction onto [min, max]. @param {number} frac @param {number} min @param {number} max @returns {number} */
export function buildingJitter(frac, min, max) {
  return min + frac * (max - min);
}

/**
 * Taller buildings render slightly lighter -- a stylised height cue, not
 * lighting simulation: without it a dense skyline reads as one flat mass.
 * @param {number|null|undefined} height metres
 * @returns {number} a brightness multiplier in [HEIGHT_LIGHTNESS_MIN_FACTOR, HEIGHT_LIGHTNESS_MAX_FACTOR]
 */
export function buildingHeightLightness(height) {
  if (height == null) return 1;
  const t = Math.max(0, Math.min(1, (height - HEIGHT_LIGHTNESS_MIN_H) / (HEIGHT_LIGHTNESS_MAX_H - HEIGHT_LIGHTNESS_MIN_H)));
  return HEIGHT_LIGHTNESS_MIN_FACTOR + t * (HEIGHT_LIGHTNESS_MAX_FACTOR - HEIGHT_LIGHTNESS_MIN_FACTOR);
}

/**
 * @typedef {'worship'|'health'|'education'|'industrial'|'commercial'} BuildingTypeKey
 */

/**
 * The building's broad use, from OSM-style tags, for the roof tint and the
 * inspect panel. Checked most-specific-first because one building often
 * carries several tags (a temple tagged both amenity=place_of_worship and
 * historic=* is "worship", not "commercial").
 * @param {Record<string, any>|null|undefined} props
 * @returns {BuildingTypeKey|null}
 */
export function buildingTypeKey(props) {
  const b = props?.building, amenity = props?.amenity, shop = props?.shop;
  if (amenity === 'place_of_worship' || props?.historic) return 'worship';
  if (amenity === 'hospital' || b === 'hospital') return 'health';
  if (amenity === 'school' || amenity === 'university' || amenity === 'college' || b === 'school') return 'education';
  if (b === 'industrial' || b === 'warehouse' || props?.man_made) return 'industrial';
  if (b === 'commercial' || b === 'retail' || shop) return 'commercial';
  return null;
}

/**
 * Numeric codes for the per-building Uint8 columns of a tile's packed
 * metadata (building-tile-builder.js's packBuildingMeta) -- one byte per
 * building instead of a string, because a metro is millions of buildings.
 * The 'null' key is the literal property name JavaScript gives `obj[null]`.
 */
export const TYPE_KEY_CODES = Object.freeze({ null: 0, worship: 1, health: 2, education: 3, industrial: 4, commercial: 5 });
export const HEIGHT_STATUS_CODES = Object.freeze({ null: 0, measured: 1, missing: 2 });

/** The reverse of TYPE_KEY_CODES, code -> key (index 0 is null), for reading a tile's typeCode column back. @type {ReadonlyArray<BuildingTypeKey|null>} */
export const TYPE_KEY_BY_CODE = Object.freeze(
  Object.entries(TYPE_KEY_CODES).reduce((keys, [key, code]) => { keys[code] = key === 'null' ? null : /** @type {BuildingTypeKey} */ (key); return keys; }, /** @type {Array<BuildingTypeKey|null>} */ ([])),
);
