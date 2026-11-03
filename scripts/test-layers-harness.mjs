// Checks the layers and controllers against Kanpur's real data, in Node
// with a stand-in DOM (jsdom) -- NOT part of the app.
//
//   node scripts/test-layers-harness.mjs
//
// `three` is imported statically on purpose: a dynamic import() placed
// after a large JSON.parse in the same module body has crashed Node (a
// segfault, seen in one environment). Static imports resolve during
// linking, before any of this file's own code runs.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// LabelLayer uses document.createElement/canvas -- real browser behavior
// TwinEngine depends on. A jsdom global gives real coverage here instead
// of skipping it entirely; canvas 2D context calls are jsdom's no-op
// stub (it doesn't rasterize), which is fine -- this harness checks
// texture/label OBJECTS got built correctly, not pixel output.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;

// jsdom doesn't rasterize (needs the native `canvas` package for that,
// not worth adding to test one texture-baking helper).
const fakeCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return undefined;
    return () => fakeCtx; // any method call is a no-op returning the same proxy; any property read is also just this proxy (harmless for a fill-style/font assignment target)
  },
  set() { return true; },
});
dom.window.HTMLCanvasElement.prototype.getContext = () => fakeCtx;

import { validateCityConfig } from '../src/config/city-schema.js';
import { kanpurConfig } from '../src/config/cities/kanpur.config.js';
import { RoadLayer } from '../src/layers/RoadLayer.js';
import { AdminAreaLayer } from '../src/layers/AdminAreaLayer.js';
import { GroundLayer } from '../src/layers/GroundLayer.js';
import { TreeLayer } from '../src/layers/TreeLayer.js';
import { LabelLayer } from '../src/layers/LabelLayer.js';
import { HighlightRenderer } from '../src/engine/HighlightRenderer.js';
import { DirtyScheduler } from '../src/engine/DirtyScheduler.js';
import { Y_KMC_WARD, Y_KMC_ZONE } from '../src/config/constants.js';

// Mirrors RoadLayer.js's FALLBACK_LINE_PALETTE (not exported -- it's an
// internal implementation detail) so this harness can check "did the
// fallback path pick A real, distinct colour" without hardcoding the one
// exact index a hash happens to produce today.
const FALLBACK_LINE_PALETTE_CHECK = [0xff8c00, 0x0033a0, 0xffd500, 0xe31e24, 0x00a651, 0x7b2d8e, 0xec008c, 0x00b7c3];

let failures = 0;
function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('OK:', msg); } }

// The same files the app itself reads (see kanpur.config.js).
const DATA = fileURLToPath(new URL('../public/data/kanpur', import.meta.url));
const loadJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ---- 0. CityConfig validation (real config + new optional fields) ----
{
  const { ok, errors } = validateCityConfig(kanpurConfig);
  assert(ok, `kanpurConfig still validates after adding labels/trees fields (errors: ${errors.join('; ')})`);
  assert(Array.isArray(kanpurConfig.labels.orientationAllowlist) && kanpurConfig.labels.orientationAllowlist.length > 0, 'kanpurConfig.labels.orientationAllowlist populated');
  assert(kanpurConfig.trees.kindDensityM2PerTree.forest === 90, 'kanpurConfig.trees.kindDensityM2PerTree ported correctly');
}

// ---- Load real (small) data slices ----
const kmcWards = loadJson(`${DATA}/kmc_wards.geojson`);
const kmcZones = loadJson(`${DATA}/kmc_zones.geojson`);
const landuse = loadJson(`${DATA}/landuse.geojson`);
const vegetation = loadJson(`${DATA}/vegetation.geojson`);
const water = loadJson(`${DATA}/water.geojson`);
const localities = loadJson(`${DATA}/localities.geojson`);
const kmcLandmarks = loadJson(`${DATA}/kmc_landmarks.geojson`);
const amenities = loadJson(`${DATA}/amenities.geojson`);
const railways = loadJson(`${DATA}/railways.geojson`);
const buildingLabelsFull = loadJson(`${DATA}/buildings.geojson`);
const kmcRoadsFull = loadJson(`${DATA}/kmc_roads.geojson`);
// Real files, sliced to a manageable feature count -- still real surveyed geometry, not synthetic.
const kmcRoads = { type: 'FeatureCollection', features: kmcRoadsFull.features.slice(0, 3000) };
const buildingLabels = { type: 'FeatureCollection', features: buildingLabelsFull.features.slice(0, 2000) };

