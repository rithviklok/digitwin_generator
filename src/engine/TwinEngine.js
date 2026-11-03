// ===================================================================
// TwinEngine — the full orchestrator: scene/camera/renderer setup,
// data loading (main-thread layers + the building worker in parallel),
// every layer and controller wired together, and the idle-gated
// animate() loop. One CityConfig in, one running twin out.
// ===================================================================
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { LAYER_ROLES } from '../config/city-schema.js';
import { DEFAULT_PALETTES } from '../config/palettes.js';
import {
  Y_KMC_WARD, Y_KMC_ZONE, buildingHeightFade,
  BUILDING_HIDE_ABOVE_HEIGHT, BUILDING_FULL_OPACITY_HEIGHT,
  BUILDING_LOD_DISTANCE, BUILDING_LOD_FADE_INNER_FRAC, FOG_FAR_FOR_LOD, GPU_UPLOAD_BOOT_CHUNK_MS,
} from '../config/constants.js';
import { escapeHtml } from '../ui/escape-html.js';

import { BuildingLayer } from '../layers/BuildingLayer.js';
import { ShadowLayer } from '../layers/ShadowLayer.js';
import { RoadLayer } from '../layers/RoadLayer.js';
import { AdminAreaLayer } from '../layers/AdminAreaLayer.js';
import { GroundLayer } from '../layers/GroundLayer.js';
import { TreeLayer } from '../layers/TreeLayer.js';
import { LabelLayer } from '../layers/LabelLayer.js';

import { DirtyScheduler } from './DirtyScheduler.js';
import { CameraRig } from './CameraRig.js';
import { HighlightRenderer } from './HighlightRenderer.js';
import { GpuUploadQueue } from './GpuUploadQueue.js';
import { PerfProbe } from './PerfProbe.js';
import { PaletteController } from './PaletteController.js';
import { loadCityData } from './DataLoader.js';

import { SearchController } from '../controllers/SearchController.js';
import { InspectController } from '../controllers/InspectController.js';
import { WeatherController } from '../controllers/WeatherController.js';

const USE_POST_FX = false; // see the comment in _setupRenderer()
const PERF_PROBE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf'); // ?perf -- see PerfProbe.js

export class TwinEngine {
  /** @param {HTMLCanvasElement} canvas @param {import('../config/city-schema.js').CityConfig} cityConfig */
  constructor(canvas, cityConfig) {
    this.cityConfig = cityConfig;
    this.scheduler = new DirtyScheduler();
    this._activeTweens = new Set();

    this._setupRenderer(canvas);
    this._setupScene();
    this._setupCamera(canvas);
    this._setupLights();

    // Pushes each mesh's buffers to the GPU ahead of time (see GpuUploadQueue.js); it also listens for everything the layers add to the scene from here on.
    this.gpuUploads = new GpuUploadQueue(this.renderer, this.scene, this.camera);
    this.gpuUploads.onNeedsFrame = () => this.scheduler.markDirty();

    this.highlightRenderer = new HighlightRenderer(this.scene);
    this.buildingLayer = new BuildingLayer(this.scene, cityConfig);
    this.shadowLayer = new ShadowLayer(this.scene);
    this.roadLayer = new RoadLayer(this.scene, cityConfig);
    this.wardLayer = new AdminAreaLayer(this.scene, cityConfig, { outlineColor: 0xaaaaaa, y: Y_KMC_WARD, metaFn: (p) => ({ kind: 'ward', name: p.name || '', wardno: p.wardno ?? null, zone: p.zone ?? null, population: p.population ?? null }) });
    this.zoneLayer = new AdminAreaLayer(this.scene, cityConfig, { outlineColor: 0x555555, y: Y_KMC_ZONE, metaFn: (p) => ({ kind: 'zone', zone_id: p.zone_id ?? null }) });
    this.groundLayer = new GroundLayer(this.scene, cityConfig);
    this.treeLayer = new TreeLayer(this.scene, cityConfig);
    this.labelLayer = new LabelLayer(cityConfig);

    this._sunElevationDeg = 45;
    this._sunAzimuthDeg = 180;
    this._updateSunFromLocalTime(); // initial angle, before boot()/buildings exist -- sky/sun light are already correct from frame 1

    this._boundAnimate = this._animate.bind(this);
    window.addEventListener('resize', () => this._onResize());
    this.perf = PERF_PROBE ? new PerfProbe(this) : null; // last: it hooks the layers and the upload queue built above
  }

