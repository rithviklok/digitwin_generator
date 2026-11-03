// Checks fetch-open-buildings.mjs's workings (open-buildings-lib.mjs and
// cog-reader.mjs) -- NOT part of the app.
//   node scripts/test-fetch-open-buildings.mjs            offline (~2 s)
//   node scripts/test-fetch-open-buildings.mjs --online   also against Google's live files (~1 min): footprint
//       file names for cities on four S2 cube faces, Kanpur's height tiles, and the heights of about 16,700
//       buildings in central Kanpur against Kanpur's own file, which was made in Earth Engine
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cog } from './cog-reader.mjs';
import {
  s2CellToken, s2CellsCovering, toUtm, utmOf, FootprintStore, parseFootprintRow, forEachSpanInside,
  projectFootprints, sampleTile, writeBuildingsGeojson, findHeightTiles, addHeights, quadkey, quadkeysCovering,
} from './open-buildings-lib.mjs';
import { validateGeojsonFile, sampleProperties } from '../server/lib/geojsonValidate.js';
import { fetchProgressOf } from '../server/jobs/buildingsJob.js';
import { readFeatureBatches } from './geojson-feature-stream.mjs';

const ONLINE = process.argv.includes('--online');
const CLI = fileURLToPath(new URL('./fetch-open-buildings.mjs', import.meta.url));
const KANPUR_FILE = fileURLToPath(new URL('../public/data/kanpur/Kanpur_OpenBuildings_2_5D.geojson', import.meta.url));
const KANPUR = { west: 80.178, south: 26.315, east: 80.493, north: 26.553 };
let failures = 0;
function assert(ok, what) {
  if (ok) console.log(`OK: ${what}`);
  else { console.error(`FAIL: ${what}`); failures++; }
}
const throws = (fn, pattern) => { try { fn(); return false; } catch (err) { return pattern.test(err.message); } };
async function rejects(promise, pattern) { try { await promise; return false; } catch (err) { return pattern.test(err.message); } }
let seed = 20261002;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// ---- S2 cells: Google's file names ----
assert(s2CellToken(80.3319, 26.4499, 2) === '39', 'S2: Kanpur is in level-2 cell 39, the name of its height manifests');
assert(s2CellToken(80.3319, 26.4499, 6) === '399d', 'S2: and level-6 cell 399d, the name of its footprint file');
assert(s2CellToken(80.3319, 26.4499, 7) === '399c4', 'S2: and level-7 cell 399c4, the folder of its 2023 height tiles');
assert(JSON.stringify(s2CellsCovering(KANPUR, 6)) === '["399d"]', "S2: Kanpur's whole area is in that one footprint file");
assert([[0, 0, '1'], [90, 0, '3'], [0, 89, '5'], [180, 0, '7'], [-90, 0, '9'], [0, -89, 'b']].every(([lon, lat, t]) => s2CellToken(lon, lat, 0) === t), 'S2: the six cube faces are numbered as the S2 library numbers them');
{
  let missed = 0;
  for (let a = 0; a < 25; a++) {
    const w = rnd() * 340 - 170, s = rnd() * 140 - 70, area = { west: w, south: s, east: w + 0.05 + rnd() * 1.4, north: s + 0.05 + rnd() * 1.4 };
    const cells = new Set(s2CellsCovering(area, 6));
    for (let k = 0; k < 400; k++) if (!cells.has(s2CellToken(area.west + rnd() * (area.east - area.west), area.south + rnd() * (area.north - area.south), 6))) missed++;
  }
  assert(missed === 0, `S2: the cells found for an area hold every point in it (10,000 random points in 25 random areas; ${missed} missed)`);
}

// ---- UTM ----
{
  const p = [0, 0], q = [0, 0];
  toUtm(44.4, 33.3, utmOf('EPSG:32638'), p, 0);
  assert(Math.abs(p[0] - 444140.54) < 0.01 && Math.abs(p[1] - 3684706.36) < 0.01, `UTM: 33.3N 44.4E is 38N 444140.54 3684706.36, as GeographicLib's GeoConvert gives (got ${p[0].toFixed(2)} ${p[1].toFixed(2)})`);
  toUtm(44.4, -33.3, utmOf('EPSG:32738'), q, 0);
  assert(Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - (10000000 - p[1])) < 1e-6, 'UTM: the southern hemisphere mirrors the northern, counted from 10,000 km');
  // Snyder's older series (Map Projections: A Working Manual, 1987), written separately here.
  const snyder = (lon, lat, zone) => {
    const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const phi = (lat * Math.PI) / 180, l = ((lon - (zone * 6 - 183)) * Math.PI) / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * l;
    const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
    return [k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000,
      k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 + ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720))];
  };
  let worst = 0;
  for (let k = 0; k < 200; k++) {
    const lon = 78 + rnd() * 6, lat = 8 + rnd() * 26;
    toUtm(lon, lat, utmOf('EPSG:32644'), p, 0);
    const [x, y] = snyder(lon, lat, 44);
    worst = Math.max(worst, Math.hypot(p[0] - x, p[1] - y));
  }
  assert(worst < 0.001, `UTM: Snyder's series agrees across zone 44 to the edges (worst ${(worst * 1000).toFixed(3)} mm, 200 points)`);
  assert(throws(() => utmOf('EPSG:4326'), /not a UTM zone/), 'UTM: a projection other than UTM is refused');
}

