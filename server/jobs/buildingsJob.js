// ===================================================================
// buildingsJob.js -- runs scripts/fetch-open-buildings.mjs for one build:
// the "Get them for me from Google Open Buildings" choice in the upload
// form. Downloads every building in the drawn area with its height and
// writes the GeoJSON the bake then reads, just as if it had been uploaded.
// Mirrors bakeJob.js: out of process (it parses hundreds of MB of CSV, which
// would stall every status poll if done in the server itself), the
// script's progress lines turned into a percentage for the Review & build
// page, and its own "ERROR: ..." line, written for people, as the reason a
// build stopped.
// ===================================================================
import { resolve } from 'node:path';
import { runNodeScript } from './childProcess.js';

const SCRIPT_PATH = resolve(import.meta.dirname, '..', '..', 'scripts', 'fetch-open-buildings.mjs');
/** "2,12,941" (the script already writes Indian grouping) -> the same, from a number either way. */
const n = (s) => Number(String(s).replace(/,/g, '')).toLocaleString('en-IN');

/**
 * The script's phases mapped onto 0-100% by the time each takes. Kanpur
 * (8.5 lakh buildings, 2026-10-02): the footprint download about 80% of
 * the run, the heights about 18%, writing the file the rest.
 * Each entry: a pattern for one of the script's lines -> [percent, text].
 */
const FETCH_PROGRESS = [
  [/^Footprints, file (\d+) of (\d+) .*: downloading (.*)$/, (m) => [2 + Math.round((78 * (m[1] - 1)) / m[2]), `Downloading building footprints from Google (${m[3]})…`]],
  [/^Footprints, file (\d+) of (\d+) .*: none/, (m) => [2 + Math.round((78 * m[1]) / m[2]), 'Downloading building footprints from Google…']],
  // The bar shows the step's own percentage, so the text gives the count, not a second percentage.
  [/^ {2}(\d+)% downloaded, ([\d,]+) buildings in the area so far$/, (m, state) => [2 + Math.round((78 * (state.file - 1 + m[1] / 100)) / state.files), `Downloading building footprints${state.files > 1 ? ` (part ${state.file} of ${state.files})` : ''}: ${n(m[2])} buildings in your area so far`]],
  [/^([\d,]+) buildings in the area$/, (m) => [80, `${n(m[1])} buildings found. Adding their heights…`]],
  [/^Heights \((\d{4})\): (\d+) tiles?/, (m) => [81, `Adding heights (as of ${m[1]}) from ${m[2]} height map tile${m[2] === '1' ? '' : 's'}…`]],
  [/^ {2}tile (\d+) of (\d+):/, (m) => [81 + Math.round((17 * m[1]) / m[2]), `Adding heights: map tile ${m[1]} of ${m[2]}`]],
  [/^Heights downloaded/, () => [98, 'Writing the buildings file…']],
];

/**
 * Turns one line of the script's output into progress, keeping track of
 * which footprint file it is on (several for a city crossing S2 cells).
 * Exported for test-fetch-open-buildings.mjs.
 * @param {string} line
 * @param {{file: number, files: number}} state - updated in place
 * @returns {[number, string]|null}
 */
export function fetchProgressOf(line, state) {
  const file = /^Footprints, file (\d+) of (\d+)/.exec(line);
  if (file) { state.file = Number(file[1]); state.files = Number(file[2]); }
  for (const [re, toProgress] of FETCH_PROGRESS) {
    const m = re.exec(line);
    if (m) return toProgress(m, state);
  }
  return null;
}

/**
 * @param {object} params
 * @param {{west: number, south: number, east: number, north: number}} params.bbox
 * @param {string} params.outPath - where the buildings GeoJSON goes (replaced if there)
 * @param {number} params.timeoutMs
 * @param {(pct: number, text: string) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal] - the city is being deleted: stop
 * @returns {Promise<{ok: boolean, logText: string, errorText: string|null, timedOut: boolean,
 *   buildings: number|null, withHeight: number|null, year: number|null}>}
 *   errorText is the script's own explanation (e.g. no Google coverage), in plain words.
 */
export async function runBuildingsFetch({ bbox, outPath, timeoutMs, onProgress, signal }) {
  const args = ['--bbox', [bbox.west, bbox.south, bbox.east, bbox.north].join(','), '--out', outPath, '--overwrite'];
  const state = { file: 1, files: 1 };
  let errorText = null, buildings = null, withHeight = null, year = null;
  const onLine = (line) => {
    const err = /^ERROR: (.*)$/.exec(line);
    if (err) { errorText ??= err[1]; return; }
    const done = /^ {2}([\d,]+) buildings, ([\d,]+) with a height.*heights as of 30 June (\d{4})/.exec(line);
    if (done) { buildings = Number(done[1].replace(/,/g, '')); withHeight = Number(done[2].replace(/,/g, '')); year = Number(done[3]); return; }
    const progress = onProgress && fetchProgressOf(line, state);
    if (progress) onProgress(...progress);
  };
  const run = await runNodeScript(SCRIPT_PATH, args, { timeoutMs, onLine, signal });
  if (!run.ok && !errorText) {
    errorText = run.timedOut
      ? `downloading the buildings from Google took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped. Try again later, or upload a buildings file instead`
      : run.cancelled ? 'stopped' : `downloading the buildings from Google stopped unexpectedly (exit code ${run.exitCode})`;
  }
  return { ok: run.ok, logText: run.logText, errorText, timedOut: run.timedOut, buildings, withHeight, year };
}
