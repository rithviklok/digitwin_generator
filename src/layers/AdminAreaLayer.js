// ===================================================================
// AdminAreaLayer — administrative boundary polygons (KMC wards + zones
// for Kanpur; any city's admin-wards/admin-zones layers work the same
// way).
//
// One mesh per feature: an invisible fill for click-picking, plus a
// boundary outline hidden by default (shown only as the click-to-
// inspect / search highlight). No colour fill -- there's nothing to
// legend it with.
// ===================================================================
import * as THREE from 'three';
import { makeProjector, projectRingFlat, collectRings } from '../workers/geo-utils.js';

export class AdminAreaLayer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../config/city-schema.js').CityConfig} cityConfig
   * @param {{outlineColor: number, y: number, metaFn: (props: Record<string, any>) => Record<string, any>}} opts
   *   y: height of the outline/pick surface (wards and zones sit at different heights so they never z-fight);
   *   metaFn: what the inspect card shows for a feature's properties
   */
  constructor(scene, cityConfig, { outlineColor, y, metaFn }) {
    this.scene = scene;
    this.project = makeProjector(cityConfig.origin);
    this.outlineColor = outlineColor;
    this.y = y;
    this.metaFn = metaFn;
    this.meshes = [];
    this.pickMeshes = [];
  }

  /** @param {{features?: Array<{geometry: any, properties?: Record<string, any>}>}|null} fc */
  load(fc) {
    if (!fc?.features?.length) return;

    const outlineMat = new THREE.LineBasicMaterial({ color: this.outlineColor });
    // The fills exist only to be clicked. They used to be drawn every frame at
    // opacity 0 -- for wards and zones together, two transparent passes over
    // the whole city that changed no pixel but cost fill rate (and wrote
    // depth). material.visible = false keeps them out of the render list,
    // while raycasting still hits them: three.js's Raycaster tests object
    // layers, never material visibility (and InspectController filters on
    // the OBJECT's .visible, which stays true).
    const fillMat = new THREE.MeshBasicMaterial({ color: this.outlineColor, side: THREE.DoubleSide, visible: false });

    for (const f of fc.features) {
      for (const ring of collectRings(f)) {
        const flat = projectRingFlat(ring, this.project);
        const n = flat.length / 2;
        if (n < 3) continue;

        const linePos = new Float32Array(n * 2 * 3);
        let w = 0;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          linePos[w++] = flat[i * 2]; linePos[w++] = this.y; linePos[w++] = flat[i * 2 + 1];
          linePos[w++] = flat[j * 2]; linePos[w++] = this.y; linePos[w++] = flat[j * 2 + 1];
        }
        const line = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3)), outlineMat);
        line.visible = false; // shown only via click/search highlight
        this.scene.add(line);
        this.meshes.push(line);

        let tris = null;
        if (n > 4) {
          const shapePts = new Array(n);
          for (let i = 0; i < n; i++) shapePts[i] = new THREE.Vector2(flat[i * 2], flat[i * 2 + 1]);
          try { tris = THREE.ShapeUtils.triangulateShape(shapePts, []); } catch { tris = []; }
        }
        const triCount = tris === null ? n - 2 : tris.length;
        if (triCount <= 0) continue;

        const fillPos = new Float32Array(triCount * 3 * 3);
        let fw = 0;
        const writeTri = (ia, ib, ic) => {
          fillPos[fw++] = flat[ia * 2]; fillPos[fw++] = this.y; fillPos[fw++] = flat[ia * 2 + 1];
          fillPos[fw++] = flat[ib * 2]; fillPos[fw++] = this.y; fillPos[fw++] = flat[ib * 2 + 1];
          fillPos[fw++] = flat[ic * 2]; fillPos[fw++] = this.y; fillPos[fw++] = flat[ic * 2 + 1];
        };
        if (tris === null) { for (let i = 1; i < n - 1; i++) writeTri(0, i, i + 1); }
        else { for (const [ia, ib, ic] of tris) writeTri(ia, ib, ic); }

        const fillMesh = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(fillPos, 3)), fillMat);
        fillMesh.userData.areaMeta = this.metaFn(f.properties || {});
        fillMesh.userData.flat = flat;
        fillMesh.userData.n = n;
        this.scene.add(fillMesh);
        this.meshes.push(fillMesh);
        this.pickMeshes.push(fillMesh);
      }
    }
  }
}
