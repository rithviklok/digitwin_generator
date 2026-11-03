// ===================================================================
// LabelLayer — every text label on the map (orientation, locality, KMC
// landmark, metro/railway station, building-name) plus the SEARCH_INDEX
// they populate as they run.
//
// Curated per-city lists (orientation allowlist, which station names are
// railway vs metro) come from CityConfig.labels -- see city-schema.js's
// note on why those are per-city content.
// ===================================================================
import * as THREE from 'three';
import { makeProjector, ringToLocal, projectRingFlat, collectRings } from '../workers/geo-utils.js';
import { toTitleCase, normalizeLabelName, Y_KMC_ROAD } from '../config/constants.js';

const BUILDING_LABEL_DISTANCE = 1000;
const LOCALITY_LABEL_DISTANCE = 4000;
const LOCALITY_LABEL_MAX_HEIGHT = 650;
const KEY_LABEL_GRID_SIZE = 6;
const STREET_LABEL_FLOOR_HEIGHT = 30;
const BUILDING_LABEL_HEIGHTS = { tier1: 1000, tier2: 650, tier3: 300 };
// Exported (with buildingImportance below) so scripts/extract-building-labels.mjs
// can replicate this exact same selection -- name/importance filter, dedupe,
// budget cut -- offline, as one shared source of truth instead of a second
// copy of the same logic that could quietly drift out of sync.
export const LABEL_BUDGET = { building: 400 };
const MIN_RENDER_HEIGHT_M = 1.5;
export const HALL_CLUSTER_RE = /^(hall\s*\d+|mess\s+hall\s*\d+)/i; // IITK-specific noise filter, harmless no-op for cities without it

const _LABEL_HIDE_MARGIN_X = -3, _LABEL_HIDE_MARGIN_Y = -2; // shown -> only yields on a real overlap
const _LABEL_SHOW_MARGIN_X = 5, _LABEL_SHOW_MARGIN_Y = 3;   // hidden -> needs a clear gap to reappear
// Everything that sits over the scene: the controls that are always there,
// and the cards that open over it. A label is hidden rather than drawn
// sliding under one of them with its text cut off.
const CHROME_SELECTORS = [
  '#mapControls', '#controlsHint', '#embedOpenFull',
  '#inspect', '#coveragePanel', '#searchPanel', '#sharePanel', '#zoomHint', '#welcomeBackBanner', '#adminBar', '#missingHint',
];
const CHROME_REMEASURE_MS = 500; // a resize moves them without telling anyone; a card opening or changing does tell (watchChrome)

function parseOsmHeight(props) {
  const h = Number(props?.height_m);
  return Number.isFinite(h) && h >= MIN_RENDER_HEIGHT_M ? h : null;
}
function bboxCenterOfRings(rings) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const ring of rings) for (const p of ring) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
}
export function buildingImportance(f, project) {
  const rings = collectRings(f);
  if (!rings.length) return 0;
  const local = ringToLocal(rings[0], project);
  if (local.length < 3) return 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of local) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const footprint = (maxX - minX) * (maxZ - minZ);
  return footprint * Math.max(1, parseOsmHeight(f.properties) / 8);
}

export class LabelLayer {
  constructor(cityConfig) {
    this.cityConfig = cityConfig;
    this.project = makeProjector(cityConfig.origin);
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:absolute; inset:0; z-index:8; pointer-events:none; overflow:hidden;';
    document.body.appendChild(this.el);
    this.activeLabels = []; // { el, worldPos, maxDistance, minHeight, maxHeight, avoidOverlap, overlapPriority, _ovShown }
    this.searchIndex = []; // { name, x, y, z, type, highlightRings?, highlightFlat?, highlightN?, highlightY? }
    this._chrome = { measuredAt: -Infinity, top: 0, rects: [] };
  }

  /**
   * A card opening, closing or changing its contents changes where labels
   * may go, but moves no camera -- so nothing would redraw them. This
   * notices, and asks for the frame.
   * @param {() => void} requestFrame
   */
  watchChrome(requestFrame) {
    const observer = new MutationObserver(() => {
      this._chrome.measuredAt = -Infinity;
      requestFrame();
    });
    for (const selector of CHROME_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
    }
  }

