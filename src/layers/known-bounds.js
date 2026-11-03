// ===================================================================
// known-bounds -- give a geometry its bounding sphere from a box we
// already know, so three.js never has to work it out from the vertices.
//
// three.js computes a geometry's bounding sphere with a loop over EVERY
// vertex, the first time the object is sorted or frustum-culled (twice per
// mesh: once for the box, once for the sphere). That is about 1 ms per MB of
// vertex data normally -- but ~24 ms per MB in a browser running with the
// JavaScript JIT switched off (Edge's "Enhance your security on the web"
// mode does that), where a single 17 MB tile mesh cost ~400 ms in one frame
// and boot took ~12 s instead of ~3 s. It was the whole reason "GPU uploads"
// looked slow in a real-session perf report.
//
// The box must be the geometry's EXACT bounding box, not just one that
// contains it: three.js uses the box centre as the sphere centre and sorts
// transparent meshes by that centre, so a looser box changes the draw order
// and therefore the blended pixels (measured with a tile-wide box: 6-9% of
// pixels differ). Exact boxes for building tiles are computed offline
// (workers/tile-bounds.js, stored in manifest.json); the shadow mesh's is
// tracked while it is built (ShadowLayer._bakeTile).
// ===================================================================
import * as THREE from 'three';

const _box = new THREE.Box3();

/** @param {THREE.BufferGeometry} geometry @param {number[]} box [minX, minY, minZ, maxX, maxY, maxZ] -- the exact bounds of the geometry's positions */
export function setKnownBounds(geometry, box) {
  _box.min.set(box[0], box[1], box[2]);
  _box.max.set(box[3], box[4], box[5]);
  // Same centre three.js would compute; the radius is the box's half-diagonal, which is >= the true (vertex-based) radius, so culling stays conservative.
  geometry.boundingSphere = _box.getBoundingSphere(new THREE.Sphere());
  // The box as well. Rendering never reads it, but picking does: a building tile's sphere is ~1.4 km across while
  // its box is a thin slab, so with the box three.js's own raycast -- and engine/MeshPicker.js's ordering -- can
  // rule out most tiles a click ray passes over without looking at a single triangle.
  geometry.boundingBox = _box.clone();
}
