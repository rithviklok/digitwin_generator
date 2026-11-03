// ===================================================================
// BuildingLayer — two loading paths, chosen by what the buildings-3d
// layer's URL points at:
//
//   STREAMING (url ends in "manifest.json", from scripts/build-building-tiles.mjs):
//   fetches the small manifest at boot, then streams each tile's
//   geometry in by camera distance (see updateTiers()), swapping/
//   evicting tiers as the camera moves instead of loading the whole
//   city upfront. Two things come of it: only a few tiles' worth of
//   detailed geometry is resident at once, at whatever detail their
//   distance calls for, and a visitor only downloads the tiles near
//   where they actually looked (Kanpur's raw buildings file is 280MB).
//
//   LEGACY (any other url, e.g. a raw .geojson): fetch + worker +
//   triangulate the whole city upfront (workers/building-worker.js).
//   It keeps a CityConfig that hasn't been through the offline build
//   script working, with no tiles at all.
// ===================================================================
import * as THREE from 'three';
import { BuildingWorkerCmd, BuildingWorkerMsg } from '../workers/building-protocol.js';
import { decodeTilePayload } from '../workers/tile-binary-format.js';
import { layersWithRole, LAYER_ROLES } from '../config/city-schema.js';
import { setKnownBounds } from './known-bounds.js';
import { BuildingMetaTable } from './building-meta.js';
import {
  BUILDING_HIDE_ABOVE_HEIGHT, BUILDING_TIER_HYSTERESIS_M, BUILDING_TIER_PREFETCH_HEIGHT_M,
  BUILDING_TIER_DOWNGRADE_DELAY_MS, BUILDING_TIER_MAX_RESIDENT,
  BUILDING_TIER_MAX_UPGRADE_SPEED_MPS, BUILDING_TIER_BIND_BUDGET_MS, BUILDING_COARSE_MAX_FETCHES, FOG_FAR_FOR_LOD,
} from '../config/constants.js';

/**
 * @typedef {'coarse'|'medium'|'full'} TierName
 *
 * @typedef {Object} ManifestTierEntry  One tier of one tile, as manifest.json lists it.
 * @property {string} url                         relative to manifest.json's own folder
 * @property {number} byteSize
 * @property {number} triCount
 * @property {Record<string, number[]>} [bounds]  mesh role -> its exact [minX, minY, minZ, maxX, maxY, maxZ] (older manifests lack it)
 *
 * @typedef {Object} BuildingTile  One tile as this layer tracks it. Legacy-path tiles only have the first four fields.
 * @property {number} centerX                     scene metres
 * @property {number} centerZ
 * @property {THREE.Object3D[]} meshes            what is in the scene for this tile right now
 * @property {number} opacity                     set every frame by TwinEngine's updateBuildingLOD() (0 = hidden)
 * @property {number} [ix]                        streaming: grid column / row
 * @property {number} [iz]
 * @property {Record<TierName, ManifestTierEntry>} [tiers]
 * @property {TierName|null} [boundTier]          the tier `meshes` currently is (null: nothing loaded)
 * @property {TierName|null} [wantedTier]         the tier last requested -- checked when a fetch lands, to drop stale results
 * @property {TierName|null} [lodTier]            the tier updateTiers() decided it should hold
 * @property {Promise<void>|null} [pendingFetch]
 * @property {boolean} [_queued]                  fetched, waiting in the build queue
 * @property {number} [_lodDist]                  last distance updateTiers() measured, for nearest-first ordering
 * @property {number|null} [_downSince]           since when a lower tier has been wanted (downgrades wait)
 * @property {number} [_retryAt]                  performance.now() before which a failed download isn't asked for again
 * @property {THREE.Object3D[]|null} [coarseMeshes] the permanent coarse floor, kept once built
 * @property {THREE.Mesh|null} [_shadowMesh]      ShadowLayer's mesh for this tile
 */

const TIER_RANK = { coarse: 0, medium: 1, full: 2 };
/** A tile holding nothing at all (a large city's tile far from the camera, see coarseOnDemand) ranks below coarse. @param {TierName|null} tier */
const rankOf = (tier) => (tier === null ? -1 : TIER_RANK[tier]);

/**
 * A tile whose download or build failed is left alone this long before it is
 * asked for again. Without a pause, updateTiers() re-requested it on every
 * rendered frame -- dozens of failing requests a second per tile while the
 * camera moved, when the server was down or one file was missing.
 * (RoadLayer's tiles wait the same way.)
 */
const TILE_RETRY_AFTER_MS = 10_000;

/**
 * Which tier a tile should hold, from its distance `d` to the camera.
 * `prev` is the tier it wanted last frame: a tile already at a higher tier
 * keeps it until `d` passes the threshold by `hyst` more, so a camera
 * hovering on a boundary doesn't flip it (and re-fetch it) every frame.
 */
function pickTier(prev, d, fullIn, mediumIn, hyst) {
  if (d <= (prev === 'full' ? fullIn + hyst : fullIn)) return 'full';
  if (d <= (prev !== 'coarse' ? mediumIn + hyst : mediumIn)) return 'medium';
  return 'coarse';
}

