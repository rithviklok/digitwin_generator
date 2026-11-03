// ===================================================================
// open-buildings-lib.mjs -- the workings of fetch-open-buildings.mjs:
// finds, downloads and joins Google's two Open Buildings datasets for an
// area, with no Earth Engine and no account. Both are public files:
//
//   footprints  Open Buildings v3 polygons: one gzipped CSV per S2 cell of
//               level 6 (about 150 km across), each footprint as WKT.
//               gs://open-buildings-data/v3/polygons_s2_level_6_gzip_no_header/
//   heights     Open Buildings 2.5D Temporal v1: Cloud-Optimised GeoTIFF
//               tiles 12.5 km square in UTM, a set per year from 2016,
//               listed by one manifest per S2 cell of level 2 and UTM zone.
//               gs://open-buildings-temporal-data/v1/{manifests,geotiffs}/
//
// A building's height is the average of the height raster over the
// pixels whose centres fall inside its footprint: what Earth Engine's
// reduceRegions with a mean reducer gives, which is how Kanpur's own file
// was made (hence its height property's name, `mean`).
//
// Licence: both datasets are CC BY 4.0 or ODbL v1.0, the user's choice.
// Either way, credit "Google Open Buildings" wherever the city is shown.
//
// Also, as a fallback: Microsoft's (Bing Maps) Global ML Building
// Footprints, one gzipped file of line-by-line GeoJSON per zoom-9 map tile
// (quadkey), listed in an index whose link changes with each release.
// Licence CDLA Permissive 2.0. Heights only where Microsoft estimated one:
// none of Kanpur's 2.8 lakh footprints have one (checked 2026-10-02).
// ===================================================================
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Cog } from './cog-reader.mjs';

const GCS = 'https://storage.googleapis.com';
const FOOTPRINTS_URL = `${GCS}/open-buildings-data/v3/polygons_s2_level_6_gzip_no_header`;
const FOOTPRINT_CELL_LEVEL = 6;
const HEIGHTS_BUCKET = 'open-buildings-temporal-data';
const MANIFEST_CELL_LEVEL = 2;
const HEIGHT_BAND_ID = 'building_height';
/** Microsoft's README lists the current index first; the fallback is the newest known (2026-08-13). */
const MICROSOFT_README = 'https://raw.githubusercontent.com/microsoft/GlobalMLBuildingFootprints/main/README.md';
const MICROSOFT_INDEX_FALLBACK = 'https://bfppub.blob.core.windows.net/%24web/2026-08-13/dataset-links.csv';
const USER_AGENT = 'DigiTwin-Generator fetch-open-buildings';
/** The same "a city, not a district" limit as the server's OpenStreetMap step (about 1.5 x 1.5 degrees). */
export const MAX_AREA_SQ_DEG = 2.25;
/** Google's v3 footprints start at this confidence; nothing below it exists to drop. */
export const MIN_CONFIDENCE_FLOOR = 0.65;
/**
 * Raster detail used for the averages, in metres. The rasters are stored
 * at 0.5 m with overviews at 1, 2, 4 m...; their real detail is about 4 m.
 * Against Kanpur's own Earth Engine-made heights (16,677 buildings in its
 * centre, 2023), 1 m matches as well as every stored pixel (median
 * difference 0.18 m, 96% within 1 m) for about 30% less to download;
 * 4 m is a little worse (94%).
 */
export const DEFAULT_PIXEL_M = 1;
/** A footprint whose centre lies this far (degrees, ~200 m) outside the area may still reach into it. */
const EDGE_MARGIN_DEG = 0.002;
/** Height tiles of a neighbouring S2 cell can reach this far (degrees) over its edge. */
const MANIFEST_SEARCH_MARGIN_DEG = 0.25;
const RETRIES = 5;
/** A request that has received nothing for this long is retried. */
const IDLE_TIMEOUT_MS = 60_000;
/** Longest a single request may take: a few MB of height blocks on a slow line. */
const REQUEST_TIMEOUT_MS = 300_000;
/** Block rows of a height tile downloaded ahead of the one being averaged. */
const STRIPS_AHEAD = 4;

/** A problem worded for the person running the script (printed without a stack trace). */
export class UserError extends Error {}

/** @typedef {{west: number, south: number, east: number, north: number}} Area */

// ---------------------------------------------------------------------
// S2 cells: Google names its footprint files and height manifests by
// them. A port of the S2 geometry library's lat/lng -> cell id (Hilbert
// curve on six cube faces, quadratic projection).
// ---------------------------------------------------------------------
const LOOKUP_BITS = 4, SWAP = 1, INVERT = 2, MAX_SIZE = 1 << 30;
const POS_TO_IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]];
const POS_TO_ORIENTATION = [SWAP, 0, 0, INVERT | SWAP];
const LOOKUP_POS = new Int32Array(1 << (2 * LOOKUP_BITS + 2));
(function initLookup() {
  const fill = (level, i, j, origOrientation, pos, orientation) => {
    if (level === LOOKUP_BITS) { LOOKUP_POS[(((i << LOOKUP_BITS) + j) << 2) + origOrientation] = (pos << 2) + orientation; return; }
    const r = POS_TO_IJ[orientation];
    for (let k = 0; k < 4; k++) fill(level + 1, (i << 1) + (r[k] >> 1), (j << 1) + (r[k] & 1), origOrientation, (pos << 2) + k, orientation ^ POS_TO_ORIENTATION[k]);
  };
  for (let o = 0; o < 4; o++) fill(0, 0, 0, o, 0, o);
})();
const uvToSt = (u) => (u >= 0 ? 0.5 * Math.sqrt(1 + 3 * u) : 1 - 0.5 * Math.sqrt(1 - 3 * u));
const stToIj = (s) => Math.max(0, Math.min(MAX_SIZE - 1, Math.floor(MAX_SIZE * s)));

/**
 * The token (as Google's file names use it) of the S2 cell of `level` holding a point.
 * @param {number} lon @param {number} lat @param {number} level - 0 to 30
 * @returns {string}
 */