  // -----------------------------------------------------------------
  // Setup
  // -----------------------------------------------------------------
  _setupRenderer(canvas) {
    // stencil: ShadowLayer blends each pixel at most once (overlapping shadow triangles otherwise stack into near-black).
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, stencil: true });
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const isLowEnd = (nav.deviceMemory ?? 8) <= 4 || (nav.hardwareConcurrency ?? 8) <= 4;
    this.renderer.setPixelRatio(isLowEnd ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.LinearToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // With no effects in use, cutting straight to renderer.render() is
    // output-equivalent (the renderer already does the tone-map +
    // colour-space conversion an OutputPass would) and saves one
    // full-screen render target + pass.
    if (USE_POST_FX) this.composer = new EffectComposer(this.renderer);
  }

  /** Merged default+city-override palette -- PaletteController re-derives the same merge later for its own `this.palettes`; both read DEFAULT_PALETTES + cityConfig.palette independently rather than one copying the other's result. */
  _dayPalette() {
    return { ...DEFAULT_PALETTES.day, ...(this.cityConfig.palette?.day ?? {}) };
  }

  _setupScene() {
    this.scene = new THREE.Scene();
    const day = this._dayPalette();
    this.scene.background = new THREE.Color(day.sky);
    this.fog = new THREE.Fog(day.fog, 9000, 22000);
    this.scene.fog = this.fog;

    this.sky = new Sky();
    this.sky.scale.setScalar(50000);
    this.scene.add(this.sky);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 2.2; u.rayleigh.value = 0.55; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.75;

    this.groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000, 64, 64), new THREE.MeshLambertMaterial({ color: day.ground }));
    this.groundMesh.rotation.x = -Math.PI / 2;
    this.scene.add(this.groundMesh);
  }

  _setupCamera(canvas) {
    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 2.0, 60000);
    this.camera.position.set(0, 4500, -4500);
    if (USE_POST_FX) { this.composer.addPass(new RenderPass(this.scene, this.camera)); this.composer.addPass(new OutputPass()); }
    this.cameraRig = new CameraRig(this.camera, canvas, this.scheduler);
  }

  _setupLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xc8c8c8, 2.2);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.1);
    this.sun.castShadow = false;
    this.scene.add(this.sun);
  }

  // -----------------------------------------------------------------
  // Boot: fetch every non-buildings-3d layer AND start the building
  // worker in parallel, wire every layer/controller once data lands.
  // -----------------------------------------------------------------
  /**
   * @param {object} [opts]
   * @param {(stage: string, done: number, total: number) => void} [opts.onProgress]
   * @param {object|null} [opts.initialView] - a CameraRig.getView()-shaped view to open on (a shared link's). Given here,
   *   not set afterwards, so that what is loaded behind the loading screen is what THAT view needs: in a large city only
   *   the tiles around the camera are loaded.
   */
  async boot({ onProgress, initialView = null } = {}) {
    this.cameraRig.init();
    if (initialView) this.cameraRig.setView(initialView, { animate: false });

    const buildingsDone = new Promise((resolve) => {
      this.buildingLayer.onDone = resolve;
      this.buildingLayer.onProgress = (done, total) => onProgress?.('buildings', done, total);
    });
    // Streaming-only: as tiles bind/evict tiers going forward (long after
    // boot, driven by camera movement -- see updateBuildingLOD() in this
    // file), keep each tile's shadow mesh in sync with it. Coarse tier has
    // no wall geometry, so there's nothing meaningful to shadow at that
    // distance -- a tile DOWNGRADING to coarse (from full/medium, where it
    // already had a shadow baked) must explicitly evict that leftover
    // shadow here, not just skip baking a new one, or it never goes away.
    // Legacy mode never calls these (no per-tile tier lifecycle exists
    // there), so this is a no-op for any city without pre-built tiles.
    // Both hooks also request a redraw: a tile's fetch lands whenever it
    // lands -- typically after the camera has stopped and the idle-gated
    // render loop has gone quiet -- and without this its new geometry stays
    // undrawn until the next unrelated camera input.
    this.buildingLayer.onTileTierBound = (tile, tier) => {
      if (tier === 'coarse') this.shadowLayer.evictTile(tile);
      else this.shadowLayer.bakeTile(tile);
      this.scheduler.markDirty();
    };
    this.buildingLayer.onTileTierEvicted = (tile) => {
      this.shadowLayer.evictTile(tile);
      this.scheduler.markDirty();
    };
    // Fetched tiles are built a few per frame (BuildingLayer._drainBindQueue), which only runs on a rendered frame.
    this.buildingLayer.onNeedsFrame = () => this.scheduler.markDirty();
    this.roadLayer.onNeedsFrame = () => this.scheduler.markDirty(); // road tiles (a large city) arrive and are built the same way
    this.buildingLayer.load(this.camera.position);

    const { data, missingRequired, missingOptional } = await loadCityData(this.cityConfig, (done, total) => onProgress?.('data', done, total));
    if (missingRequired.length) console.error('[TwinEngine] missing required layers:', missingRequired);
    if (missingOptional.length) {
      const hint = document.getElementById('missingHint');
      if (hint) {
        hint.hidden = false;
        // Role names are validated against LAYER_ROLES, but they still come from a config the server sent: escaped, like all data put into HTML.
        hint.innerHTML = `${missingOptional.length} layer(s) failed to load: <code>${missingOptional.map(escapeHtml).join('</code>, <code>')}</code>. The city will render without them.`;
      }
    }

    await this.roadLayer.load(data[LAYER_ROLES.ROADS], data[LAYER_ROLES.RAILWAY], (done, total) => onProgress?.('roads', done, total), this.camera.position);
    this.wardLayer.load(data[LAYER_ROLES.ADMIN_WARDS]);
    this.zoneLayer.load(data[LAYER_ROLES.ADMIN_ZONES]);

    const day = this._dayPalette();
    this.groundLayer.load({ landuse: data[LAYER_ROLES.LANDUSE], vegetation: data[LAYER_ROLES.VEGETATION], water: data[LAYER_ROLES.WATER] }, day);
    const waterRingsLocal = this.groundLayer.getWaterRingsLocal(data[LAYER_ROLES.WATER]);
    this.treeLayer.load(data[LAYER_ROLES.VEGETATION], waterRingsLocal, day);

    this.labelLayer.load({
      landuse: data[LAYER_ROLES.LANDUSE], wards: data[LAYER_ROLES.ADMIN_WARDS],
      // Roads as tiles have no list of roads to read names from; their name list stands in for it.
      roads: this.roadLayer.streaming ? null : data[LAYER_ROLES.ROADS], roadNames: this.roadLayer.nameIndex,
      landmarks: data[LAYER_ROLES.LANDMARKS], localities: data[LAYER_ROLES.LOCALITIES], amenities: data[LAYER_ROLES.AMENITIES],
      buildingLabels: data[LAYER_ROLES.BUILDING_LABELS],
    });

    this.paletteController = new PaletteController({
      scene: this.scene, camera: this.camera, renderer: this.renderer, sky: this.sky, fog: this.fog, hemi: this.hemi, sun: this.sun,
      groundMesh: this.groundMesh, roadLayer: this.roadLayer, groundLayer: this.groundLayer, treeLayer: this.treeLayer,
      shadowLayer: this.shadowLayer, buildingLayer: this.buildingLayer, cityConfig: this.cityConfig,
      scheduler: this.scheduler,
    });

    this._wireUI();

    // Buildings may still be constructing (city-scale: 30-90s) -- everything
    // above is already interactive. Shadows bake and the palette does its
    // first full pass (including building glow) once buildings land.
    await buildingsDone;
    // Streaming tiles bake and evict their own shadow as their tier changes
    // (onTileTierBound above: none at coarse, baked from medium up). Baking
    // every tile here as well would give the whole city full-detail shadow
    // geometry no matter its tier -- measured at ~240MB resident and about
    // half of all triangles drawn -- so it's for the legacy path only.
    if (!this.buildingLayer.streaming) await this.shadowLayer.bakeFromTileRecords(this.buildingLayer.tileRecords);
    // Compile shader programs now, behind the loading screen, instead of as a
    // ~100-180 ms hitch the first time each is drawn -- which was exactly as
    // you arrived somewhere new: the building/shadow programs (only coarse
    // tiles exist at boot), the search-highlight line shader (built on
    // demand), and the hidden tree meshes (compile() visits every object in
    // the scene, visible or not).
    this.buildingLayer.warmShaders(this.renderer, this.camera, this.shadowLayer.material);
    this.highlightRenderer.warm(this.renderer, this.camera);
    this.renderer.compile(this.scene, this.camera);
    // Programs are ready; now the geometry. Everything starts hidden, and three.js only uploads a
    // mesh's buffers the first time it is drawn -- so without this, the frame where the camera first
    // drops below BUILDING_HIDE_ABOVE_HEIGHT uploads ~100-300 MB at once (250-400 ms measured on a
    // desktop GPU, seconds on slower ones): the screen and clock freeze, then every building appears
    // in one frame. Done here, behind the loading screen, in chunks.
    this.gpuUploads.scanScene();
    await this.gpuUploads.drainAll(GPU_UPLOAD_BOOT_CHUNK_MS);
    this.paletteController.applyPalette('day');

    this.weatherController = new WeatherController({
      cityConfig: this.cityConfig, paletteController: this.paletteController,
      weatherEl: document.getElementById('panelWeather'),
    });
    this.weatherController.start();

    this._activeTweens.add(() => this.cameraRig.updateFlyTo());
    this._activeTweens.add(() => this.cameraRig.updateCompassReset());
    // Rain is a continuous ambient animation (falling streaks), not a
    // one-shot change -- it has to keep rendering every frame while
    // visible regardless of camera stillness, or it visibly freezes the
    // instant the user stops touching the camera. Modeled as a "tween"
    // that's active for as long as rainMesh.visible is true, same
    // mechanism flyTo/compass use to force continuous rendering.
    this._activeTweens.add(() => {
      const raining = this.paletteController.rainMesh.visible;
      if (raining) this.paletteController.updateRain();
      return raining;
    });

    // Sun position from local time, every 60s. Moving the shadows with it
    // is one uniform write (ShadowLayer.setSunAngles()), not a rebuild of
    // every shadow mesh. See ShadowLayer.js.
    setInterval(() => this._updateSunFromLocalTime(), 60000);

    this.scheduler.markDirty();
    this.perf?.booted();
  }

  /** Sun elevation/azimuth from local wall-clock time -- CityConfig.sun bounds, not hardcoded per-city constants. */
  _updateSunFromLocalTime(date = new Date()) {
    const { dayStartHour, dayEndHour, maxElevationDeg, minElevationDeg } = this.cityConfig.sun;
    const hours = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
    const hour = ((hours % 24) + 24) % 24;
    const isDaylight = hour >= dayStartHour && hour < dayEndHour;
    const { elevationDeg, azimuthDeg } = isDaylight
      ? (() => { const t = Math.max(0, Math.min(1, (hour - dayStartHour) / (dayEndHour - dayStartHour))); return { elevationDeg: maxElevationDeg * Math.sin(t * Math.PI), azimuthDeg: 90 + t * 180 }; })()
      : { elevationDeg: -minElevationDeg, azimuthDeg: 200 };

    this._sunElevationDeg = elevationDeg;
    this._sunAzimuthDeg = azimuthDeg;
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg), theta = THREE.MathUtils.degToRad(azimuthDeg);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    sunDir.x *= -1; // matches project()'s East/West chirality fix
    this.sky.material.uniforms.sunPosition.value.copy(sunDir);
    this.sun.position.copy(sunDir.clone().multiplyScalar(20000));
    this.shadowLayer.setSunAngles(elevationDeg, azimuthDeg, maxElevationDeg); // O(1) -- see ShadowLayer.js; shadows fade with the sun's height
    this.scheduler.markDirty();
  }

  _wireUI() {
    const dom = {
      btnSearch: document.getElementById('btnSearch'), searchPanel: document.getElementById('searchPanel'),
      searchInput: document.getElementById('searchInput'), searchResultsEl: document.getElementById('searchResults'),
    };
    this.searchController = new SearchController({ dom, labelLayer: this.labelLayer, cameraRig: this.cameraRig, highlightRenderer: this.highlightRenderer, scheduler: this.scheduler });

    this.inspectController = new InspectController({
      renderer: this.renderer, camera: this.camera, highlightRenderer: this.highlightRenderer, scheduler: this.scheduler,
      buildingLayer: this.buildingLayer, roadLayer: this.roadLayer, wardLayer: this.wardLayer, zoneLayer: this.zoneLayer,
      dom: {
        inspectPanel: document.getElementById('inspect'),
        inspectBody: document.getElementById('inspectBody'),
        inspectClose: document.getElementById('btnInspectClose'),
      },
    });
    this.labelLayer.onLandmarkClick = (name) => this.inspectController.showLandmarkInspect(name);
    this.labelLayer.watchChrome(() => this.scheduler.markDirty());

    document.getElementById('btnCompass')?.addEventListener('click', () => this.cameraRig.resetToNorth());
    document.getElementById('btnZoomIn')?.addEventListener('click', () => this.cameraRig.dolly(0.8));
    document.getElementById('btnZoomOut')?.addEventListener('click', () => this.cameraRig.dolly(1.25));

    // Day / Night. The button follows the scene, whoever changed it: a click
    // here, sunrise or sunset (WeatherController), or the embed API's setNight.
    const btnNight = document.getElementById('btnToggleNight');
    btnNight?.addEventListener('click', () => { this.weatherController?.toggleManualPalette(); this.scheduler.markDirty(); });
    this.paletteController.onPaletteApplied = (name) => {
      if (!btnNight) return;
      const label = name === 'night' ? 'Switch to day view' : 'Switch to night view';
      btnNight.setAttribute('aria-pressed', String(name === 'night'));
      btnNight.setAttribute('aria-label', label);
      btnNight.title = label;
    };

    const compassNeedle = document.getElementById('compassNeedle');
    this._compassNeedle = compassNeedle;
  }

  registerTween(fn) { this._activeTweens.add(fn); }

  // -----------------------------------------------------------------
  // The idle-gated render loop.
  // -----------------------------------------------------------------
  start() { this._boundAnimate(); }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer?.setSize(window.innerWidth, window.innerHeight);
    this.highlightRenderer.onResize();
    this.scheduler.markDirty();
  }

  _animate() {
    requestAnimationFrame(this._boundAnimate);
    const perf = this.perf; // null unless ?perf; every call below is a no-op then
    perf?.beginFrame();

    let anyTweenActive = false;
    for (const tween of this._activeTweens) {
      if (tween()) { anyTweenActive = true; this.scheduler.markDirty(); }
    }

    this.cameraRig.tick(); // unconditional -- produces the 'change' event that sets dirty; cheap regardless

    if (this._compassNeedle) {
      this._compassNeedle.setAttribute('transform', `rotate(${this.cameraRig.headingDeg()} 20 20)`);
    }
    perf?.lap('camera');

    if (!this.scheduler.consume() && !anyTweenActive) { perf?.endFrame(false); return; }

    this.buildingLayer && updateBuildingLOD(this.buildingLayer, this.camera, this.cameraRig.flyDestination);
    this.roadLayer.updateTiles(this.camera.position, this.cameraRig.flyDestination); // no-op unless the roads are tiles
    perf?.lap('building LOD + tile builds');
    this.treeLayer?.updateLOD(this.camera);
    this.shadowLayer?.updateLOD(this.camera.position.y);
    perf?.lap('trees + shadows');
    this.labelLayer?.update(this.camera);
    perf?.lap('labels');

    // Geometry that arrived since boot (streamed tiers, new meshes) goes to the GPU a few ms per frame,
    // not in the frame it first becomes visible. The pass draws one clipped pixel; the render below overwrites it.
    this.gpuUploads.drain();
    perf?.lap('GPU uploads');

    if (USE_POST_FX) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    perf?.lap('render');

    if (this.gpuUploads.pending) this.scheduler.markDirty(); // keep draining next frame even if the camera is still
    perf?.endFrame(true);
  }
}

