// ===================================================================
// geojsonValidate.js -- the upload-time check for every uploaded file
// (buildings, municipal layers, per-layer OSM replacements, an OSM
// export): a cheap structural check plus "are these coordinates
// longitude/latitude at all", not a deep per-role schema check. Per-role
// shape fixes happen at build time (osmSplitter.js's createLayerNormalizer());
// this only needs to catch what the uploader can still fix on the form --
// "this isn't GeoJSON" or "this is in metres, not degrees".
// ===================================================================
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

/**
 * Above this, only the start of the file is checked at upload time. A full
 * parse of a city-sized buildings file (Kanpur's 283 MB: 4.6 s, 0.8 GB of
 * memory) blocked the whole server -- every other uploader's status page
 * included -- while the uploader just saw a stuck "Uploading…". The build
 * parses the full file anyway, in its own process, and reports a broken
 * file there.
 */
const FULL_CHECK_MAX_BYTES = 25 * 1024 * 1024;
const HEAD_BYTES = 2 * 1024 * 1024;

/** The start of a large file: is it a FeatureCollection, and are its first coordinates longitude/latitude? */
function checkHead(filePath) {
  const buf = Buffer.alloc(HEAD_BYTES);
  const fd = openSync(filePath, 'r');
  let n;
  try { n = readSync(fd, buf, 0, HEAD_BYTES, 0); } finally { closeSync(fd); }
  const head = buf.toString('utf8', 0, n);
  if (!/^\s*\{/.test(head)) return { ok: false, error: 'not a JSON object' };
  if (!/"type"\s*:\s*"FeatureCollection"/.test(head) || !/"features"\s*:\s*\[/.test(head)) {
    return { ok: false, error: 'doesn’t look like a GeoJSON FeatureCollection (no "type": "FeatureCollection" / "features" near the start of the file)' };
  }
  const c = /"coordinates"\s*:\s*\[[\s[]*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*,\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(head);
  if (c && (Math.abs(Number(c[1])) > 180 || Math.abs(Number(c[2])) > 90)) return { ok: false, error: projectedError(c[1], c[2]) };
  return { ok: true, featureCount: null };
}

/**
 * The `properties` of the first buildings in a file (up to `max`), read from
 * its start only -- enough to tell whether a height property name exists at
 * all, without parsing a file that may be hundreds of MB. Property objects
 * containing nested objects are skipped (rare for building footprints).
 * @returns {object[]}
 */
export function sampleProperties(filePath, max = 50) {
  const buf = Buffer.alloc(HEAD_BYTES);
  const fd = openSync(filePath, 'r');
  let n;
  try { n = readSync(fd, buf, 0, HEAD_BYTES, 0); } finally { closeSync(fd); }
  const out = [];
  for (const m of buf.toString('utf8', 0, n).matchAll(/"properties"\s*:\s*(\{[^{}]*\})/g)) {
    try { out.push(JSON.parse(m[1])); } catch { /* cut off at the end of the sample */ }
    if (out.length >= max) break;
  }
  return out;
}

function projectedError(x, y) {
  return `coordinates like (${x}, ${y}) aren't longitude/latitude. The file looks like it's in a projected system such as UTM. Re-save it as WGS 84 (EPSG:4326), e.g. in QGIS: Export → Save Features As… → CRS EPSG:4326.`;
}

const VALID_GEOMETRY_TYPES = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection',
]);

/**
 * @param {string} filePath
 * @returns {{ok: true, featureCount: number|null} | {ok: false, error: string}} featureCount is null when only the file's start was checked
 */
export function validateGeojsonFile(filePath) {
  try {
    if (statSync(filePath).size > FULL_CHECK_MAX_BYTES) return checkHead(filePath);
  } catch (err) {
    return { ok: false, error: `could not read file: ${err.message}` };
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read file: ${err.message}` };
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err.message}` };
  }

  if (!doc || typeof doc !== 'object') return { ok: false, error: 'not a JSON object' };
  if (doc.type !== 'FeatureCollection') return { ok: false, error: `expected type "FeatureCollection", got "${doc.type}"` };
  if (!Array.isArray(doc.features)) return { ok: false, error: '"features" is not an array' };

  for (let i = 0; i < doc.features.length; i++) {
    const f = doc.features[i];
    if (!f || f.type !== 'Feature') return { ok: false, error: `features[${i}] is not a Feature` };
    // `geometry: null` is valid GeoJSON (RFC 7946 3.2: an "unlocated" feature; QGIS
    // writes them for empty shapes). Every consumer skips such a feature, so
    // it is no reason to refuse the whole file. A geometry that IS present
    // must still be a real type.
    if (f.geometry === null) continue;
    if (!f.geometry || !VALID_GEOMETRY_TYPES.has(f.geometry.type)) {
      return { ok: false, error: `features[${i}].geometry has an unrecognized type "${f.geometry?.type}"` };
    }
    // Municipal GIS data (in India, very often UTM zone 43N/44N/45N) is
    // commonly in metres, not degrees. Such a file is valid GeoJSON and
    // would "upload fine", then draw nowhere -- catch it here, where the
    // uploader can still fix it. One point per feature is enough to tell.
    const [x, y] = firstCoordinate(f.geometry) ?? [];
    if (Math.abs(x) > 180 || Math.abs(y) > 90) return { ok: false, error: projectedError(x, y) };
  }

  return { ok: true, featureCount: doc.features.length };
}

function firstCoordinate(geometry) {
  let c = geometry?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === 'number' ? c : null;
}
