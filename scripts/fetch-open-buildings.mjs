#!/usr/bin/env node
// ===================================================================
// fetch-open-buildings.mjs -- downloads a city's buildings, each
// footprint with a height, as the GeoJSON the "Upload a city" form takes.
// No account, no Earth Engine, no GIS software: give it the West, South,
// East and North numbers shown in step 1 of the upload form once the
// area is drawn.
//
//   node scripts/fetch-open-buildings.mjs --bbox 80.178,26.315,80.493,26.553 --name Kanpur
//   node scripts/fetch-open-buildings.mjs --west 80.178 --south 26.315 --east 80.493 --north 26.553
//
// Source (--source):
//   google     (default) Google Open Buildings: v3 footprints, each with its
//              average height from Open Buildings 2.5D Temporal, the way
//              Kanpur's own file was made. Writes <name>_OpenBuildings_2_5D.geojson
//              with the height as `mean`. Africa, South and Southeast Asia,
//              Latin America and the Caribbean.
//   microsoft  Microsoft's (Bing Maps) Global ML Building Footprints, the
//              fallback: worldwide, but heights only where Microsoft has
//              estimated them, which for Indian cities is none. Add
//              --flat-height. Writes <name>_MicrosoftBuildings.geojson with
//              the height as `height`.
//
// Options:
//   --name <text>          start of the file name (default "city")
//   --out <path>           write here instead
//   --year <yyyy>          google: heights as of 30 June of that year, 2016 onwards (default: the latest there is)
//   --min-confidence <n>   leave out footprints the source is less sure of, 0 to 1 (default: keep all)
//   --flat-height <m>      give this height to every building that has none, instead of leaving it out
//   --microsoft-index <url> microsoft: the index of files to use (default: the newest, from Microsoft's README)
//   --overwrite            replace an existing file
//
// Kanpur (google, about 8.5 lakh buildings in this box) downloads about
// 0.7 GB, takes about 6 minutes and writes a ~240 MB file.
// Behind a proxy, set NODE_USE_ENV_PROXY=1 and HTTPS_PROXY first (HOSTING.md).
// If neither source works, DATA_SOURCES.md has the Earth Engine route.
// How it works: open-buildings-lib.mjs. Checks: test-fetch-open-buildings.mjs.
// ===================================================================
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFootprints, addHeights, readMicrosoftFootprints, writeBuildingsGeojson, UserError, MAX_AREA_SQ_DEG, MIN_CONFIDENCE_FLOOR } from './open-buildings-lib.mjs';

/**
 * `--flag value` pairs and bare `--flag` switches (as in build-building-tiles.mjs).
 * A value starting with "--" is the next flag.
 * @param {string[]} argv @returns {Record<string, string|true>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|true>} */
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new UserError(`unexpected "${argv[i]}" (options start with --; see the top of scripts/fetch-open-buildings.mjs)`);
    const key = argv[i].slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i++;
  }
  return args;
}

/** A number option, or its default; anything else is refused naming the option. */
function numberArg(args, name, fallback, min, max) {
  if (args[name] === undefined) return fallback;
  const n = typeof args[name] === 'string' ? Number(args[name]) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw new UserError(`--${name} must be a number from ${min} to ${max} (got "${args[name] === true ? '(nothing)' : args[name]}")`);
  return n;
}