export function s2CellToken(lon, lat, level) {
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180;
  const x = Math.cos(phi) * Math.cos(lam), y = Math.cos(phi) * Math.sin(lam), z = Math.sin(phi);
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face = ax > ay ? (ax > az ? 0 : 2) : (ay > az ? 1 : 2);
  if ([x, y, z][face] < 0) face += 3;
  const [u, v] = [[y / x, z / x], [-x / y, z / y], [-x / z, -y / z], [z / x, y / x], [z / y, -x / y], [-y / z, -x / z]][face];
  const i = stToIj(uvToSt(u)), j = stToIj(uvToSt(v));
  let id = BigInt(face) << 60n, bits = face & SWAP;
  const mask = (1 << LOOKUP_BITS) - 1;
  for (let k = 7; k >= 0; k--) {
    bits += ((i >> (k * LOOKUP_BITS)) & mask) << (LOOKUP_BITS + 2);
    bits += ((j >> (k * LOOKUP_BITS)) & mask) << 2;
    bits = LOOKUP_POS[bits];
    id |= BigInt(bits >> 2) << BigInt(k * 2 * LOOKUP_BITS);
    bits &= SWAP | INVERT;
  }
  id = id * 2n + 1n;
  const lsb = 1n << BigInt(2 * (30 - level));
  id = (id & ((1n << 64n) - lsb)) | lsb; // the ancestor at `level`
  return id.toString(16).padStart(16, '0').replace(/0+$/, '');
}

/**
 * The S2 cells of `level` that an area reaches into. Samples the area's
 * edge every ~50 m (a cell that reaches in further crosses it there) and
 * its inside every ~5 km (a cell wholly inside touches no edge; cells of
 * level 6 and below are 70 km and more across).
 * @param {Area} area @param {number} level
 * @returns {string[]}
 */
export function s2CellsCovering(area, level) {
  const { west, south, east, north } = area;
  const tokens = new Set();
  const edge = (from, to) => Math.max(1, Math.ceil(Math.abs(to - from) / 0.0005));
  const nx = edge(west, east), ny = edge(south, north);
  for (let k = 0; k <= nx; k++) {
    const lon = west + ((east - west) * k) / nx;
    tokens.add(s2CellToken(lon, south, level)); tokens.add(s2CellToken(lon, north, level));
  }
  for (let k = 0; k <= ny; k++) {
    const lat = south + ((north - south) * k) / ny;
    tokens.add(s2CellToken(west, lat, level)); tokens.add(s2CellToken(east, lat, level));
  }
  const gx = Math.max(1, Math.ceil((east - west) / 0.05)), gy = Math.max(1, Math.ceil((north - south) / 0.05));
  for (let a = 0; a <= gx; a++) for (let b = 0; b <= gy; b++) tokens.add(s2CellToken(west + ((east - west) * a) / gx, south + ((north - south) * b) / gy, level));
  return [...tokens].sort();
}

// ---------------------------------------------------------------------
// WGS 84 -> UTM, the height rasters' projection. Krüger's series to n^4
// (Karney 2011): well under a millimetre within 3,000 km of the zone's
// central meridian, so a city straddling two zones is projected
// accurately into either.
// ---------------------------------------------------------------------
const WGS84_A = 6378137, WGS84_F = 1 / 298.257223563, UTM_K0 = 0.9996;
const N3 = WGS84_F / (2 - WGS84_F);
const RECT_A = (WGS84_A / (1 + N3)) * (1 + N3 ** 2 / 4 + N3 ** 4 / 64);
const ALPHA = [
  N3 / 2 - (2 * N3 ** 2) / 3 + (5 * N3 ** 3) / 16 + (41 * N3 ** 4) / 180,
  (13 * N3 ** 2) / 48 - (3 * N3 ** 3) / 5 + (557 * N3 ** 4) / 1440,
  (61 * N3 ** 3) / 240 - (103 * N3 ** 4) / 140,
  (49561 * N3 ** 4) / 161280,
];
const ECC = Math.sqrt(WGS84_F * (2 - WGS84_F));

/** @typedef {{zone: number, south: boolean, epsg: number}} Utm */

/**
 * @param {string} crs - "EPSG:326zz" (north) or "EPSG:327zz" (south)
 * @returns {Utm}
 */
export function utmOf(crs) {
  const m = /^EPSG:(32[67])(\d\d)$/.exec(String(crs));
  if (!m || +m[2] < 1 || +m[2] > 60) throw new UserError(`Google's height tiles use ${crs}, not a UTM zone; this script needs updating for that`);
  return { zone: +m[2], south: m[1] === '327', epsg: Number(m[1] + m[2]) };
}

/**
 * Projects a point into a UTM zone, writing easting and northing (metres) to out[at], out[at + 1].
 * @param {number} lon @param {number} lat @param {Utm} utm
 * @param {Float64Array|number[]} out @param {number} at
 */