// ---- Footprints: WKT and Google's CSV rows ----
{
  const store = new FootprintStore();
  assert(store.addWkt('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0),(2 2, 4 2, 4 4, 2 2))'), 'WKT: a polygon with a hole is read');
  assert(store.addWkt('MULTIPOLYGON(((0 0,1 0,1 1,0 0)),((5 5,6 5,6 6,5 5),(5.1 5.1,5.2 5.1,5.2 5.2,5.1 5.1)))'), 'WKT: a multipolygon, one part with a hole, is read');
  assert(store.addWkt('POLYGON((0 0, 3 0, 3 3))'), 'WKT: a ring missing its closing point is read');
  assert(!store.addWkt('POLYGON EMPTY') && !store.addWkt('POLYGON Z ((0 0 1, 1 0 1, 1 1 1, 0 0 1))') && !store.addWkt('POLYGON((0 0, 1 x, 1 1, 0 0))') && !store.addWkt('LINESTRING(0 0, 1 1)') && !store.addWkt('POLYGON((0 0, 1 1))'),
    'WKT: empty, 3D, unreadable, non-polygon and too-short shapes are refused');
  assert(!store.addWkt('POLYGON((50 50, 51 50, 51 51, 50 50))', { west: 0, south: 0, east: 10, north: 10 }) && store.addWkt('POLYGON((9.5 9.5, 12 9.5, 12 12, 9.5 9.5))', { west: 0, south: 0, east: 10, north: 10 }),
    "WKT: with an area, a footprint is kept only if it reaches into it");
  const fp = store.seal();
  assert(fp.count === 4 && fp.ringStart.length - 1 === 7 && [...fp.ringOuter].join('') === '1011011' && [...fp.multi].join('') === '0100', 'WKT: buildings, rings, outer rings and multipolygons are counted right, and refusals leave nothing behind');
  const closed = [...fp.coords.slice(fp.ringStart[5] * 2, fp.ringStart[6] * 2)];
  assert(JSON.stringify(closed.slice(0, 2)) === JSON.stringify(closed.slice(-2)), 'WKT: every ring stored is closed, as GeoJSON wants');
  // Three real rows of Google's footprint file for Kanpur's cell (399d).
  const row = parseFootprintRow('26.31317994,80.59555817,21.2448,0.8288,"POLYGON((80.5955883962936 26.3131912151783, 80.5955491439092 26.3132082783237, 80.5955279410857 26.3131686614342, 80.5955671934596 26.3131515982944, 80.5955883962936 26.3131912151783))",7MR28H7W+76F5');
  assert(row && row.lat === 26.31317994 && row.lon === 80.59555817 && row.confidence === 0.8288 && row.wkt.startsWith('POLYGON((80.5955883962936 26.3131912151783,'), "CSV: a row of Google's footprint file is read (latitude, longitude, area, confidence, WKT, plus code)");
  assert(parseFootprintRow('not,a,row') === null && parseFootprintRow('latitude,longitude,area_in_meters,confidence,"geometry",full_plus_code') === null, 'CSV: a header or a broken row is skipped');
  // Microsoft's footprints come as GeoJSON geometries.
  const ms = new FootprintStore();
  assert(ms.addGeometry({ type: 'Polygon', coordinates: [[[80.33, 26.45], [80.3301, 26.45], [80.3301, 26.4501], [80.33, 26.45]]] })
    && ms.addGeometry({ type: 'MultiPolygon', coordinates: [[[[1, 1], [2, 1], [2, 2], [1, 1]]], [[[3, 3], [4, 3], [4, 4]], [[3.1, 3.1], [3.2, 3.1], [3.2, 3.2], [3.1, 3.1]]]] }),
  'GeoJSON: a polygon and a multipolygon with a hole (one ring unclosed) are read');
  assert(!ms.addGeometry(null) && !ms.addGeometry({ type: 'Point', coordinates: [1, 2] }) && !ms.addGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 'x'], [1, 1], [0, 0]]] }) && !ms.addGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] })
    && !ms.addGeometry({ type: 'Polygon', coordinates: [[[50, 50], [51, 50], [51, 51], [50, 50]]] }, { west: 0, south: 0, east: 10, north: 10 }),
  'GeoJSON: no geometry, a point, a broken coordinate, a two-point ring and a footprint outside the area are refused');
  const msFp = ms.seal();
  assert(msFp.count === 2 && [...msFp.ringOuter].join('') === '1110' && [...msFp.multi].join('') === '01' && msFp.coords.length === 2 * (4 + 4 + 4 + 4), 'GeoJSON: rings and points are stored as read, the open ring closed, and refusals leave nothing behind');
}

