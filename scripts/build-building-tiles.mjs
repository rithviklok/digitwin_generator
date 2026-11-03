#!/usr/bin/env node
// ===================================================================
// build-building-tiles.mjs — offline pipeline that turns a raw
// buildings GeoJSON (any city, any dataset) into pre-baked, tiered,
// binary tile files + a manifest that BuildingLayer.js can stream by
// camera distance instead of loading the whole city upfront.
//
// Two invocation modes:
//   --city <id>      convenience: reads an existing CityConfig module
//                     (src/config/cities/<id>.config.js, exporting
//                     `${id}Config`) for its buildings-3d layer + params.
//   --input <path>    direct: works on ANY raw GeoJSON with no CityConfig
//                     at all. --height-property is the only required flag;
//                     origin/bbox are inferred from the data itself if not
//                     given. Also emits a starter CityConfig on success.
//
//   --radii-only      (with --city) recompute just the tier radii from an
//                     existing manifest.json's per-tile triangle counts and
//                     rewrite it -- no re-bake. Add --dry-run to only print.
//   --bounds-only     (with --city) read the existing tile files and (re)write
//                     each tier's exact per-mesh bounding boxes into
//                     manifest.json -- no re-bake. A full bake writes them too.
//                     (BuildingLayer gives them to three.js so it never loops
//                     over vertices; ~24x cheaper with the JS JIT off.)
//
// Examples:
//   node scripts/build-building-tiles.mjs --city kanpur
//   node scripts/build-building-tiles.mjs --city kanpur --radii-only --dry-run
//   node scripts/build-building-tiles.mjs --input ./my-city.geojson --height-property height_m --city-id mycity
//
//   --output-root <dir>  where tiles/manifest.json/generated.config.js get
//                     written (and, for --radii-only/--bounds-only, read
//                     back from) -- defaults to 'public' so --city kanpur's
//                     existing behaviour is unchanged. server/'s upload
//                     pipeline passes its own storage dir here so a
//                     privately uploaded city's baked output never lands
//                     under public/, which Vite serves with no access
//                     control (see the "Upload your own city" plan).
// ===================================================================
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveBuildingLod, layersWithRole, LAYER_ROLES } from '../src/config/city-schema.js';
import { createExtent } from '../src/workers/geo-inference.js';
import { createBucketer, buildTileBuffers, tileTriCounts, releaseBucket, ALL_TILE_DETAILS } from '../src/workers/building-tile-builder.js';
import { encodeTilePayload, decodeTilePayload } from '../src/workers/tile-binary-format.js';
import { meshBoundsOf } from '../src/workers/tile-bounds.js';
import { readFeatureBatches, GeojsonFileError } from './geojson-feature-stream.mjs';
import { computeRadii } from './tier-radii.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------
// CLI parsing -- hand-rolled, no new dependency for a handful of flags.
// ---------------------------------------------------------------------
/**
 * `--flag value` pairs and bare `--flag` switches. A value starting with
 * "--" is never taken as a value (that is the next flag), which is why the
 * server validates --height-property before passing it (server/lib/sanitize.js).
 * @param {string[]} argv
 * @returns {Record<string, string|true>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|true>} */
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i++;
  }
  return args;
}

/**
 * A numeric flag, or its default when absent. Refuses anything else with a
 * message naming the flag: Number() alone turned a bare `--tile-size` (no
 * value, so `true`) into 1 -- a 1 m tile grid, i.e. one tile per building and
 * millions of files -- and a typo into NaN, which silently broke the bake.
 * @param {Record<string, string|true>} args @param {string} name @param {number} fallback
 * @param {{min?: number, max?: number}} [range] - inclusive
 * @returns {number}
 */
function numberArg(args, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (args[name] === undefined) return fallback;
  const n = typeof args[name] === 'string' ? Number(args[name]) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`--${name} must be a number${min > -Infinity ? ` from ${min}` : ''}${max < Infinity ? ` to ${max}` : ''} (got "${args[name] === true ? '(no value)' : args[name]}")`);
  }
  return n;
}

