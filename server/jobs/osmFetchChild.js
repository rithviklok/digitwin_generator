// ===================================================================
// osmFetchChild.js -- run as its own process by osmJob.js (never
// imported): produces the city's OpenStreetMap-type layers (roads,
// railway, amenities, localities, land use, vegetation, water) into
// --plan's `out` directory, plus summary.json.
//
//   node osmFetchChild.js --plan <plan.json>
//   plan: { bbox, endpoints, exportPath, manual: {role: path}, out, cacheDir, deadline, origin, tileSizeM }
//
// Downloads happen once per BUILD (never while the uploader is drawing).
// The area is asked for in parts -- a metro is a dozen or more -- and each
// part is saved the moment it arrives and kept for CACHE_DAYS. So a build
// that was cut short, or that the busy public servers refused one part
// of, asks only for what is still missing the next time; and a revision
// that keeps the same area (e.g. only swapping the buildings file)
// downloads nothing. `deadline` (epoch ms) is when to stop asking: what
// has been downloaded by then is still turned into layers.
// Progress is reported on stdout as "[progress] <pct> <text>" lines,
// which osmJob.js forwards to the uploader's Review & build page.
//
// Where each layer comes from, strongest first:
//   1. manual[role]  -- a file the uploader supplied for that one layer
//                       (a municipal survey, or a hand export). Always wins.
//   2. exportPath    -- one OSM export file the uploader made themselves
//                       (the fallback when this server can't reach OSM).
//                       When given, nothing is downloaded.
//   3. download      -- the Overpass API, for the drawn bbox; only the
//                       query groups some non-manual layer still needs.
//
// A separate process because the work is CPU- and memory-heavy (parsing
// tens of MB of JSON, widening every road line into a surface) -- in the
// server process it would stall every status poll for the duration.
// Nothing is held whole: features are read a part at a time and each
// layer is written as its features are made. (Delhi with its satellite
// cities is 3.16 lakh roads. Gathered into one list first, as this used to
// do, they were more than one function call can be handed, and the build
// went live with no roads.)
// A city's roads are written as one roads.geojson, which the viewer loads
// whole, unless there are ROAD_TILES_MIN_ROADS of them or more: then they
// are written as tiles it loads around the camera (lib/roadTiles.js; needs
// --plan's origin and tileSizeM, the city's own).
// Each download group succeeds or fails on its own; summary.json says
// what was written and what failed, and why. Exit code 0 whenever the
// summary got written.
// ===================================================================
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync, openSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  OSM_QUERY_GROUPS, MAX_DOWNLOAD_PARTS, OUT_OF_TIME, buildOsmQuery, createOverpassClient, downloadParts, explainMissingParts, explainTooLarge,
  overpassToFeatures, reachableEndpoints,
} from '../lib/overpass.js';
import { OSM_ROLES, createOsmSplitter, createLayerNormalizer } from '../lib/osmSplitter.js';
import { createRoadTileWriter, ROAD_TILES_DIR, ROAD_TILES_MIN_ROADS, ROAD_TILE_BUFFER_STEPS } from '../lib/roadTiles.js';
import { LAYER_ROLES } from '../../src/config/city-schema.js';
import { readFeatureBatches, GeojsonFileError } from '../../scripts/geojson-feature-stream.mjs';

/** Which output roles each query group feeds -- decides which groups are still needed, and reports a failed group as its missing roles. */
const GROUP_ROLES = {
  roads: [LAYER_ROLES.ROADS],
  railway: [LAYER_ROLES.RAILWAY],
  areas: [LAYER_ROLES.AMENITIES, LAYER_ROLES.LOCALITIES, LAYER_ROLES.LANDUSE, LAYER_ROLES.VEGETATION, LAYER_ROLES.WATER],
};
/** What the Review & build page calls each group while it downloads. */
const GROUP_LABEL = { roads: 'roads', railway: 'railway', areas: 'land use, parks, water and places' };
/** Share of the progress bar for downloading; the rest is turning the data into layers (a minute and a half for a Delhi-sized area: every road is widened into a surface). */
const DOWNLOAD_PCT = 60;

/** ~1 cm precision is plenty for a city model, and trims a large share of every file's bytes (buffered roads especially). */
const round = (key, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e7) / 1e7 : v);
const count = (n) => n.toLocaleString('en-IN');
let lastPct = 0;
const progress = (pct, text) => { lastPct = pct; console.log(`[progress] ${Math.round(pct)} ${text}`); };
const log = (msg) => {
  console.log(msg);
  const busy = /all servers busy -- waiting (\d+)s/.exec(msg);
  if (busy) progress(lastPct, `OpenStreetMap's servers are busy. Trying again in ${busy[1]} s`);
};

