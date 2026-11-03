// Checks src/engine/MeshPicker.js -- NOT part of the app. Click picking must
// return exactly the hit three.js's Raycaster would (the reference here),
// only faster. Rebuilds what a click sees, from Kanpur's real data, at
// several camera poses from street level to a few hundred metres up:
//   - building tiles at the tiers the streamer would hold (full near the
//     camera, medium further, coarse beyond), built as BuildingLayer builds them;
//   - roads as one file (RoadLayer's whole path, a `roadId` per vertex) and as
//     road tiles (the large-city path: indexed geometry, no id attribute).
// Then fires random click rays and compares hit by hit, and reports timings.
//   node scripts/test-picking.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as THREE from 'three';
import { decodeTilePayload } from '../src/workers/tile-binary-format.js';
import { setKnownBounds } from '../src/layers/known-bounds.js';
import { pickNearest } from '../src/engine/MeshPicker.js';
import { RoadLayer } from '../src/layers/RoadLayer.js';
import { createRoadTileBucketer, roadTilePayload } from '../src/workers/road-tile-builder.js';
import { encodeRoadTile } from '../src/workers/road-tile-format.js';
import { kanpurConfig } from '../src/config/cities/kanpur.config.js';

const DATA = fileURLToPath(new URL('../public/data/kanpur', import.meta.url));
const RAYS_PER_POSE = 60;
let failures = 0;
function assert(ok, what) {
  if (ok) console.log(`OK: ${what}`);
  else { console.error(`FAIL: ${what}`); failures++; }
}

// ---- Building tiles, as BuildingLayer._makeMesh builds them ----
const manifest = JSON.parse(readFileSync(join(DATA, 'tiles', 'manifest.json'), 'utf8'));
const half = manifest.tileSizeM / 2;
const doubleSided = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }); // every building and road material is double-sided
const tierCache = new Map();
function tierMeshes(t, tier) {
  const key = `${t.ix},${t.iz}:${tier}`;
  if (!tierCache.has(key)) {
    const payload = decodeTilePayload(readFileSync(join(DATA, 'tiles', t.tiers[tier].url)));
    const meshes = [];
    for (const role of ['wall', 'windowWall', 'roof']) {
      if (!payload[role]) continue;
      const g = new THREE.BufferGeometry();
      setKnownBounds(g, t.tiers[tier].bounds[role]);
      g.setAttribute('position', new THREE.Float32BufferAttribute(payload[role].position, 3));
      g.setAttribute('buildingId', new THREE.Float32BufferAttribute(payload[role].buildingId, 1));
      meshes.push(new THREE.Mesh(g, doubleSided));
    }
    tierCache.set(key, meshes);
  }
  return tierCache.get(key);
}
/** The streamer's choice for a camera: nearest-edge 3D distance against the manifest radii, at most 16 tiles above coarse. */
function buildingMeshesFor(camera) {
  const p = camera.position;
  const tiles = manifest.tiles.map((t) => {
    const d = Math.hypot(Math.max(Math.abs(p.x - t.centerX) - half, 0), p.y, Math.max(Math.abs(p.z - t.centerZ) - half, 0));
    return { t, d, tier: d <= manifest.radii.fullRadiusM ? 'full' : d <= manifest.radii.mediumRadiusM ? 'medium' : 'coarse' };
  });
  tiles.filter((x) => x.tier !== 'coarse').sort((a, b) => a.d - b.d).slice(16).forEach((x) => { x.tier = 'coarse'; });
  return tiles.filter((x) => Math.hypot(p.x - x.t.centerX, p.z - x.t.centerZ) < 6000).flatMap((x) => tierMeshes(x.t, x.tier));
}

// ---- Roads, both ways RoadLayer can hold them ----
const roadsFc = JSON.parse(readFileSync(join(DATA, 'kmc_roads.geojson'), 'utf8'));
const wholeRoads = new RoadLayer(new THREE.Scene(), kanpurConfig);
await wholeRoads.load(roadsFc, null);
const tiledRoads = new RoadLayer(new THREE.Scene(), kanpurConfig);
tiledRoads._tileMaterials = { class0: doubleSided, class1: doubleSided, class2: doubleSided };
{
  const bucketer = createRoadTileBucketer({ origin: kanpurConfig.origin, tileSizeM: manifest.tileSizeM });
  for (const f of roadsFc.features) bucketer.add(f);
  for (const band of Object.values(bucketer.result().bands)) {
    for (const tile of band.tiles.values()) tiledRoads._bind({ meshes: [] }, encodeRoadTile(roadTilePayload(tile)).buffer);
  }
}

// ---- The comparison ----
const poses = {
  'street level, 36 m': [[0, 36, -160], [0, 0, 0]],
  'close, 200 m, oblique': [[0, 200, -600], [0, 0, 0]],
  'top-down, 300 m': [[200, 300, 200.01], [200, 0, 200]],
  'another area, 120 m': [[1500, 120, 800], [1800, 0, 1300]],
  'west, 250 m': [[-3000, 250, -2000], [-2600, 0, -1500]],
};
let seed = 20261002;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const raycaster = new THREE.Raycaster();
const camera = new THREE.PerspectiveCamera(45, 16 / 9, 2, 60000);
const idOf = (hit, attr) => (attr ? hit.object.geometry.attributes[attr].getX(hit.faceIndex * 3) : hit.face.a);

