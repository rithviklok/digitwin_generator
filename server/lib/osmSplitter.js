// ===================================================================
// osmSplitter.js -- turns OpenStreetMap features (GeoJSON, OSM tags in
// `properties`) into the role files the viewer renders: roads, railway,
// amenities, localities, land use, vegetation, water. The features come
// from the server's own Overpass download (overpass.js) or from an OSM
// export the uploader made themselves (Overpass Turbo, BBBike, HOT
// Export Tool -- all keep tags in `properties`). Each role's output
// mirrors the shape of Kanpur's own hand-built file for that role
// (public/data/kanpur/*.geojson), since that's what the layers were
// written and tuned against.
//
// Written for every city in India, not just Kanpur: the tagging below
// covers coastal cities (sea from the coastline, mangroves, beaches, salt
// pans, aquaculture ponds), cantonments, peri-urban farmland, and the
// India-specific ways stations are tagged (halts, metro as subway/
// light_rail).
//
// createLayerNormalizer() applies the same rules to a single-layer file the
// uploader supplies instead (a municipal survey, or one layer exported
// from OSM by hand), so what reaches the viewer has one shape whatever
// its source.
// ===================================================================
import { buffer } from '@turf/turf';
import { LAYER_ROLES } from '../../src/config/city-schema.js';
import { seaPolygons } from './coastline.js';

/**
 * Road surface width, in order of trust:
 *   1. the road's own OSM `width` tag, in metres (mapped from imagery or
 *      on the ground -- right for THAT road);
 *   2. its `lanes` tag x the Indian Roads Congress lane width (3.5 m per
 *      lane on multi-lane roads, 3.75 m for a single lane);
 *   3. a per-class default built from the same IRC carriageway widths
 *      (single lane 3.75 m, intermediate 5.5 m, two-lane 7.0 m, two-lane
 *      with kerbs 7.5 m, 3.5 m per extra lane) and a typical lane count
 *      for that class in Indian cities.
 * These are national standards, not one city's measurements. Kanpur's
 * surveyed roads are only a cross-check -- they land where the defaults
 * predict (local 3.6 m vs 3.75, secondary 6.8 m vs 7.0, major 8.5 m within
 * the 7.5-14 m range). A city's own road survey, uploaded as its roads
 * layer, beats all three.
 */
const IRC_LANE_M = 3.5;
const IRC_SINGLE_LANE_M = 3.75;
/** Two-way width by class (IRC carriageway x typical lanes). */
export const HIGHWAY_WIDTH_M = {
  motorway: 14, trunk: 14, // 4-lane divided expressway / NH
  primary: 7.5, secondary: 7.0, // two-lane (primary usually kerbed in town)
  tertiary: 5.5, unclassified: 5.5, // intermediate lane
  residential: IRC_SINGLE_LANE_M, living_street: IRC_SINGLE_LANE_M, road: IRC_SINGLE_LANE_M,
  service: 3.0, track: 3.0, pedestrian: 4.0,
  footway: 2.0, cycleway: 2.0, path: 2.0, steps: 2.0,
};
/** One carriageway of a divided road (mapped in OSM as two one-way ways). Links/ramps are single-lane. */
const ONEWAY_WIDTH_M = { motorway: 7.0, trunk: 7.0, primary: 7.0, secondary: 5.5, tertiary: IRC_SINGLE_LANE_M };
const LINK_WIDTH_M = IRC_SINGLE_LANE_M;
const DEFAULT_HIGHWAY_WIDTH_M = IRC_SINGLE_LANE_M;

/** "7", "7.5 m", "7,5" -> metres; anything else (feet, ranges, "narrow") -> null. */
function metresTag(v) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:m|metres?|meters?)?\s*$/i.exec(v ?? '');
  const n = m ? Number(m[1].replace(',', '.')) : NaN;
  return n >= 1.5 && n <= 60 ? n : null;
}