export function toUtm(lon, lat, utm, out, at) {
  const phi = (lat * Math.PI) / 180;
  const lam = ((lon - (utm.zone * 6 - 183)) * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const t = Math.sinh(Math.atanh(sinPhi) - ECC * Math.atanh(ECC * sinPhi));
  const xi0 = Math.atan2(t, Math.cos(lam)), eta0 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xi0, eta = eta0;
  for (let j = 1; j <= 4; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
  }
  out[at] = 500000 + UTM_K0 * RECT_A * eta;
  out[at + 1] = (utm.south ? 10000000 : 0) + UTM_K0 * RECT_A * xi;
}

/** The extent of an area in a UTM zone (its edges are curves there, so they are sampled). @param {Area} area @param {Utm} utm */
function areaInUtm(area, utm) {
  const p = [0, 0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k <= 32; k++) {
    const f = k / 32;
    for (const [lon, lat] of [[area.west + (area.east - area.west) * f, area.south], [area.west + (area.east - area.west) * f, area.north], [area.west, area.south + (area.north - area.south) * f], [area.east, area.south + (area.north - area.south) * f]]) {
      toUtm(lon, lat, utm, p, 0);
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------
// Footprints, held compactly: a metro is several million of them, too
// many for one JavaScript object each.
// ---------------------------------------------------------------------
class Grow {
  /** @param {Float64ArrayConstructor|Uint32ArrayConstructor|Uint8ArrayConstructor} Type @param {number} [capacity] */
  constructor(Type, capacity = 1 << 16) { this.Type = Type; this.a = new Type(capacity); this.n = 0; }
  /** @param {number} v */
  push(v) {
    if (this.n === this.a.length) { const b = new this.Type(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  view() { return this.a.subarray(0, this.n); }
}

/**
 * Footprints as read: building b's rings are ringStart indices
 * [buildingRingStart[b], buildingRingStart[b + 1]); ring r's points are
 * [ringStart[r], ringStart[r + 1]); point p is coords[2p] (lon), coords[2p + 1] (lat).
 * @typedef {object} Footprints
 * @property {number} count
 * @property {Float64Array} coords
 * @property {Uint32Array} ringStart - one per ring, plus the total point count
 * @property {Uint8Array} ringOuter - 1 for each polygon's outer ring
 * @property {Uint32Array} buildingRingStart - one per building, plus the total ring count
 * @property {Uint8Array} multi - 1 for a MultiPolygon
 */

export class FootprintStore {
  constructor() {
    this.coords = new Grow(Float64Array, 1 << 20);
    this.ringStart = new Grow(Uint32Array);
    this.ringOuter = new Grow(Uint8Array);
    this.buildingRingStart = new Grow(Uint32Array);
    this.multi = new Grow(Uint8Array);
    this.count = 0;
  }

  /**
   * Adds one footprint given as WKT (POLYGON or MULTIPOLYGON, 2D), as Google's files have them.
   * @param {string} wkt
   * @param {Area|null} [area] - when given, only a footprint whose bounding box reaches into it is kept
   * @returns {boolean} whether it was added
   */
  addWkt(wkt, area = null) {
    const marks = this._marks();
    const s = wkt.trimStart();
    const multi = s.startsWith('MULTIPOLYGON');
    if (!multi && !s.startsWith('POLYGON')) return false;
    const open = s.indexOf('(');
    if (open < 0 || s.slice(multi ? 12 : 7, open).trim() !== '') return false; // EMPTY, or Z / M coordinates
    const ringDepth = multi ? 3 : 2;
    let depth = 0, rings = 0, ringsInPolygon = 0;
    for (let i = open; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === 41 /* ) */) { depth--; continue; }
      if (ch !== 40 /* ( */) continue;
      depth++;
      if (depth === ringDepth - 1) ringsInPolygon = 0;
      if (depth !== ringDepth) continue;
      const close = s.indexOf(')', i);
      if (close < 0 || !this._addWktRing(s, i + 1, close)) return this._undo(marks);
      this.ringOuter.push(ringsInPolygon === 0 ? 1 : 0);
      ringsInPolygon++; rings++;
      i = close; depth--;
    }
    if (!rings || depth !== 0) return this._undo(marks);
    return this._finish(marks, multi, area);
  }

  /**
   * Adds one footprint given as a GeoJSON geometry (Polygon or MultiPolygon), as Microsoft's files have them.
   * @param {{type: string, coordinates: any}|null|undefined} geometry
   * @param {Area|null} [area] - as for addWkt
   * @returns {boolean} whether it was added
   */
  addGeometry(geometry, area = null) {
    const multi = geometry?.type === 'MultiPolygon';
    if (!multi && geometry?.type !== 'Polygon') return false;
    const polygons = multi ? geometry.coordinates : [geometry.coordinates];
    if (!Array.isArray(polygons) || !polygons.length) return false;
    const marks = this._marks();
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || !polygon.length) return this._undo(marks);
      for (let r = 0; r < polygon.length; r++) {
        const ring = polygon[r], start = this.coords.n;
        if (!Array.isArray(ring)) return this._undo(marks);
        this.ringStart.push(start / 2);
        for (const point of ring) {
          if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return this._undo(marks);
          this.coords.push(point[0]); this.coords.push(point[1]);
        }
        if (!this._closeRing(start)) return this._undo(marks);
        this.ringOuter.push(r === 0 ? 1 : 0);
      }
    }
    return this._finish(marks, multi, area);
  }

  _marks() { return [this.coords.n, this.ringStart.n, this.ringOuter.n]; }
  /** Forgets a footprint that turned out unreadable (or outside the area). @param {number[]} marks @returns {false} */
  _undo(marks) { [this.coords.n, this.ringStart.n, this.ringOuter.n] = marks; return false; }

  /** @param {number[]} marks @param {boolean} multi @param {Area|null} area @returns {boolean} */
  _finish(marks, multi, area) {
    if (area) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const c = this.coords.a;
      for (let k = marks[0]; k < this.coords.n; k += 2) {
        minX = Math.min(minX, c[k]); maxX = Math.max(maxX, c[k]); minY = Math.min(minY, c[k + 1]); maxY = Math.max(maxY, c[k + 1]);
      }
      if (maxX < area.west || minX > area.east || maxY < area.south || minY > area.north) return this._undo(marks);
    }
    this.buildingRingStart.push(marks[1]);
    this.multi.push(multi ? 1 : 0);
    this.count++;
    return true;
  }

  /** @param {string} s @param {number} from @param {number} to - the ring's text between its parentheses */
  _addWktRing(s, from, to) {
    const start = this.coords.n;
    this.ringStart.push(start / 2);
    for (let j = from; j < to; ) {
      const ch = s.charCodeAt(j);
      if (ch === 32 || ch === 44 || ch === 9 || ch === 10 || ch === 13) { j++; continue; }
      let k = j + 1;
      while (k < to) { const c = s.charCodeAt(k); if (c === 32 || c === 44 || c === 9 || c === 10 || c === 13) break; k++; }
      const v = Number(s.slice(j, k));
      if (!Number.isFinite(v)) return false;
      this.coords.push(v);
      j = k;
    }
    return (this.coords.n - start) % 2 === 0 && this._closeRing(start); // odd: not x y pairs
  }

  /** Checks the ring just added has 3 corners, and closes it if it isn't (GeoJSON wants rings closed). @param {number} start - its first value's index */
  _closeRing(start) {
    if (this.coords.n - start < 6) return false;
    const c = this.coords.a, last = this.coords.n - 2;
    if (c[start] !== c[last] || c[start + 1] !== c[last + 1]) { this.coords.push(c[start]); this.coords.push(c[start + 1]); }
    return this.coords.n - start >= 8;
  }

  /** @returns {Footprints} */
  seal() {
    this.ringStart.push(this.coords.n / 2);
    this.buildingRingStart.push(this.ringStart.n - 1);
    return {
      count: this.count,
      coords: this.coords.view(),
      ringStart: this.ringStart.view(),
      ringOuter: this.ringOuter.view(),
      buildingRingStart: this.buildingRingStart.view(),
      multi: this.multi.view(),
    };
  }
}

/**
 * One line of Google's footprint CSV: latitude, longitude, area_in_meters,
 * confidence, "WKT", full_plus_code (no header row).
 * @param {string} line
 * @returns {{lat: number, lon: number, confidence: number, wkt: string}|null}
 */
export function parseFootprintRow(line) {
  const c1 = line.indexOf(','), c2 = line.indexOf(',', c1 + 1), c3 = line.indexOf(',', c2 + 1), c4 = line.indexOf(',', c3 + 1);
  if (c4 < 0) return null;
  const q1 = line.indexOf('"', c4), q2 = line.indexOf('"', q1 + 1);
  if (q1 < 0 || q2 < 0) return null;
  const lat = Number(line.slice(0, c1)), lon = Number(line.slice(c1 + 1, c2)), confidence = Number(line.slice(c3 + 1, c4));
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && confidence >= 0 && confidence <= 1)) return null;
  return { lat, lon, confidence, wkt: line.slice(q1 + 1, q2) };
}

// ---------------------------------------------------------------------
// Which raster pixels a footprint covers.
// ---------------------------------------------------------------------
/**
 * Calls visitSpan(row, firstCol, lastCol) for each run of pixels in a row
 * whose centres lie inside a footprint (even-odd rule, so holes are left out).
 * @param {Float64Array} xs @param {Float64Array} ys - the footprint's points in pixel units (x right, y down), ring after ring
 * @param {number[]} ringEnds - index just past each ring's last point
 * @param {number} rowFrom @param {number} rowTo - inclusive
 * @param {number} colMax - the last column there is
 * @param {(row: number, c0: number, c1: number) => void} visitSpan
 * @param {Float64Array} scratch - room for one crossing per edge
 */
export function forEachSpanInside(xs, ys, ringEnds, rowFrom, rowTo, colMax, visitSpan, scratch) {
  for (let row = rowFrom; row <= rowTo; row++) {
    const yc = row + 0.5;
    let n = 0, start = 0;
    for (const end of ringEnds) {
      for (let i = start; i < end; i++) {
        const j = i + 1 < end ? i + 1 : start;
        const y1 = ys[i], y2 = ys[j];
        if ((y1 <= yc) !== (y2 <= yc)) scratch[n++] = xs[i] + ((yc - y1) * (xs[j] - xs[i])) / (y2 - y1);
      }
      start = end;
    }
    if (n < 2) continue;
    const crossings = scratch.subarray(0, n).sort();
    for (let k = 0; k + 1 < n; k += 2) {
      const c0 = Math.max(0, Math.ceil(crossings[k] - 0.5)), c1 = Math.min(colMax, Math.ceil(crossings[k + 1] - 0.5) - 1);
      if (c0 <= c1) visitSpan(row, c0, c1);
    }
  }
}

/**
 * Every footprint projected into one UTM zone, relative to (x0, y0) so
 * 32-bit floats keep centimetres; with each one's box and centre point.
 * @typedef {{x0: number, y0: number, xy: Float32Array, minX: Float32Array, minY: Float32Array, maxX: Float32Array, maxY: Float32Array, cx: Float32Array, cy: Float32Array}} Projected
 * @param {Footprints} fp @param {Utm} utm @param {Area} area
 * @returns {Projected}
 */
export function projectFootprints(fp, utm, area) {
  const origin = [0, 0];
  toUtm(area.west, area.south, utm, origin, 0);
  const [x0, y0] = origin;
  const points = fp.coords.length / 2, xy = new Float32Array(fp.coords.length), p = [0, 0];
  for (let k = 0; k < points; k++) {
    toUtm(fp.coords[2 * k], fp.coords[2 * k + 1], utm, p, 0);
    xy[2 * k] = p[0] - x0; xy[2 * k + 1] = p[1] - y0;
  }
  const n = fp.count;
  const minX = new Float32Array(n), minY = new Float32Array(n), maxX = new Float32Array(n), maxY = new Float32Array(n), cx = new Float32Array(n), cy = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    const r0 = fp.buildingRingStart[b], from = fp.ringStart[r0], to = fp.ringStart[fp.buildingRingStart[b + 1]];
    let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
    for (let k = from; k < to; k++) {
      const x = xy[2 * k], y = xy[2 * k + 1];
      if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y;
    }
    minX[b] = ax; minY[b] = ay; maxX[b] = bx; maxY[b] = by;
    // Centre point: the outer ring's corners averaged (its closing point repeats the first).
    const outerEnd = fp.ringStart[r0 + 1] - 1;
    let sx = 0, sy = 0;
    for (let k = from; k < outerEnd; k++) { sx += xy[2 * k]; sy += xy[2 * k + 1]; }
    cx[b] = sx / (outerEnd - from); cy[b] = sy / (outerEnd - from);
  }
  return { x0, y0, xy, minX, minY, maxX, maxY, cx, cy };
}

