// @ts-check
// ===================================================================
// tile-bounds -- exact per-mesh bounding boxes for a built/decoded tile
// payload. Pure (no three.js, no DOM), so the offline tile builder can run
// it and store the result in manifest.json; BuildingLayer then hands each
// mesh's box to three.js instead of letting it loop over every vertex
// (see layers/known-bounds.js for why that loop is worth avoiding).
//
// The numbers must be EXACTLY what three.js would compute: it takes the
// box centre as the bounding-sphere centre, and it sorts transparent meshes
// by that centre. A looser or tile-wide box changes the draw order and
// therefore the blended pixels (measured: 6-9% of pixels differ).
// ===================================================================

/** Mesh roles a tile payload can carry; the same keys BuildingLayer reads. */
export const TILE_MESH_ROLES = ['wall', 'windowWall', 'roof', 'outline'];

/**
 * @param {{[role:string]: {position: ArrayLike<number>}|null|undefined}} payload
 * @returns {{[role:string]: number[]}} role -> [minX, minY, minZ, maxX, maxY, maxZ], only for parts that have vertices
 */
export function meshBoundsOf(payload) {
  /** @type {{[role: string]: number[]}} */
  const out = {};
  for (const role of TILE_MESH_ROLES) {
    const a = payload?.[role]?.position;
    if (!a || a.length < 3) continue;
    let minX = a[0], minY = a[1], minZ = a[2], maxX = minX, maxY = minY, maxZ = minZ;
    for (let i = 3; i < a.length; i += 3) {
      const x = a[i], y = a[i + 1], z = a[i + 2];
      if (x < minX) minX = x; else if (x > maxX) maxX = x;
      if (y < minY) minY = y; else if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
    }
    out[role] = [minX, minY, minZ, maxX, maxY, maxZ];
  }
  return out;
}