/** @returns {{width: number, source: 'width-tag'|'lanes-tag'|'class-default'}} */
export function roadWidth(tags) {
  const tagged = metresTag(tags.width) ?? metresTag(tags['width:carriageway']);
  if (tagged) return { width: tagged, source: 'width-tag' };
  const lanes = Number(tags.lanes);
  if (Number.isInteger(lanes) && lanes >= 1 && lanes <= 12) return { width: lanes === 1 ? IRC_SINGLE_LANE_M : lanes * IRC_LANE_M, source: 'lanes-tag' };
  const cls = String(tags.highway ?? '');
  if (cls.endsWith('_link')) return { width: LINK_WIDTH_M, source: 'class-default' };
  const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout';
  return { width: (oneway && ONEWAY_WIDTH_M[cls]) || HIGHWAY_WIDTH_M[cls] || DEFAULT_HIGHWAY_WIDTH_M, source: 'class-default' };
}

/**
 * RoadLayer.js styles roads by KMC's numeric class tiers (0 = major
 * arterial, 1 = sub-arterial, 2 = local), so OSM classes are mapped onto
 * them -- a string class would silently render every road, national
 * highways included, as a back lane.
 */
function roadTier(highway) {
  const base = String(highway ?? '').replace(/_link$/, '');
  if (['motorway', 'trunk', 'primary'].includes(base)) return 0;
  if (['secondary', 'tertiary'].includes(base)) return 1;
  return 2;
}

/** Every role this module can produce, in the order they're reported. Taken from LAYER_ROLES (not retyped) because these strings flow on
 * into layer_files.role and assembleConfig.js's ROLE_FILENAME -- a typo here would silently drop a whole layer from the city. The
 * splitter below indexes `out` by the same values ('roads', 'railway', …). */
export const OSM_ROLES = [
  LAYER_ROLES.ROADS, LAYER_ROLES.RAILWAY, LAYER_ROLES.AMENITIES, LAYER_ROLES.LOCALITIES,
  LAYER_ROLES.LANDUSE, LAYER_ROLES.VEGETATION, LAYER_ROLES.WATER,
];

const WATER_LANDUSE = { reservoir: 'reservoir', basin: 'basin', salt_pond: 'salt_pan', aquaculture: 'fish_pond' };
const GREEN_LEISURE = new Set(['park', 'garden', 'recreation_ground', 'golf_course', 'village_green', 'dog_park']);
const GREEN_NATURAL = new Set(['wood', 'scrub', 'grassland', 'heath', 'wetland']);
const GREEN_LANDUSE = new Set(['forest', 'grass', 'meadow', 'orchard', 'farmland', 'village_green', 'recreation_ground',
  'plant_nursery', 'allotments', 'vineyard', 'greenhouse_horticulture', 'flowerbed']);
/** Mapped land that is open ground, not "use" -- shown in the land-use layer so it's inspectable. */
const OPEN_NATURAL = new Set(['beach', 'sand']);
/** landuse values that aren't a physical thing on the ground (yet), or carry no information. */
const NOT_LANDUSE = new Set(['proposed', 'planned', 'yes', 'no', 'unknown', 'abandoned', 'disused']);
const PAVED = /^(asphalt|concrete|paved|paving_stones|clay|tartan|acrylic|dirt|compacted|gravel|sand)$/;

/**
 * Decides which ground layer a closed OSM area belongs to, and the `kind`
 * label it carries there (shown when the area is clicked; for vegetation,
 * it also decides trees -- TreeLayer.js plants them for forest, wood,
 * mangrove and park, and in rows for orchard).
 *
 * Checked in this order, because one area often carries several tags:
 *   1. water    -- anything that is water on the ground wins outright
 *                  (a reservoir is landuse=reservoir, a lake inside a park
 *                  is still water);
 *   2. green    -- natural/leisure/landuse cover you'd see from above as
 *                  plants (so a wooded cantonment with landuse=military +
 *                  natural=wood reads as trees, which is what it looks like);
 *   3. land use -- every other real landuse=* value, kept as-is: Indian
 *                  mapping uses many (cantonment "military", "religious"
 *                  temple complexes, "education" campuses, ports, landfills,
 *                  brick kilns tagged "industrial"...), and a catch-all
 *                  keeps all of them instead of silently dropping new ones.
 * Deliberately NOT drawn: protected-area boundaries (leisure=nature_reserve
 * -- a boundary around mixed land, water and villages, not a land cover),
 * bare rock/scree/glacier, and anything else unrecognised.
 *
 * @param {Record<string,string>} tags - raw OSM tags of a Polygon/MultiPolygon feature
 * @returns {{role: 'water'|'vegetation'|'landuse', kind: string} | null}
 */