// Scratch objects reused every call -- building a new Frustum/Matrix4/Sphere
// per frame for ~150 tiles would be avoidable allocation.
const _lodFrustum = new THREE.Frustum();
const _lodFrustumMatrix = new THREE.Matrix4();
const _lodSphere = new THREE.Sphere();

/**
 * Building LOD.
 * Two factors multiply: a height-based fade (same curve as
 * buildingHeightFade()) AND a spatial reveal radius around the camera
 * (frustum-culled, growing as the camera descends, capped by fog
 * distance) -- height alone would fade every tile in the city
 * identically regardless of distance, which reads as a flat "whole city
 * dims/brightens" instead of buildings resolving in around the camera.
 *
 * In streaming mode (buildingLayer.streaming -- see BuildingLayer.js),
 * the same reveal radius is additionally capped by the manifest's
 * coarseRadiusM, and every tile also gets a detail tier
 * (full/medium/coarse) -- the actual fix for render-time lag, since a
 * tile's geometry complexity shrinks with distance instead of every
 * visible tile always being full detail. That is BuildingLayer.
 * updateTiers(), run first below: it is deliberately separate from
 * everything else here because it is about what is LOADED (a sphere
 * around the camera, ignoring where the camera is facing), whereas the
 * frustum/fade logic below is about what is DRAWN. Boot primes tiles to
 * the cheap coarse tier (BuildingLayer._primeCoarseBaseline()), so in a
 * city the size of Kanpur 'coarse' is a permanent floor -- a tile is
 * never evicted to nothing, which is what makes a fresh area never read
 * as "empty" for a moment. (A metro too large to hold its whole coarse
 * tier -- BuildingLayer.coarseOnDemand -- keeps that floor only around
 * the camera, and lets distant tiles go.)
 * Legacy-mode tiles (buildingLayer.streaming === false) skip all of
 * that and behave byte-for-byte as before -- a city without pre-built
 * tiles must be completely unaffected by this function existing.
 *
 * @param {BuildingLayer} buildingLayer
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.Vector3|null} [flyDestination] - where a fly-to is heading, while one is in flight
 */
