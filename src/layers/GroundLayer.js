// ===================================================================
// GroundLayer — flat-fill ground features: landuse, vegetation, water.
//
// Each of the three is ONE mesh holding every polygon of that kind. They
// used to be a mesh per polygon, which is a draw call per polygon: fine
// for Kanpur's 577, not for a metro (Delhi with its satellite cities has
// 23,662 in OpenStreetMap). Nothing reads the polygons one by one -- a
// click goes to buildings, roads, wards and zones (InspectController) --
// and one kind is one flat colour, so the picture is the same.
// ===================================================================
import * as THREE from 'three';
import { makeProjector, collectRings, ringToLocal } from '../workers/geo-utils.js';
import { Y_LANDUSE, Y_VEGETATION, Y_WATER } from '../config/constants.js';
import { setKnownBounds } from './known-bounds.js';

/** Every polygon of `geojson`, triangulated as THREE.ShapeGeometry does it, as one mesh at height `y`. @returns {THREE.Mesh[]} one mesh, or none if there is nothing to draw */
function buildFlatPolygons(scene, project, geojson, material, y) {
  if (!geojson?.features?.length) return [];
  const positions = [], indices = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const feature of geojson.features) {
    for (const ring of collectRings(feature)) {
      const local = ringToLocal(ring, project);
      if (local.length < 3) continue;
      const shapePts = local.map((p) => new THREE.Vector2(p.x, p.z));
      if (!THREE.ShapeUtils.isClockWise(shapePts)) shapePts.reverse();
      let faces;
      try { faces = THREE.ShapeUtils.triangulateShape(shapePts, []); } catch { continue; }
      const base = positions.length / 3;
      for (const p of shapePts) {
        positions.push(p.x, 0, p.y);
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
      }
      for (const [a, b, c] of faces) indices.push(base + a, base + b, base + c);
    }
  }
  if (!indices.length) return [];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  setKnownBounds(geo, [minX, 0, minZ, maxX, 0, maxZ]);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = y;
  scene.add(mesh);
  return [mesh];
}

export class GroundLayer {
  constructor(scene, cityConfig) {
    this.scene = scene;
    this.project = makeProjector(cityConfig.origin);
    this.landuseMeshes = [];
    this.vegetationMeshes = [];
    this.waterMeshes = [];
    this.landuseMaterial = null;
    this.vegetationMaterial = null;
    this.waterMaterial = null;
  }

  load({ landuse, vegetation, water }, palette) {
    this.landuseMaterial = new THREE.MeshBasicMaterial({ color: palette.landuse, side: THREE.DoubleSide });
    this.landuseMeshes = buildFlatPolygons(this.scene, this.project, landuse, this.landuseMaterial, Y_LANDUSE);

    this.vegetationMaterial = new THREE.MeshBasicMaterial({ color: palette.veg, side: THREE.DoubleSide });
    this.vegetationMeshes = buildFlatPolygons(this.scene, this.project, vegetation, this.vegetationMaterial, Y_VEGETATION);

    this.waterMaterial = new THREE.MeshBasicMaterial({ color: palette.water, side: THREE.DoubleSide });
    this.waterMeshes = buildFlatPolygons(this.scene, this.project, water, this.waterMaterial, Y_WATER);
  }

  /** Water polygons, in local scene coords, for TreeLayer's isInWater() exclusion test. */
  getWaterRingsLocal(waterGeojson) {
    if (!waterGeojson?.features?.length) return [];
    const rings = [];
    for (const f of waterGeojson.features) {
      for (const ring of collectRings(f)) {
        const local = ringToLocal(ring, this.project);
        if (local.length >= 3) rings.push(local);
      }
    }
    return rings;
  }

  repaint(palette) {
    // Water intentionally does not repaint day/night: it is one flat colour, and the atmosphere (fog, light) does the work.
    if (this.landuseMaterial) this.landuseMaterial.color.setHex(palette.landuse);
    if (this.vegetationMaterial) this.vegetationMaterial.color.setHex(palette.veg);
  }
}
