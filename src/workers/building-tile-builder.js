// ===================================================================
// building-tile-builder.js — the pure, DOM/`self`-free tile-building
// pipeline, used by BOTH the live browser worker (building-worker.js)
// AND scripts/build-building-tiles.mjs (a plain Node script), so the two
// build the same geometry. Pass 1 buckets the buildings into tiles and
// triangulates each once; Pass 2 allocates buffers of the exact size and
// writes them.
//
// `detail` is which tier of geometry Pass 2 builds for a given tile --
//   full   -- wall (or windowed wall) + roof (real height) + outline.
//   medium -- every building's wall via the plain (non-windowed) path, no
//             separate windowed variant + roof (real height). No outline.
//   coarse -- roof only, flattened to y=0 (no wall extrusion at all).
// All three reuse the exact same triangulation/shading functions --
// this is the same pipeline with parts progressively skipped, not
// three different geometry algorithms. See the offline build script
// for how each tile picks its tier's radius; this module has no
// opinion on distance, only on what a given detail level draws.
// ===================================================================
import * as THREE from 'three';
import { makeProjector, projectRingFlat, collectRings } from './geo-utils.js';
import {
  buildingJitterFrac, buildingJitter, buildingHeightLightness, buildingTypeKey,
  ROOF_JITTER_RANGE, WALL_JITTER_RANGE, WALL_GRADIENT_BASE, WINDOW_TILE_M,
  TYPE_KEY_CODES, HEIGHT_STATUS_CODES,
} from './building-style.js';

export const TILE_DETAIL = Object.freeze({ FULL: 'full', MEDIUM: 'medium', COARSE: 'coarse' });
export const ALL_TILE_DETAILS = Object.freeze([TILE_DETAIL.FULL, TILE_DETAIL.MEDIUM, TILE_DETAIL.COARSE]);

/**
 * @typedef {'full'|'medium'|'coarse'} TileDetail
 *
 * @typedef {Object} BucketerParams
 * @property {{lon: number, lat: number}} origin  scene (0, 0); every footprint is projected relative to it
 * @property {number} tileSizeM          side of one tile, metres
 * @property {number} windowMinHeightM   buildings at least this tall get the textured (windowed) wall
 * @property {string} heightProperty     GeoJSON property holding the height in metres
 * @property {number} minRenderHeightM   buildings lower than this (or with no height) are left out
 *
 * @typedef {Object} BucketStats
 * @property {number} skippedCount     features with no usable height
 * @property {number} windowedCount
 * @property {number} roofFailedCount  footprints whose roof could not be triangulated (drawn with walls only)
 * @property {number} buildingCount    footprints placed (a MultiPolygon counts once per part)
 */

/**
 * The height test, as a function so the bake and the live worker apply the
 * same rule. A building with no valid height is left out rather than given
 * a made-up one: a guessed height would be shown as if measured.
 * @param {string} heightProperty @param {number} minRenderHeightM
 * @returns {(props: Record<string, any>|null|undefined) => number|null}
 */
export function makeHeightFn(heightProperty, minRenderHeightM) {
  return (props) => {
    const h = Number(props?.[heightProperty]);
    return Number.isFinite(h) && h >= minRenderHeightM ? h : null;
  };
}
/** @param {string} heightProperty @returns {(props: Record<string, any>|null|undefined) => 'measured'|'missing'} */
export function makeHeightStatusFn(heightProperty) {
  return (props) => (Number.isFinite(Number(props?.[heightProperty])) ? 'measured' : 'missing');
}

/**
 * A typed array that grows as values are appended. A tile's buildings are
 * kept in a handful of these (see newBucket), not as one object each: a
 * metro is millions of buildings, and one small object plus one small
 * Float32Array per building came to about 650 bytes each (3.3 GB for a
 * Delhi-sized file) -- and made every garbage collection during the tile
 * writing walk all of them. (road-tile-builder.js keeps a tile's roads the
 * same way.)
 */
