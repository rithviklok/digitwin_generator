// ===================================================================
// DirtyScheduler — lets the render loop sit idle. Running the full
// update suite (building LOD, shadow visibility, tree LOD, label
// placement) and drawing the scene on EVERY frame costs the same with a
// perfectly still camera and nothing animating as it does in motion.
//
// Any system that can change what's on screen calls markDirty(). The
// render loop calls consume() once per frame: true at most once per
// actual change, false on every otherwise-idle frame -- which is where a
// twin sits the overwhelming majority of the time.
// ===================================================================
export class DirtyScheduler {
  constructor() {
    // Dirty on construction so the very first frame always renders.
    this._dirty = true;
  }

  markDirty() {
    this._dirty = true;
  }

  /** @returns {boolean} true at most once per markDirty() call -- clears the flag. */
  consume() {
    const was = this._dirty;
    this._dirty = false;
    return was;
  }
}
