// ===================================================================
// PaletteController — the one place that repaints every material in the
// scene on a day/night switch, plus weather-mood (sun/cloudy/overcast/
// rain) fog/light/rain adjustments and the rain particle system.
//
// Deliberately holds references to every layer instead of each layer
// polling a global palette: one function walks every material, from an
// explicit dependency list and not module-scope globals, so a second
// TwinEngine instance wouldn't share state through window/module scope.
// ===================================================================
import * as THREE from 'three';
import { DEFAULT_PALETTES } from '../config/palettes.js';
import { darkenHex } from '../config/constants.js';

const FLOODLIGHT_INTENSITY_NIGHT = 0.12;
const BASE_SUN_INTENSITY = { day: 1.1, night: 0.22 };
const BASE_HEMI_INTENSITY = { day: 2.2, night: 1.0 };
const BASE_TURBIDITY = { day: 2.2, night: 0.5 };
const NIGHT_FOG_MIN_LUM = 0.05;
const NIGHT_FOG_DISTANCE_MUL = 1.35;

const WEATHER_MOODS = {
  sun: { fogNear: 9000, fogFar: 22000, sunMul: 1.0, hemiMul: 1.0, turbidityMul: 1.0 },
  cloudy: { fogNear: 8000, fogFar: 20000, sunMul: 0.85, hemiMul: 0.9, turbidityMul: 1.3 },
  overcast: { fogNear: 6000, fogFar: 16000, sunMul: 0.6, hemiMul: 0.75, turbidityMul: 1.8 },
  rain: { fogNear: 3500, fogFar: 10000, sunMul: 0.4, hemiMul: 0.6, turbidityMul: 2.4 },
};

const RAIN_COUNT = 4000, RAIN_SPREAD = 1400, RAIN_BOX_HEIGHT = 900, RAIN_FALL_SPEED = 620;
const RAIN_WIND = { x: 55, z: 20 }, RAIN_STREAK_LEN = 22;
const RAIN_COLOR_FOR_BRIGHT_BG = [0.20, 0.28, 0.40, 0.65];
const RAIN_COLOR_FOR_DARK_BG = [0.80, 0.88, 0.97, 0.45];

export class PaletteController {
  constructor({ scene, camera, renderer, sky, fog, hemi, sun, groundMesh, roadLayer, groundLayer, treeLayer, shadowLayer, buildingLayer, cityConfig, scheduler }) {
    Object.assign(this, { scene, camera, renderer, sky, fog, hemi, sun, groundMesh, roadLayer, groundLayer, treeLayer, shadowLayer, buildingLayer, scheduler });
    this.palettes = { day: { ...DEFAULT_PALETTES.day, ...(cityConfig.palette?.day ?? {}) }, night: { ...DEFAULT_PALETTES.night, ...(cityConfig.palette?.night ?? {}) } };
    this.paletteName = 'day';
    this.weatherMood = 'sun';
    this._skySampleTarget = new THREE.WebGLRenderTarget(1, 1);
    this._skySampleCamera = new THREE.PerspectiveCamera(1, 1, 1, 100000);
    this._skySamplePixel = new Uint8Array(4);
    this._buildRain();
  }