// ---- Map tiles (quadkeys): Microsoft's file names ----
assert(quadkey(3, 5, 3) === '213', "quadkey: tile (3, 5) at zoom 3 is 213, the worked example in Microsoft's Bing Maps Tile System article");
assert(JSON.stringify(quadkeysCovering(KANPUR, 9)) === '["123132010","123132012"]', "quadkey: Kanpur's area is the two zoom-9 tiles Microsoft has files for, 123132010 and 123132012");

// ---- Which pixels a footprint covers: scanline vs testing every pixel centre ----
{
  const insideEvenOdd = (x, y, xs, ys, ringEnds) => {
    let inside = false, start = 0;
    for (const end of ringEnds) {
      for (let i = start, j = end - 1; i < end; j = i++) if ((ys[i] <= y) !== (ys[j] <= y) && x >= xs[i] + ((y - ys[i]) * (xs[j] - xs[i])) / (ys[j] - ys[i])) inside = !inside;
      start = end;
    }
    return inside;
  };
  const star = (cx, cy, r, n, xs, ys) => {
    const angles = Array.from({ length: n }, () => rnd() * 2 * Math.PI).sort((a, b) => a - b);
    for (const t of angles) { const rr = r * (0.4 + 0.6 * rnd()); xs.push(cx + rr * Math.cos(t)); ys.push(cy + rr * Math.sin(t)); }
    xs.push(xs[xs.length - n]); ys.push(ys[ys.length - n]);
  };
  let differences = 0, pixels = 0;
  for (let k = 0; k < 300; k++) {
    const xs = [], ys = [], ringEnds = [];
    const cx = 5 + rnd() * 50, cy = 5 + rnd() * 30, r = 0.3 + rnd() * 12;
    star(cx, cy, r, 3 + Math.floor(rnd() * 10), xs, ys); ringEnds.push(xs.length);
    if (k % 3 === 0) { star(cx, cy, r * 0.3, 3 + Math.floor(rnd() * 5), xs, ys); ringEnds.push(xs.length); }
    const fx = Float64Array.from(xs), fy = Float64Array.from(ys), colMax = 50;
    const got = new Set();
    forEachSpanInside(fx, fy, ringEnds, 0, 40, colMax, (row, c0, c1) => { for (let c = c0; c <= c1; c++) got.add(`${c},${row}`); }, new Float64Array(64));
    for (let row = 0; row <= 40; row++) for (let col = 0; col <= colMax; col++) {
      const want = insideEvenOdd(col + 0.5, row + 0.5, fx, fy, ringEnds);
      if (want) pixels++;
      if (want !== got.has(`${col},${row}`)) differences++;
    }
  }
  assert(differences === 0, `pixels: the scanline finds exactly the pixel centres inside, holes left out (300 random footprints, ${pixels} pixels; ${differences} differ)`);
}

// ---- Reading Cloud-Optimised GeoTIFFs ----
/**
 * A small tiled float32 GeoTIFF in memory, written here independently of cog-reader.mjs.
 * @param {{le: boolean, planar: 1|2, predictor: 1|3, deflate: boolean, tile: number, striped?: boolean,
 *   levels: Array<{width: number, height: number, bands: Float32Array[]}>, nodata?: string,
 *   geo: {originX: number, originY: number, pixel: number, epsg: number, pixelIsPoint?: boolean},
 *   sparse?: Set<string>}} spec - sparse: blocks left out, as "level/band/key"
 */
