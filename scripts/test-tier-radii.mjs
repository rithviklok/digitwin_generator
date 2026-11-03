// Checks scripts/tier-radii.mjs -- NOT part of the app. Its search only
// looks at the tiles near each camera position and stops at the first
// position over budget; this compares the radii it picks with those of the
// plain search it replaced (every tile, from every position), which is kept
// here as the reference.
//   node scripts/test-tier-radii.mjs
// Also checks any real manifest given on the command line, e.g.
//   node scripts/test-tier-radii.mjs public/data/kanpur/tiles/manifest.json
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { computeRadii } from './tier-radii.mjs';

function assert(ok, what) {
  if (ok) console.log(`OK: ${what}`);
  else { console.error(`FAIL: ${what}`); process.exitCode = 1; }
}

// ---- The reference: the search as it was before, unchanged ----
const GRID_STEP_M = 100, LADDER_STEP_M = 25;
function edgeDistance(px, pz, tile, halfTile) {
  const ex = Math.max(Math.abs(px - tile.centerX) - halfTile, 0);
  const ez = Math.max(Math.abs(pz - tile.centerZ) - halfTile, 0);
  return Math.hypot(ex, ez);
}
function tileExtent(tiles, halfTile) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const t of tiles) {
    minX = Math.min(minX, t.centerX - halfTile); maxX = Math.max(maxX, t.centerX + halfTile);
    minZ = Math.min(minZ, t.centerZ - halfTile); maxZ = Math.max(maxZ, t.centerZ + halfTile);
  }
  return { minX, maxX, minZ, maxZ };
}
function worstCaseSum(tiles, radius, tierKey, halfTile, extent) {
  let worst = 0;
  for (let x = extent.minX; x <= extent.maxX; x += GRID_STEP_M) {
    for (let z = extent.minZ; z <= extent.maxZ; z += GRID_STEP_M) {
      let sum = 0;
      for (const t of tiles) if (edgeDistance(x, z, t, halfTile) <= radius) sum += t.triCounts[tierKey];
      if (sum > worst) worst = sum;
    }
  }
  return worst;
}
function referenceRadius(tiles, tierKey, budget, minRadius, halfTile) {
  if (!tiles.length) return minRadius;
  const extent = tileExtent(tiles, halfTile);
  const maxRadius = Math.hypot(extent.maxX - extent.minX, extent.maxZ - extent.minZ);
  let lo = Math.ceil(minRadius / LADDER_STEP_M), hi = Math.ceil(maxRadius / LADDER_STEP_M);
  let best = lo * LADDER_STEP_M;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = mid * LADDER_STEP_M;
    if (worstCaseSum(tiles, r, tierKey, halfTile, extent) <= budget) { best = r; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}
function referenceRadii(tiles, params) {
  const halfTile = params.tileSizeM / 2;
  const fullRadiusM = referenceRadius(tiles, 'full', params.targetFullTierTris, halfTile, halfTile);
  const mediumRadiusM = referenceRadius(tiles, 'medium', params.targetMediumTierTris, fullRadiusM, halfTile);
  const coarseRadiusM = referenceRadius(tiles, 'coarse', params.targetMediumTierTris, mediumRadiusM, halfTile);
  return { fullRadiusM, mediumRadiusM, coarseRadiusM };
}

// ---- Random cities: sparse and dense, around the origin and far from it, several tile sizes and budgets ----
let seed = 987654321;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
let agreed = 0, cases = 0;
const seenRadii = new Set();
for (let run = 0; run < 70; run++) {
  const tileSizeM = [500, 1000, 2000, 2000, 3000][int(0, 4)];
  const span = int(1, Math.round(16000 / tileSizeM)); // tiles across, so the extent stays at most 16 km
  const offCol = int(-40, 40), offRow = int(-40, 40);
  const fill = [0.15, 0.5, 0.9, 1][int(0, 3)];
  const tiles = [];
  for (let c = 0; c < span; c++) {
    for (let r = 0; r < span; r++) {
      if (rnd() > fill && tiles.length) continue;
      const buildings = int(1, [50, 4000, 20000][int(0, 2)]);
      const full = buildings * int(10, 40);
      tiles.push({ centerX: (offCol + c + 0.5) * tileSizeM, centerZ: (offRow + r + 0.5) * tileSizeM, triCounts: { full, medium: buildings * 10, coarse: buildings * 2 } });
    }
  }
  const total = tiles.reduce((s, t) => s + t.triCounts.full, 0);
  const targetFullTierTris = Math.max(1, Math.round(total * [0.02, 0.2, 0.6, 1.5][int(0, 3)]));
  const params = { tileSizeM, targetFullTierTris, targetMediumTierTris: Math.round(targetFullTierTris * [1, 1.9, 4][int(0, 2)]) };
  const want = referenceRadii(tiles, params), got = computeRadii(tiles, params);
  cases++;
  if (isDeepStrictEqual(got, want)) agreed++;
  else console.error(`  run ${run} (${tiles.length} tiles of ${tileSizeM} m): got ${JSON.stringify(got)}, reference ${JSON.stringify(want)}`);
  seenRadii.add(JSON.stringify(want));
}
assert(agreed === cases, `${agreed}/${cases} random cities: same radii as the plain search`);
assert(seenRadii.size > 25, `the random cities really differ (${seenRadii.size} distinct answers)`);
assert(isDeepStrictEqual(computeRadii([], { tileSizeM: 2000, targetFullTierTris: 1, targetMediumTierTris: 1 }), { fullRadiusM: 1000, mediumRadiusM: 1000, coarseRadiusM: 1000 }), 'no tiles at all: every radius is the floor (half a tile), and the search ends');

// ---- Real manifests, if any were given ----
for (const path of process.argv.slice(2)) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const tiles = manifest.tiles.map((t) => ({ centerX: t.centerX, centerZ: t.centerZ, triCounts: { full: t.tiers.full.triCount, medium: t.tiers.medium.triCount, coarse: t.tiers.coarse.triCount } }));
  const params = { tileSizeM: manifest.tileSizeM, targetFullTierTris: 800000, targetMediumTierTris: 1500000 };
  const t0 = performance.now();
  const got = computeRadii(tiles, params);
  const fastMs = performance.now() - t0;
  if (tiles.length <= 200) {
    const t1 = performance.now();
    const want = referenceRadii(tiles, params);
    assert(isDeepStrictEqual(got, want), `${path} (${tiles.length} tiles): ${JSON.stringify(got)}, same as the plain search (${(fastMs / 1000).toFixed(1)} s against ${((performance.now() - t1) / 1000).toFixed(1)} s)`);
  } else {
    // Too many tiles to wait for the plain search: compare with the radii the manifest was built with, if it used these budgets.
    assert(isDeepStrictEqual(got, manifest.radii), `${path} (${tiles.length} tiles): ${JSON.stringify(got)} in ${(fastMs / 1000).toFixed(1)} s, the same as its own manifest says (${JSON.stringify(manifest.radii)})`);
  }
}

console.log(process.exitCode === 1 ? '\n=== TIER RADII: FAILURES ABOVE ===' : '\n=== TIER RADII: ALL CHECKS PASSED ===');
