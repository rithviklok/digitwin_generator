// ===================================================================
// RoadLayer — road polygons (tiered class0/1/2) + railway lines (heavy
// rail + metro, split by the `railway` tag).
//
// Each road's polygon IS its width -- no centerline+width model. Kanpur's
// are its municipal survey's; an uploaded city's are made by the server
// from OpenStreetMap's centre lines (server/lib/osmSplitter.js). Tiled
// like buildings (CityConfig's own tileSizeM) so MultiPolygon pieces
// become independent clickable roads and the mesh count stays bounded at
// city scale.
//
// Two ways the roads arrive, told apart by what the roads layer holds:
//
//   WHOLE (a roads GeoJSON): every road is triangulated here at boot and
//   stays in the scene. Kanpur's own survey and every city up to tens of
//   thousands of roads.
//
//   TILES (a road-tiles manifest, written by the server for a large city,
//   server/lib/roadTiles.js): the same meshes, already triangulated, in
//   small files that are loaded around the camera and let go behind it
//   (updateTiles). Delhi with its satellite cities is 3.16 lakh roads and
//   68 lakh triangles; whole, that is 436 MB to download and parse.
// ===================================================================
import * as THREE from 'three';
import { makeProjector, projectRingFlat, projectLineFlat, collectRings } from '../workers/geo-utils.js';
import { buildingJitterFrac } from '../workers/building-style.js';
import { decodeRoadTile } from '../workers/road-tile-format.js';
import { setKnownBounds } from './known-bounds.js';
import { layersWithRole, LAYER_ROLES } from '../config/city-schema.js';
import {
  Y_KMC_ROAD, Y_RAILWAY, darkenHex, BUILDING_TIER_MAX_UPGRADE_SPEED_MPS,
  ROAD_MAJOR_RADIUS_M, ROAD_LOCAL_RADIUS_M, ROAD_TILE_HYSTERESIS_M, ROAD_TILE_EVICT_DELAY_MS, ROAD_TILE_MAX_FETCHES, ROAD_TILE_BIND_BUDGET_MS,
} from '../config/constants.js';

const TIER_KEYS = ['class0', 'class1', 'class2'];
const BAND_RADIUS_M = { major: ROAD_MAJOR_RADIUS_M, local: ROAD_LOCAL_RADIUS_M };
const PRIME_CONCURRENCY = 8;
const RETRY_AFTER_MS = 10_000; // a tile whose download failed is left alone this long before it is asked for again

function kmcRoadTier(cls) {
  if (cls === 0) return 'class0';
  if (cls === 1) return 'class1';
  return 'class2';
}

// Per-tier road style: one shared fill colour across all three tiers (no
// seam at junctions) -- the tier hierarchy comes from roughness + grain,
// not colour.
const TIER_STYLE = {
  class0: { albedoDay: 0xb8bdc6, albedoNight: 0x3d444c, roughness: 0.28, metalness: 0.08, grainScale: 0.22, grainAmount: 0.045, polygonOffsetFactor: -3, polygonOffsetUnits: -3, renderOrder: 30 },
  class1: { albedoDay: 0xb8bdc6, albedoNight: 0x3d444c, roughness: 0.58, metalness: 0.03, grainScale: 0.15, grainAmount: 0.07, polygonOffsetFactor: -2, polygonOffsetUnits: -2, renderOrder: 20 },
  class2: { albedoDay: 0xb8bdc6, albedoNight: 0x3d444c, roughness: 0.9, metalness: 0.0, grainScale: 0.085, grainAmount: 0.11, polygonOffsetFactor: -1, polygonOffsetUnits: -1, renderOrder: 10 },
};
const ROAD_EMISSIVE_DAY = { hex: 0x141414, intensity: 0.18 };
const ROAD_EMISSIVE_NIGHT = { hex: 0x545c69, intensity: 0.55 };