export function classifyArea(tags) {
  const { natural, landuse, leisure, water, waterway, wetland } = tags;

  // 1. Water. Kind is the specific water type where OSM gives one (river,
  // lake, pond, canal, reservoir, lagoon...) -- shown on click.
  if (natural === 'water' || water || waterway === 'riverbank') return { role: 'water', kind: water ?? (waterway === 'riverbank' ? 'river' : 'water') };
  if (WATER_LANDUSE[landuse]) return { role: 'water', kind: WATER_LANDUSE[landuse] };
  if (natural === 'bay' || natural === 'strait') return { role: 'water', kind: natural };
  if (natural === 'wetland' && (wetland === 'tidalflat' || wetland === 'saltern')) return { role: 'water', kind: wetland };

  // 2. Green cover. Mangroves (Mumbai's creeks, Kochi, Kolkata's fringe)
  // are their own kind so they get trees; other wetlands (marsh, reedbed)
  // stay treeless green.
  if (natural === 'wetland') return { role: 'vegetation', kind: wetland === 'mangrove' ? 'mangrove' : 'wetland' };
  if (GREEN_NATURAL.has(natural)) return { role: 'vegetation', kind: natural };
  if (GREEN_LEISURE.has(leisure)) return { role: 'vegetation', kind: leisure };
  if (leisure === 'pitch') {
    // A cricket/football ground is usually grass; a paved or mud court isn't.
    return PAVED.test(tags.surface ?? '') ? { role: 'landuse', kind: 'pitch' } : { role: 'vegetation', kind: 'pitch' };
  }
  if (GREEN_LANDUSE.has(landuse)) return { role: 'vegetation', kind: landuse };

  // 3. Everything else that says what the land is used for.
  if (landuse && !NOT_LANDUSE.has(landuse)) return { role: 'landuse', kind: landuse };
  if (leisure === 'stadium' || leisure === 'sports_centre') return { role: 'landuse', kind: leisure };
  if (OPEN_NATURAL.has(natural)) return { role: 'landuse', kind: natural };
  return null;
}

const nameOf = (p) => p.name ?? p['name:en'] ?? null;
const osmIdOf = (f) => f.id ?? f.properties?.['@id'] ?? f.properties?.id ?? null;
const osmNumericId = (id) => Number(String(id ?? '').split('/')[1]) || null;

function isMetroStation(p) {
  return p.station === 'subway' || p.station === 'light_rail' || p.station === 'monorail' || p.subway === 'yes' || p.light_rail === 'yes';
}

/** turf's own default roundness when `steps` isn't given (8 segments per quarter circle); see roadTiles.js for why tiles ask for fewer. */
const bufferOptions = (steps) => (steps ? { units: 'meters', steps } : { units: 'meters' });