console.log(`data sizes: wards=${kmcWards.features.length} zones=${kmcZones.features.length} roads(sliced)=${kmcRoads.features.length} landuse=${landuse.features.length} veg=${vegetation.features.length} water=${water.features.length} localities=${localities.features.length} landmarks=${kmcLandmarks.features.length} amenities=${amenities.features.length} railways=${railways.features.length} buildingLabels(sliced)=${buildingLabels.features.length}`);

const scene = new THREE.Scene();

// ---- 1. RoadLayer ----
{
  const roadLayer = new RoadLayer(scene, kanpurConfig);
  await roadLayer.load(kmcRoads, railways, () => {});
  const totalRoadMeshes = roadLayer.class0Meshes.length + roadLayer.class1Meshes.length + roadLayer.class2Meshes.length;
  assert(totalRoadMeshes > 0, `RoadLayer built ${totalRoadMeshes} KMC road tile meshes from ${kmcRoads.features.length} real features`);
  assert(roadLayer.pickMeshes.length === totalRoadMeshes, 'RoadLayer.pickMeshes count matches total road meshes');
  for (const m of roadLayer.pickMeshes) {
    assert(Array.isArray(m.userData.roadMeta) && m.userData.roadMeta.length > 0, 'each road mesh carries non-empty roadMeta for click-inspect');
  }
  assert(roadLayer.railwaysHeavy.mesh !== null, 'RoadLayer built a heavy-rail ribbon mesh from real railways.geojson');

  // Metro line colour-by-name (real data: Kanpur's railways.geojson has a
  // 'railway=subway' way literally named "Orange Line", plus one named
  // "Line 1 – IIT Kanpur to Naubasta", plus some with no name at all).
  assert(roadLayer.metroLines.length >= 2, `RoadLayer split real subway ways into ${roadLayer.metroLines.length} named line group(s) (expect >=2 for Kanpur's real data)`);
  const orangeLine = roadLayer.metroLines.find((l) => l.name === 'Orange Line');
  assert(!!orangeLine, 'a line literally named "Orange Line" was found in the grouped output');
  assert(orangeLine.color === 0xff8c00, `"Orange Line" auto-resolved to orange (0x${orangeLine.color.toString(16)}) from its OWN NAME, with zero CityConfig.railway.lineColors entry`);
  // Real-world check (confirmed via Wikipedia): "Orange Line" and "Line 1
  // – IIT Kanpur to Naubasta" are the SAME physical Kanpur Metro line,
  // just tagged two different ways across OSM ways. A name with no colour
  // signal of its own -- whether truly unnamed (depot spurs) or just
  // descriptively named ("Line 1 – ...") -- must inherit the dominant
  // colour-signalled line's colour, not get its own arbitrary hash colour.
  const unnamedGroup = roadLayer.metroLines.find((l) => l.name === 'Unnamed Line');
  const namedNonColorLine = roadLayer.metroLines.find((l) => l.name.includes('IIT Kanpur'));
  if (unnamedGroup) assert(unnamedGroup.color === orangeLine.color, `unnamed depot-spur ways inherit "Orange Line"'s colour (0x${unnamedGroup.color.toString(16)}) instead of an unrelated hash colour`);
  if (namedNonColorLine) assert(namedNonColorLine.color === orangeLine.color, `"${namedNonColorLine.name}" (no colour word of its own) inherits "Orange Line"'s colour -- it's the same real-world line, not a second one`);
  for (const line of roadLayer.metroLines) assert(line.mesh !== null && line.mesh.isMesh, `metro line "${line.name}" produced a real mesh`);

  // Explicit CityConfig override test: a fabricated city config with a
  // lineColors entry must win over both the name heuristic and the hash fallback.
  const overrideConfig = { ...kanpurConfig, railway: { lineColors: { 'Orange Line': 0x123456 } } };
  const roadLayerOverride = new RoadLayer(scene, overrideConfig);
  await roadLayerOverride.load(null, railways, () => {});
  const overriddenLine = roadLayerOverride.metroLines.find((l) => l.name === 'Orange Line');
  assert(overriddenLine.color === 0x123456, 'CityConfig.railway.lineColors override beats both the name heuristic and the hash fallback');

  // Last-resort hash path: when NOTHING in the feature set has any colour
  // signal at all (no override, no colour word anywhere), there's no
  // dominant line to fold into -- each distinctly-named group should
  // still get its own stable, real colour rather than everything
  // collapsing to one arbitrary default.
  const noSignalRailways = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { railway: 'subway', name: 'Line 1' }, geometry: { type: 'LineString', coordinates: [[80.30, 26.44], [80.31, 26.45]] } },
      { type: 'Feature', properties: { railway: 'subway', name: 'Line 2' }, geometry: { type: 'LineString', coordinates: [[80.32, 26.46], [80.33, 26.47]] } },
    ],
  };
  const roadLayerNoSignal = new RoadLayer(scene, kanpurConfig);
  await roadLayerNoSignal.load(null, noSignalRailways, () => {});
  const [l1, l2] = [roadLayerNoSignal.metroLines.find((l) => l.name === 'Line 1'), roadLayerNoSignal.metroLines.find((l) => l.name === 'Line 2')];
  assert(!!l1 && !!l2, 'both synthetic no-colour-signal lines were built');
  if (l1 && l2) {
    assert(FALLBACK_LINE_PALETTE_CHECK.includes(l1.color) && FALLBACK_LINE_PALETTE_CHECK.includes(l2.color), 'with zero colour signal anywhere, each line still gets a real colour from the hash-fallback palette');
    // NOT asserting l1.color !== l2.color here: the hash palette has only
    // 8 buckets, so two arbitrary names (e.g. "Line 1"/"Line 2", differing
    // by one trailing character) can legitimately land on the same bucket
    // -- the design's actual guarantee is STABILITY (same name -> same
    // colour every time, deterministic not random), not pairwise
    // uniqueness. Check that instead, via a second independent build.
    const roadLayerNoSignal2 = new RoadLayer(scene, kanpurConfig);
    await roadLayerNoSignal2.load(null, noSignalRailways, () => {});
    const l1Again = roadLayerNoSignal2.metroLines.find((l) => l.name === 'Line 1');
    assert(!!l1Again && l1Again.color === l1.color, '"Line 1" resolves to the same colour on a second, independent build (deterministic hash, not random per-load)');
  }
  // repaint() must not throw against the real merged palette
  const { DEFAULT_PALETTES } = await import('../src/config/palettes.js');
  roadLayer.repaint(DEFAULT_PALETTES.night, true, 0.72);
  console.log('OK: RoadLayer.repaint(night, wet) ran without throwing');
}