/** @param {string} s @returns {string} */
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function loadCityConfig(cityId) {
  const modPath = join(PROJECT_ROOT, 'src', 'config', 'cities', `${cityId}.config.js`);
  const mod = await import(pathToFileURL(modPath).href);
  const exportName = `${cityId}Config`;
  const config = mod[exportName];
  if (!config) throw new Error(`${modPath} has no export named "${exportName}"`);
  return config;
}

/** Resolves every param this pipeline needs, from either invocation mode, into one plain object. */
async function resolveParams(args) {
  if (args.city) {
    const cityId = args.city;
    const config = await loadCityConfig(cityId);
    const [spec] = layersWithRole(config, LAYER_ROLES.BUILDINGS_3D);
    if (!spec) throw new Error(`CityConfig "${cityId}" declares no buildings-3d layer`);
    // sourceUrl (raw GeoJSON) once `url` has been switched to point at a
    // manifest for the runtime to consume; falls back to `url` itself for
    // a city not yet tiled, where url is still the raw file.
    const inputPath = join(PROJECT_ROOT, 'public', spec.sourceUrl ?? spec.url);
    const lod = resolveBuildingLod(config);
    return {
      cityId,
      inputPath,
      origin: config.origin,
      tileSizeM: config.buildings.tileSizeM,
      minRenderHeightM: spec.minRenderHeightM ?? config.buildings.minRenderHeightM,
      windowMinHeightM: config.buildings.windowMinHeightM,
      heightProperty: spec.heightProperty,
      targetFullTierTris: lod.targetFullTierTris,
      targetMediumTierTris: lod.targetMediumTierTris,
      existingConfig: true,
      outputRoot: args['output-root'] ?? 'public',
    };
  }

  if (args.input) {
    if (typeof args['height-property'] !== 'string') throw new Error('--input mode requires --height-property (which GeoJSON property holds building height)');
    if (typeof args.input !== 'string') throw new Error('--input needs a path');
    const inputPath = resolve(args.input);
    const cityId = typeof args['city-id'] === 'string' ? args['city-id'] : slugify(basename(args.input, extname(args.input)));
    const lod = resolveBuildingLod(null);
    const origin = (args['origin-lon'] !== undefined && args['origin-lat'] !== undefined)
      ? { lon: numberArg(args, 'origin-lon', 0, { min: -180, max: 180 }), lat: numberArg(args, 'origin-lat', 0, { min: -90, max: 90 }) }
      : null; // inferred later, once the file is read (needs the data itself)
    return {
      cityId,
      inputPath,
      origin,
      tileSizeM: numberArg(args, 'tile-size', 2000, { min: 1 }),
      minRenderHeightM: numberArg(args, 'min-render-height', 1.5, { min: 0 }),
      windowMinHeightM: numberArg(args, 'window-min-height', 12, { min: 0 }),
      heightProperty: args['height-property'],
      targetFullTierTris: numberArg(args, 'target-full-tris', lod.targetFullTierTris, { min: 1 }),
      targetMediumTierTris: numberArg(args, 'target-medium-tris', lod.targetMediumTierTris, { min: 1 }),
      existingConfig: false,
      outputRoot: typeof args['output-root'] === 'string' ? args['output-root'] : 'public',
    };
  }

  throw new Error('Usage: build-building-tiles.mjs --city <id>  OR  --input <path.geojson> --height-property <name> [options]');
}

/**
 * --radii-only: recompute just the radii from an existing manifest.json's
 * own per-tile triangle counts and rewrite it -- the tile geometry doesn't
 * depend on the radii, so there's no need to re-bake gigabytes of tiles to
 * change them (e.g. after retuning buildingLod, or moving to a new metric).
 * --dry-run prints the result without writing.
 */