/** One OSM feature -> [role, outputFeature], or null if it's not something the viewer draws. `railwayStationNames` is filled as a side effect; `roadSteps` is how round a widened road's ends and bends are. */
function convert(f, railwayStationNames, roadSteps) {
  const p = f.properties ?? {};
  const type = f.geometry?.type;
  const id = osmIdOf(f);
  const base = { id, osm_id: osmNumericId(id), name: nameOf(p) ?? '' };

  if (p.railway && (type === 'LineString' || type === 'MultiLineString') && !p.highway) {
    return [LAYER_ROLES.RAILWAY, { type: 'Feature', geometry: f.geometry, properties: { ...base, railway: p.railway, usage: p.usage ?? '', electrified: p.electrified ?? '' } }];
  }

  if (p.highway && ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(type)) {
    const props = { feature: 'road', class: roadTier(p.highway), highway: p.highway, name: nameOf(p) };
    if (type === 'Polygon' || type === 'MultiPolygon') return [LAYER_ROLES.ROADS, { type: 'Feature', geometry: f.geometry, properties: props }]; // a mapped square/plaza -- already a surface
    const { width, source } = roadWidth(p);
    props.width_m = width;
    props.width_source = source;
    const polygon = buffer(f, width / 2, bufferOptions(roadSteps));
    if (!polygon) return null; // degenerate (e.g. zero-length) line
    polygon.properties = props;
    return [LAYER_ROLES.ROADS, polygon];
  }

  if (type === 'Point') {
    if (p.railway === 'station' || p.railway === 'halt') {
      if (!isMetroStation(p) && base.name) railwayStationNames.add(base.name);
      return [LAYER_ROLES.AMENITIES, { type: 'Feature', geometry: f.geometry, properties: { ...base, amenity: 'station' } }];
    }
    if (p.amenity) return [LAYER_ROLES.AMENITIES, { type: 'Feature', geometry: f.geometry, properties: { ...base, amenity: p.amenity } }];
    if (p.place && base.name) return [LAYER_ROLES.LOCALITIES, { type: 'Feature', geometry: f.geometry, properties: { id, name: base.name, kind: 'locality', source: `osm_place_${p.place}` } }];
    return null;
  }

  if (type === 'Polygon' || type === 'MultiPolygon') {
    const cls = classifyArea(p);
    return cls ? [cls.role, { type: 'Feature', geometry: f.geometry, properties: { ...base, kind: cls.kind } }] : null;
  }
  return null;
}

/**
 * Sorts OSM features into the viewer's layers one at a time, handing each
 * result to `write` as it is made instead of collecting them. A metro's
 * roads are lakhs of features, and a road centre-line widened into a
 * surface is several times its own size: Delhi with its satellite cities
 * is 3.16 lakh roads, 436 MB once widened and written as GeoJSON.
 *
 * @param {object} opts
 * @param {{west:number, south:number, east:number, north:number}} opts.bbox - the city's area, for the sea
 * @param {(role: string, feature: GeoJSON.Feature) => void} opts.write - called once per feature the viewer draws
 * @param {number} [opts.roadSteps] - for road tiles; turf's default when left out
 * @returns {{add: (feature: GeoJSON.Feature) => void, finish: () => {railwayStationNames: string[], stats: Record<string, number>, warnings: string[]}}}
 *   `add` takes OSM features (tags in properties), in the order they should
 *   appear in each layer. `finish` builds the sea from the coastline seen
 *   (it needs all of it) and reports. `railwayStationNames` feeds
 *   CityConfig.labels.railwayStationNames, which LabelLayer uses to say
 *   "X Railway Station" rather than "X Metro".
 */
export function createOsmSplitter({ bbox, write, roadSteps }) {
  const stats = Object.fromEntries(OSM_ROLES.map((r) => [r, 0]));
  const railwayStationNames = new Set();
  const coastlines = [];
  let skipped = 0;
  const emit = (role, feature) => { stats[role]++; write(role, feature); };

  return {
    add(f) {
      if (f.properties?.natural === 'coastline' && f.geometry?.type === 'LineString') { coastlines.push(f.geometry.coordinates); return; }
      const hit = convert(f, railwayStationNames, roadSteps);
      if (hit) emit(hit[0], hit[1]); else skipped++;
    },
    finish() {
      const warnings = [];
      const sea = seaPolygons(coastlines, bbox);
      if (sea.warning) warnings.push(sea.warning);
      for (const coordinates of sea.polygons) {
        emit(LAYER_ROLES.WATER, { type: 'Feature', geometry: { type: 'Polygon', coordinates }, properties: { id: null, osm_id: null, name: '', kind: 'sea' } });
      }
      stats.skipped = skipped;
      stats.seaPolygons = sea.polygons.length;
      return { railwayStationNames: [...railwayStationNames].sort(), stats, warnings };
    },
  };
}