/** The area, from --bbox west,south,east,north or the four separate options. */
function readArea(args) {
  let parts;
  if (args.bbox !== undefined) {
    parts = String(args.bbox).split(',').map((s) => s.trim());
    if (parts.length !== 4) throw new UserError('--bbox takes four numbers separated by commas: west,south,east,north');
  } else if (['west', 'south', 'east', 'north'].every((k) => args[k] !== undefined)) {
    parts = ['west', 'south', 'east', 'north'].map((k) => args[k]);
  } else {
    throw new UserError('give the area: --bbox west,south,east,north (the four numbers from step 1 of the upload form)');
  }
  const [west, south, east, north] = parts.map((p) => (typeof p === 'string' && p.trim() !== '' ? Number(p) : NaN));
  if (![west, south, east, north].every(Number.isFinite)) throw new UserError('the area must be four numbers: west,south,east,north');
  if (west < -180 || east > 180 || south < -80 || north > 84) throw new UserError('longitudes go from -180 to 180 and latitudes from -80 to 84');
  if (west >= east) throw new UserError(`West (${west}) must be less than East (${east})`);
  if (south >= north) throw new UserError(`South (${south}) must be less than North (${north})`);
  if ((east - west) * (north - south) > MAX_AREA_SQ_DEG) throw new UserError('the area is larger than any city (more than about 1.5 x 1.5 degrees). Draw the city, not the district or the state');
  return { west, south, east, north };
}

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const area = readArea(args);
  const source = args.source === undefined ? 'google' : String(args.source).toLowerCase();
  if (source !== 'google' && source !== 'microsoft') throw new UserError('--source is google (the default) or microsoft');
  if (source === 'microsoft' && args.year !== undefined) throw new UserError("--year is for Google's heights; Microsoft's footprints have one height each, or none");
  const year = args.year === undefined ? null : numberArg(args, 'year', null, 2016, new Date().getFullYear());
  const minConfidence = numberArg(args, 'min-confidence', source === 'google' ? MIN_CONFIDENCE_FLOOR : 0, 0, 1);
  const flatHeight = args['flat-height'] === undefined ? null : numberArg(args, 'flat-height', null, 1, 300);
  const indexUrl = args['microsoft-index'] === undefined ? null : String(args['microsoft-index']);
  if (indexUrl !== null && !/^https:\/\//.test(indexUrl)) throw new UserError('--microsoft-index takes the https:// link to a dataset-links.csv');
  const name = args.name === undefined ? 'city' : String(args.name).trim().replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'city';
  const fileStem = `${name}_${source === 'google' ? 'OpenBuildings_2_5D' : 'MicrosoftBuildings'}`;
  const heightProperty = source === 'google' ? 'mean' : 'height';
  const out = resolve(typeof args.out === 'string' ? args.out : `${fileStem}.geojson`);
  if (existsSync(out) && !args.overwrite) throw new UserError(`${out} already exists. Delete it, choose another --out, or add --overwrite`);
  const log = (line) => console.log(line);

  const km = (deg, lat) => (deg * 111.32 * (lat === undefined ? 1 : Math.cos((lat * Math.PI) / 180))).toFixed(1);
  log(`Area: west ${area.west}, south ${area.south}, east ${area.east}, north ${area.north} (about ${km(area.east - area.west, (area.south + area.north) / 2)} x ${km(area.north - area.south)} km)`);
  let footprints, heights, about;
  if (source === 'google') {
    footprints = await readFootprints(area, { minConfidence, log });
    log(`${footprints.count.toLocaleString('en-IN')} buildings in the area`);
    const got = await addHeights(footprints, area, { year, log });
    heights = got.heights;
    log(`Heights downloaded: ${(got.bytes / 1e6).toFixed(0)} MB`);
    about = {
      footprints: 'Google Open Buildings v3 polygons',
      heights: `Google Open Buildings 2.5D Temporal v1, as of 30 June ${got.year}: each building's mean height in metres`,
      licence: 'CC BY 4.0 or ODbL v1.0; credit Google Open Buildings',
      asOf: got.year,
    };
  } else {
    ({ footprints, heights } = await readMicrosoftFootprints(area, { minConfidence, indexUrl, log }));
    log(`${footprints.count.toLocaleString('en-IN')} buildings in the area`);
    about = {
      footprints: "Microsoft (Bing Maps) Global ML Building Footprints",
      heights: "Microsoft's estimate in metres, where it has one",
      licence: 'CDLA Permissive 2.0; credit Microsoft',
    };
  }
  let filled = 0;
  if (flatHeight !== null) {
    for (let b = 0; b < heights.length; b++) if (!Number.isFinite(heights[b])) { heights[b] = flatHeight; filled++; }
    if (filled) about.flatHeight = `${filled} buildings with no height were given ${flatHeight} m (--flat-height)`;
  }
  const meta = { ...about, area: [area.west, area.south, area.east, area.north], minConfidence, made: new Date().toISOString().slice(0, 10), by: 'scripts/fetch-open-buildings.mjs' };
  const { withHeight } = await writeBuildingsGeojson(out, footprints, heights, { name: fileStem, source: meta, heightProperty });
  const missing = footprints.count - withHeight;
  log('');
  log(`Wrote ${out}`);
  log(`  ${footprints.count.toLocaleString('en-IN')} buildings, ${withHeight.toLocaleString('en-IN')} with a height${filled ? ` (${filled.toLocaleString('en-IN')} of them the flat ${flatHeight} m)` : ''}${about.asOf ? `; heights as of 30 June ${about.asOf}` : ''}`);
  if (missing) log(`  ${missing.toLocaleString('en-IN')} have no height and will be left out of the 3D city${flatHeight === null ? '. To give them one, run again with --flat-height 6 (about two storeys)' : ''}`);
  log(`  took ${Math.round((Date.now() - started) / 1000)} s`);
  log(`Next: in the upload form, attach this file as the buildings file and choose "${heightProperty}" as the height property.`);
}

main().catch((err) => {
  if (err instanceof UserError) console.error(`ERROR: ${err.message}`);
  else console.error(`ERROR: ${err?.message ?? err}\n${err?.cause ? `(cause: ${err.cause.message ?? err.cause})\n` : ''}If this keeps happening, see "Buildings" in DATA_SOURCES.md for the other routes.\n\n${err?.stack ?? ''}`);
  process.exitCode = 1;
});