export class Growable {
  /** @param {Float32ArrayConstructor|Float64ArrayConstructor|Int32ArrayConstructor|Uint32ArrayConstructor|Uint8ArrayConstructor} ArrayType */
  constructor(ArrayType) {
    /** @type {any} the backing typed array; only data[0 .. length) is in use */
    this.data = new ArrayType(64);
    this.length = 0;
  }
  /** @param {number} value */
  push(value) {
    if (this.length === this.data.length) this.grow(this.length + 1);
    this.data[this.length++] = value;
  }
  /** @param {ArrayLike<number>} values */
  pushAll(values) {
    const end = this.length + values.length;
    if (end > this.data.length) this.grow(end);
    this.data.set(values, this.length);
    this.length = end;
  }
  /** Doubles capacity (amortised O(1) per push) until `needed` fits. @param {number} needed */
  grow(needed) {
    let capacity = this.data.length * 2;
    while (capacity < needed) capacity *= 2;
    const bigger = new this.data.constructor(capacity);
    bigger.set(this.data);
    this.data = bigger;
  }
}

/**
 * One tile's buildings. Every per-building array has one entry per
 * building, in the order they were added -- that position is the
 * building's index in the tile (the `buildingId` its vertices carry).
 */
function newBucket(ix, iz) {
  return {
    ix, iz, count: 0,
    // Every footprint end to end, [x, z, x, z, ...], and where each building's ends (it starts where the one before ends).
    ring: new Growable(Float32Array), ringEnd: new Growable(Int32Array),
    // Float64, like the numbers they are computed from: the shading maths reads them, and must give exactly what it always has.
    height: new Growable(Float64Array), wallJitter: new Growable(Float64Array), roofJitter: new Growable(Float64Array),
    typeCode: new Growable(Uint8Array), heightStatusCode: new Growable(Uint8Array), windowed: new Growable(Uint8Array),
    // The roof triangles of the footprints that needed real triangulation (more than 4 corners), as corner indices into
    // their own footprint, end to end. A footprint drawn as a simple fan has none (roofIsFastFan = 1).
    roofTri: new Growable(Int32Array), roofTriEnd: new Growable(Int32Array), roofIsFastFan: new Growable(Uint8Array),
    wallVertCount: 0, windowWallVertCount: 0, roofVertCount: 0, outlineVertCount: 0, roofTriIndexCount: 0, ringFlatCount: 0,
  };
}

/** Lets a tile's buildings go once it has been written, so memory falls as the writing goes on (the bucket's counts stay). */
export function releaseBucket(bucket) {
  for (const [key, value] of Object.entries(bucket)) if (value instanceof Growable) bucket[key] = null;
}

/**
 * A tile's buildings as the records Pass 2's writers take. `flat` and
 * `roofTris` are views into the bucket's own arrays, not copies; roofTris
 * is null for a footprint drawn as a fan.
 */
function recordsOf(bucket) {
  const ring = bucket.ring.data, ringEnd = bucket.ringEnd.data;
  const roofTri = bucket.roofTri.data, roofTriEnd = bucket.roofTriEnd.data;
  const records = new Array(bucket.count);
  for (let i = 0; i < bucket.count; i++) {
    const start = i === 0 ? 0 : ringEnd[i - 1], end = ringEnd[i];
    records[i] = {
      flat: ring.subarray(start, end), n: (end - start) / 2,
      height: bucket.height.data[i], wallJitter: bucket.wallJitter.data[i], roofJitter: bucket.roofJitter.data[i],
      typeCode: bucket.typeCode.data[i], windowed: bucket.windowed.data[i] === 1,
      roofTris: bucket.roofIsFastFan.data[i] === 1 ? null : roofTri.subarray(i === 0 ? 0 : roofTriEnd[i - 1], roofTriEnd[i]),
      buildingIndex: i,
    };
  }
  return records;
}

/**
 * Pass 1, one feature at a time: puts each feature into its tileSizeM
 * cell, projecting + triangulating each roof once (kept in the tile's
 * bucket, reused by every detail tier's Pass 2 -- roof triangulation
 * doesn't change per tier, only whether/how it's drawn). Also counts exact
 * vertex needs per part so Pass 2 can exact-size-allocate.
 *
 * Taking features one by one is what lets the offline bake read a
 * buildings file of any size (scripts/geojson-feature-stream.mjs): once
 * add() returns, nothing here holds on to the feature itself.
 *
 * @param {BucketerParams} params
 * @returns {{add(feature: any): void, result(): {tiles: Map<string, any>, stats: BucketStats}}}
 */
