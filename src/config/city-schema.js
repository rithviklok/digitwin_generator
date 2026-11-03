// ===================================================================
// CityConfig — everything the engine needs to know about one city:
// where it is, which data files it has, and how they are to be drawn.
//
// Every layer declares a ROLE, not a name the code would have to know.
// Generic layer code (BuildingLayer, RoadLayer, ...) asks the config
// "which layer(s) have role X", so a new city is a new CityConfig object
// — zero engine/worker code changes, as long as its data is shaped to
// fit the roles below. The server writes one for every uploaded city
// (server/lib/assembleConfig.js); Kanpur's is written by hand
// (cities/kanpur.config.js).
// ===================================================================

/** Canonical layer roles the engine knows how to consume. */
export const LAYER_ROLES = Object.freeze({
  BUILDINGS_3D: 'buildings-3d',       // heavy footprint+height source -> BuildingLayer (worker)
  BUILDING_LABELS: 'building-labels', // name-only source, no 3D geometry
  ROADS: 'roads',                     // road surfaces: a GeoJSON of polygons, or a large city's road-tiles manifest
  RAILWAY: 'railway',
  ADMIN_WARDS: 'admin-wards',
  ADMIN_ZONES: 'admin-zones',
  LANDMARKS: 'landmarks',
  LOCALITIES: 'localities',
  LANDUSE: 'landuse',
  VEGETATION: 'vegetation',
  WATER: 'water',
  AMENITIES: 'amenities',
  CITY_BOUNDARY: 'city-boundary',
});

/**
 * @typedef {Object} CityLayerSpec
 * @property {string} url                 Fetched relative to the config's own location, or absolute.
 * @property {string} role                 One of LAYER_ROLES.
 * @property {boolean} [required]          Logged as an error if it can't be loaded (an optional layer that can't is only noted on screen).
 * @property {number} [fallbackColor]      Hex, used when no palette entry applies.
 * @property {string} [heightProperty]     BUILDINGS_3D only — GeoJSON property holding height in meters (e.g. 'mean', 'height_m').
 * @property {number} [minRenderHeightM]   BUILDINGS_3D only — overrides CityConfig.buildings.minRenderHeightM for this source.
 * @property {string} [sourceUrl]          BUILDINGS_3D only — where the RAW buildings GeoJSON still lives on disk, once `url`
 *   has been switched to point at a pre-tiled manifest.json for BuildingLayer.js to stream. Lets
 *   `scripts/build-building-tiles.mjs --city <id>` find the original input again to regenerate
 *   tiles after the source data changes, without `url` (the runtime-facing field) having to keep
 *   pointing at raw data forever. Omitted for a city that hasn't been tiled yet -- the build
 *   script then reads `url` directly, since that's still the raw file in that case.
 */

/**
 * @typedef {Object} CityConfig
 * @property {string} id                   Slug used as the /public/data/<id>/ folder and the worker cache key.
 * @property {string} displayName
 * @property {{lon:number, lat:number}} origin   Scene-space (0,0) — matches project()'s ORIGIN.
 * @property {{west:number, south:number, east:number, north:number}} bbox
 * @property {CityLayerSpec[]} layers
 * @property {{tileSizeM:number, minRenderHeightM:number, windowMinHeightM:number}} buildings
 * @property {{dayStartHour:number, dayEndHour:number, maxElevationDeg:number, minElevationDeg:number}} sun
 * @property {{endpoint:string, refreshMs:number, apiKey?:string}|null} [weather]
 *   Not part of a city's own file: the server adds its one OpenWeatherMap key when a city is opened
 *   (server/lib/siteWeather.js). Absent or null = no live weather.
 * @property {Partial<import('./palettes.js').DEFAULT_PALETTES>} [palette]  Deep-merged over DEFAULT_PALETTES.
 * @property {{orientationAllowlist?:string[], railwayStationNames?:string[], localityNamesCoveredByStations?:string[]}} [labels]
 *   Curated place-name lists: the places that always show a label, the
 *   stations that are railway rather than metro, and locality names left
 *   unlabelled because a station of the same name marks the spot. Per-city content by nature
 *   (Delhi has no "Panki Thermal Power Station"), so it lives here and not in
 *   the engine. Optional -- omitted lists just mean no curated
 *   orientation labels / no railway-vs-metro station disambiguation for this city.
 * @property {{kindDensityM2PerTree?:Record<string,number>, orchardGridSpacingM?:number, instanceCap?:number}} [trees]
 * @property {{targetFullTierTris?:number, targetMediumTierTris?:number}} [buildingLod]
 *   GPU triangle budgets scripts/build-building-tiles.mjs uses to derive this
 *   city's tier radii from its OWN measured building density (see that
 *   script) -- the only human-set knob in the whole tiered-tile pipeline.
 *   Optional; defaults apply if omitted, so an older CityConfig without this
 *   field still builds.
 */