const googleWallMaterial = new THREE.MeshLambertMaterial({ color: 0xf5ebde, side: THREE.DoubleSide, vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const googleRoofMaterial = new THREE.MeshLambertMaterial({ color: 0xfdfcfc, side: THREE.DoubleSide, vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x6b6257 });

// One tiny shared window-cell texture, tiled by wall size in world metres
// via the UV attribute building-worker.js already baked in (WINDOW_TILE_M,
// see workers/building-style.js). Drawing it is genuinely a
// browser-only concern (canvas), so it lives here on the main thread.
function createWindowTexture() {
  const size = 64;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = size;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#ffffff'; // near-white -- close to a no-op multiply against the material's own palette color
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#8d95a0'; // darker inset -- reads as a window recess, no gloss/reflection (flat, no-shadow style)
  const margin = size * 0.18;
  ctx.fillRect(margin, margin, size - margin * 2, size - margin * 2);
  const tex = new THREE.CanvasTexture(cnv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const SHARED_WINDOW_TEXTURE = createWindowTexture();
const googleWindowWallMaterial = googleWallMaterial.clone();
googleWindowWallMaterial.map = SHARED_WINDOW_TEXTURE;
googleWindowWallMaterial.needsUpdate = true;

export class BuildingLayer {
  /** @param {THREE.Scene} scene @param {import('../config/city-schema.js').CityConfig} cityConfig */
  constructor(scene, cityConfig) {
    this.scene = scene;
    this.cityConfig = cityConfig;
    /** @type {BuildingTile[]} every tile; legacy tiles carry only the fields updateBuildingLOD() reads */
    this.tileRecords = [];
    /** @type {THREE.Object3D[]} meshes a click may hit (outlines excluded) */
    this.pickMeshes = [];
    this.worker = null;
    this.onProgress = null;      // (done, total) => void
    this.onDone = null;          // (stats) => void
    this.onTileTierBound = null;   // streaming only: (tile, tier) => void -- ShadowLayer's per-tile bake hook
    this.onTileTierEvicted = null; // streaming only: (tile) => void -- ShadowLayer's per-tile evict hook
    this.streaming = false;
    this.manifestRadii = null;   // streaming only: { fullRadiusM, mediumRadiusM, coarseRadiusM }
    // Streaming only. False: every tile holds at least its coarse tier, always (the whole city's coarse tier is loaded at
    // boot). True, for a city too large for that: a tile holds something only while the camera is within _coarseReachM
    // of it. See _loadStreaming() for which a city gets.
    this.coarseOnDemand = false;
    this._coarseReachM = Infinity;
    this._fetching = 0;          // tile downloads in flight (what BUILDING_COARSE_MAX_FETCHES limits)
    this._baseUrl = null;
    // The grid the tiles were baked on: the manifest's own value once it is
    // read (it is what the tile files were cut to), the CityConfig's before.
    this._tileSizeM = cityConfig.buildings.tileSizeM;
    this._legacyFinished = false; // legacy path: onDone has been called (exactly once, success or failure)
    this.primedTileCount = 0;     // streaming: tiles whose coarse tier boot loads (all of them, or a large city's opening view)
    // Streaming tier-selection tuning -- see updateTiers(). A plain object (not
    // read straight from the constants at use time) so it can be tuned live.
    this.lodConfig = {
      hysteresisM: BUILDING_TIER_HYSTERESIS_M, prefetchHeightM: BUILDING_TIER_PREFETCH_HEIGHT_M,
      downgradeDelayMs: BUILDING_TIER_DOWNGRADE_DELAY_MS, maxResident: BUILDING_TIER_MAX_RESIDENT,
      maxUpgradeSpeedMps: BUILDING_TIER_MAX_UPGRADE_SPEED_MPS, bindBudgetMs: BUILDING_TIER_BIND_BUDGET_MS,
    };
    this._tiersActive = false;
    this._camX = 0; this._camY = 0; this._camZ = 0; this._camT = null; // last updateTiers() camera sample, for its speed
    this._bindQueue = [];        // streaming: fetched tiers waiting to be built, see _drainBindQueue()
    this.onNeedsFrame = null;    // streaming: () => void -- more queued work, so the idle-gated render loop must run another frame
    this.onTileEvent = null;     // streaming, optional (the ?perf probe): (kind: 'request'|'body'|'bind', tile, tier, value) => void
    this._glow = null;           // night floodlight glow ({wall, roof} emissive intensities) or null by day -- see setGlow()
  }

  /** Side of one building tile, in metres -- what every per-tile distance and visibility test must use, not a global constant. */
  get tileSizeM() { return this._tileSizeM; }

  /** @param {{x: number, z: number}} [camPos] where the camera starts -- a large city loads only the tiles around it (coarseOnDemand) */
  load(camPos = { x: 0, z: 0 }) {
    this._bootX = camPos.x; this._bootZ = camPos.z;
    const [spec] = layersWithRole(this.cityConfig, LAYER_ROLES.BUILDINGS_3D);
    if (!spec) throw new Error(`BuildingLayer: city "${this.cityConfig.id}" declares no buildings-3d layer`);

    // Naming convention (not content-sniffing): scripts/build-building-tiles.mjs
    // always names its output "manifest.json". Deciding this from the URL
    // alone means a CityConfig that hasn't been through that script --
    // still pointing at a raw .geojson, like every third-party config
    // nobody's migrated yet -- never even attempts a manifest fetch, let
    // alone accidentally downloads a huge raw file just to inspect its shape.
    if (spec.url.endsWith('manifest.json')) this._loadStreaming(spec);
    else this._loadLegacyWorker(spec);
  }

  // -----------------------------------------------------------------
  // Streaming path
  // -----------------------------------------------------------------
  async _loadStreaming(spec) {
    const manifestUrl = new URL(spec.url, window.location.href).href;
    let manifest;
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`);
      manifest = await res.json();
    } catch (err) {
      console.error(`[BuildingLayer] streaming manifest fetch failed (${manifestUrl}):`, err);
      // The URL naming convention got us into streaming mode, but the file
      // that promise depends on turned out not to be reachable (deleted,
      // network hiccup, whatever) -- fall back to the raw source via
      // sourceUrl if this layer spec carries one (see city-schema.js), the
      // same safety net a not-yet-migrated CityConfig gets automatically.
      // Only truly out of options if sourceUrl was never configured either.
      if (spec.sourceUrl) {
        console.warn('[BuildingLayer] falling back to legacy worker via sourceUrl');
        this._loadLegacyWorker({ ...spec, url: spec.sourceUrl });
      } else {
        this.onDone?.({ tileCount: 0, streaming: true, failed: true });
      }
      return;
    }

    this.streaming = true;
    this.manifestRadii = manifest.radii;
    if (Number.isFinite(manifest.tileSizeM) && manifest.tileSizeM > 0) this._tileSizeM = manifest.tileSizeM;
    if (manifest.radiusMetric !== 'nearest-edge') {
      console.warn('[BuildingLayer] manifest radii were measured to tile centres (no radiusMetric); updateTiers() measures to the nearest edge, so full/medium will reach further than intended. Run: node scripts/build-building-tiles.mjs --city <id> --radii-only');
    }
    if (!manifest.tiles?.[0]?.tiers?.coarse?.bounds) {
      console.warn('[BuildingLayer] manifest has no per-mesh bounding boxes (tiers.<tier>.bounds); three.js will loop over every vertex of every mesh to compute them -- ~24x slower with the JS JIT disabled (boot ~12 s instead of ~9 s, 400 ms stalls per large tile). Run: node scripts/build-building-tiles.mjs --city <id> --bounds-only');
    }
    this._baseUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);

    this.tileRecords = manifest.tiles.map((t) => ({
      centerX: t.centerX, centerZ: t.centerZ, ix: t.ix, iz: t.iz,
      tiers: t.tiers,
      boundTier: null, wantedTier: null, pendingFetch: null, _queued: false,
      lodTier: 'coarse', _lodDist: Infinity, _downSince: null, // updateTiers() state: the tier held (null: nothing), its last distance, and since when a lower one has been wanted
      meshes: [], coarseMeshes: null, opacity: 0, // coarseMeshes: the permanent floor, kept resident once built (hidden while a higher tier shows)
    }));

    // Can the whole city's coarse tier be held at once? The build answers
    // that already: coarseRadiusM is how far coarse tiles may be DRAWN
    // within the triangle budget, and its search stops at the extent's
    // diagonal, where the radius takes in every tile (scripts/tier-radii.mjs).
    // So a coarse radius that reaches the diagonal means the whole city fits
    // -- Kanpur: 35.4 km for a 35.4 km extent, 176 MB -- and it is all loaded
    // at boot, as it always was. One that falls short means it can never all
    // be drawn anyway, so holding it all would be pure cost: a Delhi-sized
    // city is 1,149 tiles and 1.47 GB of coarse tier, with a coarse radius of
    // 11.7 km. Such a city holds a tile only while the camera is within reach
    // of it: the distance buildings can be drawn at (TwinEngine's
    // updateBuildingLOD()), plus one tile so it is there before it shows.
    const tileSizeM = this._tileSizeM;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const t of this.tileRecords) {
      minX = Math.min(minX, t.centerX); maxX = Math.max(maxX, t.centerX);
      minZ = Math.min(minZ, t.centerZ); maxZ = Math.max(maxZ, t.centerZ);
    }
    const extentDiagonalM = Math.hypot(maxX - minX + tileSizeM, maxZ - minZ + tileSizeM);
    this.coarseOnDemand = manifest.radii.coarseRadiusM < extentDiagonalM;
    this._coarseReachM = Math.min(FOG_FAR_FOR_LOD, manifest.radii.coarseRadiusM) + tileSizeM;
    const first = this.coarseOnDemand
      ? this.tileRecords.filter((t) => Math.hypot(this._bootX - t.centerX, this._bootZ - t.centerZ) <= this._coarseReachM)
      : this.tileRecords;
    this.primedTileCount = first.length; // read by the ?perf probe, to know when boot priming is done
    if (this.coarseOnDemand) {
      const opening = new Set(first);
      for (const t of this.tileRecords) if (!opening.has(t)) t.lodTier = null;
      console.info(`[BuildingLayer] large city: ${first.length} of ${this.tileRecords.length} tiles loaded for the opening view, the rest as the camera nears them`);
    }

    // Eagerly fetch + bind the CHEAP coarse tier of these tiles before
    // boot() considers buildings "done" -- a bounded download (Kanpur,
    // every tile: ~176MB, less than its single 280MB raw file) that
    // guarantees each has SOME geometry resident the instant the loading
    // screen hides, so a fresh area never reads as "nothing there" for a
    // moment. updateTiers() takes it from there: upgrading to medium/full
    // as the camera approaches and downgrading back to coarse as it
    // leaves (a large city lets a tile go altogether once it is out of
    // reach). That's what keeps per-visitor download small AND keeps the
    // render-time triangle budget bounded -- the whole point of the
    // tiered pipeline.
    await this._primeCoarseBaseline(first);
    this.onDone?.({ tileCount: this.tileRecords.length, streaming: true });
  }

  /**
   * Compiles every shader program a building tile can need -- walls, the
   * textured windowed walls, roofs, outlines, and the shadow shader --
   * while the loading screen is still up. Only the coarse tier is built at
   * boot, so without this the windowed-wall / outline / shadow programs
   * first compile the moment a medium or full tile is first drawn, i.e.
   * exactly as you arrive somewhere: measured as several 100-180 ms
   * stalls in a row. One throwaway mesh per material variant is compiled
   * against the REAL scene (same lights, fog) so the programs it caches
   * are the ones real tiles then reuse, and is discarded.
   * @param {THREE.WebGLRenderer} renderer @param {THREE.Camera} camera @param {THREE.ShaderMaterial} shadowMaterial ShadowLayer's shared material
   */
  warmShaders(renderer, camera, shadowMaterial) {
    const geo = (attrs) => {
      const g = new THREE.BufferGeometry();
      for (const [name, size] of attrs) g.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(3 * size), size));
      return g;
    };
    const wallAttrs = [['position', 3], ['color', 3], ['buildingId', 1], ['normal', 3]];
    const geometries = [geo(wallAttrs), geo([...wallAttrs, ['uv', 2]]), geo([['position', 3]]), geo([['position', 3], ['aSlide', 1]])];
    const [wallG, windowG, lineG, shadowG] = geometries;
    const solid = (baseMat) => { const m = baseMat.clone(); m.transparent = true; m.opacity = 0; return m; }; // exactly what _makeMesh gives a real tile
    const materials = [solid(googleWallMaterial), solid(googleWindowWallMaterial), solid(googleRoofMaterial), outlineMaterial.clone()];
    materials[3].transparent = true; materials[3].opacity = 0;

    const warm = new THREE.Scene();
    warm.add(new THREE.Mesh(wallG, materials[0]));
    warm.add(new THREE.Mesh(windowG, materials[1]));
    warm.add(new THREE.Mesh(wallG, materials[2]));
    warm.add(new THREE.LineSegments(lineG, materials[3]));
    if (shadowMaterial) warm.add(new THREE.Mesh(shadowG, shadowMaterial));

    renderer.compile(warm, camera, this.scene);
    // Deliberately NOT disposed. three.js reference-counts a compiled program
    // by the materials using it and destroys it when the count hits zero, so
    // disposing these here would throw the programs straight back out. Keeping
    // them (a few tiny objects) also stops a program being destroyed -- and
    // recompiled as a hitch -- later, whenever every real tile using a variant
    // (say the windowed walls) happens to be unloaded at once.
    this._warm = { geometries, materials };
  }

  /**
   * Fetches + binds the 'coarse' tier of `tiles` (every tile, or a large city's opening ones) with bounded concurrency, reporting (done, total) as each one lands.
   * @param {BuildingTile[]} tiles
   */
  async _primeCoarseBaseline(tiles) {
    const total = tiles.length;
    if (total === 0) return;
    let done = 0;
    this.onProgress?.(0, total);
    const CONCURRENCY = 8;
    let next = 0;
    const runWorker = async () => {
      while (next < tiles.length) {
        const tile = tiles[next++];
        await this._fetchAndBindTier(tile, 'coarse');
        done++;
        this.onProgress?.(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, runWorker));
  }

  /**
   * Fetch+decode+bind for one tile's tier, used only by the coarse-priming
   * pass above -- unlike ensureTier() below, this has no staleness check
   * against a since-changed wantedTier, which is fine here: nothing else
   * is requesting a DIFFERENT tier for a tile while priming still owns it
   * (boot() hasn't resolved yet, so the camera-driven LOD loop hasn't run).
   */
  /** @param {BuildingTile} tile @param {TierName} tier */
  async _fetchAndBindTier(tile, tier) {
    const tierInfo = tile.tiers?.[tier];
    if (!tierInfo) return;
    const url = this._baseUrl + tierInfo.url;
    try {
      const res = await fetch(url);
      // An error page decoded as a tile fails deep in the decoder with a
      // misleading message (and Vite's dev server answers a missing file
      // with index.html and a 200, so check the status explicitly).
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      this._bindTier(tile, tier, decodeTilePayload(buf));
    } catch (err) {
      this._noteTileFailure(tile, url, err);
    }
  }

  /**
   * A tile's download or build failed: say so once, and keep it from being
   * asked for again for TILE_RETRY_AFTER_MS. A frame is requested for when
   * that pause ends, because the render loop is idle-gated -- with the camera
   * still, nothing else would ever run updateTiers() to try again.
   * @param {BuildingTile} tile @param {string} url @param {unknown} err
   */
  _noteTileFailure(tile, url, err) {
    tile._retryAt = performance.now() + TILE_RETRY_AFTER_MS;
    console.error(`[BuildingLayer] tile failed (${url}); trying again in ${TILE_RETRY_AFTER_MS / 1000} s:`, err);
    setTimeout(() => this.onNeedsFrame?.(), TILE_RETRY_AFTER_MS);
  }

  /**
   * Streaming only; called every dirty frame by updateBuildingLOD(). Picks
   * every tile's tier and requests any change, nearest tile first.
   *
   * The distance is from the camera, in 3D (x, y, z), to the nearest point of
   * the tile's box -- so a camera sitting between two tiles counts as close to
   * both, instead of judging each by a centre that can be a whole tile-width
   * away from the buildings you're actually looking at. It deliberately
   * ignores the view frustum: the frustum decides what is DRAWN (see
   * TwinEngine.updateBuildingLOD), while this decides what is LOADED, so
   * tiles behind you stay at full detail and rotating never has to wait on
   * a fetch. A tile is upgraded as soon as it's inside its tier's radius
   * (from the manifest) and downgraded `hysteresisM` beyond it -- and, since
   * a camera orbiting or panning back and forth swings further than any
   * sensible margin, only once it has wanted the lower tier for
   * `downgradeDelayMs`. Upgrades are never delayed (bar the fly-over rule
   * below). At most `maxResident` tiles are held above coarse; past that the
   * farthest drop back at once -- which costs nothing, since a tile keeps its
   * coarse geometry resident (see _bindTier) and falls back to it.
   *
   * No NEW upgrade is started while the camera is moving faster than
   * `maxUpgradeSpeedMps`. A fly-to (search) sweeps across the city at 10+
   * km/s, and without this every tile it passes over was fetched and built
   * for a fraction of a second of use: measured, one fly-to across town
   * pulled ~45 tiles / 390 MB and stuttered for ~2.5 s. Only the destination
   * matters, and upgrades resume the moment the camera eases down.
   *
   * Tiles that finish loading are built a few at a time (see
   * _drainBindQueue), so a burst of arrivals is smooth frames, not one stall.
   *
   * Above HIDE_ABOVE_HEIGHT + prefetchHeightM the buildings are hidden and
   * far from the ground, so everything just holds the coarse floor.
   *
   * In a large city (coarseOnDemand) the floor itself follows the camera: a
   * tile further than _coarseReachM from it, over the ground, holds nothing
   * (tier null), and is let go after the same delay as any other step down.
   * Tiles that hold nothing yet are downloaded a few at a time, nearest first.
   *
   * `focusPos` is where the camera is GOING (a fly-to's destination). While
   * it is given, tiers are chosen for that spot instead of the camera's current
   * one, and the speed limit does not apply: the destination's tiles start
   * loading the moment the flight starts, so they are there on arrival. Without
   * this they only began loading on arrival, and since the coarse tier (flat
   * roofs, no walls) is nearly invisible against the ground up close, the
   * screen showed roads only for 1-3 s and then every building at once.
   * @param {{x:number, y:number, z:number}} camPos
   * @param {{x:number, y:number, z:number}|null} [focusPos]
   */
  updateTiers(camPos, focusPos = null) {
    if (!this.streaming || !this.manifestRadii) return;
    const { hysteresisM, prefetchHeightM, downgradeDelayMs, maxResident, maxUpgradeSpeedMps } = this.lodConfig;
    const fullIn = this.manifestRadii.fullRadiusM;
    const mediumIn = this.manifestRadii.mediumRadiusM;
    const tileSizeM = this._tileSizeM;
    const half = tileSizeM / 2;
    const now = performance.now();

    let speed = 0; // metres/second since the previous call
    if (this._camT !== null && now > this._camT) {
      speed = Math.hypot(camPos.x - this._camX, camPos.y - this._camY, camPos.z - this._camZ) / ((now - this._camT) / 1000);
    }
    this._camX = camPos.x; this._camY = camPos.y; this._camZ = camPos.z; this._camT = now;
    const canUpgrade = focusPos !== null || speed <= maxUpgradeSpeedMps;
    const at = focusPos ?? camPos; // where tiers are planned for

    const gate = BUILDING_HIDE_ABOVE_HEIGHT + prefetchHeightM;
    if (at.y < gate) this._tiersActive = true;
    else if (at.y > gate + hysteresisM) this._tiersActive = false;

    let suppressed = false; // an upgrade was held back by the speed limit
    const held = [];
    for (const tile of this.tileRecords) {
      let want = 'coarse', d = Infinity;
      if (this.coarseOnDemand) {
        d = Math.hypot(at.x - tile.centerX, at.z - tile.centerZ); // over the ground, to the centre: what updateBuildingLOD() draws by
        if (d > this._coarseReachM + (tile.lodTier === null ? 0 : tileSizeM)) want = null; // a tile already held is kept one tile further out
      }
      if (want !== null && this._tiersActive) {
        const ex = Math.max(Math.abs(at.x - tile.centerX) - half, 0);
        const ez = Math.max(Math.abs(at.z - tile.centerZ) - half, 0);
        d = Math.hypot(ex, at.y, ez);
        want = pickTier(tile.lodTier ?? 'coarse', d, fullIn, mediumIn, hysteresisM);
      }
      if (!canUpgrade && rankOf(want) > rankOf(tile.lodTier)) { want = tile.lodTier; suppressed = true; }
      tile._lodDist = d;
      if (rankOf(want) >= rankOf(tile.lodTier)) {
        tile.lodTier = want;
        tile._downSince = null;
      } else {
        tile._downSince ??= now;
        if (now - tile._downSince >= downgradeDelayMs) { tile.lodTier = want; tile._downSince = null; }
      }
      if (rankOf(tile.lodTier) > TIER_RANK.coarse) held.push(tile);
    }

    if (held.length > maxResident) {
      held.sort((a, b) => b._lodDist - a._lodDist); // farthest first
      for (let i = 0; i < held.length - maxResident; i++) { held[i].lodTier = 'coarse'; held[i]._downSince = null; }
    }

    const changes = this.tileRecords.filter((t) => t.boundTier !== t.lodTier || t.wantedTier !== t.lodTier);
    changes.sort((a, b) => a._lodDist - b._lodDist); // nearest first: they're the ones about to be seen
    for (const t of changes) {
      // A tile that holds nothing is a download from scratch, and arriving somewhere new in a large city wants a hundred
      // of them: a few at a time, so the nearest are not queued behind the rest. (Each one landing asks for another frame.)
      if (t.boundTier === null && t.lodTier !== null && !t.pendingFetch && !t._queued && this._fetching >= BUILDING_COARSE_MAX_FETCHES) continue;
      this.ensureTier(t, t.lodTier);
    }

    this._drainBindQueue();
    // The render loop is idle-gated: if the camera stops right after a fast
    // move, no further frame would ever lift the speed limit and those
    // upgrades would be stranded until the next input. Ask for one more
    // frame; by then the camera has (almost always) slowed and it passes.
    if (suppressed) this.onNeedsFrame?.();
  }

  /**
   * Builds fetched tiles into meshes, nearest first, until about
   * `bindBudgetMs` of main-thread time is spent (always at least one, so a
   * single heavy tile still gets through). Each build is a decode plus mesh
   * construction plus shadow bake, and the GPU upload lands on the next
   * draw -- done for a dozen tiles at once that's one long stall; spread
   * over frames it's not noticeable. If work is left, asks for another frame.
   */
  _drainBindQueue() {
    if (!this._bindQueue.length) return;
    this._bindQueue.sort((a, b) => a.tile._lodDist - b.tile._lodDist);
    const t0 = performance.now();
    let built = 0;
    while (this._bindQueue.length && (built === 0 || performance.now() - t0 < this.lodConfig.bindBudgetMs)) {
      const { tile, tier, buf } = this._bindQueue.shift();
      tile._queued = false;
      if (tile.wantedTier !== tier) { this.ensureTier(tile, tile.wantedTier); continue; } // the camera moved on while it waited
      // This runs inside the render loop: a damaged file must cost one tile,
      // not throw out of the frame (which skipped the render, and then did it
      // again on every later frame as the tile was re-requested).
      try {
        this._bindTier(tile, tier, decodeTilePayload(buf));
      } catch (err) {
        this._noteTileFailure(tile, `${tier} tile ${tile.ix},${tile.iz}`, err);
      }
      built++;
    }
    if (this._bindQueue.length) this.onNeedsFrame?.();
  }

  /**
   * Requests one tile's tier. No-ops if already correct; otherwise
   * fetches+decodes+builds that tier's meshes and swaps them in, or
   * evicts entirely if desiredTier is null. Streaming callers go through
   * updateTiers(), which picks the tier.
   * @param {BuildingTile} tile @param {TierName|null} desiredTier
   */
  ensureTier(tile, desiredTier) {
    tile.wantedTier = desiredTier; // staleness marker checked when an in-flight fetch resolves

    if (desiredTier === null) {
      if (tile.boundTier !== null) this._evictTile(tile);
      return;
    }
    if (tile.boundTier === desiredTier) return;
    // Falling back to coarse never needs the network: its geometry is kept.
    if (desiredTier === 'coarse' && tile.coarseMeshes) { this._restoreCoarse(tile); return; }
    if (tile.pendingFetch || tile._queued) return; // already fetching/waiting to be built; that resolution re-checks wantedTier
    if (tile._retryAt && performance.now() < tile._retryAt) return; // failed recently -- see TILE_RETRY_AFTER_MS

    const tierInfo = tile.tiers?.[desiredTier];
    if (!tierInfo) return; // defensive -- every real tile has all 3 tiers

    const url = this._baseUrl + tierInfo.url;
    this.onTileEvent?.('request', tile, desiredTier, 0);
    this._fetching++;
    tile.pendingFetch = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`); // see _fetchAndBindTier
        return res.arrayBuffer();
      })
      .then((buf) => {
        this.onTileEvent?.('body', tile, desiredTier, buf.byteLength);
        tile.pendingFetch = null;
        tile._retryAt = 0;
        if (tile.wantedTier !== desiredTier) {
          // Stale by the time this resolved (camera moved on) -- chase
          // whatever's actually wanted now instead of binding dead geometry.
          this.ensureTier(tile, tile.wantedTier);
          return;
        }
        // Not built here: queued, then built a few per frame by _drainBindQueue().
        tile._queued = true;
        this._bindQueue.push({ tile, tier: desiredTier, buf });
        this.onNeedsFrame?.();
      })
      .catch((err) => {
        tile.pendingFetch = null;
        this._noteTileFailure(tile, url, err);
      })
      // Counted down exactly once whichever way it went (decrementing in both
      // handlers above double-counted when the success handler itself threw).
      .finally(() => { this._fetching--; });
  }

  /**
   * Stop showing `meshes` for `tile`. The coarse set is only hidden -- it is
   * the permanent floor a tile falls back to for free -- everything else is
   * disposed.
   * @param {BuildingTile} tile @param {THREE.Object3D[]} meshes
   */
  _releaseMeshes(tile, meshes) {
    if (!meshes.length) return;
    const set = new Set(meshes);
    this.pickMeshes = this.pickMeshes.filter((m) => !set.has(m));
    if (meshes === tile.coarseMeshes) { for (const m of meshes) m.visible = false; return; }
    for (const m of meshes) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  }

  /**
   * Night floodlight glow for every building mesh, current AND future. `glow` is `{wall, roof}` emissive intensities
   * (the mesh's own colour becomes its emissive colour), or null for day.
   * The state is remembered and applied to each mesh as it is created (_makeMesh): streamed tiers arrive all session, so
   * glow set only on the meshes that existed when the palette switched left every later tile unlit at night -- and the
   * hidden, kept-for-later coarse meshes glowing by day.
   * @param {{wall: number, roof: number}|null} glow
   */
  setGlow(glow) {
    this._glow = glow;
    for (const tile of this.tileRecords) {
      for (const m of tile.meshes) this._applyGlow(m);
      if (tile.coarseMeshes && tile.coarseMeshes !== tile.meshes) for (const m of tile.coarseMeshes) this._applyGlow(m);
    }
  }

  _applyGlow(mesh) {
    const mat = mesh.material;
    if (!mat.emissive) return; // outline meshes (LineBasicMaterial) have no glow channel
    mat.emissive.setHex(this._glow ? mat.color.getHex() : 0x000000);
    mat.emissiveIntensity = this._glow ? (mesh.userData.buildingRole === 'roof' ? this._glow.roof : this._glow.wall) : 0;
  }

  /** Match whatever opacity/visibility updateBuildingLOD() already decided for this tile -- freshly swapped-in meshes would otherwise sit hidden until the next LOD pass. */
  _syncMeshOpacity(tile) {
    const visible = tile.opacity > 0.01;
    for (const m of tile.meshes) {
      m.visible = visible;
      if (visible && m.material?.opacity !== undefined) m.material.opacity = tile.opacity;
    }
  }

  /** Back to the resident coarse geometry: frees the medium/full meshes, no fetch, no build. */
  _restoreCoarse(tile) {
    this._releaseMeshes(tile, tile.meshes);
    tile.meshes = tile.coarseMeshes;
    tile.boundTier = 'coarse';
    for (const m of tile.meshes) if (m.userData.buildingRole !== 'outline') this.pickMeshes.push(m);
    this._syncMeshOpacity(tile);
    this.onTileTierBound?.(tile, 'coarse');
  }

  /** @param {BuildingTile} tile @param {TierName} tier @param {import('../workers/tile-binary-format.js').TilePayload} decoded */
  _bindTier(tile, tier, decoded) {
    if (tier === 'coarse' && tile.coarseMeshes) { this._restoreCoarse(tile); return; } // a duplicate coarse fetch landed; the one we already hold wins
    const bindStart = this.onTileEvent ? performance.now() : 0;
    const oldMeshes = tile.meshes;
    const newMeshes = this._buildMeshesForPayload(decoded, 'buildings-3d', tile.tiers[tier]?.bounds ?? null);
    if (tier === 'coarse') tile.coarseMeshes = newMeshes; // built once, kept for the life of the layer

    this._releaseMeshes(tile, oldMeshes);
    for (const m of newMeshes) if (m.userData.buildingRole !== 'outline') this.pickMeshes.push(m);

    tile.meshes = newMeshes;
    tile.boundTier = tier;
    this._syncMeshOpacity(tile);

    this.onTileTierBound?.(tile, tier);
    this.onTileEvent?.('bind', tile, tier, performance.now() - bindStart);
  }

  _evictTile(tile) {
    this._releaseMeshes(tile, tile.meshes);
    if (tile.coarseMeshes) { // evicting means really gone: drop the kept coarse set too
      for (const m of tile.coarseMeshes) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
      tile.coarseMeshes = null;
    }
    tile.meshes = [];
    tile.boundTier = null;
    this.onTileTierEvicted?.(tile);
  }

  // -----------------------------------------------------------------
  // Legacy path -- unchanged from before streaming existed.
  // -----------------------------------------------------------------
  _loadLegacyWorker(spec) {
    this._legacyFinished = false;
    this.worker = new Worker(new URL('../workers/building-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => this._handleMessage(ev.data);
    // A worker that can't start (a module error) or can't deliver a message
    // reports here, not through onmessage. Unhandled, boot() waited forever
    // for onDone and the loading screen never went away.
    this.worker.onerror = (ev) => { ev.preventDefault?.(); this._finishLegacyLoad({ failed: true, error: ev.message || 'the buildings worker could not start' }); };
    this.worker.onmessageerror = () => this._finishLegacyLoad({ failed: true, error: 'a message from the buildings worker could not be read' });
    this.worker.postMessage({
      type: BuildingWorkerCmd.LOAD,
      cityId: this.cityConfig.id,
      // Resolved to an absolute URL HERE, on the main thread, where
      // window.location is the page's real URL. A relative CityConfig
      // path like 'data/kanpur/....geojson' would otherwise resolve
      // inside the worker against the WORKER SCRIPT's own location (a
      // different path -- a Vite-processed module URL in dev, an
      // /assets/ chunk in prod), not the page's -- fetch() then 404s
      // there, Vite's dev server serves its default HTML fallback for
      // that 404, and JSON.parse fails on the '<' of "<!DOCTYPE html>"
      // (exactly the "unexpected character at line 1 column 1" error).
      url: new URL(spec.url, window.location.href).href,
      origin: this.cityConfig.origin,
      tileSizeM: this.cityConfig.buildings.tileSizeM,
      minRenderHeightM: spec.minRenderHeightM ?? this.cityConfig.buildings.minRenderHeightM,
      windowMinHeightM: this.cityConfig.buildings.windowMinHeightM,
      heightProperty: spec.heightProperty,
      sourceLabel: 'buildings-3d',
    });
  }

  /**
   * City switch / teardown. The worker is told to stop and then terminated
   * outright -- terminate() alone would do, the message only lets a worker
   * between yields (every ~20k features) stop cleanly. Legacy path only;
   * streaming has no worker to abort.
   */
  abort() {
    this.worker?.postMessage({ type: BuildingWorkerCmd.ABORT });
    this.worker?.terminate();
    this.worker = null;
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case BuildingWorkerMsg.PROGRESS:
        this.onProgress?.(msg.done, msg.total);
        break;
      case BuildingWorkerMsg.TILE:
        this._addTile(msg);
        // Backpressure ACK -- see building-worker.js's Pass 2 comment.
        this.worker?.postMessage({ type: BuildingWorkerCmd.TILE_ACK });
        break;
      case BuildingWorkerMsg.DONE:
        this._finishLegacyLoad(msg.stats);
        break;
      case BuildingWorkerMsg.ERROR:
        // The worker stops after an ERROR and never sends DONE, so this is the
        // end of the load: boot() must hear about it, with whatever tiles did
        // arrive, instead of waiting forever behind the loading screen.
        this._finishLegacyLoad({ failed: true, error: msg.message });
        break;
    }
  }

  /**
   * Ends a legacy load exactly once, however it ended: a worker can report an
   * error AND then fail to load, and boot() must be told only once.
   * @param {{failed?: boolean, error?: string} & Record<string, any>} stats
   */
  _finishLegacyLoad(stats) {
    if (this._legacyFinished) return;
    this._legacyFinished = true;
    if (stats.failed) console.error(`[BuildingLayer] buildings could not be loaded (${stats.error}); showing the ${this.tileRecords.length} tile(s) that arrived`);
    this.worker?.terminate();
    this.worker = null;
    this.onDone?.({ tileCount: this.tileRecords.length, streaming: false, ...stats });
  }

  _addTile(msg) {
    const meshes = this._buildMeshesForPayload(msg, msg.sourceLabel, msg.bounds ?? null);
    for (const m of meshes) if (m.userData.buildingRole !== 'outline') this.pickMeshes.push(m);

    this.tileRecords.push({
      centerX: (msg.centerIx + 0.5) * this.cityConfig.buildings.tileSizeM,
      centerZ: (msg.centerIz + 0.5) * this.cityConfig.buildings.tileSizeM,
      meshes,
      opacity: 0,
    });
  }

  // -----------------------------------------------------------------
  // Shared: builds the mesh set for one tile's decoded payload, used by
  // both the legacy per-tile worker message and streaming's per-tier bind.
  // `bounds` (streaming only: manifest tiers.<tier>.bounds, role -> exact box)
  // gives each geometry its bounding sphere up front, so three.js never loops
  // over the vertices to find it (see known-bounds.js). Absent -> three.js computes it, as before.
  // -----------------------------------------------------------------
  /**
   * @param {import('../workers/tile-binary-format.js').TilePayload} payload
   * @param {string} sourceLabel - shown as "source" when a building is clicked
   * @param {Record<string, number[]>|null} [bounds]
   * @returns {THREE.Object3D[]}
   */
  _buildMeshesForPayload(payload, sourceLabel, bounds = null) {
    const meshes = [];
    // One table per tier bind, shared by all of this tier's meshes; it holds
    // references to the decoded columns, not an object per building (see
    // building-meta.js for what that used to cost).
    const buildingMeta = new BuildingMetaTable(payload.meta);

    if (payload.wall) meshes.push(this._makeMesh(payload.wall, googleWallMaterial, 'wall', buildingMeta, sourceLabel, bounds?.wall));
    if (payload.windowWall) meshes.push(this._makeMesh(payload.windowWall, googleWindowWallMaterial, 'wall-windowed', buildingMeta, sourceLabel, bounds?.windowWall));
    if (payload.roof) {
      const roofMesh = this._makeMesh(payload.roof, googleRoofMaterial, 'roof', buildingMeta, sourceLabel, bounds?.roof);
      meshes.push(roofMesh);
    }
    if (payload.outline) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(payload.outline.position, 3));
      if (bounds?.outline) setKnownBounds(geo, bounds.outline);
      const outlineMat = outlineMaterial.clone();
      // transparent MUST be true here: the LOD system drives every mesh's
      // fade-in via `.material.opacity`, and opacity is a no-op unless
      // transparent:true -- without this the outline stays fully solid
      // at ANY fade value while walls/roof correctly fade under it.
      outlineMat.transparent = true;
      outlineMat.opacity = 0;
      const m = new THREE.LineSegments(geo, outlineMat);
      m.userData.buildingRole = 'outline';
      m.visible = false;
      this.scene.add(m);
      meshes.push(m);
    }
    return meshes;
  }

  /**
   * @param {import('../workers/tile-binary-format.js').TileMeshPart} part
   * @param {THREE.Material} baseMat - cloned, because each tile fades its own opacity
   * @param {string} role @param {BuildingMetaTable} buildingMeta @param {string} sourceLabel
   * @param {number[]|null} [box]
   * @returns {THREE.Mesh}
   */
  _makeMesh(part, baseMat, role, buildingMeta, sourceLabel, box = null) {
    const g = new THREE.BufferGeometry();
    if (box) setKnownBounds(g, box);
    // (no box: three.js computes the bounding sphere from the vertices on first use, as it always did)
    g.setAttribute('position', new THREE.Float32BufferAttribute(part.position, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(part.color, 3));
    g.setAttribute('buildingId', new THREE.Float32BufferAttribute(part.buildingId, 1));
    if (part.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
    // Normals arrive pre-computed (from building-worker.js live, or baked
    // into the tile binary offline) instead of being computed here.
    g.setAttribute('normal', new THREE.Float32BufferAttribute(part.normal, 3));
    const mat = baseMat.clone();
    mat.transparent = true;
    mat.opacity = 0;
    const m = new THREE.Mesh(g, mat);
    m.visible = false;
    m.userData.buildingRole = role;
    m.userData.buildingMeta = buildingMeta; // InspectController reads one building from it on click: buildingMeta.get(buildingId)
    m.userData.buildingSource = sourceLabel;
    this._applyGlow(m); // a tile built at night must glow from its first frame
    this.scene.add(m);
    return m;
  }
}