export function createBucketer(params) {
  const { origin, tileSizeM, windowMinHeightM, heightProperty, minRenderHeightM } = params;
  const project = makeProjector(origin);
  const heightFn = makeHeightFn(heightProperty, minRenderHeightM);
  const heightStatusFn = makeHeightStatusFn(heightProperty);

  const tiles = new Map();
  let skippedCount = 0, windowedCount = 0, roofFailedCount = 0, buildingCount = 0;

  function add(f) {
    const props = f.properties;
    const height = heightFn(props);
    if (height === null) { skippedCount++; return; }

    const jitterFrac = buildingJitterFrac(props?.osm_id ?? props?.id ?? f.id);
    const wallJitter = buildingJitter(jitterFrac, ...WALL_JITTER_RANGE);
    const roofJitter = buildingJitter(jitterFrac, ...ROOF_JITTER_RANGE);
    const typeKey = buildingTypeKey(props);
    const windowed = height >= windowMinHeightM;
    if (windowed) windowedCount++;
    const heightStatus = heightStatusFn(props);

    for (const ring of collectRings(f)) {
      const flat = projectRingFlat(ring, project);
      const n = flat.length / 2;
      if (n < 3) continue;

      let roofTris = null; // null = fast-fan path
      if (n > 4) {
        const shapePts = new Array(n);
        for (let i = 0; i < n; i++) shapePts[i] = new THREE.Vector2(flat[i * 2], flat[i * 2 + 1]);
        try { roofTris = THREE.ShapeUtils.triangulateShape(shapePts, []); }
        catch { roofTris = []; }
        if (roofTris.length === 0) roofFailedCount++;
      }
      const roofTriCount = roofTris === null ? n - 2 : roofTris.length;

      const ix = Math.floor(flat[0] / tileSizeM);
      const iz = Math.floor(flat[1] / tileSizeM);
      const key = `${ix},${iz}`;
      let bucket = tiles.get(key);
      if (!bucket) {
        bucket = newBucket(ix, iz);
        tiles.set(key, bucket);
      }

      bucket.ring.pushAll(flat);
      bucket.ringEnd.push(bucket.ring.length);
      bucket.height.push(height);
      bucket.wallJitter.push(wallJitter);
      bucket.roofJitter.push(roofJitter);
      bucket.typeCode.push(TYPE_KEY_CODES[typeKey ?? 'null']);
      bucket.heightStatusCode.push(HEIGHT_STATUS_CODES[heightStatus ?? 'null']);
      bucket.windowed.push(windowed ? 1 : 0);
      bucket.roofIsFastFan.push(roofTris === null ? 1 : 0);
      if (roofTris !== null) for (const tri of roofTris) bucket.roofTri.pushAll(tri);
      bucket.roofTriEnd.push(bucket.roofTri.length);
      bucket.count++;
      if (windowed) bucket.windowWallVertCount += n * 6; else bucket.wallVertCount += n * 6;
      bucket.roofVertCount += roofTriCount * 3;
      bucket.outlineVertCount += n * 4;
      bucket.ringFlatCount += n * 2;
      if (roofTris !== null) bucket.roofTriIndexCount += roofTris.length * 3;
      buildingCount++;
    }
  }

  return { add, result: () => ({ tiles, stats: { skippedCount, windowedCount, roofFailedCount, buildingCount } }) };
}

/**
 * Pass 1 over a whole array of features (the browser worker, which has
 * already fetched and parsed the file) -- see createBucketer().
 *
 * Async so callers that need to stay responsive can yield/abort at
 * `opts.yieldEvery`-feature intervals, same cadence building-worker.js
 * always used.
 *
 * @param {any[]} features - GeoJSON Features
 * @param {BucketerParams} params
 * @param {{yieldEvery?: number, isAborted?: () => boolean, onProgress?: ((done: number, total: number) => void)|null}} [opts]
 * @returns {Promise<{tiles: Map<string, any>, stats: BucketStats}|null>} null if aborted mid-pass
 */