/**
 * A single-layer file the uploader supplied for one of OSM_ROLES -- a
 * municipal survey, or that layer exported from OSM by hand -- brought to
 * the same shape the viewer gets from the download:
 *   - OSM-tagged features (highway=*, landuse=*, railway=station...) go
 *     through exactly the rules above, so e.g. road centre-lines are
 *     widened into surfaces;
 *   - features that already have the final shape (e.g. KMC's road
 *     polygons with a numeric `class`, a municipal water-body layer) pass
 *     through, with only missing essentials filled in: road `class`
 *     defaults to the local tier, area `kind` to the role's own name,
 *     a station layer's points without `amenity` count as stations.
 *
 * One feature at a time, like createOsmSplitter(): a metro's own road
 * survey is lakhs of features (a 436 MB test file of 3.16 lakh road
 * surfaces took 2.5 GB of memory to read whole).
 * @param {string} role
 * @param {{bbox: object, roadSteps?: number}} opts - roadSteps: see createOsmSplitter()
 * @returns {{convert: (feature: GeoJSON.Feature) => GeoJSON.Feature|null, result: () => {count: number, railwayStationNames: string[], error: string|null}}}
 *   `convert` gives the feature in the viewer's shape, or null if this
 *   layer can't use it. `result`, once every feature has been through,
 *   says whether the file is usable at all: if `error` is set, what
 *   convert() returned must be thrown away.
 */
export function createLayerNormalizer(role, { bbox, roadSteps }) {
  const names = new Set();
  let count = 0, insideBbox = 0;
  const inBox = ([x, y]) => x >= bbox.west && x <= bbox.east && y >= bbox.south && y <= bbox.north;
  const AREA_ROLES = new Set([LAYER_ROLES.LANDUSE, LAYER_ROLES.VEGETATION, LAYER_ROLES.WATER]);

  function convertOne(f) {
    const p = f.properties ?? {};
    const hit = convert(f, names, roadSteps);
    // The uploader chose which layer this file is; for areas, keep that choice but take the more specific `kind` the tags give (e.g. "park").
    let out = hit && (hit[0] === role || (AREA_ROLES.has(role) && AREA_ROLES.has(hit[0]))) ? hit[1] : null;
    if (!out) {
      const type = f.geometry?.type;
      if (role === LAYER_ROLES.ROADS && (type === 'LineString' || type === 'MultiLineString')) {
        const poly = buffer(f, roadWidth(p).width / 2, bufferOptions(roadSteps)); // a municipal centre-line's own `width` / `lanes` attribute counts too
        out = poly && { ...poly, properties: { ...p, feature: 'road', class: Number.isInteger(p.class) ? p.class : 2, name: nameOf(p) } };
      } else if (role === LAYER_ROLES.ROADS && (type === 'Polygon' || type === 'MultiPolygon')) {
        out = { ...f, properties: { ...p, class: Number.isInteger(p.class) ? p.class : 2 } };
      } else if (AREA_ROLES.has(role) && (type === 'Polygon' || type === 'MultiPolygon')) {
        out = { ...f, properties: { ...p, name: nameOf(p) ?? '', kind: p.kind ?? role } };
      } else if (role === LAYER_ROLES.AMENITIES && type === 'Point') {
        out = { ...f, properties: { ...p, name: nameOf(p) ?? '', amenity: p.amenity ?? 'station' } };
      } else if (role === LAYER_ROLES.LOCALITIES && type === 'Point' && nameOf(p)) {
        out = { ...f, properties: { ...p, name: nameOf(p), kind: 'locality' } };
      } else if (role === LAYER_ROLES.RAILWAY && (type === 'LineString' || type === 'MultiLineString')) {
        out = f;
      }
    }
    if (!out) return null;
    count++;
    const first = firstCoord(out.geometry);
    if (first && inBox(first)) insideBbox++;
    return out;
  }

  function result() {
    const error = !count ? `no usable ${role} features (wrong geometry type for this layer?)`
      : !insideBbox ? `none of its ${count} features fall inside the area you drew. Is it for this city, and in plain longitude/latitude (WGS84)?`
        : null;
    return { count, railwayStationNames: error ? [] : [...names].sort(), error };
  }

  return { convert: convertOne, result };
}

function firstCoord(g) {
  let c = g?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && c.length >= 2 ? c : null;
}
