// ===================================================================
// TreeLayer — individual tree instances scattered inside forest/wood/
// mangrove/park/orchard vegetation polygons. Density and the instance
// cap come from CityConfig.trees (a new city's park/forest mix will
// differ; see kanpur.config.js's `trees` block).
// ===================================================================
import * as THREE from 'three';
import { makeProjector, collectRings, ringToLocal } from '../workers/geo-utils.js';
import {
  buildingHeightFade, TILE_SIZE_M, BUILDING_HIDE_ABOVE_HEIGHT, BUILDING_FULL_OPACITY_HEIGHT,
  BUILDING_LOD_DISTANCE, FOG_FAR_FOR_LOD,
} from '../config/constants.js';

/** m^2 of polygon per tree, by vegetation `kind`. A city's CityConfig.trees.kindDensityM2PerTree overrides/extends these per kind; any
 * kind with a density gets scattered trees ('orchard' gets a grid instead). Mangrove is here for India's coastal cities (Mumbai's creeks,
 * Kochi, the Hooghly fringe), where it's the densest tree cover there is -- see server/lib/osmSplitter.js's classifyArea(). */
const DEFAULT_TREE_DENSITY_M2 = { forest: 90, wood: 90, mangrove: 60, park: 350 };

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const hit = (a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x;
    if (hit) inside = !inside;
  }
  return inside;
}
function ringBBox(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z; }
  return { minX, maxX, minZ, maxZ };
}
function ringAreaM2(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const p0 = ring[i], p1 = ring[(i + 1) % ring.length]; a += p0.x * p1.z - p1.x * p0.z; }
  return Math.abs(a) / 2;
}
function scatterPointsInRing(ring, targetCount) {
  const points = [];
  if (targetCount <= 0) return points;
  const { minX, maxX, minZ, maxZ } = ringBBox(ring);
  const maxAttempts = targetCount * 40;
  let attempts = 0;
  while (points.length < targetCount && attempts < maxAttempts) {
    attempts++;
    const x = minX + Math.random() * (maxX - minX), z = minZ + Math.random() * (maxZ - minZ);
    if (pointInRing(x, z, ring)) points.push({ x, z });
  }
  return points;
}
function gridPointsInRing(ring, spacing) {
  const points = [];
  const { minX, maxX, minZ, maxZ } = ringBBox(ring);
  for (let x = minX; x <= maxX; x += spacing) for (let z = minZ; z <= maxZ; z += spacing) if (pointInRing(x, z, ring)) points.push({ x, z });
  return points;
}

export class TreeLayer {
  /** @param {THREE.Scene} scene @param {import('../config/city-schema.js').CityConfig} cityConfig */
  constructor(scene, cityConfig) {
    this.scene = scene;
    this.cityConfig = cityConfig;
    this.project = makeProjector(cityConfig.origin);
    this.tiles = []; // [{ centerX, centerZ, meshes: [trunkMesh, canopyMesh] }]
    this._visible = null;
  }

  /** @param {{x:number,z:number}[][]} waterRingsLocal from GroundLayer.getWaterRingsLocal() */
  load(vegetationFc, waterRingsLocal, palette) {
    const points = this._scatterPoints(vegetationFc, waterRingsLocal);
    this.tiles = this._buildTileInstances(points, palette);
    console.info(`[TreeLayer] trees scattered: ${points.length} across ${this.tiles.length} tiles`);
    return points.length;
  }

  _scatterPoints(fc, waterRingsLocal) {
    const cfg = this.cityConfig.trees ?? {};
    const density = { ...DEFAULT_TREE_DENSITY_M2, ...cfg.kindDensityM2PerTree };
    const orchardSpacing = cfg.orchardGridSpacingM ?? 6;
    const cap = cfg.instanceCap ?? 40000;
    // Most scattered points land nowhere near water, but the old
    // `waterRingsLocal.some(pointInRing)` check still walked every ring's
    // full edge list for every such point before it could conclude "no" --
    // the exact case `.some()` can't short-circuit early on. Each ring's
    // bbox is computed once, here, and checked first: a point outside a
    // ring's bbox can't possibly be inside that ring, so the expensive
    // per-edge pointInRing() test only runs for rings that could actually
    // contain the point. Same result every time, just without the wasted
    // edge walks -- this doesn't change which points are rejected.
    const waterRingsWithBBox = waterRingsLocal.map((ring) => ({ ring, bbox: ringBBox(ring) }));
    const isInWater = (x, z) => waterRingsWithBBox.some(({ ring, bbox }) =>
      x >= bbox.minX && x <= bbox.maxX && z >= bbox.minZ && z <= bbox.maxZ && pointInRing(x, z, ring));

    const allPoints = [];
    if (!fc) return allPoints;
    for (const f of fc.features) {
      const kind = f.properties?.kind;
      if (kind !== 'orchard' && !density[kind]) continue;
      for (const ring of collectRings(f)) {
        const local = ringToLocal(ring, this.project);
        if (local.length < 3) continue;
        // Never more than the cap still has room for: a metro's largest forest (Delhi's Asola sanctuary is 32 sq km) would
        // otherwise have 3.5 lakh points tested against its outline at boot, to keep a fraction of them.
        const points = kind === 'orchard'
          ? gridPointsInRing(local, orchardSpacing)
          : scatterPointsInRing(local, Math.min(Math.round(ringAreaM2(local) / density[kind]), cap - allPoints.length));
        for (const p of points) if (!isInWater(p.x, p.z)) allPoints.push(p);
        if (allPoints.length >= cap) return allPoints.slice(0, cap);
      }
    }
    return allPoints;
  }