function makeTiff(spec) {
  const { le, planar, predictor, deflate, tile } = spec;
  const samples = spec.levels[0].bands.length;
  const parts = [];
  let size = 8;
  const put = (bytes) => { const at = size; parts.push({ at, bytes }); size += bytes.length + (bytes.length % 2); return at; };
  const encode = (type, values) => {
    const width = { 2: 1, 3: 2, 4: 4, 12: 8 }[type], buf = new Uint8Array(values.length * width), v = new DataView(buf.buffer);
    values.forEach((x, i) => { if (type === 2) buf[i] = x; else if (type === 3) v.setUint16(i * 2, x, le); else if (type === 4) v.setUint32(i * 4, x, le); else v.setFloat64(i * 8, x, le); });
    return buf;
  };
  const block = (level, band, bx, by) => {
    const per = planar === 2 ? 1 : samples, vals = new Float32Array(tile * tile * per);
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) for (let s = 0; s < per; s++) {
      const gx = bx * tile + x, gy = by * tile + y;
      vals[(y * tile + x) * per + s] = gx < level.width && gy < level.height ? level.bands[planar === 2 ? band : s][gy * level.width + gx] : 0;
    }
    const raw = new Uint8Array(vals.length * 4);
    if (predictor === 3) {
      // Adobe's floating-point predictor: byte planes, most significant first, then differences along the row.
      const wc = tile * per, rowBytes = wc * 4, one = new DataView(new ArrayBuffer(4));
      for (let y = 0; y < tile; y++) {
        const row = new Uint8Array(rowBytes);
        for (let k = 0; k < wc; k++) { one.setFloat32(0, vals[y * wc + k], false); for (let b = 0; b < 4; b++) row[b * wc + k] = one.getUint8(b); }
        for (let i = rowBytes - 1; i >= per; i--) row[i] = (row[i] - row[i - per]) & 0xff;
        raw.set(row, y * rowBytes);
      }
    } else {
      const dv = new DataView(raw.buffer);
      vals.forEach((x, i) => dv.setFloat32(i * 4, x, le));
    }
    return deflate ? new Uint8Array(deflateSync(raw)) : raw;
  };
  const dirs = [];
  spec.levels.forEach((level, li) => {
    const across = Math.ceil(level.width / tile), down = Math.ceil(level.height / tile), offsets = [], counts = [];
    for (let band = 0; band < (planar === 2 ? samples : 1); band++) for (let by = 0; by < down; by++) for (let bx = 0; bx < across; bx++) {
      if (spec.sparse?.has(`${li}/${band}/${by * across + bx}`)) { offsets.push(0); counts.push(0); continue; }
      const bytes = block(level, band, bx, by);
      offsets.push(put(bytes)); counts.push(bytes.length);
    }
    const entries = [[254, 4, [li ? 1 : 0]], [256, 4, [level.width]], [257, 4, [level.height]], [258, 3, Array(samples).fill(32)], [259, 3, [deflate ? 8 : 1]],
      [277, 3, [samples]], [284, 3, [planar]], [317, 3, [predictor]], [339, 3, Array(samples).fill(3)]];
    if (!spec.striped) entries.push([322, 3, [tile]], [323, 3, [tile]], [324, 4, offsets], [325, 4, counts]);
    if (li === 0) {
      const g = spec.geo;
      entries.push([33550, 12, [g.pixel, g.pixel, 0]], [33922, 12, [0, 0, 0, g.originX, g.originY, 0]], [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, g.pixelIsPoint ? 2 : 1, 3072, 0, 1, g.epsg]]);
      if (spec.nodata !== undefined) entries.push([42113, 2, [...Buffer.from(`${spec.nodata}\0`, 'latin1')]]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    const fields = entries.map(([tag, type, values]) => { const bytes = encode(type, values); return { tag, type, count: values.length, bytes, at: bytes.length > 4 ? put(bytes) : -1 }; });
    const dir = new Uint8Array(2 + fields.length * 12 + 4), dv = new DataView(dir.buffer);
    dv.setUint16(0, fields.length, le);
    fields.forEach((f, k) => { const o = 2 + k * 12; dv.setUint16(o, f.tag, le); dv.setUint16(o + 2, f.type, le); dv.setUint32(o + 4, f.count, le); if (f.at >= 0) dv.setUint32(o + 8, f.at, le); else dir.set(f.bytes, o + 8); });
    dirs.push({ dir, at: put(dir) });
  });
  dirs.forEach((d, k) => new DataView(d.dir.buffer).setUint32(d.dir.length - 4, k + 1 < dirs.length ? dirs[k + 1].at : 0, le));
  const file = new Uint8Array(size), dv = new DataView(file.buffer);
  file.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  dv.setUint16(2, 42, le); dv.setUint32(4, dirs[0].at, le);
  for (const { at, bytes } of parts) file.set(bytes, at);
  return file;
}
/** A reader over bytes in memory that counts its requests, as the real one fetches ranges. */
const memoryRange = (file, counter = { requests: 0 }) => async (offset, length) => { counter.requests++; return file.slice(offset, offset + length); };
const grid = (width, height, fn) => { const a = new Float32Array(width * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) a[y * width + x] = fn(x, y); return a; };
const sameFloat = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