function radiiOnly(args, params) {
  const manifestPath = resolve(PROJECT_ROOT, params.outputRoot, 'data', params.cityId, 'tiles', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const tiles = manifest.tiles.map((t) => ({
    centerX: t.centerX, centerZ: t.centerZ,
    triCounts: { full: t.tiers.full.triCount, medium: t.tiers.medium.triCount, coarse: t.tiers.coarse.triCount },
  }));
  const radii = computeRadii(tiles, { ...params, tileSizeM: manifest.tileSizeM });
  console.log(`[build-building-tiles] budgets: full<=${params.targetFullTierTris.toLocaleString()} tris, medium/coarse<=${params.targetMediumTierTris.toLocaleString()} tris`);
  console.log(`[build-building-tiles] manifest radii were ${JSON.stringify(manifest.radii)} (${manifest.radiusMetric ?? 'tile-centre'})`);
  console.log(`[build-building-tiles] recomputed (nearest-edge): full=${radii.fullRadiusM}m medium=${radii.mediumRadiusM}m coarse=${radii.coarseRadiusM}m`);
  if (args['dry-run']) { console.log('[build-building-tiles] --dry-run: manifest not written'); return; }
  manifest.radii = radii;
  manifest.radiusMetric = 'nearest-edge';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[build-building-tiles] rewrote radii in ${manifestPath}`);
}

/**
 * --bounds-only: decode every tile file the manifest points at and store each
 * tier's exact per-mesh bounding boxes back into the manifest (`tiers.<tier>.bounds`).
 * Reads all tier files (Kanpur: ~1.9 GB, about a minute); nothing is re-baked.
 */
function boundsOnly(args, params) {
  const tilesDir = resolve(PROJECT_ROOT, params.outputRoot, 'data', params.cityId, 'tiles');
  const manifestPath = join(tilesDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let done = 0;
  for (const t of manifest.tiles) {
    for (const tier of ALL_TILE_DETAILS) {
      // The Buffer goes straight in: decodeTilePayload() reads Node Buffers
      // correctly now, so the extra copy of every file (all ~1.9 GB of
      // Kanpur's tiers) into a fresh ArrayBuffer is gone.
      const payload = decodeTilePayload(readFileSync(join(tilesDir, t.tiers[tier].url)));
      t.tiers[tier].bounds = meshBoundsOf(payload);
    }
    if (++done % 25 === 0) console.log(`[build-building-tiles] bounds: ${done}/${manifest.tiles.length} tiles`);
  }
  if (args['dry-run']) { console.log('[build-building-tiles] --dry-run: manifest not written'); return; }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[build-building-tiles] wrote bounds for ${done} tiles x ${ALL_TILE_DETAILS.length} tiers into ${manifestPath}`);
}

