// ===================================================================
// CameraRig — OrbitControls setup + search fly-to + compass reset +
// manual zoom buttons.
//
// Every tween here (flyTo, compass reset) is run from TwinEngine's
// _animate() on every frame -- see there for why tweens are the one
// thing that still runs unconditionally, while everything else waits for
// the DirtyScheduler.
// ===================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MIN_CAMERA_HEIGHT_M } from '../config/constants.js';

export class CameraRig {
  constructor(camera, domElement, scheduler) {
    this.camera = camera;
    this.scheduler = scheduler;
    this.orbit = new OrbitControls(camera, domElement);
    this.orbit.target.set(0, 0, 0);
    this.orbit.maxPolarAngle = Math.PI * 0.49; // stop just short of going under the ground
    this.orbit.minDistance = 3;
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.zoomSpeed = 2.5;
    // Button roles swapped from OrbitControls' defaults: left-drag pans, right-drag rotates/tilts.
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.orbit.enableRotate = true;
    this.orbit.enablePan = true;
    this.orbit.screenSpacePanning = false; // ground-plane-only panning, no vertical drift on an oblique camera
    this.orbit.addEventListener('change', () => scheduler.markDirty());

    this._flyState = null;
    this._compassResetState = null;
  }

  /** Called once at startup. */
  init() {
    this.orbit.enabled = true;
    this.orbit.target.set(0, 0, 0);
    this.camera.position.set(0, 4500, -4500); // north-up default: camera south of downtown looking north
    this.orbit.maxDistance = this.camera.position.distanceTo(this.orbit.target);
    this.orbit.update();
  }

  flyTo(x, z, targetDistance = 700) {
    const toTarget = new THREE.Vector3(x, 0, z);
    const offsetDir = this.camera.position.clone().sub(this.orbit.target);
    if (offsetDir.lengthSq() < 1e-6) offsetDir.set(0, 1, 1);
    offsetDir.normalize();
    const toPos = toTarget.clone().addScaledVector(offsetDir, targetDistance);
    this._flyState = { fromTarget: this.orbit.target.clone(), toTarget, fromPos: this.camera.position.clone(), toPos, start: performance.now(), duration: 900 };
  }

  /**
   * The current view as the orbit point on the ground plus how the camera
   * looks at it -- what a share link or the embed API stores and restores.
   * heading: compass degrees (0 = looking north); tilt: degrees from
   * straight down (0 = top-down, ~88 = at the horizon).
   */
  getView() {
    const t = this.orbit.target;
    return {
      x: t.x, z: t.z,
      distance: this.camera.position.distanceTo(t),
      headingDeg: ((this.headingDeg() % 360) + 360) % 360,
      tiltDeg: THREE.MathUtils.radToDeg(this.orbit.getPolarAngle()),
    };
  }

  /** Moves to a getView()-shaped view -- instantly, or with the same 900 ms tween as a search fly-to (which also pre-loads the destination's building tiles). */
  setView({ x, z, distance, headingDeg, tiltDeg }, { animate = true } = {}) {
    const toTarget = new THREE.Vector3(x, 0, z);
    const current = this.getView();
    const s = new THREE.Spherical(
      THREE.MathUtils.clamp(distance ?? current.distance, this.orbit.minDistance, this.orbit.maxDistance),
      THREE.MathUtils.clamp(THREE.MathUtils.degToRad(tiltDeg ?? current.tiltDeg), 0.01, this.orbit.maxPolarAngle),
      Math.PI - THREE.MathUtils.degToRad(headingDeg ?? current.headingDeg), // inverse of headingDeg()
    );
    const toPos = toTarget.clone().add(new THREE.Vector3().setFromSpherical(s));
    if (animate) {
      this._flyState = { fromTarget: this.orbit.target.clone(), toTarget, fromPos: this.camera.position.clone(), toPos, start: performance.now(), duration: 900 };
    } else {
      this._flyState = null;
      this.orbit.target.copy(toTarget);
      this.camera.position.copy(toPos);
      this.orbit.update();
    }
    this.scheduler.markDirty();
  }

  /** Where the camera will end up while a fly-to is in flight, else null -- lets the building streamer load the destination's tiles during the flight. */
  get flyDestination() { return this._flyState?.toPos ?? null; }

  /** @returns {boolean} true while a tween is still in flight -- TwinEngine's active-tween set expects this shape. */
  updateFlyTo() {
    if (!this._flyState) return false;
    const t = Math.min(1, (performance.now() - this._flyState.start) / this._flyState.duration);
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; // ease-in-out-quad
    this.orbit.target.lerpVectors(this._flyState.fromTarget, this._flyState.toTarget, e);
    this.camera.position.lerpVectors(this._flyState.fromPos, this._flyState.toPos, e);
    if (t >= 1) { this._flyState = null; return false; }
    return true;
  }

  dolly(factor) {
    const offset = this.camera.position.clone().sub(this.orbit.target);
    const dist = THREE.MathUtils.clamp(offset.length() * factor, this.orbit.minDistance, this.orbit.maxDistance);
    offset.setLength(dist);
    this.camera.position.copy(this.orbit.target).add(offset);
    this.orbit.update();
    this.scheduler.markDirty();
  }

  resetToNorth() {
    const offset = this.camera.position.clone().sub(this.orbit.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const startTheta = spherical.theta;
    // theta=PI (camera south of target, looking north) is north-up on screen; theta=0 is the startup view.
    let delta = Math.PI - startTheta;
    delta = ((delta + Math.PI) % (2 * Math.PI)) - Math.PI; // shortest-path wrap
    this._compassResetState = { spherical, startTheta, delta, t0: performance.now(), duration: 500 };
  }

  /** @returns {boolean} true while the compass-reset tween is still in flight. */
  updateCompassReset() {
    if (!this._compassResetState) return false;
    const { spherical, startTheta, delta, t0, duration } = this._compassResetState;
    const e = Math.min(1, (performance.now() - t0) / duration);
    const eased = 1 - (1 - e) ** 3; // ease-out cubic
    spherical.theta = startTheta + delta * eased;
    this.camera.position.copy(this.orbit.target).add(new THREE.Vector3().setFromSpherical(spherical));
    this.orbit.update();
    if (e >= 1) { this._compassResetState = null; return false; }
    return true;
  }

  /** Runs every frame unconditionally -- see TwinEngine._animate()'s comment on why. */
  tick() {
    this.orbit.update();
    this.orbit.target.y = 0;
    if (this.camera.position.y < MIN_CAMERA_HEIGHT_M) this.camera.position.y = MIN_CAMERA_HEIGHT_M;
  }

  headingDeg() {
    return THREE.MathUtils.radToDeg(Math.PI - this.orbit.getAzimuthalAngle());
  }
}