{
  // Google's layout: little-endian, bands in their own blocks, Deflate with the floating-point predictor, an overview.
  const W = 40, H = 24;
  const bands = [0, 1, 2].map((b) => grid(W, H, (x, y) => (x === 3 && y === 5 ? NaN : x === 7 && y === 2 ? -99 : b * 1000 - y * 37.25 + x * 0.015625 + Math.sin(x * y))));
  const overview = [0, 1, 2].map((b) => grid(20, 12, (x, y) => b * 10 + x - y / 3));
  const file = makeTiff({ le: true, planar: 2, predictor: 3, deflate: true, tile: 16, levels: [{ width: W, height: H, bands }, { width: 20, height: 12, bands: overview }],
    geo: { originX: 430000, originY: 2930000, pixel: 0.5, epsg: 32644 }, nodata: '-99', sparse: new Set(['0/1/4']) });
  const counter = { requests: 0 };
  const cog = await Cog.open(memoryRange(file, counter));
  const [full, half] = cog.images;
  assert(cog.images.length === 2 && full.width === 40 && half.width === 20 && full.pixelSizeX === 0.5 && half.pixelSizeX === 1 && half.pixelSizeY === 1, 'COG: the full image and its overview are found, with their pixel sizes');
  assert(cog.originX === 430000 && cog.originY === 2930000 && cog.epsg === 32644 && cog.nodata === -99, 'COG: corner, projection and no-data value are read from the GeoTIFF tags');
  counter.requests = 0;
  const blocks = await cog.readBlocks(full, 1, [0, 1, 2].flatMap((col) => [0, 1].map((row) => ({ col, row }))));
  let mismatches = 0;
  for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
    const b = blocks.get(row * 3 + col);
    if (row * 3 + col === 4) { if (b !== null) mismatches++; continue; }
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const gx = col * 16 + x, gy = row * 16 + y;
      if (gx < W && gy < H && !sameFloat(b[y * 16 + x], bands[1][gy * W + gx])) mismatches++;
    }
  }
  assert(mismatches === 0, 'COG: every value of a band comes back bit for bit (Deflate, float predictor, NaN, no-data, edge blocks), and a block the file leaves out reads as missing');
  assert(counter.requests === 1, `COG: neighbouring blocks are fetched in one request (${counter.requests})`);
  const ov = (await cog.readBlocks(half, 2, [{ col: 1, row: 0 }])).get(1);
  assert(ov[3 * 16 + 2] === overview[2][3 * 20 + 18], 'COG: an overview block reads back too');
}
{
  // The other layout: big-endian, bands interleaved, no compression or predictor, tie point on a pixel's centre.
  const bands = [0, 1].map((b) => grid(20, 20, (x, y) => b ? x * 100 + y : -x - y));
  const cog = await Cog.open(memoryRange(makeTiff({ le: false, planar: 1, predictor: 1, deflate: false, tile: 16, levels: [{ width: 20, height: 20, bands }], geo: { originX: 1000, originY: 2000, pixel: 2, epsg: 32743, pixelIsPoint: true } })));
  const b = (await cog.readBlocks(cog.images[0], 1, [{ col: 1, row: 1 }])).get(3);
  assert(b[2 * 16 + 3] === bands[1][18 * 20 + 19] && cog.originX === 999 && cog.originY === 2001 && cog.epsg === 32743, 'COG: big-endian, interleaved, uncompressed, and a pixel-centre tie point (corner moved half a pixel)');
  assert(await rejects(Cog.open(memoryRange(new Uint8Array(64).fill(7))), /not a TIFF/), 'COG: a file that is not a TIFF is refused');
  assert(await rejects(Cog.open(memoryRange(makeTiff({ le: true, planar: 2, predictor: 1, deflate: false, tile: 16, striped: true, levels: [{ width: 20, height: 20, bands }], geo: { originX: 0, originY: 0, pixel: 1, epsg: 32644 } }))), /not tiled/), 'COG: a TIFF that is not tiled is refused, not misread');
}