function generatedConfigSource(params, origin, bbox) {
  return `// Auto-generated by scripts/build-building-tiles.mjs from ${basename(params.inputPath)}.
// Only the buildings-3d layer is wired up -- add roads/landuse/water/etc.
// layers by hand, then move this file to src/config/cities/${params.cityId}.config.js
// and export it as \`${params.cityId}Config\` to actually use it (see main.js).
import { LAYER_ROLES } from '../../../src/config/city-schema.js';

export const cityConfig = {
  id: ${JSON.stringify(params.cityId)},
  displayName: ${JSON.stringify(params.cityId)},
  origin: ${JSON.stringify(origin)},
  bbox: ${JSON.stringify(bbox)},
  layers: [
    { url: ${JSON.stringify(`data/${params.cityId}/tiles/manifest.json`)}, role: LAYER_ROLES.BUILDINGS_3D, required: true, heightProperty: ${JSON.stringify(params.heightProperty)} },
  ],
  buildings: {
    tileSizeM: ${params.tileSizeM},
    minRenderHeightM: ${params.minRenderHeightM},
    windowMinHeightM: ${params.windowMinHeightM},
  },
  buildingLod: {
    targetFullTierTris: ${params.targetFullTierTris},
    targetMediumTierTris: ${params.targetMediumTierTris},
  },
  sun: { dayStartHour: 6, dayEndHour: 18, maxElevationDeg: 68, minElevationDeg: 8 },
};
`;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const params = await resolveParams(args);

  if (args['radii-only']) { radiiOnly(args, params); return; } // no need to read or re-bake anything
  if (args['bounds-only']) { boundsOnly(args, params); return; } // reads the tile files, re-bakes nothing

  console.log(`[build-building-tiles] reading ${params.inputPath} ...`);
  const t0 = performance.now();

  // The file is read a piece at a time (geojson-feature-stream.mjs) and
  // each building goes straight into its tile's bucket, so neither the file
  // nor its parsed features are ever all in memory at once -- what lets a
  // metro-sized file (Delhi: about 2 GB) be baked at all.
  let { origin } = params;
  let bbox = null;
  let featureCount = 0;
  let firstPropertyNames = null; // of the first building that has properties, for the "wrong height property" message below
  let bucketResult;
  const percent = (read, total) => (total ? Math.floor((100 * read) / total) : 100);
  const NO_BUILDINGS = 'the buildings file has no buildings in it (its "features" list is empty). Export it again and revise.';
  try {
    if (!origin) {
      // No origin given: it is the centre of the data's own extent, which
      // has to be known before anything can be placed -- a first pass over
      // the file just for that.
      const extent = createExtent();
      let seen = 0;
      for (const { features, bytesRead, totalBytes } of readFeatureBatches(params.inputPath)) {
        for (const f of features) extent.add(f);
        seen += features.length;
        console.log(`[build-building-tiles] finding the data's extent: ${percent(bytesRead, totalBytes)}%`);
      }
      if (seen === 0) throw new GeojsonFileError(NO_BUILDINGS);
      ({ origin, bbox } = extent.result());
      params.origin = origin; // createBucketer() reads params.origin directly
      console.log(`[build-building-tiles] inferred origin from data: lon=${origin.lon.toFixed(4)}, lat=${origin.lat.toFixed(4)}`);
    }

    const extent = bbox ? null : createExtent(); // the generated config wants the bbox even when the origin was given
    const bucketer = createBucketer(params);
    for (const { features, bytesRead, totalBytes } of readFeatureBatches(params.inputPath)) {
      for (const f of features) {
        firstPropertyNames ??= f.properties ? Object.keys(f.properties) : null;
        extent?.add(f);
        bucketer.add(f);
      }
      featureCount += features.length;
      // Read by the server's bakeJob.js to show build progress -- keep the wording in sync with its BAKE_PROGRESS patterns.
      console.log(`[build-building-tiles] read ${percent(bytesRead, totalBytes)}% of the file, ${featureCount} buildings so far`);
    }
    if (featureCount === 0) throw new GeojsonFileError(NO_BUILDINGS);
    if (extent) bbox = extent.result().bbox;
    bucketResult = bucketer.result();
  } catch (err) {
    if (!(err instanceof GeojsonFileError)) throw err;
    // A problem with the file itself. The "ERROR:" line is shown to the uploader as-is (server/jobs/bakeJob.js).
    console.error(`[build-building-tiles] ERROR: ${err.message}`);
    process.exit(1);
  }
  console.log(`[build-building-tiles] parsed ${featureCount} features in ${(performance.now() - t0).toFixed(0)}ms`);

  const { tiles, stats } = bucketResult;
  console.log(`[build-building-tiles] bucketed into ${tiles.size} tiles (${stats.buildingCount} buildings, ${stats.skippedCount} skipped, ${stats.roofFailedCount} roof-triangulation failures)`);
  if (tiles.size === 0) {
    // Nothing to bake. Without this, computeRadii() below searched an
    // infinite range over an empty tile list and never returned -- a wrong
    // height property name hung the build until its timeout. The "ERROR:"
    // line is shown to the uploader as-is (server/jobs/bakeJob.js).
    const seen = (firstPropertyNames ?? []).slice(0, 12).join(', ') || 'none';
    console.error(`[build-building-tiles] ERROR: none of the ${featureCount.toLocaleString('en-IN')} buildings has a usable height in the property "${params.heightProperty}" (a number of at least ${params.minRenderHeightM} m). Properties in this file: ${seen}. Revise with the right height property name.`);
    process.exit(1);
  }

  // Per-tile tri counts per tier, and the flat list findRadiusForBudget/worstCaseSum need.
  const tileList = [...tiles.entries()].map(([key, bucket]) => {
    const centerX = (bucket.ix + 0.5) * params.tileSizeM;
    const centerZ = (bucket.iz + 0.5) * params.tileSizeM;
    return { key, bucket, centerX, centerZ, triCounts: tileTriCounts(bucket) };
  });

  const { fullRadiusM, mediumRadiusM, coarseRadiusM } = computeRadii(tileList, params);
  console.log(`[build-building-tiles] computed radii (nearest-edge): full=${fullRadiusM}m medium=${mediumRadiusM}m coarse=${coarseRadiusM}m`);

  const tilesDir = resolve(PROJECT_ROOT, params.outputRoot, 'data', params.cityId, 'tiles');
  for (const tier of ALL_TILE_DETAILS) mkdirSync(join(tilesDir, tier), { recursive: true });

  const manifestTiles = [];
  const tierByteTotals = { full: 0, medium: 0, coarse: 0 };
  const tierTriTotals = { full: 0, medium: 0, coarse: 0 };
  let processed = 0;

  for (const { key, bucket, centerX, centerZ } of tileList) {
    const tierEntries = {};
    for (const tier of ALL_TILE_DETAILS) {
      const payload = buildTileBuffers(bucket, tier);
      const encoded = encodeTilePayload(payload);
      const fileName = `${bucket.ix}_${bucket.iz}.bin`;
      writeFileSync(join(tilesDir, tier, fileName), encoded);
      const triCount = tileTriCounts(bucket)[tier];
      // Relative to manifest.json's OWN directory (BuildingLayer.js resolves
      // tier URLs against wherever it fetched the manifest FROM, not
      // against the city folder one level up) -- no "tiles/" prefix here,
      // manifest.json already lives inside that tiles/ folder.
      tierEntries[tier] = { url: `${tier}/${fileName}`, byteSize: encoded.byteLength, triCount, bounds: meshBoundsOf(payload) };
      tierByteTotals[tier] += encoded.byteLength;
      tierTriTotals[tier] += triCount;
    }
    manifestTiles.push({ ix: bucket.ix, iz: bucket.iz, centerX, centerZ, tiers: tierEntries });
    releaseBucket(bucket); // all three tiers are on disk

    processed++;
    if (processed % 25 === 0) console.log(`[build-building-tiles] ${processed}/${tileList.length} tiles written`);
  }

  const manifest = {
    cityId: params.cityId,
    tileSizeM: params.tileSizeM,
    origin,
    radii: { fullRadiusM, mediumRadiusM, coarseRadiusM },
    radiusMetric: 'nearest-edge', // camera -> nearest point of a tile's box (see BuildingLayer.updateTiers); older manifests measured to the tile centre
    generatedAt: new Date().toISOString(),
    sourceStats: stats,
    tiles: manifestTiles,
  };
  writeFileSync(join(tilesDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (!params.existingConfig) {
    const configPath = resolve(PROJECT_ROOT, params.outputRoot, 'data', params.cityId, 'generated.config.js');
    writeFileSync(configPath, generatedConfigSource(params, origin, bbox));
    console.log(`[build-building-tiles] wrote starter CityConfig: ${configPath}`);
  }

  const inputBytes = statSync(params.inputPath).size;
  const totalOutBytes = tierByteTotals.full + tierByteTotals.medium + tierByteTotals.coarse;
  console.log('\n[build-building-tiles] done.');
  console.log(`  input:  ${(inputBytes / 1e6).toFixed(1)} MB (raw GeoJSON)`);
  console.log(`  output: ${(totalOutBytes / 1e6).toFixed(1)} MB across all 3 tiers combined`);
  for (const tier of ALL_TILE_DETAILS) {
    console.log(`    ${tier.padEnd(6)} ${(tierByteTotals[tier] / 1e6).toFixed(1)} MB, ${tierTriTotals[tier].toLocaleString()} triangles total across ${tileList.length} tiles`);
  }
  console.log(`  manifest: ${join(tilesDir, 'manifest.json')}`);
  console.log(`  memory: ${Math.round(process.resourceUsage().maxRSS / 1024).toLocaleString()} MB at its peak`); // in the build log, for sizing a server against the cities people upload
}

main().catch((err) => {
  console.error('[build-building-tiles] FAILED:', err);
  process.exit(1);
});