  /**
   * Where labels may not go: `top` is the bottom edge of the top bar (0 in
   * an embed, which has none) and `rects` are the controls and open cards
   * over the scene. Read from the DOM, so it follows the layout at any
   * window size without a second copy of the CSS numbers here -- but only
   * every so often, or when watchChrome() says something changed.
   */
  _measureChrome() {
    const now = performance.now();
    if (now - this._chrome.measuredAt < CHROME_REMEASURE_MS) return this._chrome;
    const rects = [];
    for (const selector of CHROME_SELECTORS) {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) rects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    this._chrome = { measuredAt: now, top: document.getElementById('topbar')?.getBoundingClientRect().bottom ?? 0, rects };
    return this._chrome;
  }

  /**
   * @param {object} p named FeatureCollections -- the ONE place mapping
   *   CityConfig roles to what this layer needs is TwinEngine's data
   *   loader, not this file (see TwinEngine._loadCityData()).
   * @param {object|null} p.landuse role LANDUSE (orientation-label name matching)
   * @param {object|null} p.wards role ADMIN_WARDS
   * @param {object|null} p.roads role ROADS (KMC roads -- name search entries + outline lookup)
   * @param {Array<{name: string, x: number, z: number, rings: number[][]}>|null} [p.roadNames] in place of `roads` when the roads
   *   are tiles (RoadLayer.nameIndex): one entry per road name, with where it is and its outline
   * @param {object|null} p.landmarks role LANDMARKS
   * @param {object|null} p.localities role LOCALITIES
   * @param {object|null} p.amenities role AMENITIES (metro/railway station points)
   * @param {object|null} p.buildingLabels role BUILDING_LABELS
   */
  load({ landuse, wards, roads, roadNames, landmarks, localities, amenities, buildingLabels }) {
    const normalizedName = normalizeLabelName;
    const project = this.project;

    const kmcWardOutlinesByName = new Map();
    for (const f of wards?.features ?? []) {
      const name = normalizedName(f.properties?.name);
      if (!name) continue;
      const outlines = collectRings(f).map((r) => projectRingFlat(r, project)).filter((flat) => flat.length >= 6);
      if (outlines.length) kmcWardOutlinesByName.set(name, outlines);
    }
    const kmcRoadOutlinesByName = new Map();
    for (const f of roads?.features ?? []) {
      const name = normalizedName(f.properties?.name);
      if (!name) continue;
      const outlines = collectRings(f).map((r) => projectRingFlat(r, project)).filter((flat) => flat.length >= 6);
      if (outlines.length && !kmcRoadOutlinesByName.has(name)) kmcRoadOutlinesByName.set(name, outlines);
    }

    this._addOrientationLabels(landuse);

    // Ward search entries (no visual label -- wards only ever show via search/click highlight).
    for (const f of wards?.features ?? []) {
      const name = f.properties?.name;
      const key = normalizedName(name);
      if (!key) continue;
      const ring = collectRings(f)[0];
      if (!ring) continue;
      const flat = projectRingFlat(ring, project);
      if (flat.length < 6) continue;
      const center = bboxCenterOfRings([ringToLocal(ring, project)]);
      this.searchIndex.push({ name: toTitleCase(name), x: center.x, y: Y_KMC_ROAD, z: center.z, type: 'ward', highlightRings: kmcWardOutlinesByName.get(key) ?? null });
    }

    const keyLabelNames = this._computeKeyLabelNames(localities, landmarks);

    const coveredNames = new Set();
    for (const f of landmarks?.features ?? []) { const n = normalizedName(f.properties?.name); if (n) coveredNames.add(n); }
    for (const f of roads?.features ?? []) { const n = normalizedName(f.properties?.name); if (n) coveredNames.add(n); }
    for (const r of roadNames ?? []) { const n = normalizedName(r.name); if (n) coveredNames.add(n); }

    this._addLocalityLabels(localities, coveredNames, keyLabelNames, kmcWardOutlinesByName);
    this._addLocalityLabels(landmarks, null, keyLabelNames, kmcWardOutlinesByName, { clickInspect: true });
    this._addMetroStationLabels(amenities);
    this._addBuildingNameLabels(buildingLabels);

    // Named roads still belong in search even though they no longer get a visual label.
    const placedRoadSearchNames = new Set();
    for (const f of roads?.features ?? []) {
      const name = f.properties?.name;
      const key = normalizedName(name);
      const ring = collectRings(f)[0];
      if (!key || placedRoadSearchNames.has(key) || !ring) continue;
      const flat = projectRingFlat(ring, project);
      if (flat.length < 6) continue;
      placedRoadSearchNames.add(key);
      const center = bboxCenterOfRings([ringToLocal(ring, project)]);
      this.searchIndex.push({ name: toTitleCase(name), x: center.x, y: Y_KMC_ROAD, z: center.z, type: 'road', highlightRings: kmcRoadOutlinesByName.get(key) ?? [flat] });
    }
    for (const r of roadNames ?? []) {
      if (!normalizedName(r.name)) continue;
      this.searchIndex.push({ name: toTitleCase(r.name), x: r.x, y: Y_KMC_ROAD, z: r.z, type: 'road', highlightRings: r.rings.map((ring) => Float32Array.from(ring)) });
    }

    this._dedupeSearchIndex();
  }