// ---- 2. AdminAreaLayer (wards + zones) ----
{
  const wardLayer = new AdminAreaLayer(scene, kanpurConfig, { outlineColor: 0xaaaaaa, y: Y_KMC_WARD, metaFn: (p) => ({ kind: 'ward', name: p.name || '' }) });
  wardLayer.load(kmcWards);
  assert(wardLayer.pickMeshes.length === kmcWards.features.length, `AdminAreaLayer(wards): ${wardLayer.pickMeshes.length} pick meshes for ${kmcWards.features.length} real ward features`);
  for (const m of wardLayer.pickMeshes) assert(m.userData.areaMeta?.kind === 'ward', 'ward pick mesh carries areaMeta.kind === "ward"');

  const zoneLayer = new AdminAreaLayer(scene, kanpurConfig, { outlineColor: 0x555555, y: Y_KMC_ZONE, metaFn: (p) => ({ kind: 'zone', zone_id: p.zone_id ?? null }) });
  zoneLayer.load(kmcZones);
  // >= not ===: a MultiPolygon zone legitimately yields one pick mesh per
  // piece (kmc_zones.geojson has exactly one: zone_id 0, 3 pieces -- same
  // "MultiPolygon pieces become independent clickable features" design as roads).
  assert(zoneLayer.pickMeshes.length >= kmcZones.features.length, `AdminAreaLayer(zones): ${zoneLayer.pickMeshes.length} pick meshes for ${kmcZones.features.length} real zone features (MultiPolygon pieces split, so >= is correct)`);
}

