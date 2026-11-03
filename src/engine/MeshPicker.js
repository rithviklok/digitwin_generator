// ===================================================================
// MeshPicker -- which triangle a click ray hits first among many large
// meshes, without testing every triangle of every mesh.
//
// Why: three.js's Raycaster tests EVERY triangle of every mesh whose
// bounding sphere the ray crosses. A building tile's sphere is about
// 1.4 km across, so a click near the ground crossed a dozen tiles and
// tested well over a million triangles on the main thread. Measured in
// Edge on Kanpur: 85-123 ms per click normally, and 2.1-2.7 s -- the page
// frozen the whole time -- with the browser's JavaScript JIT switched off,
// which Edge's "Enhance your security on the web" mode does to sites it
// treats as unfamiliar.
//
// How: each mesh gets, on its first pick, an index of short runs of
// consecutive triangles -- one building or one road per run (never two),
// at most RUN_MAX_TRIANGLES -- with a bounding box per run. A pick visits
// the meshes nearest first, tests the ray against the run boxes, and runs
// the exact triangle test only inside the few runs it passes through.
// Meshes that start beyond the best hit so far are never opened, nor
// indexed, so a first click indexes only the tiles it reaches.
//
// The triangle test is three.js's own Ray.intersectTriangle written out on
// plain numbers, so a hit is the one three.js would report -- checked
// against it on real tiles and roads by scripts/test-picking.mjs.
//
// The index is built from the geometry as it is when first picked. Every
// pickable mesh in this app is built once and never edited; geometry that
// does change must delete geometry.userData.pickIndex.
// ===================================================================
import * as THREE from 'three';

/** Longest run, in triangles: short enough that its box stays tight around part of one building or road, long enough to keep the run list short. */
const RUN_MAX_TRIANGLES = 64;
/** Numbers per run in PickIndex.runs: first triangle, end triangle (exclusive), box min x, y, z, box max x, y, z. */
const RUN_STRIDE = 8;
/** Run boundaries are stored as floats; below this, a Float32Array holds triangle numbers exactly. */
const FLOAT32_EXACT_INTEGERS = 2 ** 24;

const IDENTITY = new THREE.Matrix4();

/**
 * @typedef {Object} PickIndex
 * @property {Float32Array|Float64Array} runs - RUN_STRIDE numbers per run
 * @property {number[]} box - [minX, minY, minZ, maxX, maxY, maxZ] of the whole mesh
 */

/**
 * Whether a mesh can use the index. Anything unusual -- a transformed,
 * instanced or skinned mesh, several materials, morph targets, an
 * interleaved or quantised position attribute, a draw range -- is left to
 * three.js's own raycast, which handles all of it.
 * @param {any} mesh
 * @returns {boolean}
 */
function canIndex(mesh) {
  const g = mesh.geometry;
  const pos = g?.attributes?.position;
  return Boolean(mesh.isMesh && !mesh.isInstancedMesh && !mesh.isSkinnedMesh && mesh.material && !Array.isArray(mesh.material)
    && pos && !pos.isInterleavedBufferAttribute && pos.itemSize === 3 && !pos.normalized
    && Object.keys(g.morphAttributes ?? {}).length === 0 && g.groups.length === 0
    && g.drawRange.start === 0 && g.drawRange.count === Infinity
    && mesh.matrixWorld.equals(IDENTITY));
}

/**
 * @param {THREE.BufferGeometry} geometry
 * @param {string|null} idAttribute - a per-vertex id ('buildingId', 'roadId'): a run never spans two ids, so each box
 *   hugs part of a single building or road. Without one (indexed road tiles), runs are simply consecutive triangles,
 *   which are still one road at a time because roads are written one after another.
 * @returns {PickIndex}
 */