const REQUIRED_TOP_LEVEL = ['id', 'displayName', 'origin', 'bbox', 'layers', 'buildings', 'sun'];

/**
 * The building tile sizes an UPLOAD may choose, in metres (inclusive) -- the
 * upload form checks it before sending anything, and the server refuses
 * anything else (server/routes/uploads.js). The tile size decides how many
 * files a bake writes: 1 m would be a tile per building, millions of files;
 * 1,000 km one tile too large for a browser to download. Deliberately NOT
 * checked by validateCityConfig(): a city built earlier with an odd size
 * must keep opening.
 */
export const TILE_SIZE_RANGE_M = Object.freeze({ min: 250, max: 20_000 });

/** Defaults for CityConfig.buildingLod when a city omits the field entirely. */
export const DEFAULT_BUILDING_LOD = Object.freeze({ targetFullTierTris: 800000, targetMediumTierTris: 1500000 });

/** CityConfig.buildingLod merged with defaults -- the one place both the build script and any future runtime code should read this from, so neither can drift from the other's idea of the default. */
export function resolveBuildingLod(config) {
  return { ...DEFAULT_BUILDING_LOD, ...(config?.buildingLod ?? {}) };
}

/**
 * Hand-rolled validator, dependency-free on purpose (needs to run inside
 * the worker too, without bundling a schema library into that thread).
 * @param {CityConfig} config
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateCityConfig(config) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (!config || typeof config !== 'object') return { ok: false, errors: ['config is not an object'] };

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in config)) fail(`missing required field "${key}"`);
  }

  if (config.origin && (!Number.isFinite(config.origin.lon) || !Number.isFinite(config.origin.lat))) {
    fail('origin.lon/origin.lat must be finite numbers');
  }

  if (config.bbox) {
    const { west, south, east, north } = config.bbox;
    if (![west, south, east, north].every(Number.isFinite)) fail('bbox fields must be finite numbers');
    else if (west >= east || south >= north) fail('bbox must satisfy west < east and south < north');
  }

  if (!Array.isArray(config.layers) || config.layers.length === 0) {
    fail('layers must be a non-empty array');
  } else {
    const knownRoles = new Set(Object.values(LAYER_ROLES));
    let hasBuildingSource = false;
    config.layers.forEach((layer, i) => {
      if (!layer.url) fail(`layers[${i}] missing url`);
      if (!knownRoles.has(layer.role)) fail(`layers[${i}] has unknown role "${layer.role}"`);
      if (layer.role === LAYER_ROLES.BUILDINGS_3D) {
        hasBuildingSource = true;
        if (!layer.heightProperty) fail(`layers[${i}] (buildings-3d) missing heightProperty`);
      }
    });
    // A city needs at least one building source. Checked here, at config time, not after a failed fetch.
    if (!hasBuildingSource) fail('no layer declares role "buildings-3d" — city would render with no 3D buildings');
  }

  if (config.buildings) {
    const { tileSizeM, minRenderHeightM, windowMinHeightM } = config.buildings;
    if (!Number.isFinite(tileSizeM) || tileSizeM <= 0) fail('buildings.tileSizeM must be a positive number');
    if (!Number.isFinite(minRenderHeightM)) fail('buildings.minRenderHeightM must be a number');
    if (!Number.isFinite(windowMinHeightM)) fail('buildings.windowMinHeightM must be a number');
  }

  if (config.buildingLod) {
    const { targetFullTierTris, targetMediumTierTris } = config.buildingLod;
    if (targetFullTierTris !== undefined && (!Number.isFinite(targetFullTierTris) || targetFullTierTris <= 0)) fail('buildingLod.targetFullTierTris must be a positive number');
    if (targetMediumTierTris !== undefined && (!Number.isFinite(targetMediumTierTris) || targetMediumTierTris <= 0)) fail('buildingLod.targetMediumTierTris must be a positive number');
    if (Number.isFinite(targetFullTierTris) && Number.isFinite(targetMediumTierTris) && targetMediumTierTris < targetFullTierTris) {
      fail('buildingLod.targetMediumTierTris must be >= targetFullTierTris');
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Convenience: layers matching a given role, in declaration order. */
export function layersWithRole(config, role) {
  return config.layers.filter((l) => l.role === role);
}