  _computeKeyLabelNames(localities, landmarks) {
    // Selects one named point per grid cell so the always-visible label
    // tier represents the whole city instead of clustering around the
    // densest landmark area.
    const candidates = [...(localities?.features ?? []), ...(landmarks?.features ?? [])].filter((f) => f.geometry?.type === 'Point' && normalizeLabelName(f.properties?.name));
    if (!candidates.length) return new Set();
    const points = candidates.map((f) => {
      const p = this.project(f.geometry.coordinates[0], f.geometry.coordinates[1]);
      return { name: normalizeLabelName(f.properties.name), x: p.x, z: p.z };
    });
    const minX = Math.min(...points.map((p) => p.x)), maxX = Math.max(...points.map((p) => p.x));
    const minZ = Math.min(...points.map((p) => p.z)), maxZ = Math.max(...points.map((p) => p.z));
    const width = Math.max(maxX - minX, 1), depth = Math.max(maxZ - minZ, 1);
    const selected = new Set();
    for (let gx = 0; gx < KEY_LABEL_GRID_SIZE; gx++) {
      for (let gz = 0; gz < KEY_LABEL_GRID_SIZE; gz++) {
        const cx = minX + (gx + 0.5) * width / KEY_LABEL_GRID_SIZE, cz = minZ + (gz + 0.5) * depth / KEY_LABEL_GRID_SIZE;
        const nearest = points.filter((p) => !selected.has(p.name)).sort((a, b) => ((a.x - cx) ** 2 + (a.z - cz) ** 2) - ((b.x - cx) ** 2 + (b.z - cz) ** 2))[0];
        if (nearest) selected.add(nearest.name);
      }
    }
    return selected;
  }