/**
 * One layer's GeoJSON file, written a feature at a time: byte for byte
 * what JSON.stringify({type: 'FeatureCollection', features}, round) would
 * give, without ever building it as one string (Node's longest is 512 MB;
 * a metro's widened roads are about that). No file at all if nothing is
 * written, as before.
 */
class LayerFile {
  constructor(path) { this.path = path; this.fd = null; this.count = 0; this.pending = []; this.pendingChars = 0; }

  write(feature) {
    if (this.fd === null) this.fd = openSync(this.path, 'w');
    const text = (this.count++ ? ',' : '{"type":"FeatureCollection","features":[') + JSON.stringify(feature, round);
    this.pending.push(text);
    this.pendingChars += text.length;
    if (this.pendingChars >= 4 * 1024 * 1024) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    writeFileSync(this.fd, this.pending.join(''));
    this.pending = [];
    this.pendingChars = 0;
  }

  close() {
    if (this.fd === null) return;
    this.pending.push(']}');
    this.flush();
    closeSync(this.fd);
    this.fd = null;
  }

  /** Closes and removes the file: what was written so far must not be taken for the whole layer. */
  discard() {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
    rmSync(this.path, { force: true });
    this.count = 0;
    this.pending = [];
  }
}

const { values } = parseArgs({ options: { plan: { type: 'string' } } });
const plan = JSON.parse(readFileSync(values.plan, 'utf8'));
const { bbox, out } = plan;
const deadline = plan.deadline ?? Infinity;
const manualRoles = new Set(Object.keys(plan.manual ?? {}));
mkdirSync(out, { recursive: true });