/**
 * Running totals of height per building: the sum and count of covered
 * pixels, plus the pixel under its centre point for a footprint too small
 * to cover any pixel centre.
 * @typedef {{sum: Float64Array, count: Uint32Array, centre: Float32Array}} HeightTotals
 */

/**
 * Adds one height tile's pixels to the totals of every footprint on it,
 * downloading only the blocks those footprints cover, a block row at a time.
 * @param {Cog} cog @param {import('./cog-reader.mjs').CogImage} image @param {number} band
 * @param {Footprints} fp @param {Projected} proj @param {HeightTotals} totals
 * @returns {Promise<{buildings: number}>}
 */
export async function sampleTile(cog, image, band, fp, proj, totals) {
  const px = image.pixelSizeX, py = image.pixelSizeY, W = image.width, H = image.height, tw = image.tileWidth, th = image.tileHeight;
  // The tile's corner relative to the projected footprints' origin.
  const ox = cog.originX - proj.x0, oy = cog.originY - proj.y0;
  const nodata = cog.nodata;
  /** @type {Map<number, number[]>} block row -> buildings */
  const byRow = new Map();
  /** @type {Map<number, Set<number>>} block row -> block columns needed */
  const colsByRow = new Map();
  let buildings = 0;
  for (let b = 0; b < fp.count; b++) {
    const c0 = Math.floor((proj.minX[b] - ox) / px), c1 = Math.floor((proj.maxX[b] - ox) / px);
    const r0 = Math.floor((oy - proj.maxY[b]) / py), r1 = Math.floor((oy - proj.minY[b]) / py);
    if (c1 < 0 || c0 >= W || r1 < 0 || r0 >= H) continue;
    buildings++;
    const bc0 = Math.floor(Math.max(0, c0) / tw), bc1 = Math.floor(Math.min(W - 1, c1) / tw);
    for (let br = Math.floor(Math.max(0, r0) / th); br <= Math.floor(Math.min(H - 1, r1) / th); br++) {
      let list = byRow.get(br);
      if (!list) { list = []; byRow.set(br, list); colsByRow.set(br, new Set()); }
      list.push(b);
      const cols = colsByRow.get(br);
      for (let bc = bc0; bc <= bc1; bc++) cols.add(bc);
    }
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  const fetchStrip = (br) => {
    const p = cog.readBlocks(image, band, [...colsByRow.get(br)].map((col) => ({ col, row: br })));
    p.catch(() => {}); // awaited below; this only stops an early failure being reported as unhandled
    return p;
  };
  const pending = rows.slice(0, STRIPS_AHEAD).map(fetchStrip);

  let xs = new Float64Array(64), ys = new Float64Array(64), scratch = new Float64Array(64);
  const ringEnds = [];
  for (let k = 0; k < rows.length; k++) {
    const br = rows[k];
    const blocks = await pending[k];
    pending[k] = null;
    if (k + STRIPS_AHEAD < rows.length) pending.push(fetchStrip(rows[k + STRIPS_AHEAD]));
    const rowFirst = br * th, rowLast = Math.min(H, rowFirst + th) - 1, keyBase = br * image.tilesAcross;
    const valueAt = (col, row) => {
      const bc = Math.floor(col / tw), block = blocks.get(keyBase + bc);
      return block ? block[(row - rowFirst) * tw + (col - bc * tw)] : NaN;
    };
    for (const b of byRow.get(br)) {
      // The footprint in this tile's pixel units.
      const r0 = fp.buildingRingStart[b], r1 = fp.buildingRingStart[b + 1];
      const from = fp.ringStart[r0], to = fp.ringStart[r1];
      if (to - from > xs.length) { xs = new Float64Array(2 * (to - from)); ys = new Float64Array(xs.length); scratch = new Float64Array(xs.length); }
      ringEnds.length = 0;
      for (let r = r0; r < r1; r++) ringEnds.push(fp.ringStart[r + 1] - from);
      for (let k2 = from; k2 < to; k2++) { xs[k2 - from] = (proj.xy[2 * k2] - ox) / px; ys[k2 - from] = (oy - proj.xy[2 * k2 + 1]) / py; }
      const top = Math.max(rowFirst, Math.ceil((oy - proj.maxY[b]) / py - 0.5)), bottom = Math.min(rowLast, Math.floor((oy - proj.minY[b]) / py - 0.5));
      let sum = 0, count = 0;
      if (top <= bottom) {
        forEachSpanInside(xs, ys, ringEnds, top, bottom, W - 1, (row, c0, c1) => {
          for (let col = c0; col <= c1; ) {
            const bc = Math.floor(col / tw), last = Math.min(c1, (bc + 1) * tw - 1), block = blocks.get(keyBase + bc);
            if (block) {
              const base = (row - rowFirst) * tw - bc * tw;
              for (let c = col; c <= last; c++) { const v = block[base + c]; if (v === v && v !== nodata) { sum += v; count++; } }
            }
            col = last + 1;
          }
        }, scratch);
      }
      totals.sum[b] += sum; totals.count[b] += count;
      // The pixel under the centre point, for a footprint too small to cover a pixel centre.
      const ccol = Math.floor((proj.cx[b] - ox) / px), crow = Math.floor((oy - proj.cy[b]) / py);
      if (crow >= rowFirst && crow <= rowLast && ccol >= 0 && ccol < W) {
        const v = valueAt(ccol, crow);
        if (v === v && v !== nodata) totals.centre[b] = v;
      }
    }
  }
  return { buildings };
}

// ---------------------------------------------------------------------
// Network: retried, resumable, through HTTPS_PROXY when NODE_USE_ENV_PROXY=1.
// ---------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class HttpError extends Error {
  /** @param {number} status @param {string} url */
  constructor(status, url) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    /** Not worth retrying: the file isn't there, or we may not have it. */
    this.permanent = status === 400 || status === 401 || status === 403 || status === 404 || status === 416;
  }
}