// ---------------------------------------------------------------------
// Metro/subway line colour resolution. Kanpur has exactly one line
// ("Orange Line"); a city like Delhi has Blue/Yellow/Red/Magenta/Pink/...
// lines, so the colour can't be one constant. Resolution order, cheapest
// and most city-agnostic first:
//   1. An explicit CityConfig.railway.lineColors[name] override (exact
//      branding, for a line whose real colour isn't in its own name).
//   2. A colour word found IN the line's own name -- most metro systems
//      worldwide literally name lines after their colour ("Orange Line",
//      "Blue Line", ...), so this needs zero per-city configuration and
//      is what makes Kanpur's "Orange Line" resolve correctly with no
//      CityConfig entry at all.
//   3. A stable colour hashed from the line's own name (buildingJitterFrac,
//      the same deterministic per-seed hash buildings already use for
//      jitter) picked from a small distinct palette -- so an unrecognized
//      line name still gets its own consistent colour every reload,
//      never silently merged into a single flat "metro" colour.
// ---------------------------------------------------------------------
const COLOR_WORD_HEX = {
  orange: 0xff8c00, blue: 0x0033a0, yellow: 0xffd500, red: 0xe31e24, green: 0x00a651,
  violet: 0x7b2d8e, magenta: 0xd0006f, pink: 0xec008c, grey: 0x8f96a0, gray: 0x8f96a0,
  aqua: 0x00b7c3, teal: 0x008080, purple: 0x800080, brown: 0x8b4513, maroon: 0x800000,
  gold: 0xffd700, silver: 0xc0c0c0,
};
const FALLBACK_LINE_PALETTE = [0xff8c00, 0x0033a0, 0xffd500, 0xe31e24, 0x00a651, 0x7b2d8e, 0xec008c, 0x00b7c3];
/** Whole-word matchers, compiled once (this runs for every metro line name), in COLOR_WORD_HEX's order -- the first match wins. */
const COLOR_WORD_MATCHERS = Object.entries(COLOR_WORD_HEX).map(([word, hex]) => /** @type {[RegExp, number]} */ ([new RegExp(`\\b${word}\\b`), hex]));

/** @param {string|null|undefined} name @returns {number|null} hex colour of the first colour word in the name */
function detectColorWord(name) {
  const lower = (name || '').toLowerCase();
  for (const [re, hex] of COLOR_WORD_MATCHERS) if (re.test(lower)) return hex;
  return null;
}

/** Only the two REAL signals -- an explicit override, or a colour word actually in the name. Null means "no evidence this is a distinct line." */
function resolveExplicitLineColor(name, cityConfig) {
  const explicit = cityConfig.railway?.lineColors?.[name];
  if (explicit != null) return explicit;
  return detectColorWord(name);
}

/** Full chain including the hash fallback -- only meaningful as a last resort when NOTHING in the whole feature set has an explicit signal to anchor on (see _buildRailway). */
function resolveLineColor(name, cityConfig) {
  const explicit = resolveExplicitLineColor(name, cityConfig);
  if (explicit != null) return explicit;
  const idx = Math.floor(buildingJitterFrac(name || 'unnamed-line') * FALLBACK_LINE_PALETTE.length);
  return FALLBACK_LINE_PALETTE[idx];
}

/**
 * One road class's material: MeshStandardMaterial plus a procedural
 * asphalt grain in world space.
 *
 * The class's grain scale/amount and roughness range are UNIFORMS, not
 * numbers written into the shader source. three.js caches compiled programs
 * by customProgramCacheKey and does not look at what onBeforeCompile wrote:
 * with the numbers baked into the source under one shared key, every class
 * silently reused the program of whichever class compiled first, so all
 * roads got that class's grain and roughness clamp (the intended hierarchy
 * -- glossy arterials, rough lanes -- was lost). As uniforms, the three
 * classes share ONE program and each material still carries its own values.
 * @param {'class0'|'class1'|'class2'} tier
 * @returns {THREE.MeshStandardMaterial}
 */