/** Same hit, or an exact tie on the same building or road (a ray through an edge two of its triangles share). */
function sameHit(a, b, attr) {
  if (!a || !b) return !a && !b;
  if (a.object === b.object && a.faceIndex === b.faceIndex) return true;
  return a.object === b.object && Math.abs(a.distance - b.distance) < 1e-6 && (!attr || idOf(a, attr) === idOf(b, attr));
}

const totals = { three: 0, picker: 0, firstPicks: 0, rays: 0 };
for (const [name, [pos, target]] of Object.entries(poses)) {
  camera.position.set(...pos);
  camera.lookAt(...target);
  camera.updateMatrixWorld();
  const sets = [
    ['buildings', buildingMeshesFor(camera), 'buildingId'],
    ['roads (one file)', wholeRoads.pickMeshes, 'roadId'],
    ['roads (tiles)', tiledRoads.pickMeshes, null],
  ];
  for (const [what, meshes, attr] of sets) {
    let agree = 0, hits = 0, threeMs = 0, pickerMs = 0, firstMs = 0;
    for (let i = 0; i < RAYS_PER_POSE; i++) {
      raycaster.setFromCamera(new THREE.Vector2(rnd() * 1.9 - 0.95, rnd() * 1.9 - 0.95), camera);
      let t0 = performance.now();
      const ref = raycaster.intersectObjects(meshes)[0] ?? null;
      threeMs += performance.now() - t0;
      t0 = performance.now();
      const got = pickNearest(raycaster, meshes, { idAttribute: attr });
      const ms = performance.now() - t0;
      if (i === 0) firstMs = ms; else pickerMs += ms; // the first pick also builds the index of every mesh it reaches
      if (ref) hits++;
      if (sameHit(ref, got, attr)) agree++;
      else console.error(`  ${name}, ${what}, ray ${i}: three.js ${ref ? `${ref.distance.toFixed(3)} m, face ${ref.faceIndex}` : 'nothing'}; picker ${got ? `${got.distance.toFixed(3)} m, face ${got.faceIndex}` : 'nothing'}`);
    }
    assert(agree === RAYS_PER_POSE, `${name}, ${what}: the same hit as three.js on ${agree}/${RAYS_PER_POSE} rays (${hits} hit something)`);
    console.log(`     three.js ${(threeMs / RAYS_PER_POSE).toFixed(2)} ms per click; picker ${(pickerMs / (RAYS_PER_POSE - 1)).toFixed(3)} ms per click, first click ${firstMs.toFixed(1)} ms (indexing)`);
    totals.three += threeMs; totals.picker += pickerMs; totals.firstPicks += firstMs; totals.rays += RAYS_PER_POSE;
  }
}

// ---- Edge cases ----
{
  camera.position.set(0, 36, -160); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  assert(pickNearest(raycaster, []) === null, 'no meshes: no hit');
  const skyward = new THREE.Raycaster(new THREE.Vector3(0, 50, 0), new THREE.Vector3(0, 1, 0));
  assert(pickNearest(skyward, buildingMeshesFor(camera), { idAttribute: 'buildingId' }) === null, 'a ray pointing at the sky hits nothing');
  // A moved mesh is left to three.js's own raycast: still the right answer.
  const moved = tierMeshes(manifest.tiles[0], 'coarse').map((m) => { const c = new THREE.Mesh(m.geometry, doubleSided); c.position.set(5, 0, 5); c.updateMatrixWorld(); return c; });
  let movedAgree = 0;
  for (let i = 0; i < 20; i++) {
    raycaster.set(new THREE.Vector3(manifest.tiles[0].centerX + (rnd() - 0.5) * 1500, 300, manifest.tiles[0].centerZ + (rnd() - 0.5) * 1500), new THREE.Vector3(0, -1, 0));
    if (sameHit(raycaster.intersectObjects(moved)[0] ?? null, pickNearest(raycaster, moved, { idAttribute: 'buildingId' }), 'buildingId')) movedAgree++;
  }
  assert(movedAgree === 20, `a transformed mesh falls back to three.js's raycast (${movedAgree}/20 agree)`);
}

console.log(`\nper click, over ${totals.rays} rays: three.js ${(totals.three / totals.rays).toFixed(2)} ms, picker ${(totals.picker / (totals.rays - Object.keys(poses).length * 3)).toFixed(3)} ms (first click at a new spot: indexing included, ${(totals.firstPicks / (Object.keys(poses).length * 3)).toFixed(1)} ms on average)`);
console.log(failures ? '\n=== PICKING: FAILURES ABOVE ===' : '\n=== PICKING: ALL CHECKS PASSED ===');
process.exitCode = failures ? 1 : 0;
