// ===================================================================
// tier-radii.mjs -- how far from the camera each detail tier of a city's
// building tiles may be shown, worked out from that city's own tiles by
// build-building-tiles.mjs (and re-run alone by its --radii-only).
//
// The distance is the SAME one BuildingLayer.updateTiers() uses at
// runtime: from the camera to the nearest point of a tile's box (ground
// plane; ignoring camera height only ever over-counts, i.e. is
// conservative), not to the tile's centre. For a candidate radius R the
// worst case is the camera position that maximizes the sum of every
// tile's triangle count within R of it (real, uneven occupancy, not an
// assumed uniform density). The sum only changes when the disk's edge
// crosses a tile's edge, so scanning camera positions on a fine grid over
// the tiles' own extent finds it.
//
// Two things keep that scan fast on a metro (about 1,150 tiles over
// 75 x 67 km: checking every tile from every position took many minutes,
// with nothing to show for it on the build page meanwhile). Neither
// changes which radius is chosen -- scripts/test-tier-radii.mjs checks
// the result against the plain every-tile scan:
//   - a position only looks at the tiles whose columns and rows are
//     within R of it, found by index on the tiles' own grid;
//   - the question is only ever "does any position exceed the budget?",
//     so the scan stops at the first one that does.
// ===================================================================

/**
 * @typedef {{full: number, medium: number, coarse: number}} TierTriCounts
 * @typedef {{centerX: number, centerZ: number, triCounts: TierTriCounts}} RadiusTile
 */

/** Spacing of the camera positions tried: each halving quadruples the scan, and 100 m is fine next to 2 km tiles. (scripts/test-tier-radii.mjs holds the result to the plain search, which uses the same spacing.) */
const WORST_CASE_GRID_STEP_M = 100;
/** Radii are searched in steps of this: finer would change nothing visible and only lengthen the binary search. */
const RADIUS_LADDER_STEP_M = 25;

function tileExtent(tiles, halfTile) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const t of tiles) {
    minX = Math.min(minX, t.centerX - halfTile); maxX = Math.max(maxX, t.centerX + halfTile);
    minZ = Math.min(minZ, t.centerZ - halfTile); maxZ = Math.max(maxZ, t.centerZ + halfTile);
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * One tier's triangle counts laid out on the tiles' own column/row grid
 * (a tile's column is its centre's position in whole tiles), so the tiles
 * near a point can be found by index. Cells with no tile hold 0.
 */
function tileGrid(tiles, tierKey, tileSizeM) {
  const col = (t) => Math.round(t.centerX / tileSizeM - 0.5);
  const row = (t) => Math.round(t.centerZ / tileSizeM - 0.5);
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const t of tiles) {
    minCol = Math.min(minCol, col(t)); maxCol = Math.max(maxCol, col(t));
    minRow = Math.min(minRow, row(t)); maxRow = Math.max(maxRow, row(t));
  }
  const cols = maxCol - minCol + 1, rows = maxRow - minRow + 1;
  const count = new Float64Array(cols * rows);
  const centerX = new Float64Array(cols), centerZ = new Float64Array(rows);
  for (const t of tiles) {
    const c = col(t) - minCol, r = row(t) - minRow;
    count[c * rows + r] += t.triCounts[tierKey];
    centerX[c] = t.centerX; // the tiles' own numbers, not recomputed: the distances below must be exactly the runtime's
    centerZ[r] = t.centerZ;
  }
  return { minCol, minRow, cols, rows, count, centerX, centerZ };
}

/** Whether NO camera position over the tiles' extent has more than `budget` triangles within `radius` of it. */
function withinBudget(grid, radius, budget, halfTile, extent) {
  const tileSizeM = halfTile * 2;
  const { minCol, minRow, cols, rows, count, centerX, centerZ } = grid;
  for (let x = extent.minX; x <= extent.maxX; x += WORST_CASE_GRID_STEP_M) {
    // Columns that can be within `radius` of x, one extra on each side so rounding can never drop one.
    const c0 = Math.max(Math.floor((x - radius) / tileSizeM) - 1 - minCol, 0);
    const c1 = Math.min(Math.floor((x + radius) / tileSizeM) + 1 - minCol, cols - 1);
    for (let z = extent.minZ; z <= extent.maxZ; z += WORST_CASE_GRID_STEP_M) {
      const r0 = Math.max(Math.floor((z - radius) / tileSizeM) - 1 - minRow, 0);
      const r1 = Math.min(Math.floor((z + radius) / tileSizeM) + 1 - minRow, rows - 1);
      let sum = 0;
      for (let c = c0; c <= c1; c++) {
        const ex = Math.max(Math.abs(x - centerX[c]) - halfTile, 0);
        const base = c * rows;
        for (let r = r0; r <= r1; r++) {
          const tris = count[base + r];
          if (tris === 0) continue; // no tile here
          const ez = Math.max(Math.abs(z - centerZ[r]) - halfTile, 0);
          if (Math.hypot(ex, ez) <= radius) sum += tris;
        }
      }
      if (sum > budget) return false;
    }
  }
  return true;
}

/**
 * Largest radius (on a RADIUS_LADDER_STEP_M ladder) whose worst-case sum
 * stays within budget -- the sum only ever grows with radius, so this is
 * a binary search. Floored at `minRadius` so the tile the camera is over
 * is never excluded even if it alone busts the budget: a building
 * you're standing next to shouldn't just vanish.
 */
function findRadiusForBudget(tiles, tierKey, budget, minRadius, halfTile) {
  if (!tiles.length) return minRadius; // an empty extent is infinite -- the search below would never end
  const extent = tileExtent(tiles, halfTile);
  const grid = tileGrid(tiles, tierKey, halfTile * 2);
  const maxRadius = Math.hypot(extent.maxX - extent.minX, extent.maxZ - extent.minZ); // past this every tile is always in range
  let lo = Math.ceil(minRadius / RADIUS_LADDER_STEP_M), hi = Math.ceil(maxRadius / RADIUS_LADDER_STEP_M);
  let best = lo * RADIUS_LADDER_STEP_M;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = mid * RADIUS_LADDER_STEP_M;
    if (withinBudget(grid, r, budget, halfTile, extent)) { best = r; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

/**
 * Radii for a tile list, in the runtime's nearest-edge metric.
 * @param {Array<{centerX: number, centerZ: number, triCounts: {full: number, medium: number, coarse: number}}>} tiles
 * @param {{tileSizeM: number, targetFullTierTris: number, targetMediumTierTris: number}} params
 * @returns {{fullRadiusM: number, mediumRadiusM: number, coarseRadiusM: number}}
 */
export function computeRadii(tiles, params) {
  const halfTile = params.tileSizeM / 2;
  const floorM = halfTile; // a camera over a tile's centre always reaches that tile's own edges
  const fullRadiusM = findRadiusForBudget(tiles, 'full', params.targetFullTierTris, floorM, halfTile);
  const mediumRadiusM = findRadiusForBudget(tiles, 'medium', params.targetMediumTierTris, fullRadiusM, halfTile);
  const coarseRadiusM = findRadiusForBudget(tiles, 'coarse', params.targetMediumTierTris, mediumRadiusM, halfTile);
  return { fullRadiusM, mediumRadiusM, coarseRadiusM };
}
