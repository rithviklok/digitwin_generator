// ===================================================================
// ShadowLayer — building shadows that follow the sun without ever being
// rebuilt.
//
// The obvious way is to triangulate each building's shadow WITH the sun's
// offset already baked into its vertex positions. Moving the sun then
// means disposing every shadow mesh's geometry and re-triangulating from
// scratch -- O(buildings), paid at load and again every 60s forever
// (measured on Kanpur's buildings: a ~2.2 s stutter, once a minute).
//
// Here a tile's shadow is built once (bakeTile). Each vertex stores its
// TRUE (unsheared) footprint position plus a scalar `aSlide` (0 at the
// ground-edge ring, that building's height at the far ring/cap).
// setSunAngles() -- the entire 60s tick -- writes one Vector2 uniform
// that shadow.vert.glsl multiplies against aSlide on the GPU. The
// per-minute hitch and its GC churn are gone by construction, not by
// throttling.
// ===================================================================
import * as THREE from 'three';
import shadowVert from '../shaders/shadow.vert.glsl?raw';
import shadowFrag from '../shaders/shadow.frag.glsl?raw';
import { buildingHeightFade, BUILDING_SHADOW_MAX_LENGTH_PER_HEIGHT } from '../config/constants.js';
import { setKnownBounds } from './known-bounds.js';

const SHADOW_MIN_HEIGHT_M = 3;       // buildings at/below this cast no shadow -- not worth the triangle cost
const BUILDING_SHADOW_Y = 1.0;       // above roads/casing, below any building base
const BUILDING_SHADOW_COLOR = 0x000000;
const BUILDING_SHADOW_OPACITY = 0.4; // noon, full sun. Was 0.28, but that was also being stacked by overlapping shadow triangles (see the stencil in the material); each pixel is blended once now, so the base is higher
// Per-weather-mood shadow strength.
const WEATHER_STRENGTH = { sun: 1.0, cloudy: 0.5 };

/**
 * @typedef {import('./BuildingLayer.js').BuildingTile} BuildingTile
 * @typedef {import('./building-meta.js').BuildingMetaTable} BuildingMetaTable
 */

/**
 * The sun's position as one shear vector: the direction a shadow falls in, times its length per metre of building height.
 * @param {number} sunElevationDeg @param {number} sunAzimuthDeg
 * @returns {THREE.Vector2}
 */
export function computeShadowShear(sunElevationDeg, sunAzimuthDeg) {
  const phi = THREE.MathUtils.degToRad(90 - sunElevationDeg);
  const theta = THREE.MathUtils.degToRad(sunAzimuthDeg);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  // Shadow falls AWAY from the sun.
  let sx = -sunDir.x, sz = -sunDir.z;
  const sLen = Math.hypot(sx, sz) || 1;
  sx /= sLen; sz /= sLen;
  // Capped: 1/tan(elevation) explodes as the sun nears the horizon (27x at 2 degrees), which stretched dusk shadows across whole blocks.
  const tan = Math.tan(THREE.MathUtils.degToRad(sunElevationDeg));
  const lenPerHeight = tan > 1e-3 ? Math.min(1 / tan, BUILDING_SHADOW_MAX_LENGTH_PER_HEIGHT) : BUILDING_SHADOW_MAX_LENGTH_PER_HEIGHT;
  return new THREE.Vector2(sx * lenPerHeight, sz * lenPerHeight);
}

/**
 * 0 with the sun on/below the horizon, 1 at the day's highest sun. Follows sin(elevation) (how directly the sun hits the
 * ground) to the power 1.5, so the early/late hours are clearly lighter than mid-morning/afternoon, not just a bit.
 * Kanpur (68 deg peak): 07:15 ~0.2, 09:00 ~0.7, noon 1.0, 16:45 ~0.25, 17:53 ~0.01.
 * @param {number} sunElevationDeg @param {number} maxElevationDeg
 * @returns {number} 0..1
 */
export function computeSunStrength(sunElevationDeg, maxElevationDeg) {
  if (!(maxElevationDeg > 0)) return 1;
  const s = Math.sin(THREE.MathUtils.degToRad(Math.max(sunElevationDeg, 0))) / Math.sin(THREE.MathUtils.degToRad(maxElevationDeg));
  return THREE.MathUtils.clamp(s, 0, 1) ** 1.5;
}

