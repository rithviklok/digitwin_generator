// Checks scripts/geojson-feature-stream.mjs -- NOT part of the app. The
// reader must hand back exactly the features JSON.parse would, whatever the
// file's formatting and wherever the pieces it is read in happen to be cut
// (in the middle of a string, an escape, a multi-byte character, a number).
// Self-contained: writes small files to the temp folder and removes them.
//   node scripts/test-feature-stream.mjs
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readFeatureBatches, GeojsonFileError } from './geojson-feature-stream.mjs';

const dir = mkdtempSync(join(tmpdir(), 'feature-stream-'));
let fileNo = 0;
function fileOf(text) {
  const path = join(dir, `${fileNo++}.geojson`);
  writeFileSync(path, text);
  return path;
}
function assert(ok, what) {
  if (ok) console.log(`OK: ${what}`);
  else { console.error(`FAIL: ${what}`); process.exitCode = 1; }
}
const readAll = (path, chunkBytes) => [...readFeatureBatches(path, chunkBytes ? { chunkBytes } : {})].flatMap((b) => b.features);
/** What the reader should return: the objects in "features", in order. */
const expected = (text) => JSON.parse(text.replace(/^\uFEFF/, '')).features.filter((f) => f && typeof f === 'object' && !Array.isArray(f));
function failure(path, chunkBytes) {
  try { readAll(path, chunkBytes); return null; } catch (err) { return err; }
}

