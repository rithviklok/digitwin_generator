// ===================================================================
// osmJob.js -- runs osmFetchChild.js for one build and reads back what
// it produced. Mirrors bakeJob.js: the parent only spawns and collects.
// ===================================================================
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runNodeScript } from './childProcess.js';

const CHILD_PATH = resolve(import.meta.dirname, 'osmFetchChild.js');

/**
 * @param {object} params
 * @param {{west:number, south:number, east:number, north:number}} params.bbox
 * @param {string} params.outDir - emptied first, so a re-run never mixes in an earlier attempt's files
 * @param {string[]} params.endpoints
 * @param {string|null} params.exportPath - the uploader's own OSM export; when set, nothing is downloaded
 * @param {Record<string, string>} params.manual - role -> path of the uploader's own file for that layer
 * @param {string} params.cacheDir - per-city download cache (kept across builds, unlike outDir)
 * @param {number} params.downloadMs - how long the step may keep asking the servers; what it has by then is still turned into layers
 * @param {number} params.timeoutMs - when the whole step is stopped, however far it got (downloadMs plus time to make the layers)
 * @param {{lon: number, lat: number}} params.origin - the city's origin and
 * @param {number} params.tileSizeM - its building tile size: what a large city's road tiles are laid out on
 * @param {(pct: number, text: string) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal] - the city is being deleted: stop
 * @returns {Promise<{ok: boolean, logText: string,
 *   files: Array<{role: string, path: string, count: number, tiled?: boolean}>,
 *   failed: Array<{roles: string[]|null, error: string}>,
 *   manual: Record<string, {path?: string, count?: number, tiled?: boolean, error?: string}>,
 *   railwayStationNames: string[]}>}
 *   `ok: false` means no summary at all (crash / timeout) -- `failed` then has one entry with roles: null (= every layer).
 *   `tiled`: `path` is a folder of tiles with a manifest.json, not one GeoJSON file.
 */
export async function runOsmFetch({ bbox, outDir, endpoints, exportPath, manual, cacheDir, downloadMs, timeoutMs, origin, tileSizeM, onProgress, signal }) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const planPath = join(outDir, 'plan.json');
  writeFileSync(planPath, JSON.stringify({ bbox, endpoints, exportPath, manual, out: outDir, cacheDir, deadline: Date.now() + downloadMs, origin, tileSizeM }));
  const onLine = onProgress && ((line) => {
    const m = /^\[progress\] (\d+) (.*)$/.exec(line);
    if (m) onProgress(Number(m[1]), m[2]);
  });
  const run = await runNodeScript(CHILD_PATH, ['--plan', planPath], { timeoutMs, onLine, signal });

  let summary = null;
  try { summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8')); } catch { /* crashed or timed out before writing it */ }
  if (!summary) {
    const why = run.timedOut ? `timed out after ${Math.round(timeoutMs / 60000)} min` : `stopped unexpectedly (exit code ${run.exitCode})`;
    return { ok: false, logText: run.logText, files: [], failed: [{ roles: null, error: `OpenStreetMap step ${why}` }], manual: {}, railwayStationNames: [] };
  }

  // A layer written as tiles (a large city's roads) is a folder, not a file.
  const files = Object.entries(summary.counts)
    .filter(([, count]) => count > 0)
    .map(([role, count]) => (summary.tiled?.[role]
      ? { role, path: join(outDir, summary.tiled[role]), count, tiled: true }
      : { role, path: join(outDir, `${role}.geojson`), count }));
  return { ok: true, logText: run.logText, files, failed: summary.failed, manual: summary.manual, railwayStationNames: summary.railwayStationNames ?? [] };
}
