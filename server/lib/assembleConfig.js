// ===================================================================
// assembleConfig.js -- turns one city's rows (cities + layer_files) +
// a finished bake into the actual CityConfig object the front end's
// TwinEngine consumes, and self-checks it against the SAME
// validateCityConfig() the main app uses (imported directly from
// src/config/city-schema.js, not reimplemented -- so this can never
// quietly drift from what the engine actually requires).
//
// Every layer file for a given job lives under
//   storage/cities/<cityId>/<jobId>/data/<cityId>/<role>.geojson
// (light roles; a large city's roads are .../roads/manifest.json and its
// tiles instead, see roadTiles.js) or .../data/<cityId>/tiles/manifest.json
// (buildings-3d, written by build-building-tiles.mjs itself) -- a deliberate mirror of
// how public/data/kanpur/ is laid out, so the same relative shape
// applies whether a city is Kanpur's static import or an uploaded one
// served over HTTP. Served at /files/<cityId>/<jobId>/... (see app.js).
// ===================================================================
import { LAYER_ROLES, validateCityConfig } from '../../src/config/city-schema.js';
import { ROAD_TILES_DIR } from './roadTiles.js';

const ROLE_FILENAME = {
  [LAYER_ROLES.CITY_BOUNDARY]: 'city-boundary.geojson',
  [LAYER_ROLES.LOCALITIES]: 'localities.geojson',
  [LAYER_ROLES.ROADS]: 'roads.geojson',
  [LAYER_ROLES.RAILWAY]: 'railway.geojson',
  [LAYER_ROLES.ADMIN_WARDS]: 'admin-wards.geojson',
  [LAYER_ROLES.ADMIN_ZONES]: 'admin-zones.geojson',
  [LAYER_ROLES.LANDMARKS]: 'landmarks.geojson',
  [LAYER_ROLES.LANDUSE]: 'landuse.geojson',
  [LAYER_ROLES.VEGETATION]: 'vegetation.geojson',
  [LAYER_ROLES.WATER]: 'water.geojson',
  [LAYER_ROLES.AMENITIES]: 'amenities.geojson',
};

/**
 * @param {object} args
 * @param {string} args.cityId
 * @param {string} args.jobId
 * @param {string} args.displayName
 * @param {{lon:number, lat:number}} args.origin
 * @param {{west:number, south:number, east:number, north:number}} args.bbox
 * @param {{tileSizeM:number, minRenderHeightM:number, windowMinHeightM:number}} args.buildings
 * @param {string} args.heightProperty
 * @param {Array<{role:string, source:'manual'|'osm-derived', tiled?: boolean}>} args.lightLayers - which optional roles actually have a file for this job; `tiled`: a large city's roads, written as tiles
 * @param {{railwayStationNames?: string[]}} [args.labels] - from the OpenStreetMap download (jobHooks.js): which station names are railway, not metro
 * @param {string} args.publicApiBaseUrl
 * @returns {{ok: boolean, config: object|null, errors: string[]}}
 */
export function assembleCityConfig(args) {
  const filesBaseUrl = `${args.publicApiBaseUrl}/files/${args.cityId}/${args.jobId}/data/${args.cityId}`;

  const layers = [
    {
      url: `${filesBaseUrl}/tiles/manifest.json`,
      role: LAYER_ROLES.BUILDINGS_3D,
      required: true,
      heightProperty: args.heightProperty,
    },
  ];

  for (const { role, source, tiled } of args.lightLayers) {
    // Roads written as tiles are reached through their manifest; RoadLayer tells the two apart by that name, as BuildingLayer does.
    const filename = tiled ? `${ROAD_TILES_DIR}/manifest.json` : ROLE_FILENAME[role];
    if (!filename) continue; // BUILDINGS_3D / BUILDING_LABELS aren't in this table: the first is added above, the second isn't offered for uploads
    // `source` ('manual' | 'osm-derived') isn't part of city-schema.js's
    // CityLayerSpec typedef -- validateCityConfig() doesn't check for
    // unknown properties, so this rides along harmlessly for every other
    // consumer. It exists so CoverageView.js ("What's on this map")
    // can tell "a presumably-authoritative upload" from "buffered by the
    // OSM auto-splitter, not a surveyed dataset" without a second,
    // uploaded-city-only API call the front end would have to special-case.
    layers.push({ url: `${filesBaseUrl}/${filename}`, role, required: false, source });
  }

  const config = {
    id: args.cityId,
    displayName: args.displayName,
    origin: args.origin,
    bbox: args.bbox,
    layers,
    buildings: args.buildings,
    sun: { dayStartHour: 6, dayEndHour: 18, maxElevationDeg: 60, minElevationDeg: 8 }, // the same for every uploaded city: right in spirit for India, though the real values depend on the city's latitude
    ...(args.labels ? { labels: args.labels } : {}),
    // No `weather` here: the site's one key is added when the city is opened (siteWeather.js).
  };

  const { ok, errors } = validateCityConfig(config);
  return { ok, config: ok ? config : null, errors };
}