  /**
   * Buckets scattered points into TILE_SIZE_M cells (same grid buildings
   * use) and builds one trunk/canopy InstancedMesh PAIR PER TILE, instead
   * of one giant pair covering all ~40,000 city-wide trees. three.js
   * can't cull individual instances inside an InstancedMesh -- with a
   * single city-wide pair, updateLOD()'s old height-only visibility flip
   * meant EVERY tree in Kanpur (up to the 40,000 instance cap) got
   * submitted in one draw call the moment the camera dropped low enough
   * to see buildings at all, regardless of where the camera was pointed.
   * Measured contributing ~990K of the ~1M triangles/frame behind the
   * "zoomed-in view lags" report. Per-tile meshes let updateLOD() cull by
   * distance from the camera, same as buildings already do.
   */
  _buildTileInstances(points, palette) {
    if (points.length === 0) return [];
    const buckets = new Map();
    for (const p of points) {
      const ix = Math.floor(p.x / TILE_SIZE_M), iz = Math.floor(p.z / TILE_SIZE_M);
      const key = `${ix},${iz}`;
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { centerX: (ix + 0.5) * TILE_SIZE_M, centerZ: (iz + 0.5) * TILE_SIZE_M, points: [] }; buckets.set(key, bucket); }
      bucket.points.push(p);
    }

    const TRUNK_H = 2.2, TRUNK_R = 0.35, CANOPY_H = 4.5, CANOPY_R = 2.2;
    const trunkGeo = new THREE.CylinderGeometry(TRUNK_R * 0.7, TRUNK_R, TRUNK_H, 6);
    const canopyGeo = new THREE.ConeGeometry(CANOPY_R, CANOPY_H, 7);
    // Scratch objects reused for every tree: this loop runs for up to the
    // instance cap (40,000) at boot, and a fresh Vector3 per call to
    // Matrix4.scale() was two short-lived allocations per tree.
    const m = new THREE.Matrix4();
    const s = new THREE.Vector3();
    const tiles = [];
    for (const bucket of buckets.values()) {
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a35, transparent: true, opacity: 1 });
      const canopyMat = new THREE.MeshLambertMaterial({ color: palette.veg, transparent: true, opacity: 1 });
      const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, bucket.points.length);
      const canopyMesh = new THREE.InstancedMesh(canopyGeo, canopyMat, bucket.points.length);
      trunkMesh.visible = false; canopyMesh.visible = false;

      for (let i = 0; i < bucket.points.length; i++) {
        const { x, z } = bucket.points[i];
        const scale = 0.75 + Math.random() * 0.5, rotY = Math.random() * Math.PI * 2;
        s.setScalar(scale);
        m.makeRotationY(rotY); m.scale(s); m.setPosition(x, TRUNK_H * scale / 2, z);
        trunkMesh.setMatrixAt(i, m);
        m.makeRotationY(rotY); m.scale(s); m.setPosition(x, (TRUNK_H + CANOPY_H / 2) * scale, z);
        canopyMesh.setMatrixAt(i, m);
      }
      trunkMesh.instanceMatrix.needsUpdate = true;
      canopyMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(trunkMesh);
      this.scene.add(canopyMesh);
      tiles.push({ centerX: bucket.centerX, centerZ: bucket.centerZ, meshes: [trunkMesh, canopyMesh] });
    }
    return tiles;
  }

  /**
   * Same fade curve as building LOD, PLUS the same distance-based reveal
   * radius (mirrors TwinEngine's updateBuildingLOD() -- see its comment
   * for the heightScale reasoning) so a tree tile only renders when it's
   * both low enough AND near enough to the camera, instead of every tree
   * tile in the city rendering together.
   */
  updateLOD(camera) {
    const cameraY = camera.position.y, camX = camera.position.x, camZ = camera.position.z;
    const heightFade = buildingHeightFade(cameraY);
    if (heightFade <= 0.01) {
      if (this._visible !== false) { this._visible = false; for (const tile of this.tiles) for (const m of tile.meshes) m.visible = false; }
      return;
    }
    this._visible = true;

    const camHeight = Math.min(Math.max(cameraY, BUILDING_FULL_OPACITY_HEIGHT), BUILDING_HIDE_ABOVE_HEIGHT);
    const heightScale = BUILDING_HIDE_ABOVE_HEIGHT / camHeight;
    let effectiveDist = BUILDING_LOD_DISTANCE * heightScale;
    if (effectiveDist > FOG_FAR_FOR_LOD) effectiveDist = FOG_FAR_FOR_LOD;
    const effectiveDistSq = effectiveDist * effectiveDist;

    for (const tile of this.tiles) {
      const dx = camX - tile.centerX, dz = camZ - tile.centerZ;
      const visible = (dx * dx + dz * dz) <= effectiveDistSq;
      for (const m of tile.meshes) {
        m.visible = visible;
        if (visible && m.material.opacity !== heightFade) m.material.opacity = heightFade;
      }
    }
  }

  repaint(palette) {
    for (const tile of this.tiles) {
      const canopy = tile.meshes[1];
      if (canopy) canopy.material.color.setHex(palette.veg); // canopy only; trunk color is fixed
    }
  }
}
