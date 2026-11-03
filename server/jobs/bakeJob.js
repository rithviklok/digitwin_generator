// ===================================================================
// bakeJob.js -- child_process wrapper around
// scripts/build-building-tiles.mjs's --input mode. That script has no
// exported function to call (it runs main() unconditionally when
// loaded, with no import.meta.url guard) and no input sanitization of
// its own, so this is the one place a bake actually gets spawned, and
// the one place its arguments must already be trusted before they arrive
// (see lib/sanitize.js -- call those BEFORE building `params` here).
//
// Also turns the script's own progress lines into a percentage for the
// uploader's Review & build page (BAKE_PROGRESS below).
// ===================================================================
import { resolve } from 'node:path';
import { runNodeScript } from './childProcess.js';

const SCRIPT_PATH = resolve(import.meta.dirname, '..', '..', 'scripts', 'build-building-tiles.mjs');
const n = (s) => Number(s).toLocaleString('en-IN');
const OUT_OF_MEMORY = /JavaScript heap out of memory|Array buffer allocation failed/;

/**
 * The bake's phases, as it prints them, mapped onto 0-100% in proportion
 * to the time each takes -- the Review & build page's time-left estimate
 * (lib/eta.js) relies on "percent done ≈ percent of time spent". Weights
 * from timing two real bakes phase by phase on the development PC
 * (2026-09-30):
 *                                   reading+placing  detail levels  writing tiles
 *   Kanpur, 283 MB, 7.3 lakh, 27 s        25%            14%            61%
 *   Delhi-sized, 2.3 GB, 58 lakh, 5 min   17%             4%            77%
 * (Writing is limited by the disk, which a big city keeps busy for
 * minutes.) The split used here sits between the two -- 21 / 9 / 69 -- so
 * the estimate is within about a third for both from the first report on.
 * It corrects itself as each phase reports, and the text always names the
 * phase; "detail levels" prints nothing until it's done, hence its own label.
 */
const BAKE_PROGRESS = [
  [/\] reading /, () => [1, 'Reading your buildings file…']],
  [/\] read (\d+)% of the file, (\d+) buildings/, (m) => [1 + Math.round(0.2 * m[1]), `Reading your buildings file: ${n(m[2])} buildings so far`]],
  [/\] bucketed into (\d+) tiles \((\d+) buildings/, (m) => [21, `${n(m[2])} buildings placed on ${n(m[1])} map tiles. Working out detail levels…`]],
  [/\] computed radii/, () => [30, 'Detail levels done. Writing 3D tiles…']],
  [/\] (\d+)\/(\d+) tiles written/, (m) => [30 + Math.round((69 * m[1]) / m[2]), `Writing 3D tiles: ${n(m[1])} of ${n(m[2])}`]],
  [/\] done\./, () => [99, 'Finishing up…']],
];

/**
 * @param {object} params - already-sanitized (lib/sanitize.js, lib/ids.js)
 * @param {string} params.inputPath
 * @param {string} params.heightProperty
 * @param {string} params.cityId
 * @param {string} params.outputRoot
 * @param {number} params.tileSizeM
 * @param {number} params.minRenderHeightM
 * @param {number} params.windowMinHeightM
 * @param {{lon:number, lat:number}} [params.origin]
 * @param {number} params.timeoutMs
 * @param {{onProgress?: (pct: number, text: string) => void, signal?: AbortSignal}} [opts]
 * @returns {Promise<{ok: boolean, exitCode: number|null, logText: string, timedOut: boolean, cancelled: boolean, errorText: string|null}>}
 */
export async function runBake(params, { onProgress, signal } = {}) {
  const args = [
    '--input', params.inputPath,
    '--height-property', params.heightProperty,
    '--city-id', params.cityId,
    '--output-root', params.outputRoot,
    '--tile-size', String(params.tileSizeM),
    '--min-render-height', String(params.minRenderHeightM),
    '--window-min-height', String(params.windowMinHeightM),
  ];
  if (params.origin) {
    args.push('--origin-lon', String(params.origin.lon), '--origin-lat', String(params.origin.lat));
  }
  // The script's own "ERROR: ..." line is written for people (e.g. "none of
  // the 7,25,627 buildings has a usable height in the property ..."), so it
  // becomes the failure reason on the uploader's Review & build page.
  let errorText = null;
  const onLine = (line) => {
    const err = /\] ERROR: (.*)$/.exec(line);
    if (err) { errorText = err[1]; return; }
    // Node's own last words when it runs out of memory -- a crash dump otherwise, and no reason at all on the page.
    if (OUT_OF_MEMORY.test(line)) { errorText ??= 'the server ran out of memory while building this city. It is too large for this server as it stands: upload a smaller area, or ask whoever runs the server to give it more memory.'; return; }
    if (!onProgress) return;
    for (const [re, toProgress] of BAKE_PROGRESS) {
      const m = re.exec(line);
      if (m) { onProgress(...toProgress(m)); return; }
    }
  };
  const result = await runNodeScript(SCRIPT_PATH, args, { timeoutMs: params.timeoutMs, onLine, signal });
  return { ...result, errorText };
}
