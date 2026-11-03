// Checks the road tiles a large city's roads are written as
// (src/workers/road-tile-builder.js, road-tile-format.js,
// server/lib/roadTiles.js) -- NOT part of the app. The reference is what
// RoadLayer builds in the browser from a roads GeoJSON: the tiles must
// hold exactly those triangles.
//   node scripts/test-road-tiles.mjs
// Also checks any real roads file given on the command line, e.g.
//   node scripts/test-road-tiles.mjs public/data/kanpur/kmc_roads.geojson
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { makeProjector, projectRingFlat, collectRings } from '../src/workers/geo-utils.js';
import { createRoadTileBucketer, roadTilePayload, roadTier, ROAD_BANDS } from '../src/workers/road-tile-builder.js';
import { encodeRoadTile, decodeRoadTile } from '../src/workers/road-tile-format.js';
import { createRoadTileWriter } from '../server/lib/roadTiles.js';

function assert(ok, what) {
  if (ok) console.log(`OK: ${what}`);
  else { console.error(`FAIL: ${what}`); process.exitCode = 1; }
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- The reference: RoadLayer._buildKmcRoads' first pass, as it is in the viewer ----
function referencePieces(features, origin) {
  const project = makeProjector(origin);
  const pieces = [];
  let skipped = 0;
  for (const f of features) {
    const p = f.properties || {};
    for (const ring of collectRings(f)) {
      const flat = projectRingFlat(ring, project);
      const n = flat.length / 2;
      if (n < 3) { skipped++; continue; }
      let tris = [];
      const shapePts = new Array(n);
      for (let i = 0; i < n; i++) shapePts[i] = new THREE.Vector2(flat[i * 2], flat[i * 2 + 1]);
      try { tris = THREE.ShapeUtils.triangulateShape(shapePts, []); } catch { tris = []; }
      if (tris.length === 0) { skipped++; continue; }
      pieces.push({ flat, n, tris, tier: roadTier(p.class), name: p.name || '', props: p });
    }
  }
  return { pieces, skipped };
}

/** Builds tiles from `features` and compares them, road by road, with the reference. Returns counts for the caller's message. */
function checkAgainstReference(features, origin, tileSizeM) {
  const bucketer = createRoadTileBucketer({ origin, tileSizeM });
  for (const f of features) bucketer.add(f);
  const { bands, names, stats } = bucketer.result();
  const { pieces, skipped } = referencePieces(features, origin);

  // The reference pieces, in the order each tile and tier receives them.
  const expected = new Map();
  for (const piece of pieces) {
    const bandName = piece.tier < 2 ? 'major' : 'local';
    const size = tileSizeM * ROAD_BANDS[bandName].gridFactor;
    const key = `${bandName}/${Math.floor(piece.flat[0] / size)},${Math.floor(piece.flat[1] / size)}/${piece.tier}`;
    if (!expected.has(key)) expected.set(key, []);
    expected.get(key).push(piece);
  }

  let roads = 0, triangles = 0, wrong = 0, facingDown = 0, tiers = 0, boundsWrong = 0;
  for (const [bandName, band] of Object.entries(bands)) {
    for (const [tileKey, tile] of band.tiles) {
      for (const t of decodeRoadTile(encodeRoadTile(roadTilePayload(tile)))) { // through the file format and back
        tiers++;
        const want = expected.get(`${bandName}/${tileKey}/${t.tier}`) ?? [];
        expected.delete(`${bandName}/${tileKey}/${t.tier}`);
        if (want.length !== t.roads) { wrong++; continue; }
        let tri = 0, minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (let r = 0; r < t.roads; r++) {
          const start = r === 0 ? 0 : t.end[r - 1], end = t.end[r];
          const piece = want[r];
          if (!same(t.xz.subarray(start * 2, end * 2), piece.flat) || t.names[r] !== piece.name) { wrong++; continue; }
          for (const [a, b, c] of piece.tris) {
            const got = [t.index[tri * 3] - start, t.index[tri * 3 + 1] - start, t.index[tri * 3 + 2] - start];
            tri++;
            if (got[0] !== a || !((got[1] === b && got[2] === c) || (got[1] === c && got[2] === b))) wrong++;
            const [i, j, k] = got.map((v) => v + start);
            const up = (t.xz[j * 2 + 1] - t.xz[i * 2 + 1]) * (t.xz[k * 2] - t.xz[i * 2]) - (t.xz[j * 2] - t.xz[i * 2]) * (t.xz[k * 2 + 1] - t.xz[i * 2 + 1]);
            if (up < 0) facingDown++;
          }
          for (let v = start; v < end; v++) { minX = Math.min(minX, t.xz[v * 2]); maxX = Math.max(maxX, t.xz[v * 2]); minZ = Math.min(minZ, t.xz[v * 2 + 1]); maxZ = Math.max(maxZ, t.xz[v * 2 + 1]); }
          roads++;
        }
        if (tri * 3 !== t.index.length) wrong++;
        if (!same(t.bounds, [minX, minZ, maxX, maxZ])) boundsWrong++;
        triangles += tri;
      }
    }
  }
  return { roads, triangles, wrong, facingDown, boundsWrong, tiers, missing: expected.size, pieces: pieces.length, skipped, stats, names, bands };
}

// ---- A small made-up city: every case the builder has a branch for ----
const origin = { lon: 80.33, lat: 26.45 };
const project = makeProjector(origin);
const unproject = (x, z) => [origin.lon - x / (111320 * Math.cos((origin.lat * Math.PI) / 180)), origin.lat + z / 110574];
const box = (x, z, w, d) => [[unproject(x, z), unproject(x + w, z), unproject(x + w, z + d), unproject(x, z + d), unproject(x, z)]];
const road = (props, coordinates, type = 'Polygon') => ({ type: 'Feature', properties: props, geometry: { type, coordinates } });
const lShape = [[unproject(0, 0), unproject(60, 0), unproject(60, 10), unproject(10, 10), unproject(10, 50), unproject(0, 50), unproject(0, 0)]];
const city = [
  road({ class: 2, name: 'Gali One' }, box(100, 100, 40, 6)),
  road({ class: 2, name: 'gali one ' }, box(300, 100, 40, 6)), // the same name again, in other letters
  road({ class: 0, name: 'Grand Trunk Road', length_m: 1200.5, area_m2: 9000, ward_id: 12, zone_id: 3 }, box(-9000, -9000, 1200, 14)),
  road({ class: 1, name: 'Mall Road' }, box(2500, -300, 300, 7)),
  road({ name: 'No class at all' }, box(-100, -2100, 30, 4)),
  road({ class: 2 }, lShape), // not convex: needs real triangulation
  road({ class: 2, name: 'Two pieces' }, [box(4100, 4100, 20, 4), box(6100, 4100, 20, 4)], 'MultiPolygon'),
  road({ class: 2, name: 'Too few points' }, [[unproject(0, 0), unproject(5, 0), unproject(0, 0)]]),
  road({ class: 2, name: 'A line, not a surface' }, [unproject(0, 0), unproject(5, 0)], 'LineString'),
  road({ class: 2, name: 'Runs out of its tile' }, box(1990, 10, 300, 5)),
];
{
  const r = checkAgainstReference(city, origin, 2000);
  assert(r.wrong === 0 && r.missing === 0 && r.roads === r.pieces && r.roads === 9, `made-up city: all ${r.roads} road pieces are in the tiles with the reference's outline, name and triangles (2 unusable ones left out: ${r.skipped + 1})`);
  assert(r.facingDown === 0 && r.triangles > 0, `every one of the ${r.triangles} triangles faces up`);
  assert(r.boundsWrong === 0, 'each tier\'s recorded bounds are exactly its roads\' extent');
  assert(r.stats.roads === city.length && r.stats.pieces === 9 && r.stats.skippedDegenerate === 1 && r.stats.triangles === r.triangles, `the counts reported match (${JSON.stringify(r.stats)})`);

  const major = [...r.bands.major.tiles.values()], local = [...r.bands.local.tiles.values()];
  assert(r.bands.major.tileSizeM === 8000 && r.bands.local.tileSizeM === 2000, 'major roads are on a grid four times the building tiles, local roads on the building tiles\' own');
  assert(major.every((t) => !t.tiers[2]) && local.every((t) => !t.tiers[0] && !t.tiers[1]) && major.length === 2 && local.length === 4, `classes 0 and 1 go to major tiles (${major.length}), everything else to local tiles (${local.length})`);
  const twoPieces = local.filter((t) => t.tiers[2].names.includes('Two pieces'));
  assert(twoPieces.length === 2, 'the two pieces of a MultiPolygon road go to the tiles their own first points are in');
  const gt = decodeRoadTile(encodeRoadTile(roadTilePayload(major.find((t) => t.tiers[0])))).find((t) => t.tier === 0);
  assert(gt.lengthM[0] === 1200.5 && gt.areaM2[0] === 9000 && gt.wardId[0] === 12 && gt.zoneId[0] === 3, 'a surveyed road\'s length, area, ward and zone come through the file');
  const plain = decodeRoadTile(encodeRoadTile(roadTilePayload(local[0])))[0];
  assert(plain.lengthM === null && plain.wardId === null, 'and are left out of a tile where no road has them');
  const out = decodeRoadTile(encodeRoadTile(roadTilePayload(local.find((t) => t.tiers[2].names.includes('Runs out of its tile')))))[0];
  assert(out.bounds[2] > 2000 && Math.floor(out.xz[0] / 2000) === 0, 'a road that runs past its tile\'s edge stays whole, and the bounds say how far it reaches');

  const names = r.names.map((n) => n.name);
  assert(same(names, ['Gali One', 'Grand Trunk Road', 'Mall Road', 'No class at all', 'Two pieces', 'Too few points', 'Runs out of its tile'].filter((n) => n !== 'Too few points')), `the name list has each name once, in first-seen order, without the unusable road: ${names.join(', ')}`);
  const gali = r.names[0], p0 = project(...unproject(100, 100)), p1 = project(...unproject(140, 106));
  assert(Math.abs(gali.x - (p0.x + p1.x) / 2) < 0.01 && Math.abs(gali.z - (p0.z + p1.z) / 2) < 0.01 && gali.rings.length === 1 && gali.rings[0].length === 8, 'a name points at the middle of its first road and carries that road\'s outline');
  assert(r.names.find((n) => n.name === 'Two pieces').rings.length === 2, 'a road in two pieces carries both outlines');
}

// ---- The file format ----
{
  const tier = { tier: 2, xz: new Float32Array([0, 0, 10, 0, 10, 5, 0.5, 5.25]), end: new Uint32Array([4]), index: new Uint32Array([0, 1, 2, 0, 2, 3]), bounds: [0, 0, 10, 5.25], names: ['सड़क'], lengthM: [null], areaM2: [null], wardId: [null], zoneId: [null] };
  let inPlace = true;
  for (const name of ['', 'a', 'ab', 'abc', 'abcd']) { // every header length modulo 4
    const bytes = encodeRoadTile([{ ...tier, names: [tier.names[0] + name] }]);
    const headerLen = new DataView(bytes.buffer).getUint32(0, true);
    const back = decodeRoadTile(bytes.buffer)[0];
    if (headerLen % 4 !== 0 || back.xz.buffer !== bytes.buffer || !same(back.xz, tier.xz) || !same(back.index, tier.index) || back.names[0] !== tier.names[0] + name) inPlace = false;
  }
  assert(inPlace, 'the header is padded so the arrays are read in place, not copied (a name in Devanagari included)');
  const shifted = new Uint8Array(encodeRoadTile([tier]).length + 1);
  shifted.set(encodeRoadTile([tier]), 1);
  const back = decodeRoadTile(shifted.subarray(1))[0];
  assert(same(back.xz, tier.xz) && same(back.end, tier.end) && same(back.index, tier.index), 'bytes that do not start on a 4-byte boundary (a file read in Node) are still read correctly');
  assert(decodeRoadTile(encodeRoadTile([])).length === 0, 'a tile with no tiers is a valid, empty file');
  let refused = false;
  try { const b = encodeRoadTile([tier]); decodeRoadTile(new TextEncoder().encode(new TextDecoder().decode(b).replace('"v":1', '"v":9'))); } catch { refused = true; }
  assert(refused, 'a file of another format version is refused, not misread');
}

// ---- Written to disk as the server writes them ----
{
  const dir = mkdtempSync(join(tmpdir(), 'road-tiles-test-'));
  const writer = createRoadTileWriter({ dir, origin, tileSizeM: 2000 });
  for (const f of city) writer.write(f);
  const result = writer.close();
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const listed = Object.values(manifest.bands).flatMap((b) => b.tiles);
  assert(result.roads === city.length && result.tiles === 6 && listed.length === 6 && listed.every((t) => statSync(join(dir, t.url)).size === t.byteSize), 'the manifest lists every tile file, with its true size');
  assert(manifest.format === 'road-tiles' && manifest.tileSizeM === 2000 && manifest.bands.major.tileSizeM === 8000 && same(manifest.bands.local.classes, [2]) && manifest.origin.lon === origin.lon, 'and says which grid and classes each band has');
  assert(listed.reduce((n, t) => n + t.roads, 0) === 9 && listed.reduce((n, t) => n + t.triangles, 0) === result.triangles, 'road and triangle counts in the manifest add up');
  const t = listed.find((e) => e.url === 'local/0_0.bin');
  const tiers = decodeRoadTile(readFileSync(join(dir, t.url)));
  assert(t.bounds[0] <= tiers[0].bounds[0] + 0.01 && t.bounds[2] >= tiers[0].bounds[2] - 0.01 && t.bounds[2] > 2000, 'a tile\'s bounds in the manifest are its roads\' own extent, past the grid cell where a road runs out of it');
  const names = JSON.parse(readFileSync(join(dir, manifest.names), 'utf8'));
  assert(names.length === 6 && names[0].name === 'Gali One' && names[0].rings[0].length === 8 && names.every((n) => Number.isFinite(n.x) && Number.isFinite(n.z)), 'names.json has one entry per road name, with a place and an outline');
  assert(same(readdirSync(dir).sort(), ['local', 'major', 'manifest.json', 'names.json']), 'nothing else is written');
  rmSync(dir, { recursive: true, force: true });
}

// ---- Real roads files, if any were given ----
for (const path of process.argv.slice(2)) {
  const features = JSON.parse(readFileSync(path, 'utf8')).features;
  const t0 = performance.now();
  const r = checkAgainstReference(features, origin, 2000);
  assert(r.wrong === 0 && r.missing === 0 && r.roads === r.pieces && r.facingDown === 0 && r.boundsWrong === 0,
    `${path}: ${r.roads.toLocaleString('en-IN')} road pieces, ${r.triangles.toLocaleString('en-IN')} triangles in ${r.tiers} tile tiers -- the same outlines and triangles as the viewer builds, all facing up (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

console.log(process.exitCode === 1 ? '\n=== ROAD TILES: FAILURES ABOVE ===' : '\n=== ROAD TILES: ALL CHECKS PASSED ===');