// ---- Heights for footprints from a raster: sampleTile against testing every pixel centre ----
{
  const utm = utmOf('EPSG:32644');
  const area = { west: 80.33, south: 26.45, east: 80.3316, north: 26.4514 };
  const store = new FootprintStore();
  const rect = (x, y, w, h) => `${x} ${y}, ${x + w} ${y}, ${x + w} ${y + h}, ${x} ${y + h}, ${x} ${y}`;
  const L = area.west, S = area.south;
  store.addWkt(`POLYGON((${rect(L + 0.0002, S + 0.0002, 0.0002, 0.00015)}))`); // a building
  store.addWkt(`POLYGON((${rect(L + 0.0005, S + 0.0005, 0.0003, 0.0003)}),(${rect(L + 0.0006, S + 0.0006, 0.0001, 0.0001)}))`); // a courtyard
  store.addWkt(`MULTIPOLYGON(((${rect(L + 0.0009, S + 0.0002, 0.0001, 0.0001)})),((${rect(L + 0.0011, S + 0.0002, 0.00008, 0.00012)})))`); // two parts
  store.addWkt(`POLYGON((${rect(L + 0.00121, S + 0.00051, 0.000003, 0.000003)}))`); // smaller than a pixel: the centre fallback
  store.addWkt(`POLYGON((${rect(L + 0.0001, S + 0.0009, 0.0008, 0.0003)}))`); // across several blocks
  store.addWkt(`POLYGON((${L + 0.0013} ${S + 0.0011}, ${L + 0.00155} ${S + 0.00105}, ${L + 0.0015} ${S + 0.0013}, ${L + 0.0013} ${S + 0.0011}))`); // a triangle
  const fp = store.seal();
  const proj = projectFootprints(fp, utm, area);
  // A 1 m raster around the area: values unique per pixel, a left-out block, some no-data and NaN pixels.
  const W = 190, H = 180, tile = 32;
  const corner = { x: Math.floor(proj.x0) - 15, y: Math.ceil(proj.y0) + 165 };
  const values = grid(W, H, (x, y) => ((x * 7 + y * 3) % 11 === 0 ? -99 : (x + y) % 23 === 0 ? NaN : 0.1 * x + 0.01 * y + 1));
  const cog = await Cog.open(memoryRange(makeTiff({ le: true, planar: 2, predictor: 3, deflate: true, tile, levels: [{ width: W, height: H, bands: [values] }], geo: { originX: corner.x, originY: corner.y, pixel: 1, epsg: 32644 }, nodata: '-99', sparse: new Set(['0/0/7']) })));
  const totals = { sum: new Float64Array(fp.count), count: new Uint32Array(fp.count), centre: new Float32Array(fp.count).fill(NaN) };
  await sampleTile(cog, cog.images[0], 0, fp, proj, totals);
  // The same by brute force: every pixel centre in each footprint's box, even-odd.
  const ox = corner.x - proj.x0, oy = corner.y - proj.y0;
  const value = (col, row) => { if (col < 0 || row < 0 || col >= W || row >= H) return NaN; if (Math.floor(row / tile) * Math.ceil(W / tile) + Math.floor(col / tile) === 7) return NaN; const v = values[row * W + col]; return v === -99 ? NaN : v; };
  let worst = 0, centreUsed = 0;
  for (let b = 0; b < fp.count; b++) {
    const r0 = fp.buildingRingStart[b], r1 = fp.buildingRingStart[b + 1], from = fp.ringStart[r0], to = fp.ringStart[r1];
    const xs = [], ys = [], ringEnds = [];
    for (let k = from; k < to; k++) { xs.push(proj.xy[2 * k] - ox); ys.push(oy - proj.xy[2 * k + 1]); }
    for (let r = r0; r < r1; r++) ringEnds.push(fp.ringStart[r + 1] - from);
    let sum = 0, n = 0;
    for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) {
      let inside = false, start = 0;
      for (const end of ringEnds) { for (let i = start, j = end - 1; i < end; j = i++) if ((ys[i] <= row + 0.5) !== (ys[j] <= row + 0.5) && col + 0.5 >= xs[i] + ((row + 0.5 - ys[i]) * (xs[j] - xs[i])) / (ys[j] - ys[i])) inside = !inside; start = end; }
      const v = inside ? value(col, row) : NaN;
      if (v === v) { sum += v; n++; }
    }
    const want = n ? sum / n : value(Math.floor(proj.cx[b] - ox), Math.floor(oy - proj.cy[b]));
    if (!n) centreUsed++;
    const got = totals.count[b] ? totals.sum[b] / totals.count[b] : totals.centre[b];
    worst = Math.max(worst, sameFloat(got, want) ? 0 : Math.abs(got - want) || Infinity);
  }
  assert(worst < 1e-9 && centreUsed === 1, `heights: each footprint's average is exactly the brute-force one, across blocks, holes, two-part shapes, a left-out block and no-data (worst ${worst}); the sub-pixel one takes the pixel under it`);
}