// ---- 3. GroundLayer ----
{
  const { DEFAULT_PALETTES } = await import('../src/config/palettes.js');
  const groundLayer = new GroundLayer(scene, kanpurConfig);
  groundLayer.load({ landuse, vegetation, water }, DEFAULT_PALETTES.day);
  assert(groundLayer.landuseMeshes.length > 0, `GroundLayer built ${groundLayer.landuseMeshes.length} landuse meshes`);
  assert(groundLayer.vegetationMeshes.length > 0, `GroundLayer built ${groundLayer.vegetationMeshes.length} vegetation meshes`);
  assert(groundLayer.waterMeshes.length > 0, `GroundLayer built ${groundLayer.waterMeshes.length} water meshes`);
  const waterRingsLocal = groundLayer.getWaterRingsLocal(water);
  assert(waterRingsLocal.length > 0, `getWaterRingsLocal() returned ${waterRingsLocal.length} rings for TreeLayer's exclusion test`);

  // ---- 4. TreeLayer (depends on GroundLayer's water rings) ----
  // Trees are split per tile (treeLayer.tiles = [{ meshes: [trunk, canopy] }]),
  // not held as one flat pair.
  const treeLayer = new TreeLayer(scene, kanpurConfig);
  const count = treeLayer.load(vegetation, waterRingsLocal, DEFAULT_PALETTES.day);
  assert(count > 0, `TreeLayer scattered ${count} trees from real vegetation.geojson`);
  assert(treeLayer.tiles.length > 0, `TreeLayer split trees across ${treeLayer.tiles.length} tile(s)`);
  assert(treeLayer.tiles.every((t) => t.meshes.length === 2), 'every tile has exactly [trunkMesh, canopyMesh]');
  const trunkCountSum = treeLayer.tiles.reduce((sum, t) => sum + t.meshes[0].count, 0);
  const canopyCountSum = treeLayer.tiles.reduce((sum, t) => sum + t.meshes[1].count, 0);
  assert(trunkCountSum === count && canopyCountSum === count, `InstancedMesh counts summed across tiles (trunk=${trunkCountSum}, canopy=${canopyCountSum}) match the scattered point count (${count})`);
}

// ---- 5. LabelLayer ----
{
  const labelLayer = new LabelLayer(kanpurConfig);
  labelLayer.load({ landuse, wards: kmcWards, roads: kmcRoads, landmarks: kmcLandmarks, localities, amenities, buildingLabels });
  assert(labelLayer.searchIndex.length > 0, `LabelLayer built a ${labelLayer.searchIndex.length}-entry search index`);
  assert(labelLayer.activeLabels.length > 0, `LabelLayer placed ${labelLayer.activeLabels.length} visible label DOM entries`);
  assert(labelLayer.searchIndex.some((e) => e.type === 'locality'), 'search index contains at least one locality entry');
  assert(labelLayer.searchIndex.some((e) => e.type === 'road'), 'search index contains at least one named-road entry');
  assert(labelLayer.el.children.length === labelLayer.activeLabels.length, 'every activeLabels entry has a corresponding DOM child in labelLayer.el');
  // Exercise the per-frame update path (projection + overlap culling) against a real camera -- the part most likely to throw on a malformed entry.
  {
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 60000);
    camera.position.set(0, 1000, -1000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    labelLayer.update(camera);
    console.log('OK: LabelLayer.update(camera) ran without throwing against a real camera');
  }
}

