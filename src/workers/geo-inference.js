// @ts-check
// ===================================================================
// geo-inference.js — derives an origin + bbox directly from a raw
// GeoJSON file's own coordinates. Lets the offline tile builder
// (scripts/build-building-tiles.mjs) work against ANY uploaded dataset
// with no hand-authored CityConfig and no human having to look up that
// city's lon/lat first -- the origin is just the data's own bbox
// centroid.
//
// Pure, DOM-free, no `self`/`window` -- safe to import from Node
// (the build script) and, if ever needed, the browser.
// ===================================================================

/**
 * How many array levels sit above a coordinate pair in each geometry type
 * (Point=0, LineString/MultiPoint=1, Polygon/MultiLineString=2,
 * MultiPolygon=3). Module-level: this runs for every feature of a
 * metro-sized file (58 lakh buildings), so it isn't rebuilt per call.
 * @type {Readonly<Record<string, number>>}
 */
const COORDINATE_DEPTH = Object.freeze({ Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 });

/**
 * @param {any} coords - nested coordinate arrays, `depth` levels above [lon, lat] pairs
 * @param {number} depth
 * @param {(lon: number, lat: number) => void} visit
 */
function walkCoordinates(coords, depth, visit) {
  if (depth === 0) { visit(coords[0], coords[1]); return; }
  for (const c of coords) walkCoordinates(c, depth - 1, visit);
}

/** @param {any} feature - a GeoJSON Feature @param {(lon:number, lat:number) => void} visit called for every coordinate pair in the feature, any geometry type */
function eachCoordinate(feature, visit) {
  const g = feature?.geometry;
  if (!g) return;
  const depth = COORDINATE_DEPTH[g.type];
  if (depth === undefined || !g.coordinates) return; // GeometryCollection / unknown types carry no extent of their own here
  walkCoordinates(g.coordinates, depth, visit);
}

/**
 * Fed one feature at a time, so the caller never needs the whole file in
 * memory (the offline bake reads its file in pieces).
 * @returns {{add(feature: any): void, result(): {origin: {lon:number, lat:number}, bbox: {west:number, south:number, east:number, north:number}}}}
 *   result() throws if no feature had a finite coordinate
 */
export function createExtent() {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  /** @param {number} lon @param {number} lat */
  const visit = (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  };
  return {
    add(feature) { eachCoordinate(feature, visit); },
    result() {
      if (!Number.isFinite(west) || !Number.isFinite(south)) {
        throw new Error('no finite coordinates found in the dataset');
      }
      return {
        origin: { lon: (west + east) / 2, lat: (south + north) / 2 },
        bbox: { west, south, east, north },
      };
    },
  };
}