// ---- The file written ----
{
  const dir = mkdtempSync(join(tmpdir(), 'fob-'));
  try {
    const store = new FootprintStore();
    store.addWkt('POLYGON((80.33 26.45, 80.3302 26.45, 80.3302 26.4502, 80.33 26.4502, 80.33 26.45))');
    store.addWkt('MULTIPOLYGON(((80.34 26.46, 80.3401 26.46, 80.3401 26.4601, 80.34 26.46)),((80.35 26.47, 80.3502 26.47, 80.3502 26.4702, 80.35 26.47),(80.3500 26.4700, 80.3501 26.4700, 80.3501 26.4701, 80.3500 26.4700)))');
    store.addWkt('POLYGON((80.36 26.48, 80.3601 26.48, 80.3601 26.4801, 80.36 26.48))');
    const path = join(dir, 'Test_OpenBuildings_2_5D.geojson');
    const { withHeight } = await writeBuildingsGeojson(path, store.seal(), Float32Array.from([6.4567, 12, NaN]), { name: 'Test_OpenBuildings_2_5D', source: { by: 'test' } });
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const [a, b, c] = doc.features;
    assert(doc.type === 'FeatureCollection' && doc.features.length === 3 && withHeight === 2 && !existsSync(`${path}.part`), 'file: a FeatureCollection, nothing left half-written');
    assert(a.properties.mean === 6.46 && b.properties.mean === 12 && Object.keys(c.properties).length === 0, 'file: `mean` in metres to the centimetre; a building with no height has none');
    assert(a.geometry.type === 'Polygon' && b.geometry.type === 'MultiPolygon' && b.geometry.coordinates.length === 2 && b.geometry.coordinates[1].length === 2 && a.geometry.coordinates[0][0][0] === 80.33, 'file: polygons, multipolygons and holes come out as they went in');
    const check = validateGeojsonFile(path);
    const props = sampleProperties(path);
    let streamed = 0;
    for (const batch of readFeatureBatches(path)) streamed += batch.features.length;
    assert(check.ok && check.featureCount === 3 && props.some((p) => 'mean' in p) && streamed === 3, "file: passes the server's upload check, offers `mean` in the height list, and the tile builder reads every building");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- The server's reading of the script's output (server/jobs/buildingsJob.js) ----
{
  // A real run, Kanpur, 2026-10-02.
  const kanpur = [
    'Area: west 80.178, south 26.315, east 80.493, north 26.553 (about 31.4 x 26.5 km)',
    'Footprints, file 1 of 1 (S2 cell 399d): downloading 529 MB',
    '  25% downloaded, 2,12,941 buildings in the area so far', '  50% downloaded, 4,25,468 buildings in the area so far',
    '  75% downloaded, 6,38,048 buildings in the area so far', '  100% downloaded, 8,51,268 buildings in the area so far',
    '8,51,297 buildings in the area',
    'Heights (2023): 12 tiles of 12.5 km; downloading only what the buildings cover',
    ...Array.from({ length: 12 }, (_, i) => `  tile ${i + 1} of 12: 1,000 buildings; ${(i + 1) * 19} MB downloaded so far`),
    'Heights downloaded: 228 MB',
  ];
  const state = { file: 1, files: 1 };
  const got = kanpur.map((line) => fetchProgressOf(line, state));
  const pcts = got.filter(Boolean).map(([p]) => p);
  assert(got[0] === null && got.slice(1).every(Boolean) && pcts[0] === 2 && pcts.at(-1) === 98 && pcts.every((p, i) => !i || p >= pcts[i - 1]),
    `server: every line of a real run becomes progress, rising from 2% to 98% (${pcts.join(', ')})`);
  assert(got[2][1] === 'Downloading building footprints: 2,12,941 buildings in your area so far' && got[7][1] === 'Adding heights (as of 2023) from 12 height map tiles…' && got[20][1] === 'Writing the buildings file…',
    'server: the progress text is plain words for the Review & build page');
  // A city across two footprint files, the second with none in it.
  const two = { file: 1, files: 1 };
  const twoGot = ['Footprints, file 1 of 2 (S2 cell 3974): downloading 300 MB', '  50% downloaded, 1,000 buildings in the area so far', '  100% downloaded, 2,000 buildings in the area so far', 'Footprints, file 2 of 2 (S2 cell 3975): none; Google has no buildings there']
    .map((line) => fetchProgressOf(line, two));
  const twoPcts = twoGot.map(([p]) => p);
  assert(JSON.stringify(twoPcts) === '[2,22,41,80]' && twoGot[1][1] === 'Downloading building footprints (part 1 of 2): 1,000 buildings in your area so far', `server: with two footprint files each counts for half the download, and the text says which part (${twoPcts.join(', ')})`);
}

// ---- The command line refuses bad input before downloading anything ----
{
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30_000 });
  const refused = (r, pattern) => r.status === 1 && /^ERROR: /m.test(r.stderr) && pattern.test(r.stderr);
  assert(refused(run(), /give the area/), 'CLI: no area: says how to give one');
  assert(refused(run('--bbox', '80.1,26.3,80.4'), /four numbers/), 'CLI: three numbers: refused');
  assert(refused(run('--bbox', '80.5,26.3,80.2,26.6'), /West \(80\.5\) must be less than East/), 'CLI: west and east swapped: refused, naming them');
  assert(refused(run('--bbox', '78,25,81,28'), /larger than any city/), 'CLI: a whole region: refused');
  assert(refused(run('--bbox', '80.1,26.3,80.2,26.4', '--year', '2010'), /--year must be a number from 2016/), 'CLI: a year before the data: refused');
  assert(refused(run('--west', '80.1', '--south', '26.3', '--east', '80.2', '--north', 'x'), /four numbers/), 'CLI: the four separate options are checked too');
  assert(refused(run('--bbox', '80.1,26.3,80.2,26.4', '--source', 'osm'), /--source is google .* or microsoft/), 'CLI: an unknown source: refused');
  assert(refused(run('--bbox', '80.1,26.3,80.2,26.4', '--source', 'microsoft', '--year', '2023'), /--year is for Google/), "CLI: --year with Microsoft's footprints: refused");
  assert(refused(run('--bbox', '80.1,26.3,80.2,26.4', '--flat-height', '0'), /--flat-height must be a number from 1 to 300/), 'CLI: a flat height of 0 m: refused');
  assert(refused(run('--bbox', '80.1,26.3,80.2,26.4', '--source', 'microsoft', '--microsoft-index', 'ftp://x'), /--microsoft-index takes the https/), 'CLI: an index link that is not https: refused');
}