export class ShadowLayer {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    /** @type {THREE.Mesh[]} every live shadow mesh, one per tile at medium/full detail */
    this.meshes = [];
    // Weather sets the CEILING on shadow strength (0 in overcast/rain/night,
    // 1 in full sun, etc.); camera height then fades that down toward zero
    // exactly like buildings do (buildingHeightFade -- same curve, same
    // BUILDING_HIDE_ABOVE_HEIGHT/BUILDING_FULL_OPACITY_HEIGHT constants),
    // so a shadow and its own building disappear together as you zoom out
    // instead of the shadow staying pinned at full weather-strength opacity
    // regardless of zoom. Stored here so updateLOD() (called every frame,
    // see TwinEngine._animate()) can recombine it with the LATEST camera
    // height without needing to know the weather mood string itself.
    this._weatherStrength = 0;
    // Time-of-day strength (setSunAngles): 1 at noon, ~0 at dawn/dusk. Multiplies the weather ceiling above.
    this._sunStrength = 1;
    // ONE shared material/uniform set for every shadow mesh in the city:
    // every tile's shadow has the same opacity and the same sun, so one
    // write moves every shadow on screen, instead of a loop over N
    // materials.
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uShadowShear: { value: new THREE.Vector2(0, 0) },
        uColor: { value: new THREE.Color(BUILDING_SHADOW_COLOR) },
        uOpacity: { value: BUILDING_SHADOW_OPACITY },
      },
      vertexShader: shadowVert,
      fragmentShader: shadowFrag,
      transparent: true,
      depthWrite: false, // overlapping shadows shouldn't occlude each other or fight on depth
      side: THREE.DoubleSide,
      // Negative offset biases shadows toward the camera in depth so they
      // reliably win against the road surface at city-scale distances
      // under logarithmicDepthBuffer.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      // Blend each screen pixel AT MOST ONCE. Shadow triangles overlap heavily (the ribbon and far-cap of one building,
      // neighbouring buildings' shadows), and plain alpha blending stacked them into near-black patches. The stencil
      // buffer (enabled on the renderer) marks a pixel the first time a shadow touches it and refuses the rest.
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
  }

  /**
   * Bulk convenience for legacy (non-streaming) loading: bakes every
   * currently-loaded tile's shadow once, at boot, after BuildingLayer's
   * one-time whole-city load finishes. Built on the same per-tile
   * bakeTile() streaming uses for its ongoing bind/evict lifecycle (see
   * that method) -- this is just a loop over it with a yield cadence so
   * a real dataset's worth of tiles doesn't bake as one unbroken ~350ms
   * block.
   * @param {BuildingTile[]} tileRecords - BuildingLayer.tileRecords
   */
  async bakeFromTileRecords(tileRecords) {
    let i = 0;
    for (const tile of tileRecords) {
      this.bakeTile(tile);
      i++;
      if (i % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /**
   * Bakes one tile's shadow mesh, if it doesn't already have one.
   * Idempotent and tier-independent on purpose: shadow geometry comes
   * from a tile's buildingMeta (real footprint + height), which is the
   * SAME regardless of which visual tier (full/medium) is currently
   * bound -- see building-tile-builder.js's packBuildingMeta(). So a
   * tile swapping full<->medium tier should NOT re-bake its shadow;
   * only a genuinely new tile (or one coming back from eviction) needs
   * this to do anything. Called from BuildingLayer's onTileTierBound
   * hook (streaming) as well as bakeFromTileRecords() (legacy/initial).
   * @param {BuildingTile} tile
   */
  bakeTile(tile) {
    if (tile._shadowMesh) return;
    const roofMesh = tile.meshes.find((m) => m.userData.buildingRole === 'roof');
    const meta = roofMesh?.userData.buildingMeta;
    if (!meta || !meta.length) return;
    const mesh = this._bakeTile(meta);
    if (!mesh) return;
    mesh.userData.sourceTile = tile;
    // Shadow visibility is entirely derived from tile.opacity (see
    // updateLOD() below), so revealing a tile always reveals its
    // shadow along with it.
    this.scene.add(mesh);
    this.meshes.push(mesh);
    tile._shadowMesh = mesh;
  }

  /** Disposes and unregisters one tile's shadow mesh, if it has one. Called from BuildingLayer's onTileTierEvicted hook. @param {BuildingTile} tile */
  evictTile(tile) {
    const mesh = tile._shadowMesh;
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    const idx = this.meshes.indexOf(mesh);
    if (idx !== -1) this.meshes.splice(idx, 1);
    tile._shadowMesh = null;
  }

  /**
   * Builds one tile's shadow geometry from its packed per-building columns
   * (see building-meta.js for why there is no object per building). Runs on
   * the main thread inside BuildingLayer's per-frame build budget, so it
   * allocates exactly two typed arrays and nothing per building.
   * @param {BuildingMetaTable} table
   * @returns {THREE.Mesh|null} null when no building is tall enough to cast a shadow
   */
  _bakeTile(table) {
    const p = table.packed;
    if (!p) return null;
    const { ringFlat, ringOffsets, heights, roofIsFastFan, roofTriIndex, roofTriOffsets, count } = p;
    // Degenerate footprints (fewer than 3 corners) never reach a tile -- the
    // builder drops them -- but a malformed tile must not make the two passes
    // below disagree on the vertex count, so they are skipped here too.
    /** @param {number} b @returns {number} corner count, or 0 if this building casts no shadow */
    const shadowCorners = (b) => {
      const n = (ringOffsets[b + 1] - ringOffsets[b]) / 2;
      return heights[b] < SHADOW_MIN_HEIGHT_M || n < 3 ? 0 : n;
    };

    // PASS 1: exact vertex count, same two-pass discipline as the building
    // worker -- one exactly-sized allocation instead of growing arrays.
    let vertCount = 0;
    // Exact x/z extent of the base footprints (every vertex written below is one of these ring points, all at y = BUILDING_SHADOW_Y):
    // tracked here so the mesh can be given its bounds up front instead of three.js looping over every vertex (see known-bounds.js).
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let b = 0; b < count; b++) {
      const n = shadowCorners(b);
      if (n === 0) continue;
      const triCount = roofIsFastFan[b] ? n - 2 : (roofTriOffsets[b + 1] - roofTriOffsets[b]) / 3;
      vertCount += triCount * 3; // far-cap fill (reuses the roof's own triangulation)
      vertCount += n * 6;        // ground-to-far ribbon, 2 tris/edge
      for (let k = ringOffsets[b], end = ringOffsets[b + 1]; k < end; k += 2) {
        const x = ringFlat[k], z = ringFlat[k + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    if (vertCount === 0) return null;

    // PASS 2: write BASE (unsheared) position + per-vertex slide amount.
    const pos = new Float32Array(vertCount * 3);
    const slide = new Float32Array(vertCount);
    let w = 0;

    const writeTri = (ax, az, sa, bx, bz, sb, cx, cz, sc) => {
      const pi = w * 3;
      pos[pi] = ax; pos[pi + 1] = BUILDING_SHADOW_Y; pos[pi + 2] = az;
      pos[pi + 3] = bx; pos[pi + 4] = BUILDING_SHADOW_Y; pos[pi + 5] = bz;
      pos[pi + 6] = cx; pos[pi + 7] = BUILDING_SHADOW_Y; pos[pi + 8] = cz;
      slide[w] = sa; slide[w + 1] = sb; slide[w + 2] = sc;
      w += 3;
    };

    for (let b = 0; b < count; b++) {
      const n = shadowCorners(b);
      if (n === 0) continue;
      const height = heights[b];
      const o = ringOffsets[b]; // this building's footprint starts at ringFlat[o]: corner i is (ringFlat[o + 2i], ringFlat[o + 2i + 1])

      // Far-cap fill: the roof's own triangulation, at slide=height (fully shifted once sheared).
      if (roofIsFastFan[b]) {
        for (let i = 1; i < n - 1; i++) {
          writeTri(
            ringFlat[o], ringFlat[o + 1], height,
            ringFlat[o + i * 2], ringFlat[o + i * 2 + 1], height,
            ringFlat[o + (i + 1) * 2], ringFlat[o + (i + 1) * 2 + 1], height,
          );
        }
      } else {
        for (let t = roofTriOffsets[b], te = roofTriOffsets[b + 1]; t < te; t += 3) {
          const ia = o + roofTriIndex[t] * 2, ib = o + roofTriIndex[t + 1] * 2, ic = o + roofTriIndex[t + 2] * 2;
          writeTri(
            ringFlat[ia], ringFlat[ia + 1], height,
            ringFlat[ib], ringFlat[ib + 1], height,
            ringFlat[ic], ringFlat[ic + 1], height,
          );
        }
      }

      // Ground-to-far ribbon: connects each true footprint edge (slide=0) to its far counterpart (slide=height).
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = ringFlat[o + i * 2], z0 = ringFlat[o + i * 2 + 1];
        const x1 = ringFlat[o + j * 2], z1 = ringFlat[o + j * 2 + 1];
        writeTri(x0, z0, 0, x1, z1, 0, x1, z1, height);
        writeTri(x0, z0, 0, x1, z1, height, x0, z0, height);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aSlide', new THREE.Float32BufferAttribute(slide, 1));
    setKnownBounds(geo, [minX, BUILDING_SHADOW_Y, minZ, maxX, BUILDING_SHADOW_Y, maxZ]);
    const mesh = new THREE.Mesh(geo, this.material); // shared material -- see constructor comment
    mesh.visible = false; // the safe default: the real state is applied by the next updateLOD() call
    return mesh;
  }

  /**
   * The entire 60s sun tick. O(1): one Vector2 write and one number, no geometry touched.
   * `maxElevationDeg` (CityConfig.sun) is the day's highest sun: shadow strength is 1 there and fades to ~0 at dawn/dusk.
   * The caller marks the scheduler dirty; updateLOD() applies the new strength on the next frame.
   * @param {number} elevationDeg @param {number} azimuthDeg @param {number} maxElevationDeg
   */
  setSunAngles(elevationDeg, azimuthDeg, maxElevationDeg) {
    this.material.uniforms.uShadowShear.value.copy(computeShadowShear(elevationDeg, azimuthDeg));
    this._sunStrength = computeSunStrength(elevationDeg, maxElevationDeg);
  }

  /** @param {'sun'|'cloudy'|'overcast'|'rain'|'night'} moodKey */
  setWeatherStrength(moodKey) {
    this._weatherStrength = WEATHER_STRENGTH[moodKey] ?? 0;
    // Doesn't touch opacity/visible directly -- updateLOD() (run every
    // frame) is the one place that combines this with camera height. The
    // caller (PaletteController) already marks the scheduler dirty on
    // every mood change, so the next frame picks this up immediately.
  }

  /**
   * Called every frame alongside updateBuildingLOD()/TreeLayer.updateLOD() --
   * same buildingHeightFade curve, so shadows fade out with their own
   * buildings instead of staying at a flat weather-driven opacity
   * regardless of zoom.
   *
   * Each shadow mesh also only shows when its OWN source building tile is
   * currently within updateBuildingLOD()'s spatial (distance + frustum)
   * reveal radius (tile.opacity > 0, already computed that same frame --
   * updateBuildingLOD() runs before this in TwinEngine._animate()).
   * Without this, every shadow mesh in the entire city rendered every
   * frame once the height gate opened (any camera.y < ~500 in sunny/
   * cloudy weather), regardless of where the camera was actually looking
   * -- measured at ~1M triangles/frame from shadows alone vs ~50K for the
   * rest of the scene, the dominant cost behind "zoomed-in view lags".
   * @param {number} cameraY metres
   */
  updateLOD(cameraY) {
    const heightFade = this._weatherStrength > 0 ? buildingHeightFade(cameraY) : 0;
    const targetOpacity = BUILDING_SHADOW_OPACITY * this._weatherStrength * this._sunStrength * heightFade;
    if (this.material.uniforms.uOpacity.value !== targetOpacity) this.material.uniforms.uOpacity.value = targetOpacity;
    const globallyVisible = targetOpacity > 0;
    // Runs every dirty frame (not just on opacity change) since which tiles
    // are in view can change from camera movement alone, opacity unchanged.
    for (const m of this.meshes) m.visible = globallyVisible && m.userData.sourceTile.opacity > 0;
  }
}