function createKmcRoadMaterial(tier) {
  const style = TIER_STYLE[tier];
  const mat = new THREE.MeshStandardMaterial({
    color: style.albedoDay, side: THREE.DoubleSide, roughness: style.roughness, metalness: style.metalness,
    emissive: 0x141414, emissiveIntensity: 0.18,
    polygonOffset: true, polygonOffsetFactor: style.polygonOffsetFactor, polygonOffsetUnits: style.polygonOffsetUnits,
  });
  // World-space procedural asphalt grain -- wrapped into a bounded 1000m
  // range before scaling so the hash's input stays small-magnitude (and
  // numerically stable) everywhere, however far a tile sits from ORIGIN.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uKmcRoadGrainScale = { value: style.grainScale };
    shader.uniforms.uKmcRoadGrainAmount = { value: style.grainAmount };
    // The noise may nudge roughness only a little either side of the class's own value, never into another class's look.
    shader.uniforms.uKmcRoadRoughnessRange = { value: new THREE.Vector2(Math.max(0, style.roughness - 0.06), Math.min(1, style.roughness + 0.06)) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vKmcRoadWorldPosition;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vKmcRoadWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vKmcRoadWorldPosition;\nuniform float uKmcRoadGrainScale;\nuniform float uKmcRoadGrainAmount;\nuniform vec2 uKmcRoadRoughnessRange;\nfloat kmcRoadGrain(vec2 p) {\n  p = fract(p * 0.1031);\n  p += dot(p, p.yx + 33.33);\n  return fract((p.x + p.y) * p.x);\n}\n')
      .replace('#include <color_fragment>', `#include <color_fragment>
      vec2 kmcRoadWrappedXz = mod(vKmcRoadWorldPosition.xz, 1000.0);
      vec2 kmcRoadUv = kmcRoadWrappedXz * uKmcRoadGrainScale;
      float kmcRoadNoise = (kmcRoadGrain(kmcRoadUv) - 0.5) * uKmcRoadGrainAmount;
      diffuseColor.rgb *= 1.0 + kmcRoadNoise;
    `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = clamp(roughnessFactor + kmcRoadNoise * 0.35, uKmcRoadRoughnessRange.x, uKmcRoadRoughnessRange.y);
    `);
  };
  // Same key for every class on purpose: the source is now identical for all three (see above). Bumped from v2 so the
  // key can never match a program compiled from the old, per-class source.
  mat.customProgramCacheKey = () => 'kmc-road-world-xz-v3';
  return mat;
}

export class RoadLayer {
  /** @param {THREE.Scene} scene @param {import('../config/city-schema.js').CityConfig} cityConfig */
  constructor(scene, cityConfig) {
    this.scene = scene;
    this.cityConfig = cityConfig;
    this.project = makeProjector(cityConfig.origin);
    this.class0Meshes = []; this.class1Meshes = []; this.class2Meshes = [];
    this.pickMeshes = [];
    this.railwaysHeavy = { mesh: null };
    this.metroLines = []; // [{ name, color, mesh }] -- one entry per distinct named metro/subway line

    // Tiles only (see the top of the file).
    this.streaming = false;
    this.tiles = [];             // every tile of both bands: { band, radius, url, bounds, state: 'none'|'loading'|'queued'|'bound', meshes, dist, outSince, retryAt }
    this.nameIndex = null;       // [{ name, x, z, rings }], one per road name -- what LabelLayer's search takes in place of the roads themselves
    this.onNeedsFrame = null;    // () => void -- more tile work is waiting, so the idle-gated render loop must run another frame
    this._tileMaterials = null;  // one material per class tier, shared by every tile's mesh of that tier
    this._baseUrl = null;
    this._bindQueue = [];
    this._inFlight = 0;
    this._camX = 0; this._camY = 0; this._camZ = 0; this._camT = null; // last updateTiles() camera sample, for its speed
  }

  /**
   * @param {object|null} roads role ROADS: a GeoJSON FeatureCollection, or a road-tiles manifest
   * @param {object|null} railwayFc role RAILWAY
   * @param {(done: number, total: number) => void} [onProgress]
   * @param {{x: number, y: number, z: number}} [camPos] where the camera starts -- with tiles, the ones that view needs are loaded before this resolves
   */
  async load(roads, railwayFc, onProgress, camPos) {
    if (roads?.format === 'road-tiles') await this._loadTiles(roads, onProgress, camPos);
    else if (roads) await this._buildKmcRoads(roads, onProgress);
    if (railwayFc) this._buildRailway(railwayFc);
  }

  // -----------------------------------------------------------------
  // Tiles
  // -----------------------------------------------------------------
  async _loadTiles(manifest, onProgress, camPos = { x: 0, y: 0, z: 0 }) {
    const [spec] = layersWithRole(this.cityConfig, LAYER_ROLES.ROADS);
    this._baseUrl = new URL('.', new URL(spec.url, window.location.href)).href;
    this.streaming = true;
    this._tileMaterials = Object.fromEntries(TIER_KEYS.map((tier) => [tier, createKmcRoadMaterial(tier)]));
    for (const [band, { tiles }] of Object.entries(manifest.bands)) {
      for (const t of tiles) this.tiles.push({ band, radius: BAND_RADIUS_M[band], url: t.url, bounds: t.bounds, state: 'none', meshes: [], dist: Infinity, outSince: null, retryAt: 0 });
    }

    const names = fetch(this._baseUrl + manifest.names).then((res) => (res.ok ? res.json() : [])).catch(() => []);

    // The tiles the opening view needs, behind the loading screen -- everything after that follows the camera (updateTiles).
    const first = this.tiles.filter((tile) => this._distance(tile, camPos) <= tile.radius);
    let done = 0, next = 0;
    onProgress?.(0, first.length);
    const worker = async () => {
      while (next < first.length) {
        const tile = first[next++];
        tile.state = 'loading';
        try {
          this._bind(tile, await this._fetchTile(tile));
        } catch (err) {
          tile.state = 'none';
          console.error(`[RoadLayer] road tile failed (${tile.url}):`, err);
        }
        onProgress?.(++done, first.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PRIME_CONCURRENCY, first.length) }, worker));
    this.nameIndex = await names;
    onProgress?.(1, 1);
    console.info(`[RoadLayer] road tiles: ${manifest.roads} roads in ${this.tiles.length} tiles, ${first.length} loaded for the opening view`);
  }

  async _fetchTile(tile) {
    const res = await fetch(this._baseUrl + tile.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  /** From a point to the nearest of a tile's roads' extent, in 3D -- the camera's height counts, as it does for building tiers. */
  _distance(tile, p) {
    const [minX, minZ, maxX, maxZ] = tile.bounds;
    return Math.hypot(Math.max(minX - p.x, 0, p.x - maxX), p.y, Math.max(minZ - p.z, 0, p.z - maxZ));
  }

  /**
   * Tiles only; called every drawn frame. Asks for the tiles that have come
   * within their band's radius (nearest first, a few at a time), lets go of
   * the ones that have been out of it for a while, and turns downloaded
   * tiles into meshes a few milliseconds' worth per frame.
   *
   * As with building tiers: `focusPos` is where a fly-to is heading, and
   * while there is one the tiles are chosen for that spot, so the roads are
   * there on arrival; and nothing new is asked for while the camera is
   * sweeping across the city faster than anyone can look at it.
   * @param {{x:number, y:number, z:number}} camPos
   * @param {{x:number, y:number, z:number}|null} [focusPos]
   */
  updateTiles(camPos, focusPos = null) {
    if (!this.streaming) return;
    const now = performance.now();
    let speed = 0;
    if (this._camT !== null && now > this._camT) speed = Math.hypot(camPos.x - this._camX, camPos.y - this._camY, camPos.z - this._camZ) / ((now - this._camT) / 1000);
    this._camX = camPos.x; this._camY = camPos.y; this._camZ = camPos.z; this._camT = now;
    const canAsk = focusPos !== null || speed <= BUILDING_TIER_MAX_UPGRADE_SPEED_MPS;
    const at = focusPos ?? camPos;

    let heldBack = false;
    const wanted = [];
    for (const tile of this.tiles) {
      tile.dist = this._distance(tile, at);
      if (tile.dist <= tile.radius + (tile.state === 'none' ? 0 : ROAD_TILE_HYSTERESIS_M)) {
        tile.outSince = null;
        if (tile.state === 'none' && now >= tile.retryAt) { if (canAsk) wanted.push(tile); else heldBack = true; }
      } else if (tile.state === 'bound') {
        tile.outSince ??= now;
        if (now - tile.outSince >= ROAD_TILE_EVICT_DELAY_MS) this._evict(tile);
      }
    }

    wanted.sort((a, b) => a.dist - b.dist);
    for (const tile of wanted) {
      if (this._inFlight >= ROAD_TILE_MAX_FETCHES) break;
      this._request(tile);
    }
    this._drainBindQueue();
    // The render loop is idle-gated: without this, tiles held back by the speed limit would wait for the next input.
    if (heldBack) this.onNeedsFrame?.();
  }

  _request(tile) {
    tile.state = 'loading';
    this._inFlight++;
    this._fetchTile(tile)
      .then((buf) => { tile.state = 'queued'; this._bindQueue.push({ tile, buf }); })
      .catch((err) => {
        tile.state = 'none';
        tile.retryAt = performance.now() + RETRY_AFTER_MS;
        console.error(`[RoadLayer] road tile failed (${tile.url}):`, err);
      })
      .finally(() => { this._inFlight--; this.onNeedsFrame?.(); });
  }

  _drainBindQueue() {
    if (!this._bindQueue.length) return;
    this._bindQueue.sort((a, b) => a.tile.dist - b.tile.dist);
    const t0 = performance.now();
    let built = 0;
    while (this._bindQueue.length && (built === 0 || performance.now() - t0 < ROAD_TILE_BIND_BUDGET_MS)) {
      const { tile, buf } = this._bindQueue.shift();
      if (tile.dist > tile.radius + ROAD_TILE_HYSTERESIS_M) { tile.state = 'none'; continue; } // the camera moved on while it was on its way
      this._bind(tile, buf);
      built++;
    }
    if (this._bindQueue.length) this.onNeedsFrame?.();
  }

  /** One downloaded tile into its meshes: one per class tier it holds, drawn with that tier's shared material. */
  _bind(tile, buf) {
    for (const t of decodeRoadTile(buf)) {
      const verts = t.xz.length / 2;
      const pos = new Float32Array(verts * 3), normal = new Float32Array(verts * 3);
      for (let i = 0; i < verts; i++) {
        pos[i * 3] = t.xz[i * 2]; pos[i * 3 + 1] = Y_KMC_ROAD; pos[i * 3 + 2] = t.xz[i * 2 + 1];
        normal[i * 3 + 1] = 1; // every triangle in a road tile is wound to face up (road-tile-builder.js)
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
      geo.setIndex(new THREE.BufferAttribute(t.index, 1));
      setKnownBounds(geo, [t.bounds[0], Y_KMC_ROAD, t.bounds[1], t.bounds[2], Y_KMC_ROAD, t.bounds[3]]);
      const tier = TIER_KEYS[t.tier];
      const m = new THREE.Mesh(geo, this._tileMaterials[tier]);
      m.renderOrder = TIER_STYLE[tier].renderOrder;
      m.userData.roadTile = t; // roadAtHit() finds the road a click landed on from its outline ranges
      this.scene.add(m);
      tile.meshes.push(m);
      this.pickMeshes.push(m);
    }
    tile.state = 'bound';
    tile.outSince = null;
  }

  _evict(tile) {
    const gone = new Set(tile.meshes);
    this.pickMeshes = this.pickMeshes.filter((m) => !gone.has(m));
    for (const m of tile.meshes) { this.scene.remove(m); m.geometry.dispose(); } // the material is shared: it stays
    tile.meshes = [];
    tile.state = 'none';
    tile.outSince = null;
  }

  /**
   * The road a click landed on, whichever way the roads arrived.
   * @param {THREE.Intersection} hit - from raycasting this layer's pickMeshes
   * @returns {{name: string, length_m: number|null, area_m2: number|null, ward_id: any, zone_id: any, class: number|null, flat: Float32Array, n: number}|null}
   *   `flat` is the road's outline, [x, z, ...], `n` its point count.
   */
  roadAtHit(hit) {
    const { roadMeta, roadTile } = hit.object.userData;
    if (roadMeta) return roadMeta[hit.object.geometry.attributes.roadId.getX(hit.faceIndex * 3)] ?? null;
    if (!roadTile) return null;
    // A road's vertices are its outline points, one run per road: the first road whose run ends past the hit vertex is it.
    const { end } = roadTile;
    let lo = 0, hi = end.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (end[mid] > hit.face.a) hi = mid; else lo = mid + 1;
    }
    const start = lo === 0 ? 0 : end[lo - 1];
    return {
      name: roadTile.names[lo] ?? '', class: roadTile.tier,
      length_m: roadTile.lengthM?.[lo] ?? null, area_m2: roadTile.areaM2?.[lo] ?? null, ward_id: roadTile.wardId?.[lo] ?? null, zone_id: roadTile.zoneId?.[lo] ?? null,
      flat: roadTile.xz.subarray(start * 2, end[lo] * 2), n: end[lo] - start,
    };
  }

  // -----------------------------------------------------------------
  // Whole
  // -----------------------------------------------------------------

  async _buildKmcRoads(fc, onProgress) {
    if (!fc?.features?.length) return;
    const tileSizeM = this.cityConfig.buildings.tileSizeM;
    const tiles = new Map();
    let skippedDegenerate = 0, splitPieces = 0;
    const features = fc.features;

    // PASS 1: every ring (already split from any MultiPolygon by collectRings)
    // gets ear-clipped once and bucketed by tile + tier.
    for (let fi = 0; fi < features.length; fi++) {
      const f = features[fi];
      const p = f.properties || {};
      const tier = kmcRoadTier(p.class);
      const rings = collectRings(f);
      if (rings.length > 1) splitPieces += rings.length - 1;

      for (const ring of rings) {
        const flat = projectRingFlat(ring, this.project);
        const n = flat.length / 2;
        if (n < 3) { skippedDegenerate++; continue; }

        let tris = [];
        const shapePts = new Array(n);
        for (let i = 0; i < n; i++) shapePts[i] = new THREE.Vector2(flat[i * 2], flat[i * 2 + 1]);
        try { tris = THREE.ShapeUtils.triangulateShape(shapePts, []); } catch { tris = []; }
        if (tris.length === 0) { skippedDegenerate++; continue; }

        const ix = Math.floor(flat[0] / tileSizeM), iz = Math.floor(flat[1] / tileSizeM);
        const key = `${ix},${iz}`;
        let bucket = tiles.get(key);
        if (!bucket) { bucket = { class0: [], class1: [], class2: [], class0VertCount: 0, class1VertCount: 0, class2VertCount: 0 }; tiles.set(key, bucket); }

        const arr = bucket[tier];
        arr.push({
          flat, n, tris, roadIndex: arr.length,
          meta: { name: p.name || '', length_m: p.length_m ?? null, area_m2: p.area_m2 ?? null, ward_id: p.ward_id ?? null, zone_id: p.zone_id ?? null, class: p.class ?? null, flat, n },
        });
        bucket[tier + 'VertCount'] += tris.length * 3;
      }

      if (onProgress && (fi & 1023) === 0) {
        onProgress(fi, features.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // PASS 2: one merged fill mesh per tile per class tier.
    const buildTierMesh = (records, vertCount, tier) => {
      if (vertCount === 0) return null;
      const pos = new Float32Array(vertCount * 3);
      const rid = new Float32Array(vertCount);
      const meta = [];
      let w = 0;
      for (const rec of records) {
        meta[rec.roadIndex] = rec.meta;
        for (const [ia, ib, ic] of rec.tris) {
          const pi = w * 3;
          pos[pi] = rec.flat[ia * 2]; pos[pi + 1] = Y_KMC_ROAD; pos[pi + 2] = rec.flat[ia * 2 + 1];
          pos[pi + 3] = rec.flat[ib * 2]; pos[pi + 4] = Y_KMC_ROAD; pos[pi + 5] = rec.flat[ib * 2 + 1];
          pos[pi + 6] = rec.flat[ic * 2]; pos[pi + 7] = Y_KMC_ROAD; pos[pi + 8] = rec.flat[ic * 2 + 1];
          rid[w] = rid[w + 1] = rid[w + 2] = rec.roadIndex;
          w += 3;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('roadId', new THREE.Float32BufferAttribute(rid, 1));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, createKmcRoadMaterial(tier));
      m.renderOrder = TIER_STYLE[tier].renderOrder;
      m.userData.roadMeta = meta;
      this.scene.add(m);
      return m;
    };

    // Pass 1 only yielded/reported progress every 1024 FEATURES -- once it
    // finishes, this second pass (merging every tile into GPU-ready
    // meshes, `computeVertexNormals()` included) used to run as one
    // uninterrupted block with no yield and no progress call at all. For
    // the real ~21k-feature KMC road file that's several seconds of a
    // fully frozen tab, with the loading text stuck on whatever Pass 1
    // last said ("Loading roads (20480/20943)") the entire time -- not
    // actually stalled, just silently blocking with nothing left to
    // report. Continuing the SAME done/total counter through this pass
    // (denominator grows once tiles.size is known) keeps the bar visibly
    // moving and the tab responsive, same yield-every-N pattern the
    // building worker already uses for its own tile pass.
    const totalUnits = features.length + tiles.size;
    let tileIndex = 0;
    for (const [, bucket] of tiles) {
      const m0 = buildTierMesh(bucket.class0, bucket.class0VertCount, 'class0');
      const m1 = buildTierMesh(bucket.class1, bucket.class1VertCount, 'class1');
      const m2 = buildTierMesh(bucket.class2, bucket.class2VertCount, 'class2');
      if (m0) { this.class0Meshes.push(m0); this.pickMeshes.push(m0); }
      if (m1) { this.class1Meshes.push(m1); this.pickMeshes.push(m1); }
      if (m2) { this.class2Meshes.push(m2); this.pickMeshes.push(m2); }

      tileIndex++;
      if (onProgress && (tileIndex % 8 === 0)) {
        onProgress(features.length + tileIndex, totalUnits);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    onProgress?.(totalUnits, totalUnits);
    console.info(`[RoadLayer] KMC roads: ${features.length} source features, ${splitPieces} MultiPolygon pieces split, ${skippedDegenerate} degenerate rings skipped, ${tiles.size} tiles`);
  }

  /** Heavy rail (OSM `railway` tag != 'subway') and metro (== 'subway') as simple ribbon+junction-fan meshes. */
  _buildRailway(fc) {
    const color = this.cityConfig.palette?.day?.rail ?? 0xa97456;
    const heavy = { type: 'FeatureCollection', features: fc.features.filter((f) => f.properties?.railway !== 'subway') };
    this.railwaysHeavy = this._buildRibbon(heavy, 2.2, color, Y_RAILWAY);
    // Metro gets Y_RAILWAY + 0.03 below, not this same Y_RAILWAY -- see
    // its own comment: a metro line crossing the at-grade heavy-rail
    // yard (Kanpur's Orange Line priority section is real-world elevated)
    // would otherwise be perfectly coplanar with the heavy-rail ribbon at
    // every crossing, z-fighting into a flickery dashed mess.

    // Group subway/metro ways by name, then colour by GENUINE signal only
    // (an explicit CityConfig override, or a colour word literally in the
    // name) -- NOT by unique name string. Real metro systems routinely
    // tag one physical line with more than one name across different
    // ways: Kanpur's OSM data has both "Orange Line" and "Line 1 – IIT
    // Kanpur to Naubasta" for what Wikipedia confirms is one single line
    // ("Orange Line (Line 1)... IIT Kanpur and Naubasta"). Treating every
    // unique NAME as a unique LINE conflated that OSM tagging variance
    // with actual route identity -- Line 1 was rendering as a second,
    // unrelated line. A name with no colour signal of its own (whether
    // truly unnamed, like depot spurs, or just descriptively named, like
    // "Line 1 – ...") is assumed to be the SAME line as whichever named
    // group DOES have a colour signal, rather than inventing one.
    const NO_NAME = Symbol('unnamed');
    const byName = new Map();
    for (const f of fc.features) {
      if (f.properties?.railway !== 'subway') continue;
      const name = f.properties?.name || NO_NAME;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(f);
    }

    const explicitColorByName = new Map();
    for (const name of byName.keys()) {
      if (name === NO_NAME) continue;
      const c = resolveExplicitLineColor(name, this.cityConfig);
      if (c != null) explicitColorByName.set(name, c);
    }
    // Dominant = largest colour-signalled group, by feature count -- what
    // everything with no signal of its own gets folded into.
    let dominantColor = null;
    if (explicitColorByName.size > 0) {
      const [bestName] = [...explicitColorByName.keys()].sort((a, b) => byName.get(b).length - byName.get(a).length);
      dominantColor = explicitColorByName.get(bestName);
    }

    this.metroLines = [];
    for (const [name, features] of byName) {
      const displayName = name === NO_NAME ? 'Unnamed Line' : name;
      // Only a name with its OWN explicit signal renders as a genuinely
      // distinct line; everything else -- including a real last-resort
      // hash colour -- only kicks in when NOTHING anywhere had a signal
      // to anchor on (so there's no dominant colour to fold into).
      const lineColor = explicitColorByName.has(name) ? explicitColorByName.get(name) : dominantColor ?? resolveLineColor(displayName, this.cityConfig);
      const { mesh } = this._buildRibbon({ type: 'FeatureCollection', features }, 2.2, lineColor, Y_RAILWAY + 0.03);
      if (mesh) this.metroLines.push({ name: displayName, color: lineColor, mesh });
    }
    console.info(`[RoadLayer] metro/subway: ${this.metroLines.length} line(s) — ${this.metroLines.map((l) => `${l.name} (#${l.color.toString(16).padStart(6, '0')})`).join(', ')}`);
  }

  _buildRibbon(fc, halfWidth, color, yOffset) {
    if (!fc) return { mesh: null };
    const JUNCTION_FAN_SIDES = 8;
    const roads = [];
    let totalVerts = 0;

    for (const f of fc.features) {
      if (f.geometry?.type !== 'LineString') continue;
      const flat = projectLineFlat(f.geometry.coordinates, this.project);
      const n = flat.length / 2;
      if (n < 2) continue;
      let segCount = 0;
      for (let i = 0; i < n - 1; i++) {
        if (Math.hypot(flat[(i + 1) * 2] - flat[i * 2], flat[(i + 1) * 2 + 1] - flat[i * 2 + 1]) >= 1e-6) segCount++;
      }
      roads.push({ flat, n });
      totalVerts += segCount * 6 + n * JUNCTION_FAN_SIDES * 3;
    }
    if (totalVerts === 0) return { mesh: null };

    const positions = new Float32Array(totalVerts * 3);
    let w = 0;
    for (const { flat, n } of roads) {
      for (let i = 0; i < n - 1; i++) {
        const x0 = flat[i * 2], z0 = flat[i * 2 + 1], x1 = flat[(i + 1) * 2], z1 = flat[(i + 1) * 2 + 1];
        const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const nx = (-dz / len) * halfWidth, nz = (dx / len) * halfWidth;
        const wi = w * 3;
        positions[wi] = x0 + nx; positions[wi + 1] = yOffset; positions[wi + 2] = z0 + nz;
        positions[wi + 3] = x0 - nx; positions[wi + 4] = yOffset; positions[wi + 5] = z0 - nz;
        positions[wi + 6] = x1 - nx; positions[wi + 7] = yOffset; positions[wi + 8] = z1 - nz;
        positions[wi + 9] = x0 + nx; positions[wi + 10] = yOffset; positions[wi + 11] = z0 + nz;
        positions[wi + 12] = x1 - nx; positions[wi + 13] = yOffset; positions[wi + 14] = z1 - nz;
        positions[wi + 15] = x1 + nx; positions[wi + 16] = yOffset; positions[wi + 17] = z1 + nz;
        w += 6;
      }
      for (let i = 0; i < n; i++) {
        const px = flat[i * 2], pz = flat[i * 2 + 1];
        for (let s = 0; s < JUNCTION_FAN_SIDES; s++) {
          const a0 = (s / JUNCTION_FAN_SIDES) * Math.PI * 2, a1 = ((s + 1) / JUNCTION_FAN_SIDES) * Math.PI * 2;
          const wi = w * 3;
          positions[wi] = px; positions[wi + 1] = yOffset; positions[wi + 2] = pz;
          positions[wi + 3] = px + Math.cos(a0) * halfWidth; positions[wi + 4] = yOffset; positions[wi + 5] = pz + Math.sin(a0) * halfWidth;
          positions[wi + 6] = px + Math.cos(a1) * halfWidth; positions[wi + 7] = yOffset; positions[wi + 8] = pz + Math.sin(a1) * halfWidth;
          w += 3;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    this.scene.add(mesh);
    return { mesh };
  }

  /** Called by PaletteController on every day/night or wet-weather repaint. */
  repaint(palette, isNight, wetFactor = 1.0) {
    const em = isNight ? ROAD_EMISSIVE_NIGHT : ROAD_EMISSIVE_DAY;
    for (const [tier, meshes] of Object.entries({ class0: this.class0Meshes, class1: this.class1Meshes, class2: this.class2Meshes })) {
      const style = TIER_STYLE[tier];
      const base = isNight ? style.albedoNight : style.albedoDay;
      // Whole: every mesh has its own material. Tiles: one material per tier, shared.
      for (const material of [...meshes.map((mesh) => mesh.material), ...(this._tileMaterials ? [this._tileMaterials[tier]] : [])]) {
        material.color.setHex(darkenHex(THREE, base, wetFactor));
        material.emissive.setHex(em.hex);
        material.emissiveIntensity = em.intensity;
      }
    }
    if (this.railwaysHeavy.mesh) this.railwaysHeavy.mesh.material.color.setHex(palette.rail);
  }
}