// Downloaded parts, per exact area. Anything saved for a different area
// (the uploader redrew it), older than CACHE_DAYS, or left half-written by
// a process that was stopped, is dropped.
const CACHE_DAYS = 7;
const areaKey = [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => Number(v).toFixed(5)).join('_');
const partsDir = plan.cacheDir ?? join(out, 'parts');
mkdirSync(partsDir, { recursive: true });
for (const f of readdirSync(partsDir)) {
  const p = join(partsDir, f);
  if (!f.includes(areaKey) || f.endsWith('.tmp') || Date.now() - statSync(p).mtimeMs > CACHE_DAYS * 864e5) rmSync(p, { force: true });
}
const partPath = (group, i, n) => join(partsDir, `${group}_${areaKey}_${i + 1}of${n}.json`);
/** Written under another name first: a part must never be found half-written by the next build. */
function savePart(path, features) {
  writeFileSync(`${path}.tmp`, JSON.stringify(features));
  renameSync(`${path}.tmp`, path);
}
function ageOf(paths) {
  const hours = Math.max(...paths.map((p) => (Date.now() - statSync(p).mtimeMs) / 36e5));
  return hours < 1 ? 'under an hour' : hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} days`;
}

/**
 * Where the OSM features come from, in the order they go into the layers.
 * Each has `read()`, which yields its features one at a time and can be
 * run more than once, and `roles`, the layers that go missing if it can't
 * be read.
 * @type {Array<{name: string, roles: string[], read: () => Iterable<object>}>}
 */
const sources = [];
const failed = []; // [{roles, error}]
let source = 'none';
const wantedRoles = (roles) => roles.filter((r) => !manualRoles.has(r));

if (plan.exportPath) {
  source = 'export';
  log('[osm] using the OpenStreetMap export you uploaded -- nothing downloaded');
  const wording = { file: 'your OpenStreetMap export', item: 'feature', neverThatBig: 'no map feature is' };
  sources.push({
    name: 'your export',
    roles: wantedRoles(OSM_ROLES),
    * read() { for (const { features } of readFeatureBatches(plan.exportPath, { wording })) yield* features; },
  });
} else {
  const groups = Object.keys(OSM_QUERY_GROUPS).filter((g) => wantedRoles(GROUP_ROLES[g]).length);
  const parts = downloadParts(bbox, groups);
  const pathsOf = (g) => parts[g].map((cell, i) => partPath(g, i, parts[g].length));
  if (groups.length) source = 'download';

  let todo = [];
  for (const g of groups) {
    const saved = pathsOf(g).filter(existsSync);
    if (saved.length === parts[g].length) log(`[osm] ${g}: reusing this area's download from ${ageOf(saved)} ago`);
    else if (saved.length) log(`[osm] ${g}: ${saved.length} of ${parts[g].length} parts were downloaded ${ageOf(saved)} ago; only the rest are asked for`);
    parts[g].forEach((cell, i) => { if (!existsSync(partPath(g, i, parts[g].length))) todo.push({ group: g, cell, i }); });
  }

  const why = {}; // group -> what stopped its last part
  let unreachable = false;
  const tooLarge = todo.length > MAX_DOWNLOAD_PARTS ? todo.length : 0;
  if (tooLarge) {
    log(`[osm] the area would be asked for in ${tooLarge} parts (the most is ${MAX_DOWNLOAD_PARTS}) -- not downloading`);
  } else if (todo.length) {
    progress(1, 'Checking OpenStreetMap servers…');
    const endpoints = await reachableEndpoints(plan.endpoints);
    if (!endpoints.length) {
      unreachable = true;
      log('[osm] no OpenStreetMap (Overpass) server is reachable from this server');
    } else {
      log(`[osm] ${endpoints.length} server(s) reachable; ${todo.length} part(s) to download`);
      const client = createOverpassClient({ endpoints, log });
      const total = todo.length;
      let done = 0;
      // Parts the servers refused are asked for once more at the end, when the servers have had the longest rest.
      for (let pass = 0; pass < 2 && todo.length; pass++) {
        const refused = [];
        for (const item of todo) {
          const { group, cell, i } = item, n = parts[group].length;
          const part = n > 1 ? ` (part ${i + 1} of ${n})` : '';
          if (Date.now() > deadline) { why[group] = OUT_OF_TIME; refused.push(item); continue; }
          progress(2 + (DOWNLOAD_PCT * done) / total, `Downloading ${GROUP_LABEL[group]}${part}`);
          log(`[osm] downloading ${group}${part}…`);
          try {
            const json = await client.query(buildOsmQuery([group], cell), { deadline });
            savePart(partPath(group, i, n), overpassToFeatures(json));
            done++;
          } catch (err) {
            why[group] = err.outOfTime ? OUT_OF_TIME : err.name === 'TimeoutError' ? 'timed out' : err.message;
            log(`[osm] ${group}${part}: not downloaded -- ${err.message}`);
            refused.push(item);
          }
        }
        todo = refused;
      }
    }
  }

  for (const g of groups) {
    const paths = pathsOf(g);
    const missing = paths.filter((p) => !existsSync(p)).length;
    if (missing) {
      // All-or-nothing per group: half a road network is worse than a clearly-missing one.
      const error = tooLarge ? explainTooLarge(tooLarge)
        : unreachable ? 'this server can’t reach OpenStreetMap at all (no internet access, or blocked)'
        : explainMissingParts(missing, paths.length, why[g]);
      failed.push({ roles: wantedRoles(GROUP_ROLES[g]), error });
      if (!tooLarge && !unreachable) log(`[osm] ${g}: FAILED -- ${missing} of ${paths.length} part(s) not downloaded (${why[g]})`);
      continue;
    }
    sources.push({
      name: g,
      roles: wantedRoles(GROUP_ROLES[g]),
      // Each OSM element once: one on the border between two parts comes back from both.
      * read() {
        const seen = new Set();
        for (const path of paths) {
          let features;
          try {
            features = JSON.parse(readFileSync(path, 'utf8'));
          } catch {
            rmSync(path, { force: true }); // asked for again by the next build
            throw new Error('a saved part of the download was damaged. Revise the city to fetch it again');
          }
          for (const f of features) {
            if (seen.has(f.id)) continue;
            seen.add(f.id);
            yield f;
          }
        }
      },
    });
  }
}

// First pass: read every source through once. It finds a source that
// can't be read (a damaged export) BEFORE any layer is written from it,
// and gives the totals the progress line counts towards.
const readable = [];
let total = 0, roadLines = 0;
for (const src of sources) {
  try {
    let n = 0;
    for (const f of src.read()) { n++; if (f.properties?.highway) roadLines++; }
    log(`[osm] ${src.name}: ${count(n)} features`);
    readable.push(src);
    total += n;
  } catch (err) {
    log(`[osm] ${src.name}: FAILED -- ${err.message}`);
    const own = err instanceof GeojsonFileError || source !== 'export'; // already says which file and what is wrong with it
    failed.push({ roles: src.roles, error: own ? err.message.replace(/\.$/, '') : `your OpenStreetMap export couldn't be read: ${err.message}` });
  }
}

// Second pass: into layers, each written as it is made.
const SPLIT_TEXT = 'Turning OpenStreetMap data into map layers';
progress(2 + DOWNLOAD_PCT, `${SPLIT_TEXT}…`);
const layerFiles = Object.fromEntries(wantedRoles(OSM_ROLES).map((role) => [role, new LayerFile(join(out, `${role}.geojson`))]));
const canTile = Boolean(plan.origin && plan.tileSizeM);
const roadTiles = canTile && roadLines >= ROAD_TILES_MIN_ROADS && layerFiles[LAYER_ROLES.ROADS]
  ? createRoadTileWriter({ dir: join(out, ROAD_TILES_DIR), origin: plan.origin, tileSizeM: plan.tileSizeM })
  : null;
