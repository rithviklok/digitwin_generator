// ===================================================================
// GpuUploadQueue -- moves the GPU upload of a mesh's vertex buffers to a
// time of OUR choosing, instead of the first frame it is drawn.
//
// three.js only uploads a geometry's buffers (gl.bufferData) inside
// renderer.render(), for objects that are visible AND pass frustum culling.
// Everything in this scene starts hidden: coarse tiles, hidden tree/outline
// meshes, and tiles the streamer has already fetched and built while the
// camera was still above BUILDING_HIDE_ABOVE_HEIGHT. So the moment the camera
// crossed that height, ONE frame uploaded ~100-300 MB at once -- measured at
// 250-400 ms of a single render() call on a fast desktop GPU, and seconds on a
// slower/shared-memory one (the "+ button: nothing for a few seconds, then
// buildings all appear at once" report; a zoom that pauses the whole screen
// and clock).
//
// Fix: watch everything added to the scene, and upload it early and invisibly:
// draw it once, clipped to a single pixel, on a layer the main camera never
// uses (so the frame that follows overwrites that pixel), a few ms per frame.
// Same scene => same fog/lights => the SAME shader programs the real draw uses
// (a separate scene or render target would compile new program variants,
// which is its own 100+ ms hitch).
// ===================================================================
import * as THREE from 'three';
import { GPU_UPLOAD_BUDGET_MS, GPU_UPLOAD_BATCH_BYTES } from '../config/constants.js';

const WARM_LAYER = 31; // nothing else in the app uses it

const _scissor = new THREE.Vector4();

function geometryBytes(geometry) {
  let bytes = 0;
  for (const a of Object.values(geometry.attributes)) bytes += (a.array ?? a.data?.array)?.byteLength ?? 0;
  if (geometry.index?.array) bytes += geometry.index.array.byteLength;
  return bytes;
}

export class GpuUploadQueue {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    /** Called when work is queued, so an idle-gated render loop wakes up to drain it. */
    this.onNeedsFrame = null;
    /** Optional (the ?perf probe): (objectCount, bytes, ms) after each upload pass. */
    this.onUpload = null;

    this._queue = [];
    this._seen = new WeakSet(); // geometries already queued or uploaded -- never twice
    this._lights = new Set();   // lights must join the warm layer or the pass would compile a "no lights" program variant

    // childadded fires for direct children only; nested groups are covered by traversing what was added.
    scene.addEventListener('childadded', (e) => this._enqueueTree(e.child));
  }

  get pending() { return this._queue.length > 0; }

  /** Pick up everything that was added to the scene before this queue existed. */
  scanScene() { this._enqueueTree(this.scene); }

  _enqueueTree(root) {
    let added = false;
    root.traverse((o) => {
      if (o.isLight) { this._lights.add(o); return; }
      if (!(o.isMesh || o.isLine || o.isPoints) || !o.geometry?.attributes?.position) return;
      if (this._seen.has(o.geometry)) return;
      this._seen.add(o.geometry);
      this._queue.push(o);
      added = true;
    });
    if (added) this.onNeedsFrame?.();
  }

  _isLive(o) {
    let p = o;
    while (p.parent) p = p.parent;
    return p === this.scene; // tiles are removed from the scene BEFORE their geometry is disposed; uploading a disposed one would leak GPU memory
  }

  /**
   * Upload queued objects until about budgetMs has been spent (always at least
   * one batch). Call it in a frame that is about to render the main scene anyway.
   * @returns {number} objects uploaded
   */
  drain(budgetMs = GPU_UPLOAD_BUDGET_MS) {
    const t0 = performance.now();
    let uploaded = 0;
    while (this._queue.length) {
      const batch = [];
      let bytes = 0;
      while (this._queue.length && bytes < GPU_UPLOAD_BATCH_BYTES && batch.length < 32) {
        const o = this._queue.shift();
        if (!this._isLive(o)) continue;
        batch.push(o);
        bytes += geometryBytes(o.geometry);
      }
      if (batch.length) {
        const t1 = this.onUpload ? performance.now() : 0;
        this._uploadBatch(batch);
        uploaded += batch.length;
        this.onUpload?.(batch.length, bytes, performance.now() - t1);
      }
      if (performance.now() - t0 >= budgetMs) break;
    }
    return uploaded;
  }

  /** Boot: upload everything behind the loading screen, in chunks so the page stays responsive. */
  async drainAll(chunkMs) {
    while (this._queue.length) {
      this.drain(chunkMs);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  _uploadBatch(objs) {
    const r = this.renderer, cam = this.camera;
    const saved = objs.map((o) => [o.visible, o.frustumCulled, o.layers.mask]);
    const savedLights = [...this._lights].map((l) => [l, l.layers.mask]);
    const prevAutoClear = r.autoClear, prevScissorTest = r.getScissorTest(), prevCamMask = cam.layers.mask;
    r.getScissor(_scissor);
    try {
      r.autoClear = false;
      r.setScissorTest(true);
      r.setScissor(0, 0, 1, 1);
      cam.layers.set(WARM_LAYER);
      for (const l of this._lights) l.layers.enable(WARM_LAYER);
      for (const o of objs) { o.visible = true; o.frustumCulled = false; o.layers.set(WARM_LAYER); }
      r.render(this.scene, cam);
    } finally {
      objs.forEach((o, i) => { [o.visible, o.frustumCulled, o.layers.mask] = saved[i]; });
      for (const [l, mask] of savedLights) l.layers.mask = mask;
      cam.layers.mask = prevCamMask;
      r.setScissor(_scissor.x, _scissor.y, _scissor.z, _scissor.w);
      r.setScissorTest(prevScissorTest);
      r.autoClear = prevAutoClear;
    }
  }
}
