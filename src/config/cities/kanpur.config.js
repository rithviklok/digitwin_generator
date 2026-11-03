// ===================================================================
// Kanpur's CityConfig — the built-in city, and the only city-specific
// file in src/. Every other city is uploaded, and gets its CityConfig
// from the server.
//
// Its data files live in public/data/kanpur/. The building tiles and the
// raw buildings file they are built from are too large for git, and have
// to be put there separately (HOSTING.md, step 2).
// ===================================================================
import { LAYER_ROLES } from '../city-schema.js';

/** @type {import('../city-schema.js').CityConfig} */
export const kanpurConfig = {
  id: 'kanpur',
  displayName: 'Kanpur',

  // Scene origin = Mall Road / Kanpur Central. Kanpur's building tiles are in metres from this point: move it, and they have to be baked again.
  origin: { lon: 80.3319, lat: 26.4499 },

  // ~27x22 km, padded ~0.02deg past Kanpur's real municipal zones.
  bbox: { west: 80.178, south: 26.315, east: 80.493, north: 26.553 },

  layers: [
    { url: 'data/kanpur/Kanpur_city_boundaries.geojson', role: LAYER_ROLES.CITY_BOUNDARY, required: false, fallbackColor: 0xff8a4d },
    { url: 'data/kanpur/localities.geojson',             role: LAYER_ROLES.LOCALITIES,    required: false },
    { url: 'data/kanpur/kmc_roads.geojson',               role: LAYER_ROLES.ROADS,         required: false },
    { url: 'data/kanpur/kmc_wards.geojson',               role: LAYER_ROLES.ADMIN_WARDS,   required: false },
    { url: 'data/kanpur/kmc_zones.geojson',               role: LAYER_ROLES.ADMIN_ZONES,   required: false },
    { url: 'data/kanpur/kmc_landmarks.geojson',           role: LAYER_ROLES.LANDMARKS,     required: false },

    // Name labels only: the 3D buildings come from the buildings-3d layer
    // below, never from this file.
    // Pre-filtered offline (scripts/extract-building-labels.mjs) down to
    // just the <=400 buildings LabelLayer.js would ever actually label, so
    // the full buildings.geojson (2.4MB, every named building in the
    // city) never has to go through the browser just to have its names
    // read. Re-run that script and regenerate this file whenever
    // buildings.geojson's names/footprints/heights change.
    { url: 'data/kanpur/building_labels.geojson', role: LAYER_ROLES.BUILDING_LABELS, required: false, fallbackColor: 0xc9a86b },

    // The one heavy layer. `url` points at
    // the pre-tiled manifest (scripts/build-building-tiles.mjs, run
    // against sourceUrl below) instead of the raw 280MB file --
    // BuildingLayer.js detects the "manifest.json" filename and streams
    // tiles by camera distance instead of loading the whole city upfront.
    // `sourceUrl` keeps pointing at the original raw file so
    // `build-building-tiles.mjs --city kanpur` can still find it to
    // regenerate tiles whenever that source data changes -- re-run that
    // script after any such change.
    {
      url: 'data/kanpur/tiles/manifest.json', role: LAYER_ROLES.BUILDINGS_3D, required: false, fallbackColor: 0x4d7dff,
      heightProperty: 'mean', sourceUrl: 'data/kanpur/Kanpur_OpenBuildings_2_5D.geojson',
    },

    { url: 'data/kanpur/railways.geojson',   role: LAYER_ROLES.RAILWAY,    required: false },
    { url: 'data/kanpur/landuse.geojson',    role: LAYER_ROLES.LANDUSE,    required: false },
    { url: 'data/kanpur/vegetation.geojson', role: LAYER_ROLES.VEGETATION, required: false },
    { url: 'data/kanpur/amenities.geojson',  role: LAYER_ROLES.AMENITIES,  required: false, fallbackColor: 0xb98aff },
    { url: 'data/kanpur/water.geojson',      role: LAYER_ROLES.WATER,      required: false },
  ],

  buildings: {
    tileSizeM: 2000,           // the side of one building tile
    minRenderHeightM: 1.5,     // buildings lower than this are left out
    windowMinHeightM: 12,      // buildings at least this tall get windows on their walls
  },

  // GPU triangle budgets scripts/build-building-tiles.mjs uses to derive
  // Kanpur's own tier radii from its measured density (tiles ranging ~30
  // to ~218,000 triangles) -- see that script and city-schema.js's
  // resolveBuildingLod(). Each is the most triangles allowed inside a sphere
  // around the camera at that tier, worst case over the whole city (the
  // densest downtown spot): these defaults give a full-detail radius of
  // 1000m and medium of ~1975m. That is the bubble around the camera inside
  // which tiles are always fully loaded, whichever way you're facing --
  // raising the budgets grows it, at a real GPU cost: measured on an
  // integrated Intel UHD GPU, 1.15M/1.75M (=> 1275m/2225m) cost about 20%
  // of panning FPS versus these defaults (a discrete GTX 1650 Ti barely
  // noticed). Re-derive the manifest's radii after changing them, without
  // re-baking any tiles:
  //   node scripts/build-building-tiles.mjs --city kanpur --radii-only
  buildingLod: {
    targetFullTierTris: 800000,
    targetMediumTierTris: 1500000,
  },

  sun: {
    dayStartHour: 6,
    dayEndHour: 18,
    maxElevationDeg: 68,
    minElevationDeg: 8,
  },

  // No `weather` block here: the OpenWeatherMap key is the server's
  // (WEATHER_API_KEY in server/.env), added when the page loads (main.js).

  // No overrides -- Kanpur uses DEFAULT_PALETTES as-is.
  palette: null,

  labels: {
    // Curated always-on orientation labels -- ~24 hand-picked places, not
    // every named feature.
    orientationAllowlist: [
      'Kanpur Chakeri Airport', 'Kanpur Metro Depot', 'Kanpur Goods Yard',
      'Panki Thermal Power Station', 'Central Ordnance Depot Kanpur', 'Ordinance Equipment Factory',
      'Trans Ganga City', 'ICD CONCOR Kanpur', 'Indian Oil Coorporation',
      'govindpuri', 'kulwanti colony', 'model town', 'pandu nagar', 'shastri nagar',
    ],
    // Station points tagged amenity=station in the amenities layer that are
    // actually Indian Railways, not metro -- cross-checked against real
    // data (10 of the 24 station points).
    railwayStationNames: [
      'Kalianpur', 'Kanpur Anwarganj', 'Bhimsen Junction', 'Chakeri', 'Panki',
      'Kanpur Bridge Left Bank', 'Govindpuri', 'Unnao Junction', 'Sirhi Itara', 'Magarwara',
    ],
    // Locality points left unlabelled because a metro station point of the
    // same name marks the place more precisely (these lived in LabelLayer.js
    // until the engine was made free of city names).
    localityNamesCoveredByStations: ['Kalyanpur', 'Nayaganj'],
  },

  trees: {
    // m^2 of polygon area per tree, by vegetation `kind` tag. 'orchard' uses
    // orchardGridSpacingM (a grid) instead of density (random scatter).
    kindDensityM2PerTree: { forest: 90, wood: 90, park: 350 },
    orchardGridSpacingM: 6,
    instanceCap: 40000,
  },
};