if (roadTiles) log(`[osm] ${count(roadLines)} roads: writing them as tiles, not one file`);
const splitter = createOsmSplitter({
  bbox,
  roadSteps: roadTiles ? ROAD_TILE_BUFFER_STEPS : undefined,
  write: (role, feature) => (roadTiles && role === LAYER_ROLES.ROADS ? roadTiles : layerFiles[role])?.write(feature),
});
let converted = 0;
for (const src of readable) {
  for (const f of src.read()) {
    splitter.add(f);
    if (++converted % 2000 === 0) progress(2 + DOWNLOAD_PCT + ((97 - DOWNLOAD_PCT) * converted) / total, `${SPLIT_TEXT}: ${count(converted)} of ${count(total)}`);
  }
}
const split = splitter.finish();
for (const file of Object.values(layerFiles)) file.close();
for (const w of split.warnings) log(`[osm] warning: ${w}`);
const tiled = {}; // role -> the folder its tiles are in, for the layers written as tiles
if (roadTiles) {
  progress(98, 'Writing the road tiles…');
  const written = roadTiles.close();
  tiled[LAYER_ROLES.ROADS] = ROAD_TILES_DIR;
  log(`[osm] road tiles: ${count(written.roads)} roads, ${count(written.triangles)} triangles, ${count(written.tiles)} files, ${(written.bytes / 1e6).toFixed(0)} MB`);
}

const counts = Object.fromEntries(wantedRoles(OSM_ROLES).map((role) => [role, split.stats[role]]));

// The uploader's own per-layer files, brought to the same shape. Each is
// read a feature at a time, twice: once to see that all of it can be read
// and how much is in it (for roads, that decides tiles or one file), once
// to write.
const manual = {};
let manualStationNames = null;
const OWN_FILE_WORDING = { file: 'this file', item: 'feature', neverThatBig: 'no map feature is' };
for (const [role, path] of Object.entries(plan.manual ?? {})) {
  const read = function* () { for (const { features } of readFeatureBatches(path, { wording: OWN_FILE_WORDING })) yield* features; };
  const tilesDir = join(out, `manual-${ROAD_TILES_DIR}`);
  let file = null;
  try {
    let given = 0;
    for (const f of read()) if (f) given++;
    const asTiles = canTile && role === LAYER_ROLES.ROADS && given >= ROAD_TILES_MIN_ROADS;
    const normalizer = createLayerNormalizer(role, { bbox, roadSteps: asTiles ? ROAD_TILE_BUFFER_STEPS : undefined });
    const tiles = asTiles ? createRoadTileWriter({ dir: tilesDir, origin: plan.origin, tileSizeM: plan.tileSizeM }) : null;
    if (!asTiles) file = new LayerFile(join(out, `manual-${role}.geojson`));
    for (const f of read()) {
      const feature = normalizer.convert(f);
      if (feature) (tiles ?? file).write(feature);
    }
    const result = normalizer.result();
    if (result.error) {
      file?.discard();
      rmSync(tilesDir, { recursive: true, force: true });
      manual[role] = { error: result.error };
      continue;
    }
    (tiles ?? file).close();
    manual[role] = tiles ? { path: tilesDir, count: result.count, tiled: true } : { path: file.path, count: result.count };
    if (role === LAYER_ROLES.AMENITIES) manualStationNames = result.railwayStationNames;
  } catch (err) {
    file?.discard();
    rmSync(tilesDir, { recursive: true, force: true });
    manual[role] = { error: err instanceof GeojsonFileError ? err.message.replace(/\.$/, '') : `couldn't be read: ${err.message}` };
  }
}

log(`[osm] ${source === 'export' ? 'from your export' : source === 'download' ? 'downloaded' : 'nothing to download'}: ${Object.entries(counts).map(([r, n]) => `${r}=${n}`).join(', ') || '-'}` +
  `${split.stats.seaPolygons ? ` (incl. ${split.stats.seaPolygons} sea polygon(s) from the coastline)` : ''}` +
  `${manualRoles.size ? `; your files: ${Object.entries(manual).map(([r, m]) => `${r}=${m.count ?? 'unusable'}`).join(', ')}` : ''}`);

writeFileSync(join(out, 'summary.json'), JSON.stringify({
  source, counts, tiled, failed, manual, warnings: split.warnings,
  railwayStationNames: manualStationNames ?? split.railwayStationNames,
}, null, 2));