  _place(className, text, worldPos, opts) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    this.el.appendChild(el);
    const entry = { el, worldPos, ...opts };
    this.activeLabels.push(entry);
    return entry;
  }

  _addOrientationLabels(landuseFc) {
    const allowlist = new Set(this.cityConfig.labels?.orientationAllowlist ?? []);
    if (allowlist.size === 0) return;
    const placed = new Set();
    let count = 0;
    for (const f of landuseFc?.features ?? []) {
      const name = f.properties?.name;
      if (!name || !allowlist.has(name) || placed.has(name)) continue;
      placed.add(name);
      const rings = collectRings(f).map((r) => ringToLocal(r, this.project));
      if (!rings.length || !rings[0].length) continue;
      const c = bboxCenterOfRings(rings);
      const worldPos = new THREE.Vector3(c.x, 1.5, c.z);
      this._place('label3d flat-label key-label', toTitleCase(name), worldPos, { maxDistance: Infinity, minHeight: -Infinity, avoidOverlap: true, overlapPriority: 100 });
      this.searchIndex.push({ name: toTitleCase(name), x: worldPos.x, y: worldPos.y, z: worldPos.z, type: 'landmark' });
      count++;
    }
    console.info(`[LabelLayer] orientation labels: ${count} placed of ${allowlist.size} in allowlist`);
  }

  _addLocalityLabels(fc, excludeNames, keyLabelNames, kmcWardOutlinesByName, { clickInspect = false } = {}) {
    if (!fc) return;
    // Place names a station label already marks more precisely (e.g. a
    // neighbourhood named after its metro stop): two labels for one spot
    // would just fight over it. Per-city content, so it comes from the
    // city's config (Kanpur's lists two), not from a list in the engine.
    const coveredByStations = new Set(this.cityConfig.labels?.localityNamesCoveredByStations ?? []);
    const placedNames = new Set();
    let count = 0, excludedByKmc = 0;
    for (const f of fc.features) {
      const name = f.properties?.name;
      const key = normalizeLabelName(name);
      if (!key || coveredByStations.has(name) || f.geometry?.type !== 'Point' || placedNames.has(key)) continue;
      if (excludeNames?.has(key)) { excludedByKmc++; continue; }
      placedNames.add(key);
      const p = this.project(f.geometry.coordinates[0], f.geometry.coordinates[1]);
      const isKey = keyLabelNames.has(key);
      const worldPos = new THREE.Vector3(p.x, 1.5, p.z);
      const entry = this._place(
        isKey ? 'label3d flat-label key-label' : 'label3d flat-label',
        toTitleCase(name), worldPos,
        { maxDistance: isKey ? Infinity : LOCALITY_LABEL_DISTANCE, minHeight: isKey ? -Infinity : STREET_LABEL_FLOOR_HEIGHT, maxHeight: isKey ? Infinity : LOCALITY_LABEL_MAX_HEIGHT, avoidOverlap: true, overlapPriority: isKey ? 60 : 40 },
      );
      if (clickInspect) {
        entry.el.style.cursor = 'pointer';
        entry.el.style.pointerEvents = 'auto';
        entry.el.addEventListener('click', (ev) => { ev.stopPropagation(); this.onLandmarkClick?.(entry.el.textContent); });
      }
      this.searchIndex.push({ name: toTitleCase(name), x: p.x, y: 1.5, z: p.z, type: 'locality', highlightRings: kmcWardOutlinesByName.get(key) ?? null });
      count++;
    }
    if (excludedByKmc) console.info(`[LabelLayer] locality labels: ${excludedByKmc} skipped, already covered by a KMC landmark/road`);
    console.info(`[LabelLayer] locality labels: ${count} placed`);
  }

  _addMetroStationLabels(fc) {
    if (!fc) return;
    const railwayNames = new Set(this.cityConfig.labels?.railwayStationNames ?? []);
    const placedMetro = new Set(), placedRail = new Set();
    let count = 0;
    for (const f of fc.features) {
      if (f.properties?.amenity !== 'station') continue;
      const name = f.properties?.name;
      if (!name || f.geometry?.type !== 'Point') continue;
      const isRailway = railwayNames.has(name);
      const placed = isRailway ? placedRail : placedMetro;
      if (placed.has(name)) continue;
      placed.add(name);
      const p = this.project(f.geometry.coordinates[0], f.geometry.coordinates[1]);
      const text = isRailway ? `${toTitleCase(name)} Railway Station` : `${toTitleCase(name)} Metro`;
      const worldPos = new THREE.Vector3(p.x, 1.5, p.z);
      this._place('label3d flat-label key-label', text, worldPos, { maxDistance: Infinity, minHeight: -Infinity, maxHeight: Infinity, avoidOverlap: true, overlapPriority: 90 });
      this.searchIndex.push({ name: text, x: p.x, y: 1.5, z: p.z, type: isRailway ? 'railway' : 'metro' });
      count++;
    }
    console.info(`[LabelLayer] metro/railway station labels: ${count} placed`);
  }

  _addBuildingNameLabels(fc) {
    if (!fc) return;
    const named = fc.features.filter((f) => f.properties?.name && !HALL_CLUSTER_RE.test(f.properties.name));
    const scoredAll = named.map((f) => ({ f, s: buildingImportance(f, this.project) })).filter((e) => e.s > 0).sort((a, b) => b.s - a.s);

    const seen = new Set();
    const scored = [];
    let dupesDropped = 0;
    for (const e of scoredAll) {
      const key = normalizeLabelName(e.f.properties.name);
      if (key && seen.has(key)) { dupesDropped++; continue; }
      if (key) seen.add(key);
      scored.push(e);
      if (scored.length >= LABEL_BUDGET.building) break;
    }
    console.info(`[LabelLayer] building labels: ${scored.length} kept of ${named.length} named (${dupesDropped} same-name dupes dropped)`);

    const tier1Cut = Math.round(scored.length * 0.15), tier2Cut = Math.round(scored.length * 0.50);
    scored.forEach(({ f }, i) => {
      const name = f.properties.name;
      const rings = collectRings(f).map((r) => ringToLocal(r, this.project));
      if (!rings.length || !rings[0].length) return;
      const center = bboxCenterOfRings(rings);
      const buildingFlat = new Float32Array(rings[0].length * 2);
      for (let j = 0; j < rings[0].length; j++) { buildingFlat[j * 2] = rings[0][j].x; buildingFlat[j * 2 + 1] = rings[0][j].z; }
      const height = parseOsmHeight(f.properties) ?? 8;
      const maxHeight = i < tier1Cut ? BUILDING_LABEL_HEIGHTS.tier1 : i < tier2Cut ? BUILDING_LABEL_HEIGHTS.tier2 : BUILDING_LABEL_HEIGHTS.tier3;
      const worldPos = new THREE.Vector3(center.x, height + 3, center.z);
      this._place('label3d building-name', toTitleCase(name), worldPos, { maxDistance: BUILDING_LABEL_DISTANCE, maxHeight, avoidOverlap: true, overlapPriority: 20 });
      this.searchIndex.push({ name: toTitleCase(name), x: center.x, y: height + 3, z: center.z, type: 'building', highlightFlat: buildingFlat, highlightN: buildingFlat.length / 2, highlightY: 0.36 });
    });
  }

  _dedupeSearchIndex() {
    const priority = (e) => (e.type === 'ward' ? 4 : e.type === 'road' ? 3 : e.type === 'locality' ? 2 : e.type === 'building' ? 1 : 0);
    const deduped = new Map();
    for (const entry of this.searchIndex) {
      const key = normalizeLabelName(entry.name) ?? entry.name;
      if (!key) continue;
      const existing = deduped.get(key);
      if (!existing || priority(entry) > priority(existing)) deduped.set(key, entry);
    }
    this.searchIndex = [...deduped.values()];
  }

  addTransientLabel(className, text, worldPos) {
    return this._place(className, text, worldPos, {});
  }
  removeLabel(entry) {
    entry.el.remove();
    const i = this.activeLabels.indexOf(entry);
    if (i !== -1) this.activeLabels.splice(i, 1);
  }

  /** Per-frame projection + fixed-priority overlap culling with hysteresis (stops flicker on damped camera moves). */
  update(camera) {
    const chrome = this._measureChrome(); // first: a DOM read before this frame's style writes, not between them
    const halfW = window.innerWidth / 2, halfH = window.innerHeight / 2;
    const camY = camera.position.y;
    const scratch = new THREE.Vector3();
    const overlapCandidates = [];

    for (const entry of this.activeLabels) {
      const { el, worldPos, maxDistance = Infinity, minHeight = -Infinity, maxHeight = Infinity, avoidOverlap } = entry;
      if (camY > maxHeight || camY < minHeight || (maxDistance !== Infinity && camera.position.distanceTo(worldPos) > maxDistance)) {
        el.style.display = 'none'; entry._ovShown = false; continue;
      }
      scratch.copy(worldPos).project(camera);
      if (scratch.z > 1) { el.style.display = 'none'; entry._ovShown = false; continue; }
      el.style.display = '';
      const screenX = scratch.x * halfW + halfW, screenY = -scratch.y * halfH + halfH;
      el.style.left = `${screenX}px`;
      el.style.top = `${screenY}px`;
      if (avoidOverlap) { entry._screenX = screenX; entry._screenY = screenY; overlapCandidates.push(entry); }
    }

    // Fixed priority order: same label always wins a contested spot regardless of frame-to-frame projection jitter.
    overlapCandidates.sort((a, b) => (b.overlapPriority ?? 0) - (a.overlapPriority ?? 0));
    // The controls are "occupied" before any label is placed, so a label never sits under them.
    const occupiedRects = [...chrome.rects];
    const viewW = halfW * 2, viewH = halfH * 2;
    for (const entry of overlapCandidates) {
      const rect = this._labelRect(entry);
      const mx = entry._ovShown ? _LABEL_HIDE_MARGIN_X : _LABEL_SHOW_MARGIN_X;
      const my = entry._ovShown ? _LABEL_HIDE_MARGIN_Y : _LABEL_SHOW_MARGIN_Y;
      // Running off the window, or under the top bar: its text would be cut
      // off, so it's hidden -- with the same hysteresis as an overlap (a
      // label on show goes the moment it crosses an edge; a hidden one comes
      // back only once it is clear of the edge by the show margin).
      const ex = entry._ovShown ? 0 : _LABEL_SHOW_MARGIN_X, ey = entry._ovShown ? 0 : _LABEL_SHOW_MARGIN_Y;
      const cutOff = rect.left < ex || rect.right > viewW - ex || rect.top < chrome.top + ey || rect.bottom > viewH - ey;
      const overlaps = cutOff || occupiedRects.some((o) => rect.left < o.right + mx && rect.right > o.left - mx && rect.top < o.bottom + my && rect.bottom > o.top - my);
      if (overlaps) { entry.el.style.display = 'none'; entry._ovShown = false; continue; }
      entry._ovShown = true;
      occupiedRects.push(rect);
    }
  }

  /**
   * Overlap-test rect for one label, without forcing a layout reflow every
   * frame for every candidate. A label's on-screen SIZE depends only on
   * its text + CSS font -- both fixed for the label's whole lifetime (see
   * the grep-confirmed fact that no avoidOverlap label's textContent is
   * ever changed after _place()) -- so it's measured with
   * getBoundingClientRect() exactly once per label, ever, and cached from
   * then on. Every later frame reconstructs the same rect from that
   * cached size plus the anchor point already computed in update() above
   * (pure arithmetic, no DOM read), mirroring each class's own CSS
   * transform origin from styles.css: `.flat-label` is
   * `translate(-50%, -50%)` (box centered on its anchor); every other
   * avoidOverlap label (only `.building-name`, in practice) is
   * `translate(-50%, -170%)` (box anchored at its bottom tip). The one
   * thing this can't see is the +/-5px `label-float` keyframe bob
   * building-name labels animate through -- a small, purely cosmetic
   * wobble already inside the +/-3..5px hysteresis margins above, so
   * ignoring it doesn't change which label wins a contested spot.
   */
  _labelRect(entry) {
    if (entry._labelW == null) {
      const rect = entry.el.getBoundingClientRect();
      entry._labelW = rect.width;
      entry._labelH = rect.height;
      entry._isPillLabel = !entry.el.classList.contains('flat-label');
    }
    const w = entry._labelW, h = entry._labelH;
    const left = entry._screenX - w / 2;
    const top = entry._isPillLabel ? entry._screenY - h * 1.7 : entry._screenY - h / 2;
    return { left, right: left + w, top, bottom: top + h };
  }
}