export async function bucketFeatures(features, params, opts = {}) {
  const { yieldEvery = 20000, isAborted = () => false, onProgress = null } = opts; // onProgress(done, total)
  const bucketer = createBucketer(params);

  for (let fi = 0; fi < features.length; fi++) {
    // At the TOP of the loop, so features skipped for having no usable
    // height still count -- a file where most or all buildings are skipped
    // would otherwise report no progress and never yield at all.
    if (fi % yieldEvery === 0) {
      onProgress?.(fi, features.length);
      await Promise.resolve();
      if (isAborted()) return null;
    }
    bucketer.add(features[fi]);
  }

  return bucketer.result();
}

// A polygon triangulates to exactly n-2 triangles no matter which
// algorithm picks the diagonals (Euler's polygon-triangulation count) --
// so a "medium" tier that kept each building's REAL footprint would
// have the SAME triangle count as "full", just fewer draw calls/no UVs.
// That's not a real LOD tier. Medium and coarse instead simplify every
// building to its axis-aligned bounding-box footprint (always 4
// vertices, always 2 roof triangles, always 8 wall triangles) --
// genuine reduction that scales with how complex the source footprint
// is (a 20-vertex real footprint: 58 tris full -> 10 tris medium).
const SIMPLIFIED_FOOTPRINT_N = 4;
const SIMPLIFIED_WALL_TRIS_PER_BUILDING = SIMPLIFIED_FOOTPRINT_N * 2; // 4 edges * 2 tris/edge
const SIMPLIFIED_ROOF_TRIS_PER_BUILDING = SIMPLIFIED_FOOTPRINT_N - 2; // fast-fan of a 4-gon

/** @returns {Float32Array} 4-point [x,z]*4 bounding-box ring around a building's real footprint. */
function bboxFootprintFlat(flat, n) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = flat[i * 2], z = flat[i * 2 + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return new Float32Array([minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ]);
}

/** A building record with its footprint replaced by its bbox -- same metadata (height/jitter/type/buildingIndex), for medium/coarse Pass 2 writers. Winding doesn't matter: both wall and roof materials render double-sided. */
function simplifyToBBox(b) {
  return { ...b, flat: bboxFootprintFlat(b.flat, b.n), n: SIMPLIFIED_FOOTPRINT_N, roofTris: null };
}

/**
 * Each tile's exact triangle count at each detail tier, from Pass-1
 * counts alone -- no Pass 2 buffer allocation needed. Used by the
 * offline build script to compute data-driven tier radii before it
 * spends any time actually writing geometry.
 * @param {any} bucket - one tile's bucket from createBucketer().result().tiles
 * @returns {{full: number, medium: number, coarse: number}}
 */
export function tileTriCounts(bucket) {
  const fullWallTris = (bucket.wallVertCount + bucket.windowWallVertCount) / 3;
  const fullRoofTris = bucket.roofVertCount / 3;
  const buildingCount = bucket.count;
  return {
    full: fullWallTris + fullRoofTris, // outline is LineSegments, not triangles -- doesn't count toward a triangle budget
    medium: buildingCount * (SIMPLIFIED_WALL_TRIS_PER_BUILDING + SIMPLIFIED_ROOF_TRIS_PER_BUILDING),
    coarse: buildingCount * SIMPLIFIED_ROOF_TRIS_PER_BUILDING,
  };
}

/**
 * Pass-2 geometry + packed buildingMeta for one tile, at the given detail tier.
 * @param {any} bucket - one tile's bucket from createBucketer().result().tiles (not yet released)
 * @param {TileDetail} [detail]
 * @returns {import('./tile-binary-format.js').TilePayload}
 */