/** Retries a request on network errors, 429 and 5xx, waiting 1, 2, 4, 8 s. @template T @param {() => Promise<T>} attempt @returns {Promise<T>} */
async function withRetries(attempt) {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (err) {
      if (err?.permanent || tries >= RETRIES) throw err;
      await sleep(1000 * 2 ** (tries - 1));
    }
  }
}

/** @param {string|URL} url @param {RequestInit} [init] */
async function request(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) { await res.body?.cancel(); throw new HttpError(res.status, String(url)); }
  return res;
}

const fetchJson = (url) => withRetries(async () => (await request(url)).json());

/** Size of a public file, or null if it doesn't exist. @param {string} url @returns {Promise<number|null>} */
async function remoteSize(url) {
  try {
    const res = await withRetries(() => request(url, { method: 'HEAD' }));
    return Number(res.headers.get('content-length'));
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/** Bytes [offset, offset + length) of a public file. @param {string} url @param {number} offset @param {number} length */
export function fetchRange(url, offset, length) {
  return withRetries(async () => {
    const res = await request(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (res.status === 200) return bytes.subarray(offset, offset + length); // the server sent the whole file
    return bytes;
  });
}

/** Names of a public bucket's files under a prefix. @param {string} bucket @param {string} prefix @returns {Promise<string[]>} */
async function listFiles(bucket, prefix) {
  const names = [];
  let pageToken;
  do {
    const url = new URL(`${GCS}/storage/v1/b/${bucket}/o`);
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('fields', 'items(name),nextPageToken');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await fetchJson(url);
    for (const item of page.items ?? []) names.push(item.name);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return names;
}

/**
 * A file's bytes as they arrive, picking up where it broke off (HTTP
 * Range) if the connection drops: a footprint file is hundreds of MB.
 * @param {string} url @param {number} size @param {(bytes: number) => void} onBytes
 */
async function* download(url, size, onBytes) {
  let offset = 0, failures = 0;
  while (offset < size) {
    const idle = new AbortController();
    const timer = setTimeout(() => idle.abort(new Error(`no data for ${IDLE_TIMEOUT_MS / 1000} s`)), IDLE_TIMEOUT_MS);
    try {
      const res = await request(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: idle.signal });
      if (offset && res.status !== 206) { await res.body?.cancel(); throw new Error('the server would not resume the download'); }
      for await (const chunk of res.body) {
        timer.refresh();
        offset += chunk.length; failures = 0;
        onBytes(chunk.length);
        yield chunk;
      }
      if (offset < size) throw new Error('the download stopped early');
    } catch (err) {
      if (err?.permanent || ++failures >= RETRIES) throw err;
      await sleep(1000 * 2 ** (failures - 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Calls onLine for each line of a gzipped text file, as it downloads.
 * @param {string} url @param {number} size @param {(line: string) => void} onLine @param {(done: number) => void} onProgress - 0..1
 */
async function forEachLine(url, size, onLine, onProgress) {
  let received = 0, nextReport = 0.25;
  const source = Readable.from(download(url, size, (n) => {
    received += n;
    if (received / size >= nextReport) { onProgress(received / size); nextReport += 0.25; }
  }), { objectMode: false });
  const gunzip = createGunzip();
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip);
  let rest = '';
  for await (const chunk of gunzip) {
    const text = rest + chunk.toString('latin1'); // the CSV is ASCII
    let start = 0;
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', start)) {
      if (nl > start) onLine(text.charCodeAt(nl - 1) === 13 ? text.slice(start, nl - 1) : text.slice(start, nl));
      start = nl + 1;
    }
    rest = text.slice(start);
  }
  if (rest) onLine(rest);
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

// ---------------------------------------------------------------------
// The two steps.
// ---------------------------------------------------------------------
/**
 * Downloads the footprints reaching into an area.
 * @param {Area} area
 * @param {{minConfidence?: number, log?: (line: string) => void}} [opts]
 * @returns {Promise<Footprints>}
 */
export async function readFootprints(area, { minConfidence = MIN_CONFIDENCE_FLOOR, log = () => {} } = {}) {
  const cells = s2CellsCovering(area, FOOTPRINT_CELL_LEVEL);
  const near = { west: area.west - EDGE_MARGIN_DEG, south: area.south - EDGE_MARGIN_DEG, east: area.east + EDGE_MARGIN_DEG, north: area.north + EDGE_MARGIN_DEG };
  const store = new FootprintStore();
  let files = 0, rows = 0, unreadable = 0;
  for (const [i, cell] of cells.entries()) {
    const url = `${FOOTPRINTS_URL}/${cell}_buildings.csv.gz`;
    const size = await remoteSize(url);
    const label = `Footprints, file ${i + 1} of ${cells.length} (S2 cell ${cell})`;
    if (size === null) { log(`${label}: none; Google has no buildings there`); continue; }
    files++;
    log(`${label}: downloading ${mb(size)}`);
    const before = store.count;
    await forEachLine(url, size, (line) => {
      rows++;
      // Latitude and longitude come first: most rows are outside the area and need nothing else read.
      const c1 = line.indexOf(','), c2 = line.indexOf(',', c1 + 1);
      const lat = Number(line.slice(0, c1)), lon = Number(line.slice(c1 + 1, c2));
      if (!(lon >= near.west && lon <= near.east && lat >= near.south && lat <= near.north)) {
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) unreadable++;
        return;
      }
      const row = parseFootprintRow(line);
      if (!row) { unreadable++; return; }
      if (row.confidence < minConfidence) return;
      const inside = lon >= area.west && lon <= area.east && lat >= area.south && lat <= area.north;
      if (!store.addWkt(row.wkt, inside ? null : area) && inside) unreadable++;
    }, (done) => log(`  ${Math.round(done * 100)}% downloaded, ${(store.count - before).toLocaleString('en-IN')} buildings in the area so far`));
    if (rows > 1000 && unreadable > rows / 100) throw new UserError(`Google's footprint files have changed format (${unreadable.toLocaleString('en-IN')} of ${rows.toLocaleString('en-IN')} rows unreadable); this script needs updating. Use the Earth Engine route in DATA_SOURCES.md meanwhile.`);
  }
  if (!files) throw new UserError('Google Open Buildings has no footprints for this area. It covers Africa, South and Southeast Asia, Latin America and the Caribbean; for elsewhere see DATA_SOURCES.md.');
  if (!store.count) throw new UserError('there are no buildings in this area in Google Open Buildings. Check the four numbers: West and East are longitudes, South and North latitudes.');
  return store.seal();
}

/**
 * Finds the height tiles over an area for a year (the latest there is, if none is given).
 * @param {Area} area @param {number|null} year
 * @returns {Promise<{year: number, tiles: Array<{url: string, utm: Utm, band: number}>}>}
 */
export async function findHeightTiles(area, year) {
  const m = MANIFEST_SEARCH_MARGIN_DEG;
  const search = { west: area.west - m, south: area.south - m, east: area.east + m, north: area.north + m };
  // UTM zones whose tiles could reach the area: the area's own, and one either side.
  const zoneOf = (lon) => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  const zones = new Set();
  for (let z = zoneOf(search.west) - 1; z <= zoneOf(search.east) + 1; z++) zones.add(((z + 59) % 60) + 1);
  const manifests = [];
  const years = new Set();
  for (const cell of s2CellsCovering(search, MANIFEST_CELL_LEVEL)) {
    for (const name of await listFiles(HEIGHTS_BUCKET, `v1/manifests/${cell}_`)) {
      const parts = /_EPSG_32[67](\d\d)_(\d{4})_\d\d_\d\d\.json$/.exec(name);
      if (!parts || !zones.has(+parts[1])) continue;
      years.add(+parts[2]);
      manifests.push({ name, year: +parts[2] });
    }
  }
  if (!years.size) throw new UserError('Google\'s building heights (Open Buildings 2.5D) do not cover this area. They cover Africa, South and Southeast Asia, Latin America and the Caribbean; for elsewhere see DATA_SOURCES.md.');
  const use = year ?? Math.max(...years);
  if (!years.has(use)) throw new UserError(`Google has no building heights for ${use} here. Years it has: ${[...years].sort().join(', ')}.`);
  const tiles = [];
  for (const { name } of manifests.filter((x) => x.year === use)) {
    const manifest = await fetchJson(`${GCS}/${HEIGHTS_BUCKET}/${name}`);
    const heightBand = manifest.bands?.find((b) => b.id === HEIGHT_BAND_ID);
    if (!heightBand) throw new UserError(`Google's height manifests no longer list a "${HEIGHT_BAND_ID}" band; this script needs updating.`);
    for (const tileset of manifest.tilesets ?? []) {
      if (heightBand.tilesetId && tileset.id && tileset.id !== heightBand.tilesetId) continue;
      const utm = utmOf(tileset.crs);
      const box = areaInUtm(area, utm);
      for (const source of tileset.sources ?? []) {
        const t = source.affineTransform, d = source.dimensions;
        const xA = t.translateX, xB = t.translateX + t.scaleX * d.width, yA = t.translateY, yB = t.translateY + t.scaleY * d.height;
        if (Math.max(xA, xB) < box.minX || Math.min(xA, xB) > box.maxX || Math.max(yA, yB) < box.minY || Math.min(yA, yB) > box.maxY) continue;
        tiles.push({ url: (manifest.uriPrefix + source.uris[0]).replace(/^gs:\/\//, `${GCS}/`), utm, band: heightBand.tilesetBandIndex ?? 0 });
      }
    }
  }
  if (!tiles.length) throw new UserError(`Google has no building heights for ${use} over this area.`);
  return { year: use, tiles };
}

/**
 * Gives each footprint its average height from Google's height tiles.
 * @param {Footprints} fp @param {Area} area
 * @param {{year?: number|null, pixelM?: number, log?: (line: string) => void}} [opts]
 * @returns {Promise<{year: number, heights: Float32Array, tiles: number, bytes: number}>} NaN where there is no height
 */
export async function addHeights(fp, area, { year = null, pixelM = DEFAULT_PIXEL_M, log = () => {} } = {}) {
  const found = await findHeightTiles(area, year);
  log(`Heights (${found.year}): ${found.tiles.length} tile${found.tiles.length === 1 ? '' : 's'} of 12.5 km; downloading only what the buildings cover`);
  const totals = { sum: new Float64Array(fp.count), count: new Uint32Array(fp.count), centre: new Float32Array(fp.count).fill(NaN) };
  /** @type {Map<number, Projected>} */
  const projected = new Map();
  let bytes = 0;
  for (const [i, tile] of found.tiles.entries()) {
    if (!projected.has(tile.utm.epsg)) projected.set(tile.utm.epsg, projectFootprints(fp, tile.utm, area));
    const readRange = async (offset, length) => { const got = await fetchRange(tile.url, offset, length); bytes += got.length; return got; };
    const cog = await Cog.open(readRange);
    if (cog.epsg && cog.epsg !== tile.utm.epsg) throw new UserError(`a height tile is in EPSG:${cog.epsg}, not EPSG:${tile.utm.epsg} as Google's manifest says; this script needs updating`);
    const image = cog.images.reduce((best, im) => (Math.abs(Math.log(im.pixelSizeX / pixelM)) < Math.abs(Math.log(best.pixelSizeX / pixelM)) ? im : best));
    const { buildings } = await sampleTile(cog, image, tile.band, fp, projected.get(tile.utm.epsg), totals);
    log(`  tile ${i + 1} of ${found.tiles.length}: ${buildings.toLocaleString('en-IN')} buildings; ${mb(bytes)} downloaded so far`);
  }
  const heights = new Float32Array(fp.count);
  for (let b = 0; b < fp.count; b++) heights[b] = totals.count[b] ? totals.sum[b] / totals.count[b] : totals.centre[b];
  return { year: found.year, heights, tiles: found.tiles.length, bytes };
}

// ---------------------------------------------------------------------
// Microsoft (Bing Maps) footprints, the fallback source.
// ---------------------------------------------------------------------
/**
 * A map tile's quadkey (Bing Maps tile system): one digit per zoom level.
 * @param {number} x @param {number} y @param {number} zoom
 */
export function quadkey(x, y, zoom) {
  let key = '';
  for (let i = zoom; i > 0; i--) { const m = 1 << (i - 1); key += ((x & m) ? 1 : 0) + ((y & m) ? 2 : 0); }
  return key;
}

/** The quadkeys of the map tiles (Web Mercator) an area reaches into. @param {Area} area @param {number} zoom */
export function quadkeysCovering(area, zoom) {
  const n = 2 ** zoom;
  const tileX = (lon) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const tileY = (lat) => { const r = (lat * Math.PI) / 180; return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n))); };
  const keys = [];
  for (let x = tileX(area.west); x <= tileX(area.east); x++) for (let y = tileY(area.north); y <= tileY(area.south); y++) keys.push(quadkey(x, y, zoom));
  return keys;
}

/** The current link to Microsoft's index of files (it moves with each release). */
async function microsoftIndexUrl(log) {
  try {
    const readme = await withRetries(async () => (await request(MICROSOFT_README)).text());
    const link = /https:\/\/[^\s)\]]+\/dataset-links\.csv/.exec(readme);
    if (link) return link[0];
  } catch (err) {
    log(`  (couldn't read Microsoft's README for the newest index, ${err.message}; using the one of 2026-08-13)`);
  }
  return MICROSOFT_INDEX_FALLBACK;
}

/**
 * Downloads Microsoft's footprints reaching into an area, with Microsoft's
 * height for each where it has one (NaN where it doesn't).
 * @param {Area} area
 * @param {{minConfidence?: number, indexUrl?: string|null, log?: (line: string) => void}} [opts]
 * @returns {Promise<{footprints: Footprints, heights: Float32Array}>}
 */
export async function readMicrosoftFootprints(area, { minConfidence = 0, indexUrl = null, log = () => {} } = {}) {
  const url = indexUrl ?? await microsoftIndexUrl(log);
  log(`Microsoft's index: ${url}`);
  const rows = (await withRetries(async () => (await request(url)).text())).split('\n').map((line) => line.trim().split(','));
  if (rows[0]?.[1] !== 'QuadKey' || rows[0]?.[2] !== 'Url') throw new UserError("Microsoft's index has changed format; this script needs updating. Use Microsoft's own notebook meanwhile (DATA_SOURCES.md).");
  const zoom = rows[1]?.[1]?.length;
  const wanted = new Set(quadkeysCovering(area, zoom));
  const files = rows.slice(1).filter((r) => r.length >= 3 && wanted.has(r[1]));
  if (!files.length) throw new UserError('Microsoft has no building footprints for this area.');
  const store = new FootprintStore();
  const heights = new Grow(Float32Array);
  let lines = 0, unreadable = 0;
  for (const [i, [location, key, fileUrl]] of files.entries()) {
    const size = await remoteSize(fileUrl);
    if (size === null) throw new UserError(`Microsoft's index lists ${fileUrl}, but it isn't there; the index may be out of date (try again later, or pass --microsoft-index)`);
    log(`Footprints, file ${i + 1} of ${files.length} (${location}, tile ${key}): downloading ${mb(size)}`);
    const before = store.count;
    await forEachLine(fileUrl, size, (line) => {
      lines++;
      let feature;
      try { feature = JSON.parse(line); } catch { unreadable++; return; }
      const confidence = feature?.properties?.confidence;
      if (typeof confidence === 'number' && confidence >= 0 && confidence < minConfidence) return; // -1: not scored, kept
      if (!store.addGeometry(feature?.geometry, area)) return;
      const h = feature.properties?.height;
      heights.push(typeof h === 'number' && h >= 0 ? h : NaN); // -1: no estimate
    }, (done) => log(`  ${Math.round(done * 100)}% downloaded, ${(store.count - before).toLocaleString('en-IN')} buildings in the area so far`));
    if (lines > 1000 && unreadable > lines / 100) throw new UserError("Microsoft's footprint files have changed format; this script needs updating.");
  }
  if (!store.count) throw new UserError("there are no buildings in this area in Microsoft's footprints. Check the four numbers: West and East are longitudes, South and North latitudes.");
  return { footprints: store.seal(), heights: heights.view() };
}

/**
 * Writes the buildings as a GeoJSON FeatureCollection, one feature per
 * line, each with one property, the height in metres (`mean` unless
 * told otherwise), left out where there is no height. Written to `<path>.part` first, so a failed run leaves no
 * half-written file under the real name.
 * @param {string} path @param {Footprints} fp @param {Float32Array} heights
 * @param {{name: string, source: object, heightProperty?: string}} meta
 * @returns {Promise<{withHeight: number}>}
 */
export async function writeBuildingsGeojson(path, fp, heights, { name, source, heightProperty = 'mean' }) {
  const heightKey = JSON.stringify(heightProperty);
  const part = `${path}.part`;
  const out = createWriteStream(part);
  const done = finished(out); // rejects on a write error (a full disk), so nothing waits forever
  done.catch(() => {});
  let buffer = `{\n"type": "FeatureCollection",\n"name": ${JSON.stringify(name)},\n"source": ${JSON.stringify(source)},\n"features": [\n`;
  let withHeight = 0;
  const flush = async (force) => {
    if (buffer.length < (force ? 1 : 1 << 20)) return;
    if (!out.write(buffer)) await Promise.race([once(out, 'drain'), done]);
    buffer = '';
  };
  try {
    for (let b = 0; b < fp.count; b++) {
      const h = heights[b];
      const hasHeight = Number.isFinite(h);
      if (hasHeight) withHeight++;
      const polygons = [];
      let polygon = '';
      for (let r = fp.buildingRingStart[b]; r < fp.buildingRingStart[b + 1]; r++) {
        let ring = '[';
        for (let k = fp.ringStart[r]; k < fp.ringStart[r + 1]; k++) ring += `${k > fp.ringStart[r] ? ',' : ''}[${fp.coords[2 * k]},${fp.coords[2 * k + 1]}]`;
        ring += ']';
        if (fp.ringOuter[r]) { if (polygon) polygons.push(`${polygon}]`); polygon = `[${ring}`; } else polygon += `,${ring}`;
      }
      polygons.push(`${polygon}]`);
      const geometry = fp.multi[b] ? `{"type":"MultiPolygon","coordinates":[${polygons.join(',')}]}` : `{"type":"Polygon","coordinates":${polygons[0]}}`;
      buffer += `{"type":"Feature","properties":${hasHeight ? `{${heightKey}:${Math.round(h * 100) / 100}}` : '{}'},"geometry":${geometry}}${b + 1 < fp.count ? ',' : ''}\n`;
      await flush(false);
    }
    buffer += ']\n}\n';
    await flush(true);
    out.end();
    await done;
    renameSync(part, path);
  } catch (err) {
    out.destroy();
    rmSync(part, { force: true });
    throw err;
  }
  return { withHeight };
}