// ---- 7. HighlightRenderer + DirtyScheduler smoke test ----
{
  const hr = new HighlightRenderer(scene);
  const fakeBuilding = { flat: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]), n: 4, height: 12 };
  const cage = hr.makeBuildingCage(fakeBuilding, 0x2dd4ff);
  assert(cage.geometry.attributes.instanceStart !== undefined || cage.isLineSegments2, 'HighlightRenderer.makeBuildingCage() produced a LineSegments2');
  hr.dispose(cage);
  const ring = hr.makeRingMarker(10, 10, 0x2dd4ff);
  assert(ring.isMesh === true, 'HighlightRenderer.makeRingMarker() produced a Mesh');
  hr.dispose(ring);

  const sched = new DirtyScheduler();
  assert(sched.consume() === true, 'DirtyScheduler starts dirty (first frame always renders)');
  assert(sched.consume() === false, 'DirtyScheduler.consume() clears the flag');
  sched.markDirty();
  assert(sched.consume() === true, 'DirtyScheduler.markDirty() sets it again');
}

// ---- 8. CameraRig + SearchController + InspectController wiring smoke test ----
{
  const { CameraRig } = await import('../src/engine/CameraRig.js');
  const { SearchController } = await import('../src/controllers/SearchController.js');
  const { InspectController } = await import('../src/controllers/InspectController.js');
  const { DirtyScheduler } = await import('../src/engine/DirtyScheduler.js');

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 60000);
  // OrbitControls needs a DOM element with add/removeEventListener + getBoundingClientRect + ownerDocument -- jsdom's real <canvas> satisfies this (unlike a hand-rolled stub, which risks silently hiding a real wiring bug).
  const fakeCanvas = document.createElement('canvas');
  fakeCanvas.getBoundingClientRect = () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 });
  const scheduler = new DirtyScheduler();
  const rig = new CameraRig(camera, fakeCanvas, scheduler);
  rig.init();
  assert(camera.position.y === 4500, 'CameraRig.init() sets the north-up startup camera position');
  rig.flyTo(100, 200, 500);
  const stillFlying = rig.updateFlyTo();
  assert(stillFlying === true, 'CameraRig.updateFlyTo() reports true mid-tween');
  assert(camera.position.x !== 0 || camera.position.z !== 0, 'CameraRig.flyTo() actually moved the camera toward the target');
  rig.resetToNorth();
  assert(rig.updateCompassReset() === true, 'CameraRig.updateCompassReset() reports true mid-tween');
  rig.dolly(0.8);
  console.log('OK: CameraRig.dolly() ran without throwing');

  const searchDom = {
    btnSearch: document.createElement('button'), searchPanel: document.createElement('div'),
    searchInput: document.createElement('input'), searchResultsEl: document.createElement('div'),
  };
  const hr2 = new HighlightRenderer(scene);
  const labelLayerForSearch = new LabelLayer(kanpurConfig);
  labelLayerForSearch.load({ landuse, wards: kmcWards, roads: kmcRoads, landmarks: kmcLandmarks, localities, amenities, buildingLabels });
  const search = new SearchController({ dom: searchDom, labelLayer: labelLayerForSearch, cameraRig: rig, highlightRenderer: hr2 });
  search.open();
  assert(searchDom.searchPanel.hidden === false, 'SearchController.open() unhides the search panel');
  const someLocality = labelLayerForSearch.searchIndex.find((e) => e.type === 'locality');
  assert(!!someLocality, 'a real locality exists in the search index to select');
  search.select(someLocality);
  assert(search.pinEntry !== null, 'SearchController.select() placed a search pin label');
  // Highlight ownership is unified in HighlightRenderer now (see HighlightRenderer.active) -- both SearchController and InspectController route through it instead of each tracking their own mesh.
  assert(hr2.active !== null || someLocality.highlightRings === null, 'SearchController.select() set HighlightRenderer.active when the entry had ring data');
  search._clearPin();
  hr2.clearActive();
  console.log('OK: SearchController full select/clear cycle ran without throwing on a real search-index entry');

  // Same shape as index.html's #inspect: a close button and the body the controller fills.
  const inspectDom = {
    inspectPanel: document.createElement('div'),
    inspectBody: document.createElement('div'),
    inspectClose: document.createElement('button'),
  };
  inspectDom.inspectPanel.append(inspectDom.inspectClose, inspectDom.inspectBody);
  const fakeRenderer = { domElement: document.createElement('canvas') };
  const roadLayerForInspect = new RoadLayer(scene, kanpurConfig);
  await roadLayerForInspect.load(kmcRoads, railways, () => {});
  const wardLayerForInspect = new AdminAreaLayer(scene, kanpurConfig, { outlineColor: 0xaaaaaa, y: Y_KMC_WARD, metaFn: (p) => ({ kind: 'ward', name: p.name || '' }) });
  wardLayerForInspect.load(kmcWards);
  const zoneLayerForInspect = new AdminAreaLayer(scene, kanpurConfig, { outlineColor: 0x555555, y: Y_KMC_ZONE, metaFn: (p) => ({ kind: 'zone' }) });
  zoneLayerForInspect.load(kmcZones);
  const buildingLayerStub = { pickMeshes: [] }; // real BuildingLayer needs a live worker+fetch; not exercised here, see test-worker-harness.mjs for that

  const inspect = new InspectController({
    renderer: fakeRenderer, camera, highlightRenderer: hr2, buildingLayer: buildingLayerStub,
    roadLayer: roadLayerForInspect, wardLayer: wardLayerForInspect, zoneLayer: zoneLayerForInspect, dom: inspectDom,
  });
  // Directly exercise the inspect-panel renderers (the click->raycast path needs a real WebGL pick, out of scope for Node) -- these are exactly what a successful raycast hit calls into.
  inspect._showRoadInspect(roadLayerForInspect.pickMeshes[0].userData.roadMeta[0]);
  assert(inspectDom.inspectPanel.hidden === false, 'InspectController._showRoadInspect() unhides the inspect panel');
  assert(inspectDom.inspectPanel.innerHTML.includes('Road'), 'InspectController._showRoadInspect() rendered a Road panel');
  inspect._showAreaInspect(wardLayerForInspect.pickMeshes[0].userData.areaMeta);
  assert(inspectDom.inspectPanel.innerHTML.includes('Ward'), 'InspectController._showAreaInspect() rendered a Ward panel for real ward data');
  inspect.showLandmarkInspect('Test Landmark');
  assert(inspectDom.inspectPanel.innerHTML.includes('Test Landmark'), 'InspectController.showLandmarkInspect() (the LabelLayer click hook) rendered correctly');
  assert(inspectDom.inspectPanel.contains(inspectDom.inspectClose), 'rendering a panel leaves its close button in place');
  inspectDom.inspectClose.click();
  assert(inspectDom.inspectPanel.hidden === true, 'the close button hides the inspect panel');
  clearTimeout(inspect._inspectHideTimer); // nothing may keep this script alive
  console.log('OK: InspectController panel renderers ran without throwing on real road/ward data');
}

console.log(failures === 0 ? '\n=== LAYERS HARNESS: ALL CHECKS PASSED ===' : `\n=== LAYERS HARNESS: ${failures} FAILURE(S) ===`);
// jsdom's `window` (see the JSDOM() call up top) keeps at least one handle
// on Node's event loop alive even after every assertion above has run --
// without an explicit exit the process just sits there indefinitely
// instead of returning to the shell, which reads as a hang to anything
// waiting on it (a `| tail`, a CI step, etc.) even though the run finished.
process.exit(failures === 0 ? 0 : 1);
process.exitCode = failures === 0 ? 0 : 1;