export function buildTileBuffers(bucket, detail = TILE_DETAIL.FULL) {
  const out = { wall: null, windowWall: null, roof: null, outline: null, meta: null };
  const buildingCount = bucket.count;
  const buildings = recordsOf(bucket);

  if (detail === TILE_DETAIL.FULL) {
    if (bucket.wallVertCount > 0) {
      const pos = new Float32Array(bucket.wallVertCount * 3);
      const col = new Float32Array(bucket.wallVertCount * 3);
      const bid = new Float32Array(bucket.wallVertCount);
      let w = 0;
      for (const b of buildings) { if (!b.windowed) w = writeWallSegments(pos, col, bid, w, b); }
      out.wall = { position: pos, color: col, buildingId: bid, normal: computeFlatNormals(pos) };
    }
    if (bucket.windowWallVertCount > 0) {
      const pos = new Float32Array(bucket.windowWallVertCount * 3);
      const col = new Float32Array(bucket.windowWallVertCount * 3);
      const uv = new Float32Array(bucket.windowWallVertCount * 2);
      const bid = new Float32Array(bucket.windowWallVertCount);
      let w = 0, uvw = 0;
      for (const b of buildings) {
        if (!b.windowed) continue;
        ({ w, uvw } = writeWindowedWallSegments(pos, col, uv, bid, w, uvw, b));
      }
      out.windowWall = { position: pos, color: col, uv, buildingId: bid, normal: computeFlatNormals(pos) };
    }

    if (bucket.roofVertCount > 0) {
      const pos = new Float32Array(bucket.roofVertCount * 3);
      const col = new Float32Array(bucket.roofVertCount * 3);
      const bid = new Float32Array(bucket.roofVertCount);
      let r = 0;
      for (const b of buildings) r = writeRoofTriangles(pos, col, bid, r, b, false);
      out.roof = { position: pos, color: col, buildingId: bid, normal: computeFlatNormals(pos) };
    }

    if (bucket.outlineVertCount > 0) {
      const pos = new Float32Array(bucket.outlineVertCount * 3);
      let o = 0;
      for (const b of buildings) o = writeOutlineSegments(pos, o, b);
      out.outline = { position: pos };
    }
  } else {
    // medium and coarse both simplify every building to its bbox footprint first.
    const simplified = buildings.map(simplifyToBBox);

    if (detail === TILE_DETAIL.MEDIUM) {
      const wallVertCount = buildingCount * SIMPLIFIED_WALL_TRIS_PER_BUILDING * 3;
      if (wallVertCount > 0) {
        const pos = new Float32Array(wallVertCount * 3);
        const col = new Float32Array(wallVertCount * 3);
        const bid = new Float32Array(wallVertCount);
        let w = 0;
        for (const b of simplified) w = writeWallSegments(pos, col, bid, w, b);
        out.wall = { position: pos, color: col, buildingId: bid, normal: computeFlatNormals(pos) };
      }
    }
    // coarse: no wall at all.

    const roofVertCount = buildingCount * SIMPLIFIED_ROOF_TRIS_PER_BUILDING * 3;
    if (roofVertCount > 0) {
      const pos = new Float32Array(roofVertCount * 3);
      const col = new Float32Array(roofVertCount * 3);
      const bid = new Float32Array(roofVertCount);
      let r = 0;
      const flatten = detail === TILE_DETAIL.COARSE; // coarse: flattened to ground, no extrusion at all
      for (const b of simplified) r = writeRoofTriangles(pos, col, bid, r, b, flatten);
      out.roof = { position: pos, color: col, buildingId: bid, normal: computeFlatNormals(pos) };
    }
  }

  out.meta = packBuildingMeta(bucket);
  return out;
}

/**
 * Flat per-triangle face normal, computed for every consecutive vertex
 * triplet in `pos` -- replicates THREE.BufferGeometry.computeVertexNormals()'s
 * own non-indexed path exactly, just off the main thread/off the GPU-idle path.
 */
export function computeFlatNormals(pos) {
  const vertCount = pos.length / 3;
  const normal = new Float32Array(pos.length);
  for (let i = 0; i < vertCount; i += 3) {
    const ai = i * 3, bi = (i + 1) * 3, ci = (i + 2) * 3;
    const ax = pos[ai], ay = pos[ai + 1], az = pos[ai + 2];
    const bx = pos[bi], by = pos[bi + 1], bz = pos[bi + 2];
    const cx = pos[ci], cy = pos[ci + 1], cz = pos[ci + 2];
    const abx = ax - bx, aby = ay - by, abz = az - bz;
    const cbx = cx - bx, cby = cy - by, cbz = cz - bz;
    let nx = cby * abz - cbz * aby;
    let ny = cbz * abx - cbx * abz;
    let nz = cbx * aby - cby * abx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    normal[ai] = nx; normal[ai + 1] = ny; normal[ai + 2] = nz;
    normal[bi] = nx; normal[bi + 1] = ny; normal[bi + 2] = nz;
    normal[ci] = nx; normal[ci + 1] = ny; normal[ci + 2] = nz;
  }
  return normal;
}