  _buildRain() {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(RAIN_COUNT * 2 * 3), bases = new Float32Array(RAIN_COUNT * 2 * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const bx = (Math.random() - 0.5) * RAIN_SPREAD * 2, by = Math.random() * RAIN_BOX_HEIGHT, bz = (Math.random() - 0.5) * RAIN_SPREAD * 2;
      for (let v = 0; v < 2; v++) {
        const vi = (i * 2 + v) * 3;
        bases[vi] = bx; bases[vi + 1] = by; bases[vi + 2] = bz;
        positions[vi] = v === 0 ? 0 : RAIN_WIND.x * 0.02;
        positions[vi + 1] = v === 0 ? 0 : -RAIN_STREAK_LEN;
        positions[vi + 2] = v === 0 ? 0 : RAIN_WIND.z * 0.02;
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aBase', new THREE.Float32BufferAttribute(bases, 3));

    this.rainMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uFallSpeed: { value: RAIN_FALL_SPEED }, uBoxHeight: { value: RAIN_BOX_HEIGHT }, uColor: { value: new THREE.Vector4(...RAIN_COLOR_FOR_BRIGHT_BG) } },
      vertexShader: `attribute vec3 aBase; uniform float uTime; uniform float uFallSpeed; uniform float uBoxHeight;
        void main() {
          float y = mod(aBase.y - uTime * uFallSpeed, uBoxHeight);
          vec3 worldLocal = vec3(aBase.x, y, aBase.z) + position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(worldLocal, 1.0);
        }`,
      fragmentShader: `uniform vec4 uColor; void main() { gl_FragColor = uColor; }`,
    });
    this.rainMesh = new THREE.LineSegments(geo, this.rainMaterial);
    this.rainMesh.frustumCulled = false; // re-centered on the camera every frame; a static bbox would cull it wrong
    this.rainMesh.visible = false;
    this.scene.add(this.rainMesh);
  }

  updateRain() {
    if (!this.rainMesh.visible) return;
    this.rainMesh.position.set(this.camera.position.x, this.camera.position.y - RAIN_BOX_HEIGHT / 2, this.camera.position.z);
    this.rainMaterial.uniforms.uTime.value = performance.now() / 1000;
  }

  _sampleSkyHorizonColor(outColor) {
    this._skySampleCamera.position.set(0, 200, 0);
    this._skySampleCamera.lookAt(10000, 200, 0);
    this._skySampleCamera.updateMatrixWorld();
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._skySampleTarget);
    this.renderer.render(this.sky, this._skySampleCamera);
    this.renderer.readRenderTargetPixels(this._skySampleTarget, 0, 0, 1, 1, this._skySamplePixel);
    this.renderer.setRenderTarget(prevTarget);
    outColor.setRGB(this._skySamplePixel[0] / 255, this._skySamplePixel[1] / 255, this._skySamplePixel[2] / 255, THREE.SRGBColorSpace);
    return outColor;
  }

  /**
   * Day <-> night. Only what the weather mood does NOT also set is written
   * here; applyWeatherMood() (called at the end) owns the ground, sky,
   * fog, roads, light intensities, turbidity and shadow strength, because
   * each of those depends on day/night AND the mood together. Setting them
   * here first as well only meant repainting every road material twice per
   * switch, with the first result thrown away.
   * @param {'day'|'night'} name
   */
  applyPalette(name) {
    const p = this.palettes[name];
    if (!p) return;
    this.paletteName = name;
    const isNight = name === 'night';

    // The layer remembers the glow and applies it to tiles built later, and to each tile's kept-coarse meshes (see BuildingLayer.setGlow).
    this.buildingLayer.setGlow(isNight ? { wall: FLOODLIGHT_INTENSITY_NIGHT, roof: FLOODLIGHT_INTENSITY_NIGHT * 0.7 } : null);
    this.groundLayer.repaint(p);
    this.treeLayer.repaint(p);
    // Before applyWeatherMood(): it renders the sky to sample the horizon colour for the fog, so the sky must already be in its day/night state.
    this.sky.material.uniforms.rayleigh.value = isNight ? 0.05 : 0.55;

    document.body.classList.toggle('night-mode', isNight);
    this.applyWeatherMood(this.weatherMood); // the mood-dependent half of the repaint, for the new day/night state
    this.onPaletteApplied?.(name); // TwinEngine keeps the toolbar's Day / Night button in step
  }

  /** @param {'sun'|'cloudy'|'overcast'|'rain'} moodKey */
  applyWeatherMood(moodKey) {
    const mood = WEATHER_MOODS[moodKey];
    if (!mood) return;
    this.weatherMood = moodKey;
    const isNight = this.paletteName === 'night';
    this.shadowLayer.setWeatherStrength(isNight ? 'night' : moodKey);

    const baseSun = isNight ? BASE_SUN_INTENSITY.night : BASE_SUN_INTENSITY.day;
    const baseHemi = isNight ? BASE_HEMI_INTENSITY.night : BASE_HEMI_INTENSITY.day;
    const baseTurb = isNight ? BASE_TURBIDITY.night : BASE_TURBIDITY.day;

    this.fog.near = mood.fogNear * (isNight ? NIGHT_FOG_DISTANCE_MUL : 1);
    this.fog.far = mood.fogFar * (isNight ? NIGHT_FOG_DISTANCE_MUL : 1);
    this.sun.intensity = baseSun * mood.sunMul;
    this.hemi.intensity = baseHemi * mood.hemiMul;
    this.sky.material.uniforms.turbidity.value = baseTurb * mood.turbidityMul;

    this._sampleSkyHorizonColor(this.fog.color);
    if (isNight) {
      const lum = 0.2126 * this.fog.color.r + 0.7152 * this.fog.color.g + 0.0722 * this.fog.color.b;
      if (lum > 1e-4 && lum < NIGHT_FOG_MIN_LUM) {
        const scale = NIGHT_FOG_MIN_LUM / lum;
        this.fog.color.setRGB(Math.min(1, this.fog.color.r * scale), Math.min(1, this.fog.color.g * scale), Math.min(1, this.fog.color.b * scale));
      } else if (lum <= 1e-4) {
        this.fog.color.setRGB(0.055, 0.063, 0.078);
      }
    }
    this.scene.background.copy(this.fog.color);

    const fogLum = 0.2126 * this.fog.color.r + 0.7152 * this.fog.color.g + 0.0722 * this.fog.color.b;
    this.rainMaterial.uniforms.uColor.value.set(...(fogLum > 0.55 ? RAIN_COLOR_FOR_BRIGHT_BG : RAIN_COLOR_FOR_DARK_BG));

    const p = this.palettes[this.paletteName];
    const wetFactor = moodKey === 'rain' ? 0.72 : 1.0;
    this.groundMesh.material.color.setHex(darkenHex(THREE, p.ground, wetFactor));
    this.roadLayer.repaint(p, isNight, wetFactor);

    this.rainMesh.visible = moodKey === 'rain';

    // Every caller ends up here (applyPalette() itself funnels through
    // this at its own end) -- one markDirty() here covers the manual
    // night-toggle button AND the automatic 15-minute weather-fetch
    // repaint, which has no camera movement of its own and would
    // otherwise sit fully repainted but undrawn if the user is idle when
    // it fires (same idle-render gap as the click-highlight bug).
    this.scheduler?.markDirty();
  }
}
