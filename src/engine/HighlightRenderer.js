// ===================================================================
// HighlightRenderer — the fat-line selection/search outline, in one
// place so both InspectController (click-to-select) and SearchController
// (search-result highlight) share one implementation and one resize
// subscription instead of two copies.
//
// Uses LineSegments2 (screen-space quad-strip lines) because
// THREE.LineBasicMaterial.linewidth is silently ignored by WebGL on
// virtually every platform.
// ===================================================================
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { HIGHLIGHT_LINEWIDTH_PX, BUILDING_SELECT_COLOR } from '../config/constants.js';

export class HighlightRenderer {
  constructor(scene) {
    this.scene = scene;
    this._lines = new Set(); // every live fat-line, so resize() can update .material.resolution on all of them
    // The ONE current selection highlight, shared across every caller
    // (click-to-inspect AND search). Kept as two, one per caller, they
    // would never clear each other: a search followed by a click (or the
    // other way round) could leave two highlights on screen at once, or a
    // stale one lingering after a newer selection should have replaced it.
    // Routing both through setActive()/clearActive() here makes "there
    // is only one current highlight" true regardless of which action
    // created it.
    this.active = null;
  }

  /** Disposes whatever is currently active (regardless of who set it) and makes `mesh` the new active highlight. */
  setActive(mesh) {
    this.clearActive();
    this.active = mesh;
    return mesh;
  }

  clearActive() {
    if (!this.active) return;
    this.dispose(this.active);
    this.active = null;
  }

  /** For a caller's own auto-hide timer: only clear if `mesh` is STILL the active highlight -- guards against a stale timer (from a highlight that's already been replaced by something newer) wiping out that newer one. */
  isActive(mesh) {
    return this.active === mesh;
  }

  /**
   * Compiles the fat-line shader now instead of as a hitch the first time
   * something is selected or searched for (measured ~100 ms, right as a
   * search fly-to lands). A throwaway line with make()'s exact material
   * settings is compiled against the real scene and its material is KEPT --
   * three.js destroys a compiled program when the last material using it is
   * disposed, and every real highlight disposes its own on clear.
   */
  warm(renderer, camera) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions([0, 0, 0, 1, 0, 0]);
    const mat = new LineMaterial({ color: BUILDING_SELECT_COLOR, linewidth: HIGHLIGHT_LINEWIDTH_PX, worldUnits: false, depthTest: false, transparent: true, dashed: false });
    const warm = new THREE.Scene();
    warm.add(new LineSegments2(geo, mat));
    renderer.compile(warm, camera, this.scene);
    this._warm = { geo, mat };
  }

  /** @param {number[]} segPositions flat [x,y,z, x,y,z, ...] pairs, one line segment per pair */
  make(segPositions, color = BUILDING_SELECT_COLOR) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(segPositions);
    const mat = new LineMaterial({ color, linewidth: HIGHLIGHT_LINEWIDTH_PX, worldUnits: false, depthTest: false, transparent: true, dashed: false });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    const line = new LineSegments2(geo, mat);
    line.renderOrder = 999;
    line.computeLineDistances();
    this._lines.add(line);
    this.scene.add(line);
    return line;
  }

  dispose(line) {
    if (!line) return;
    this.scene.remove(line);
    this._lines.delete(line);
    line.geometry.dispose();
    line.material.dispose();
  }

  /** Roofline + vertical-corner cage around one building -- same shape as the building's own always-on outline, in the selection accent color, drawn on top. */
  makeBuildingCage(b, color) {
    const { flat, n, height } = b;
    const positions = [];
    const y = height + 0.15;
    for (let i = 0; i < n; i++) {
      const x0 = flat[i * 2], z0 = flat[i * 2 + 1];
      const j = (i + 1) % n;
      const x1 = flat[j * 2], z1 = flat[j * 2 + 1];
      positions.push(x0, y, z0, x1, y, z1);
      positions.push(x0, 0, z0, x0, y, z0);
    }
    return this.make(positions, color);
  }

  /** Flat boundary trace for a road/ward/zone polygon (or a search result's ring set). */
  makePolygonOutline(flat, n, y, color) {
    const positions = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      positions.push(flat[i * 2], y, flat[i * 2 + 1], flat[j * 2], y, flat[j * 2 + 1]);
    }
    return this.make(positions, color);
  }

  /** Multiple rings at once (a search result can carry several disjoint outline pieces). */
  makeRingsOutline(rings, y, color) {
    const positions = [];
    for (const flat of rings) {
      const n = flat.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        positions.push(flat[i * 2], y, flat[i * 2 + 1], flat[j * 2], y, flat[j * 2 + 1]);
      }
    }
    return this.make(positions, color);
  }

  /** Fallback for a search result with no polygon of its own (a metro/orientation point label) -- a flat ring marker, not a fat line. */
  makeRingMarker(x, z, color = BUILDING_SELECT_COLOR) {
    const geo = new THREE.RingGeometry(18, 24, 32);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.36, z);
    mesh.renderOrder = 999;
    this.scene.add(mesh);
    return mesh;
  }

  onResize() {
    for (const line of this._lines) line.material.resolution.set(window.innerWidth, window.innerHeight);
  }
}