function writeWallSegments(pos, col, bid, w, b) {
  const { flat, n, height, wallJitter, buildingIndex } = b;
  const heightLight = buildingHeightLightness(height);
  const topShade = wallJitter * heightLight;
  const baseShade = wallJitter * WALL_GRADIENT_BASE * heightLight;
  const shade = [baseShade, baseShade, topShade, baseShade, topShade, topShade];
  for (let i = 0; i < n; i++) {
    const x0 = flat[i * 2], z0 = flat[i * 2 + 1];
    const j = (i + 1) % n;
    const x1 = flat[j * 2], z1 = flat[j * 2 + 1];
    const wi = w * 3;
    pos[wi] = x0; pos[wi + 1] = 0; pos[wi + 2] = z0;
    pos[wi + 3] = x1; pos[wi + 4] = 0; pos[wi + 5] = z1;
    pos[wi + 6] = x1; pos[wi + 7] = height; pos[wi + 8] = z1;
    pos[wi + 9] = x0; pos[wi + 10] = 0; pos[wi + 11] = z0;
    pos[wi + 12] = x1; pos[wi + 13] = height; pos[wi + 14] = z1;
    pos[wi + 15] = x0; pos[wi + 16] = height; pos[wi + 17] = z0;
    for (let k = 0; k < 6; k++) {
      const ci = (w + k) * 3, s = shade[k];
      col[ci] = s; col[ci + 1] = s; col[ci + 2] = s;
      bid[w + k] = buildingIndex;
    }
    w += 6;
  }
  return w;
}

function writeWindowedWallSegments(pos, col, uv, bid, w, uvw, b) {
  const { flat, n, height, wallJitter, buildingIndex } = b;
  const heightLight = buildingHeightLightness(height);
  const topShade = wallJitter * heightLight;
  const baseShade = wallJitter * WALL_GRADIENT_BASE * heightLight;
  const shade = [baseShade, baseShade, topShade, baseShade, topShade, topShade];
  for (let i = 0; i < n; i++) {
    const x0 = flat[i * 2], z0 = flat[i * 2 + 1];
    const j = (i + 1) % n;
    const x1 = flat[j * 2], z1 = flat[j * 2 + 1];
    const segLen = Math.hypot(x1 - x0, z1 - z0);
    const u1 = segLen / WINDOW_TILE_M, v1 = height / WINDOW_TILE_M;

    const wi = w * 3;
    pos[wi] = x0; pos[wi + 1] = 0; pos[wi + 2] = z0;
    pos[wi + 3] = x1; pos[wi + 4] = 0; pos[wi + 5] = z1;
    pos[wi + 6] = x1; pos[wi + 7] = height; pos[wi + 8] = z1;
    pos[wi + 9] = x0; pos[wi + 10] = 0; pos[wi + 11] = z0;
    pos[wi + 12] = x1; pos[wi + 13] = height; pos[wi + 14] = z1;
    pos[wi + 15] = x0; pos[wi + 16] = height; pos[wi + 17] = z0;
    for (let k = 0; k < 6; k++) {
      const ci = (w + k) * 3, s = shade[k];
      col[ci] = s; col[ci + 1] = s; col[ci + 2] = s;
      bid[w + k] = buildingIndex;
    }
    const uvi = uvw * 2;
    uv[uvi] = 0; uv[uvi + 1] = 0;
    uv[uvi + 2] = u1; uv[uvi + 3] = 0;
    uv[uvi + 4] = u1; uv[uvi + 5] = v1;
    uv[uvi + 6] = 0; uv[uvi + 7] = 0;
    uv[uvi + 8] = u1; uv[uvi + 9] = v1;
    uv[uvi + 10] = 0; uv[uvi + 11] = v1;
    w += 6; uvw += 6;
  }
  return { w, uvw };
}