// ---- Google's live files ----
if (ONLINE) {
  const cities = { Lagos: [3.38, 6.52], Nairobi: [36.82, -1.29], Kanpur: [80.33, 26.45], Jakarta: [106.85, -6.21], 'Mexico City': [-99.13, 19.43], 'São Paulo': [-46.63, -23.55], 'Punta Arenas': [-70.91, -53.16] };
  const missing = [];
  for (const [city, [lon, lat]] of Object.entries(cities)) {
    const res = await fetch(`https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_6_gzip_no_header/${s2CellToken(lon, lat, 6)}_buildings.csv.gz`, { method: 'HEAD' });
    if (!res.ok) missing.push(`${city} (${res.status})`);
  }
  assert(!missing.length, `online: the footprint file named for each of ${Object.keys(cities).join(', ')} exists (S2 faces 0, 1, 4 and 5)${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
  const { year, tiles } = await findHeightTiles(KANPUR, null);
  assert(year >= 2023 && tiles.length >= 12 && tiles.every((t) => t.utm.epsg === 32644 && t.band === 1), `online: Kanpur's heights: the latest year (${year}), ${tiles.length} tiles in UTM 44N, height in band 2`);
  assert(await rejects(findHeightTiles(KANPUR, 2015), /no building heights for 2015.*2016/), 'online: a year Google lacks is refused, listing the years it has');
  {
    const readme = await (await fetch('https://raw.githubusercontent.com/microsoft/GlobalMLBuildingFootprints/main/README.md')).text();
    const link = /https:\/\/[^\s)\]]+\/dataset-links\.csv/.exec(readme)?.[0];
    const index = link ? await (await fetch(link)).text() : '';
    const kanpurRows = index.split('\n').filter((line) => /^India,(123132010|123132012),https:/.test(line));
    assert(kanpurRows.length === 2, `online: Microsoft's README links its current index (${link ?? 'none found'}), which lists Kanpur's two tiles`);
  }
  if (existsSync(KANPUR_FILE)) {
    // Kanpur's own file was made in Earth Engine from the same data: its footprints, our heights.
    const area = { west: 80.32, south: 26.44, east: 80.34, north: 26.46 };
    const store = new FootprintStore(), theirs = [];
    const ringWkt = (ring) => `(${ring.map(([x, y]) => `${x} ${y}`).join(',')})`;
    for (const { features } of readFeatureBatches(KANPUR_FILE)) for (const f of features) {
      const g = f.geometry;
      if (g?.type !== 'Polygon') continue;
      const [x, y] = g.coordinates[0][0];
      if (x < area.west || x > area.east || y < area.south || y > area.north) continue;
      if (store.addWkt(`POLYGON(${g.coordinates.map(ringWkt).join(',')})`)) theirs.push(Number(f.properties?.mean));
    }
    const fp = store.seal();
    const { heights } = await addHeights(fp, area, { year: 2023 });
    const diffs = [];
    for (let b = 0; b < fp.count; b++) if (Number.isFinite(heights[b]) && Number.isFinite(theirs[b])) diffs.push(Math.abs(heights[b] - theirs[b]));
    diffs.sort((p, q) => p - q);
    const median = diffs[diffs.length >> 1], within1 = diffs.filter((d) => d <= 1).length / diffs.length;
    assert(fp.count > 15000 && diffs.length === fp.count && median < 0.25 && within1 >= 0.95, `online: heights for ${fp.count} buildings in central Kanpur match Kanpur's Earth Engine-made file: median difference ${median.toFixed(3)} m, ${(within1 * 100).toFixed(1)}% within 1 m`);
  } else {
    console.log(`SKIP: ${KANPUR_FILE} is not here, so heights aren't compared with it`);
  }
} else {
  console.log('(offline checks only; add --online to check against Google\'s live files)');
}

console.log(failures ? '\n=== FETCH OPEN BUILDINGS: FAILURES ABOVE ===' : '\n=== FETCH OPEN BUILDINGS: ALL CHECKS PASSED ===');
process.exitCode = failures ? 1 : 0;