function updateBuildingLOD(buildingLayer, camera, flyDestination = null) {
  const tileRecords = buildingLayer.tileRecords;
  if (tileRecords.length === 0) return;
  buildingLayer.updateTiers(camera.position, flyDestination); // no-op unless streaming; runs even while buildings are hidden so tiles are ready by the time the camera descends. During a fly-to it plans for the destination (see updateTiers).
  if (camera.position.y >= BUILDING_HIDE_ABOVE_HEIGHT) {
    for (const tile of tileRecords) {
      if (tile.opacity === 0) continue;
      tile.opacity = 0;
      for (const m of tile.meshes) m.visible = false;
    }
    return;
  }

  const camX = camera.position.x, camZ = camera.position.z;
  const heightFade = buildingHeightFade(camera.position.y);

  // Reveal radius grows as the camera nears the ground, so a grazing/horizontal view still reveals buildings ahead.
  const camHeight = Math.min(Math.max(camera.position.y, BUILDING_FULL_OPACITY_HEIGHT), BUILDING_HIDE_ABOVE_HEIGHT);
  const heightScale = BUILDING_HIDE_ABOVE_HEIGHT / camHeight; // 1 at y=500, up to 10 at y=50
  let effectiveDist = BUILDING_LOD_DISTANCE * heightScale;
  if (effectiveDist > FOG_FAR_FOR_LOD) effectiveDist = FOG_FAR_FOR_LOD; // no point revealing past where fog already hides it
  const radii = buildingLayer.streaming ? buildingLayer.manifestRadii : null;
  if (radii && effectiveDist > radii.coarseRadiusM) effectiveDist = radii.coarseRadiusM; // beyond this even the coarse tier would bust its build-time budget
  const innerDist = effectiveDist * BUILDING_LOD_FADE_INNER_FRAC;
  const fadeRange = effectiveDist - innerDist;

  // Camera frustum test (not just distance) so buildings ahead of a low, horizontal camera are still revealed.
  // Explicit update: camera.matrixWorldInverse is otherwise only refreshed
  // inside renderer.render(), which runs AFTER this function in
  // TwinEngine._animate() -- without this call the frustum would be one
  // frame stale relative to the camera's current pose.
  camera.updateMatrixWorld();
  _lodFrustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _lodFrustum.setFromProjectionMatrix(_lodFrustumMatrix);
  // A sphere that contains the whole tile: a square of side s fits in a
  // circle of radius s/sqrt(2) ~ 0.707 s, and 0.75 s leaves room for the
  // buildings' height. It must be THIS city's tile size: an uploaded city can
  // choose its own, and with the old fixed 2 km constant, tiles larger than
  // that were culled while their buildings were still on screen.
  const tileBoundRadius = buildingLayer.tileSizeM * 0.75;

  for (const tile of tileRecords) {
    const dx = camX - tile.centerX, dz = camZ - tile.centerZ;
    const distSq = dx * dx + dz * dz;
    let targetOpacity = 0;
    let dist = 0;
    if (distSq <= effectiveDist * effectiveDist) {
      _lodSphere.center.set(tile.centerX, 20, tile.centerZ); // y=20: rough mid-height guess, not exact
      _lodSphere.radius = tileBoundRadius;
      if (_lodFrustum.intersectsSphere(_lodSphere)) {
        dist = Math.sqrt(distSq);
        targetOpacity = (dist <= innerDist ? 1 : 1 - (dist - innerDist) / fadeRange) * heightFade;
      }
    }

    if (tile.opacity === targetOpacity) continue;
    tile.opacity = targetOpacity;
    const visible = targetOpacity > 0.01;
    for (const m of tile.meshes) {
      m.visible = visible;
      if (visible) m.material.opacity = targetOpacity;
    }
  }
}