function buildIndex(geometry, idAttribute) {
  const pos = geometry.attributes.position.array;
  const index = geometry.index ? geometry.index.array : null;
  const idAttr = !index && idAttribute ? geometry.attributes[idAttribute] : null;
  const ids = idAttr && idAttr.itemSize === 1 ? idAttr.array : null;
  const triCount = index ? index.length / 3 : pos.length / 9;
  /** @type {number[]} */
  const runs = [];
  let gx0 = Infinity, gy0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gy1 = -Infinity, gz1 = -Infinity;
  let tri = 0;
  while (tri < triCount) {
    const start = tri, id = ids ? ids[tri * 3] : 0;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    do {
      for (let k = 0; k < 3; k++) {
        const v = (index ? index[tri * 3 + k] : tri * 3 + k) * 3;
        const x = pos[v], y = pos[v + 1], z = pos[v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      tri++;
    } while (tri < triCount && tri - start < RUN_MAX_TRIANGLES && (!ids || ids[tri * 3] === id));
    runs.push(start, tri, x0, y0, z0, x1, y1, z1);
    if (x0 < gx0) gx0 = x0; if (y0 < gy0) gy0 = y0; if (z0 < gz0) gz0 = z0;
    if (x1 > gx1) gx1 = x1; if (y1 > gy1) gy1 = y1; if (z1 > gz1) gz1 = z1;
  }
  return {
    runs: triCount < FLOAT32_EXACT_INTEGERS ? Float32Array.from(runs) : Float64Array.from(runs),
    box: [gx0, gy0, gz0, gx1, gy1, gz1],
  };
}

/**
 * Where along the ray it enters an axis-aligned box: the same slab test as three.js's Ray.intersectBox (including its
 * handling of a ray parallel to a face). Returns -1 when the ray misses the box or the box lies entirely behind it.
 * @param {THREE.Vector3} o @param {number} ix @param {number} iy @param {number} iz - 1 / ray direction, per axis
 * @param {ArrayLike<number>} b @param {number} at - index of [minX, minY, minZ, maxX, maxY, maxZ] within `b`
 * @returns {number} entry distance (0 if the ray starts inside), or -1
 */
function boxEntry(o, ix, iy, iz, b, at) {
  let tmin, tmax, tymin, tymax, tzmin, tzmax;
  if (ix >= 0) { tmin = (b[at] - o.x) * ix; tmax = (b[at + 3] - o.x) * ix; } else { tmin = (b[at + 3] - o.x) * ix; tmax = (b[at] - o.x) * ix; }
  if (iy >= 0) { tymin = (b[at + 1] - o.y) * iy; tymax = (b[at + 4] - o.y) * iy; } else { tymin = (b[at + 4] - o.y) * iy; tymax = (b[at + 1] - o.y) * iy; }
  if (tmin > tymax || tymin > tmax) return -1;
  if (tymin > tmin || tmin !== tmin) tmin = tymin; // `x !== x` is NaN (0 * Infinity on a face the ray runs along)
  if (tymax < tmax || tmax !== tmax) tmax = tymax;
  if (iz >= 0) { tzmin = (b[at + 2] - o.z) * iz; tzmax = (b[at + 5] - o.z) * iz; } else { tzmin = (b[at + 5] - o.z) * iz; tzmax = (b[at + 2] - o.z) * iz; }
  if (tmin > tzmax || tzmin > tmax) return -1;
  if (tzmin > tmin || tmin !== tmin) tmin = tzmin;
  if (tzmax < tmax || tmax !== tmax) tmax = tzmax;
  if (tmax < 0) return -1;
  return tmin > 0 ? tmin : 0;
}

const _sphereBox = [0, 0, 0, 0, 0, 0];

/**
 * The nearest hit of `raycaster.ray` among `meshes`, as three.js's Raycaster would report it, or null.
 * A drop-in for `raycaster.intersectObjects(meshes)[0]` for meshes without children.
 * @param {THREE.Raycaster} raycaster
 * @param {THREE.Object3D[]} meshes
 * @param {{idAttribute?: string|null}} [opts] - see buildIndex()
 * @returns {THREE.Intersection|null} {distance, point, object, face: {a, b, c, normal, materialIndex}, faceIndex}
 */
export function pickNearest(raycaster, meshes, { idAttribute = null } = {}) {
  const ray = raycaster.ray, o = ray.origin, d = ray.direction;
  const ix = 1 / d.x, iy = 1 / d.y, iz = 1 / d.z;
  let bestT = raycaster.far, best = null;

  /** @type {Array<{entry: number, mesh: any}>} */
  const candidates = [];
  /** @type {any[]} */
  const others = [];
  for (const mesh of meshes) {
    if (!mesh.layers.test(raycaster.layers)) continue; // as Raycaster.intersectObject does
    if (!canIndex(mesh)) { others.push(mesh); continue; }
    const g = mesh.geometry;
    // The tightest box known without opening the mesh: its exact box when set (known-bounds.js), else its sphere's.
    let b = _sphereBox;
    if (g.boundingBox) {
      const { min, max } = g.boundingBox;
      b = [min.x, min.y, min.z, max.x, max.y, max.z];
    } else {
      if (g.boundingSphere === null) g.computeBoundingSphere();
      const { center: c, radius: r } = g.boundingSphere;
      _sphereBox[0] = c.x - r; _sphereBox[1] = c.y - r; _sphereBox[2] = c.z - r;
      _sphereBox[3] = c.x + r; _sphereBox[4] = c.y + r; _sphereBox[5] = c.z + r;
    }
    const entry = boxEntry(o, ix, iy, iz, b, 0);
    if (entry >= 0) candidates.push({ entry, mesh });
  }
  candidates.sort((p, q) => p.entry - q.entry);

  for (const { entry, mesh } of candidates) {
    if (entry > bestT) break; // this mesh, and every one after it, starts beyond the best hit so far
    const g = mesh.geometry;
    const pickIndex = g.userData.pickIndex ?? (g.userData.pickIndex = buildIndex(g, idAttribute));
    if (boxEntry(o, ix, iy, iz, pickIndex.box, 0) < 0) continue;
    const P = g.attributes.position.array, I = g.index ? g.index.array : null, R = pickIndex.runs;
    const side = mesh.material.side, cullBack = side === THREE.FrontSide, reverse = side === THREE.BackSide;
    for (let r = 0; r < R.length; r += RUN_STRIDE) {
      const e = boxEntry(o, ix, iy, iz, R, r + 2);
      if (e < 0 || e > bestT) continue;
      for (let tri = R[r], end = R[r + 1]; tri < end; tri++) {
        let va, vb, vc;
        if (I) { va = I[tri * 3]; vb = I[tri * 3 + 1]; vc = I[tri * 3 + 2]; } else { va = tri * 3; vb = va + 1; vc = va + 2; }
        // three.js Ray.intersectTriangle(a, b, c, backfaceCulling); a BackSide material tests (c, b, a) with culling.
        const a = (reverse ? vc : va) * 3, bb = vb * 3, c = (reverse ? va : vc) * 3;
        const e1x = P[bb] - P[a], e1y = P[bb + 1] - P[a + 1], e1z = P[bb + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        let DdN = d.x * nx + d.y * ny + d.z * nz, sign;
        if (DdN > 0) { if (cullBack || reverse) continue; sign = 1; } else if (DdN < 0) { sign = -1; DdN = -DdN; } else continue;
        const qx = o.x - P[a], qy = o.y - P[a + 1], qz = o.z - P[a + 2];
        const DdQxE2 = sign * (d.x * (qy * e2z - qz * e2y) + d.y * (qz * e2x - qx * e2z) + d.z * (qx * e2y - qy * e2x));
        if (DdQxE2 < 0) continue;
        const DdE1xQ = sign * (d.x * (e1y * qz - e1z * qy) + d.y * (e1z * qx - e1x * qz) + d.z * (e1x * qy - e1y * qx));
        if (DdE1xQ < 0) continue;
        if (DdQxE2 + DdE1xQ > DdN) continue;
        const QdN = -sign * (qx * nx + qy * ny + qz * nz);
        if (QdN < 0) continue;
        const t = QdN / DdN;
        if (t < raycaster.near || t >= bestT) continue; // `>=`: on an exact tie the first triangle found stays, as in three.js
        bestT = t;
        best = { mesh, tri, va, vb, vc };
      }
    }
  }

  // Meshes the index can't serve: three.js's own raycast, compared by distance.
  /** @type {any} */
  let otherHit = null;
  for (const mesh of others) {
    /** @type {any[]} */
    const hits = [];
    mesh.raycast(raycaster, hits);
    for (const h of hits) if (h.distance < bestT) { bestT = h.distance; otherHit = h; }
  }
  if (otherHit) return otherHit;
  if (!best) return null;

  const pos = best.mesh.geometry.attributes.position;
  const vA = new THREE.Vector3().fromBufferAttribute(pos, best.va);
  const vB = new THREE.Vector3().fromBufferAttribute(pos, best.vb);
  const vC = new THREE.Vector3().fromBufferAttribute(pos, best.vc);
  return {
    distance: bestT,
    point: ray.at(bestT, new THREE.Vector3()),
    object: best.mesh,
    face: { a: best.va, b: best.vb, c: best.vc, normal: THREE.Triangle.getNormal(vA, vB, vC, new THREE.Vector3()), materialIndex: 0 },
    faceIndex: best.tri,
  };
}