// ---- A small collection with everything that could confuse a brace counter ----
const tricky = {
  type: 'FeatureCollection',
  name: 'features', // a root-level string VALUE that reads "features"
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84', nested: { deep: [1, { a: 2 }] } } },
  bbox: [80.1, 26.3, 80.5, 26.6],
  features: [
    { type: 'Feature', id: 'a1', properties: { mean: 5.5, name: 'plain' }, geometry: { type: 'Polygon', coordinates: [[[80.1, 26.4], [80.2, 26.4], [80.2, 26.5], [80.1, 26.4]]] } },
    { type: 'Feature', properties: { name: 'braces } { ] [ in a string', quote: 'say "hi" \\ back\\slash', path: 'C:\\temp\\x', tail: 'ends with a backslash\\' }, geometry: null },
    { type: 'Feature', properties: { name: 'कानपुर नगर निगम', emoji: 'tower 🗼 and ₹', features: [{ type: 'Feature', inner: true }, [1, 2]], obj: { features: [] } }, geometry: { type: 'Point', coordinates: [80.3, 26.45] } },
    { type: 'Feature', properties: null, geometry: { type: 'MultiPolygon', coordinates: [[[[1e-7, -2.5E+3], [3, 4], [5, 6], [1e-7, -2.5e3]]]] } },
    { type: 'Feature', properties: { big: 'x'.repeat(5000), n: -0.000001234, t: true, f: false, nothing: null }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
  ],
  trailing: { after: ['the', 'features', { array: true }] },
};
const layouts = {
  'on one line': JSON.stringify(tricky),
  'indented by 2': JSON.stringify(tricky, null, 2),
  'indented by tabs': JSON.stringify(tricky, null, '\t'),
  'one feature per line (ogr2ogr style)': `{\n"type": "FeatureCollection",\n"name": "features",\n"features": [\n${tricky.features.map((f) => JSON.stringify(f)).join(',\n')}\n]\n}\n`,
  'Windows line endings': JSON.stringify(tricky, null, 2).replace(/\n/g, '\r\n'),
  'with a byte-order mark': `\uFEFF${JSON.stringify(tricky)}`,
};
for (const [name, text] of Object.entries(layouts)) {
  const path = fileOf(text);
  assert(isDeepStrictEqual(readAll(path), expected(text)), `${name}: same features as JSON.parse`);
  // Every piece size from 1 byte up: each possible cut point falls on a piece boundary at some size.
  let allSizes = true;
  for (let size = 1; size <= 70 && allSizes; size++) allSizes = isDeepStrictEqual(readAll(path, size), expected(text));
  assert(allSizes, `${name}: the same when read 1, 2, 3 … 70 bytes at a time`);
}

// ---- What is in "features" besides features ----
{
  const text = '{"type":"FeatureCollection","features":[null, 7, "text {", [1,{"x":1}], {"type":"Feature","properties":{"k":1},"geometry":null}, true, {"type":"Feature","properties":{"k":2},"geometry":null}]}';
  assert(isDeepStrictEqual(readAll(fileOf(text), 5), expected(text)), 'elements of "features" that are not objects are skipped');
  const empty = '{"type":"FeatureCollection","features":[]}';
  assert(readAll(fileOf(empty)).length === 0, 'an empty "features" list gives no features and no error');
  const first = '{"features":[{"type":"Feature","properties":{"k":1},"geometry":null}],"type":"FeatureCollection","crs":{"x":[1,2,{"features":[{"no":1}]}]}}';
  assert(isDeepStrictEqual(readAll(fileOf(first), 3), expected(first)), '"features" first in the file, other members after it');
}

// ---- Progress numbers ----
{
  const text = layouts['indented by 2'];
  const path = fileOf(text);
  const batches = [...readFeatureBatches(path, { chunkBytes: 64 })];
  const total = Buffer.byteLength(text);
  assert(batches.every((b) => b.totalBytes === total), 'totalBytes is the file size');
  assert(batches.every((b, i) => i === 0 || b.bytesRead >= batches[i - 1].bytesRead), 'bytesRead never goes backwards');
  assert(batches.at(-1).bytesRead === total, 'the last report says the whole file is read');
}

// ---- Files that are not right ----
{
  const whole = layouts['one feature per line (ogr2ogr style)'];
  const cases = [
    ['no "features" member', '{"type":"FeatureCollection","items":[{"a":1}]}', /no "features" list/],
    ['an array at the root', '[{"type":"Feature"}]', /no "features" list/],
    ['"features" is null', '{"type":"FeatureCollection","features":null,"x":[1]}', /no "features" list/],
    ['an empty file', '', /no "features" list/],
    ['cut off in the middle of a building', whole.slice(0, whole.indexOf('कानपुर') + 3), /stops partway through \(after 2 buildings\)/],
    ['cut off between two buildings', whole.slice(0, whole.indexOf('{"type":"Feature","properties":{"name":"braces')), /stops partway through \(after 1 building\)/],
    ['cut off before the closing bracket', whole.slice(0, whole.lastIndexOf(']')), /stops partway through \(after 5 buildings\)/],
    ['a building that is not valid JSON', '{"type":"FeatureCollection","features":[{"type":"Feature"},{"type": Feature},{"type":"Feature"}]}', /building number 2 .* isn't valid JSON/],
  ];
  for (const [name, text, pattern] of cases) {
    for (const size of [undefined, 1, 7]) {
      const err = failure(fileOf(text), size);
      assert(err instanceof GeojsonFileError && pattern.test(err.message), `${name}${size ? ` (${size} bytes at a time)` : ''}: refused with "${err?.message?.slice(0, 60)}…"`);
    }
  }
}

// ---- Random collections, random layouts, random piece sizes ----
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const bits = ['{', '}', '[', ']', '"', '\\', ',', ':', ' ', '\n', 'é', 'नि', '🏙', 'a', '0', '\t', '\u2028', 'features'];
  const str = () => Array.from({ length: Math.floor(rnd() * 12) }, () => pick(bits)).join('');
  const value = (depth) => {
    const r = rnd();
    if (depth > 3 || r < 0.35) return pick([str(), rnd() * 1000 - 500, Math.floor(rnd() * 1e6), true, false, null, 1e-9, -2.5e21]);
    if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [str() || 'k', value(depth + 1)]));
  };
  const feature = () => ({ type: 'Feature', id: str(), properties: rnd() < 0.1 ? null : value(1), geometry: { type: 'Polygon', coordinates: [Array.from({ length: 4 }, () => [80 + rnd(), 26 + rnd()])] } });
  let ok = true, tried = 0;
  for (let run = 0; run < 300 && ok; run++) {
    const fc = {};
    const members = [['type', 'FeatureCollection'], [str() || 'x', value(0)], ['features', Array.from({ length: Math.floor(rnd() * 8) }, () => (rnd() < 0.1 ? pick([null, 3, 'text', [1]]) : feature()))], [str() || 'y', value(0)]];
    for (const [k, v] of members.sort(() => rnd() - 0.5)) if (!(k in fc) && (k !== 'features' || !('features' in fc))) fc[k] = v;
    if (!Array.isArray(fc.features) || Object.keys(fc).indexOf('features') === -1) continue;
    const text = JSON.stringify(fc, null, pick([0, 1, 2, '\t']));
    const path = fileOf(text);
    const want = expected(text);
    for (const size of [1 + Math.floor(rnd() * 40), 1 + Math.floor(rnd() * 2000), undefined]) {
      tried++;
      if (!isDeepStrictEqual(readAll(path, size), want)) { ok = false; console.error(`  differs on run ${run}, ${size} bytes at a time:\n${text.slice(0, 400)}`); }
    }
  }
  assert(ok && tried > 500, `random collections match JSON.parse (${tried} reads)`);
}

rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode === 1 ? '\n=== FEATURE STREAM: FAILURES ABOVE ===' : '\n=== FEATURE STREAM: ALL CHECKS PASSED ===');