/** @param {boolean} flatten true = coarse tier: draw at y=0 instead of the real height. */
function writeRoofTriangles(pos, col, bid, r, b, flatten) {
  const { flat, n, height, roofJitter, typeCode, roofTris, buildingIndex } = b;
  const tint = TINT_BY_TYPE_CODE[typeCode];
  const light = buildingHeightLightness(height) * roofJitter;
  const [tr, tg, tb] = tint;
  const y = flatten ? 0 : height;

  const writeTri = (ax, az, bx, bz, cx, cz) => {
    const ri = r * 3;
    pos[ri] = ax; pos[ri + 1] = y; pos[ri + 2] = az;
    pos[ri + 3] = bx; pos[ri + 4] = y; pos[ri + 5] = bz;
    pos[ri + 6] = cx; pos[ri + 7] = y; pos[ri + 8] = cz;
    for (let k = 0; k < 3; k++) {
      const ci = (r + k) * 3;
      col[ci] = tr * light; col[ci + 1] = tg * light; col[ci + 2] = tb * light;
      bid[r + k] = buildingIndex;
    }
    r += 3;
  };

  if (roofTris === null) {
    const ax = flat[0], az = flat[1];
    for (let i = 1; i < n - 1; i++) writeTri(ax, az, flat[i * 2], flat[i * 2 + 1], flat[(i + 1) * 2], flat[(i + 1) * 2 + 1]);
  } else {
    for (let t = 0; t < roofTris.length; t += 3) {
      const ia = roofTris[t], ib = roofTris[t + 1], ic = roofTris[t + 2];
      writeTri(flat[ia * 2], flat[ia * 2 + 1], flat[ib * 2], flat[ib * 2 + 1], flat[ic * 2], flat[ic * 2 + 1]);
    }
  }
  return r;
}

function writeOutlineSegments(pos, o, b) {
  const { flat, n, height } = b;
  for (let i = 0; i < n; i++) {
    const x0 = flat[i * 2], z0 = flat[i * 2 + 1];
    const j = (i + 1) % n;
    const x1 = flat[j * 2], z1 = flat[j * 2 + 1];
    const oi = o * 3;
    pos[oi] = x0; pos[oi + 1] = height; pos[oi + 2] = z0;
    pos[oi + 3] = x1; pos[oi + 4] = height; pos[oi + 5] = z1;
    o += 2;
    const oi2 = o * 3;
    pos[oi2] = x0; pos[oi2 + 1] = 0; pos[oi2 + 2] = z0;
    pos[oi2 + 3] = x0; pos[oi2 + 4] = height; pos[oi2 + 5] = z0;
    o += 2;
  }
  return o;
}

/** Flattened per-building metadata for this tile -- same for every detail tier (click-inspect/shadow-baking needs it regardless of what's actually drawn). */
function packBuildingMeta(bucket) {
  // The bucket already holds all of this in the same layout (newBucket); what
  // goes out are copies cut to size -- the browser worker transfers these
  // arrays to the main thread, which would take the bucket's own away from it.
  const count = bucket.count;
  const ringOffsets = new Int32Array(count + 1), roofTriOffsets = new Int32Array(count + 1);
  ringOffsets.set(bucket.ringEnd.data.subarray(0, count), 1); // a building starts where the one before it ends; the first at 0
  roofTriOffsets.set(bucket.roofTriEnd.data.subarray(0, count), 1);
  return {
    ringFlat: bucket.ring.data.slice(0, bucket.ringFlatCount),
    ringOffsets,
    heights: new Float32Array(bucket.height.data.subarray(0, count)),
    typeCode: bucket.typeCode.data.slice(0, count),
    heightStatusCode: bucket.heightStatusCode.data.slice(0, count),
    roofIsFastFan: bucket.roofIsFastFan.data.slice(0, count),
    roofTriIndex: bucket.roofTri.data.slice(0, bucket.roofTriIndexCount),
    roofTriOffsets,
    count,
  };
}

const TYPE_TINTS_RGB = {
  worship: [0xe8 / 255, 0xc9 / 255, 0x8a / 255],
  health: [0xf2 / 255, 0xa6 / 255, 0xa6 / 255],
  education: [0xb3 / 255, 0xa6 / 255, 0xf2 / 255],
  industrial: [0xc9 / 255, 0xc2 / 255, 0xb4 / 255],
  commercial: [0xf2 / 255, 0xd6 / 255, 0xa6 / 255],
};
/** The roof tint for each type code (TYPE_KEY_CODES); plain white for a building with no type. */
const TINT_BY_TYPE_CODE = [];
for (const [key, code] of Object.entries(TYPE_KEY_CODES)) TINT_BY_TYPE_CODE[code] = TYPE_TINTS_RGB[key] ?? [1, 1, 1];
