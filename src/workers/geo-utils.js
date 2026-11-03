// @ts-check
// ===================================================================
// Pure, DOM-free geo math — importable from the main thread, from
// building-worker.js, and from Node (the building bake and the server's
// road tiles). One copy, not one per caller, is what lets them agree on
// projection without drifting apart: a click in the viewer, a search
// fly-to and a tile built on the server all mean the same point.
// ===================================================================

const METERS_PER_DEG_LAT = 110574;

/**
 * @param {{lon:number, lat:number}} origin
 * @returns {(lon:number, lat:number) => {x:number, z:number}}
 */
export function makeProjector(origin) {
  // A local equirectangular projection: metres east/north of the origin,
  // with longitude degrees shrunk by cos(latitude). Over a city-sized area
  // (tens of km) its distortion is far below what anyone can see, and it is
  // cheap and exactly invertible (makeUnprojector) -- which is what clicks,
  // share links and the embed API need.
  const metersPerDegLon = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  // X is NEGATED: three.js is right-handed with Y up, so the naive
  // X = east, Z = north mapping would be a mirror image of the real world
  // (east and west swapped on screen). Negating X restores the right
  // handedness; Z = north stays as is. Everything that turns lon/lat into
  // scene metres goes through here, so they all agree.
  return function project(lon, lat) {
    return {
      x: (origin.lon - lon) * metersPerDegLon,
      z: (lat - origin.lat) * METERS_PER_DEG_LAT,
    };
  };
}

/**
 * Inverse of makeProjector: scene metres back to lon/lat (share links and
 * the embed API speak lat/lon; the scene speaks x/z).
 * @param {{lon:number, lat:number}} origin
 * @returns {(x:number, z:number) => {lon:number, lat:number}}
 */
export function makeUnprojector(origin) {
  const metersPerDegLon = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return function unproject(x, z) {
    return { lon: origin.lon - x / metersPerDegLon, lat: origin.lat + z / METERS_PER_DEG_LAT };
  };
}

/**
 * Drops a duplicated closing vertex ([0]===[n-1]), same rule projectRingFlat applies inline. GeoJSON rings repeat their
 * first point at the end; drawn as-is, that would add a zero-length wall segment and a degenerate roof triangle.
 * @param {number[][]} ring
 * @returns {number[][]}
 */
export function dedupeRing(ring) {
  if (ring.length < 2) return ring;
  const [x0, y0] = ring[0];
  const [xn, yn] = ring[ring.length - 1];
  if (Math.abs(x0 - xn) < 1e-12 && Math.abs(y0 - yn) < 1e-12) return ring.slice(0, -1);
  return ring;
}

/**
 * Projects a ring into an array of {x,z} points (not a flat array) -- used by the lower-frequency layers (ground fills, trees, labels), where projectRingFlat's flat array would save nothing that matters.
 * @param {number[][]} ring @param {(lon:number, lat:number) => {x:number, z:number}} project
 * @returns {Array<{x:number, z:number}>}
 */
export function ringToLocal(ring, project) {
  return dedupeRing(ring).map(([lon, lat]) => project(lon, lat));
}

/**
 * Projects one GeoJSON ring into a flat [x0,z0,x1,z1,...] Float32Array,
 * dropping a duplicated closing vertex. One typed array per ring instead of
 * an array of {x,z} objects: the building pipeline keeps millions of
 * footprints (7.3 lakh buildings in Kanpur, 58 lakh in a metro) and an
 * object per point would dominate its memory. (The {x,z} that project()
 * returns per point is short-lived and optimised away by the JIT --
 * measured: no faster with the arithmetic written inline.)
 * @param {number[][]} ring
 * @param {(lon:number, lat:number) => {x:number, z:number}} project
 * @returns {Float32Array}
 */
export function projectRingFlat(ring, project) {
  let n = ring.length;
  if (n >= 2) {
    const first = ring[0], last = ring[n - 1];
    if (Math.abs(first[0] - last[0]) < 1e-12 && Math.abs(first[1] - last[1]) < 1e-12) n -= 1;
  }
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const { x, z } = project(ring[i][0], ring[i][1]);
    out[i * 2] = x;
    out[i * 2 + 1] = z;
  }
  return out;
}

/**
 * Same idea as projectRingFlat, for a LineString's coordinates (roads/railway) -- no closing-vertex dedup, a line isn't a ring.
 * @param {number[][]} coords @param {(lon:number, lat:number) => {x:number, z:number}} project
 * @returns {Float32Array}
 */
export function projectLineFlat(coords, project) {
  const n = coords.length;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const { x, z } = project(coords[i][0], coords[i][1]);
    out[i * 2] = x;
    out[i * 2 + 1] = z;
  }
  return out;
}

/**
 * The OUTER ring of each polygon in a feature. Holes are deliberately not
 * returned: a building is extruded from its outline and gets one flat roof,
 * so a courtyard is roofed over -- a known simplification of 2.5D footprints,
 * and the same rule roads, ground fills and admin areas follow.
 * @param {any} feature - a GeoJSON Feature
 * @returns {number[][][]} one ring (array of [lon, lat]) per polygon; [] for points, lines and missing geometry
 */
export function collectRings(feature) {
  const g = feature.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates[0]];
  if (g.type === 'MultiPolygon') return g.coordinates.map((poly) => poly[0]);
  return [];
}
