// ===================================================================
// jobHooks.js -- the city-specific steps JobRunner calls around a bake:
//   - onJobStarting: first, when the uploader chose "Get them for me from
//     Google Open Buildings", downloads the drawn area's buildings (stage
//     'buildings'; a failure stops the build, as there is nothing to build
//     without them). Then produces the city's OpenStreetMap-type layers
//     (roads, railway, amenities, localities, land use, vegetation,
//     water) -- from the uploader's own per-layer files where given,
//     else their OSM export if given, else downloaded for the drawn
//     bounding box -- and adds them to the job's layer files.
//   - onJobSucceeded: copies every validated layer file into the job's
//     output directory, records layer_files (needs job_id), assembles +
//     self-validates the CityConfig, and makes the build live.
//   - onJobFailed: records what was submitted, for the admin.
//
// There is no manual review: a build that succeeds goes live at once
// (cities.status = 'live', current_job_id = this job) -- replacing the
// city's previous live build, if it had one. A build that fails never
// touches current_job_id.
// ===================================================================
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { assembleCityConfig } from './assembleConfig.js';
import { runOsmFetch } from '../jobs/osmJob.js';
import { runBuildingsFetch } from '../jobs/buildingsJob.js';
import { OSM_ROLES } from './osmSplitter.js';
import { downloadParts, MAX_DOWNLOAD_PARTS } from './overpass.js';
import { ROAD_TILES_DIR } from './roadTiles.js';
import { config } from '../config.js';

const OSM_SOURCE_NAME = 'OpenStreetMap';

// How long the OpenStreetMap step may take. config.osmFetchTimeoutMs
// (OSM_FETCH_TIMEOUT_MIN) is the download's allowance for a city small
// enough to be asked for in one part, which is three requests (roads,
// railway, areas). Each further part adds EXTRA_MS_PER_PART: with the
// public servers refusing more than half of all requests, a Delhi-sized
// download averaged 27 s per answered request on 2026-09-30, waits
// included, so 2 minutes is four times that. Turning the data into
// layers comes on top (LAYER_MAKING_MS): 90 s for that city's 3.5 lakh
// features, its road tiles included.
const ONE_PART_CITY_REQUESTS = 3;
const EXTRA_MS_PER_PART = 2 * 60 * 1000;
const LAYER_MAKING_MS = 20 * 60 * 1000;

/**
 * A reason a build stopped, worded for the uploader: jobRunner.js shows
 * `userMessage` on the Review & build page and keeps `logText` in the job log.
 */
function stopBuild(message, logText = '') {
  const err = new Error(message);
  err.userMessage = message;
  err.logText = logText;
  return err;
}

const sameArea = (a, b) => ['west', 'south', 'east', 'north'].every((k) => Number(a?.[k]) === Number(b?.[k]));

export function makeJobHooks(db) {
  /**
   * Downloads the drawn area's buildings from Google Open Buildings into
   * meta.buildingsPath, the file the bake then reads. A revision of the
   * same area reuses what was downloaded last time: Google adds a year of
   * heights at most once a year, and Kanpur's download is 0.7 GB.
   * @returns {Promise<string>} log text
   */
  async function fetchBuildings(cityId, meta, { setStage, setProgress, signal }) {
    setStage('buildings');
    const outPath = meta.buildingsPath;
    const notePath = `${outPath}.json`; // what was downloaded, for which area
    try {
      const previous = JSON.parse(readFileSync(notePath, 'utf8'));
      if (sameArea(previous.bbox, meta.bbox) && existsSync(outPath)) {
        meta.buildingsFetch = previous;
        db.prepare(`UPDATE cities SET input_bytes_total = ? WHERE id = ?`).run(statSync(outPath).size, cityId);
        setProgress(100, `Using the ${Number(previous.buildings ?? 0).toLocaleString('en-IN')} buildings already downloaded for this area`);
        return `[buildings] reused ${outPath}: the same area as the download of ${previous.fetchedAt}`;
      }
    } catch { /* none yet, or unreadable: download */ }
    rmSync(notePath, { force: true });
    const run = await runBuildingsFetch({ bbox: meta.bbox, outPath, timeoutMs: config.buildingsFetchTimeoutMs, onProgress: setProgress, signal });
    if (!run.ok) throw stopBuild(run.errorText ?? 'the buildings could not be downloaded from Google', run.logText);
    meta.buildingsFetch = { bbox: meta.bbox, buildings: run.buildings, withHeight: run.withHeight, year: run.year, fetchedAt: new Date().toISOString() };
    writeFileSync(notePath, JSON.stringify(meta.buildingsFetch));
    // The admin page lists each city's input size; for a download it is only known now.
    db.prepare(`UPDATE cities SET input_bytes_total = ? WHERE id = ?`).run(statSync(outPath).size, cityId);
    return run.logText;
  }

  const insertLayerFile = db.prepare(`
    INSERT INTO layer_files (city_id, job_id, role, original_filename, byte_size, status, error_message, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function recordLayerFiles(cityId, jobId, pendingLayerFiles) {
    for (const lf of pendingLayerFiles ?? []) {
      insertLayerFile.run(cityId, jobId, lf.role, lf.originalFilename, lf.byteSize, lf.status, lf.errorMessage, lf.source);
    }
  }

  return {
    /**
     * An OpenStreetMap failure never fails the build: the buildings bake
     * is the slow, expensive part and doesn't depend on OSM at all, so
     * throwing it away because a public server was busy would be the
     * worse trade. Each missing role is recorded as an 'invalid'
     * layer_files row instead -- the Review & build page and the admin
     * both see exactly which layers didn't make it, and a revision
     * re-runs the download.
     */
    async onJobStarting(cityId, jobId, meta, { setStage, setProgress, signal }) {
      const buildingsLog = meta?.buildingsSource === 'google' ? await fetchBuildings(cityId, meta, { setStage, setProgress, signal }) : '';
      if (signal.aborted) return buildingsLog;
      if (!meta?.osm?.bbox) return buildingsLog;
      // The uploader's own file for an OSM layer (municipal survey / hand
      // export) always wins over OpenStreetMap for that layer; it's still
      // run through the child, to be brought to the viewer's shape.
      const manual = {};
      for (const lf of meta.pendingLayerFiles) {
        if (OSM_ROLES.includes(lf.role) && lf.source === 'manual' && lf.status === 'validated') manual[lf.role] = lf;
      }
      setStage('osm');
      // The download's time allowance grows with the area: a metro is asked
      // for in many parts (Delhi with its satellite cities: 17 requests,
      // against 3 for a city of one part), so it gets 20 + 14 x 2 = 48 min.
      const parts = Object.values(downloadParts(meta.osm.bbox)).reduce((n, cells) => n + cells.length, 0);
      const downloadMs = config.osmFetchTimeoutMs + Math.max(0, Math.min(parts, MAX_DOWNLOAD_PARTS) - ONE_PART_CITY_REQUESTS) * EXTRA_MS_PER_PART;
      const osm = await runOsmFetch({
        bbox: meta.osm.bbox,
        outDir: join(config.storageRoot, 'uploads', cityId, 'osm'),
        endpoints: config.overpassEndpoints,
        exportPath: meta.osm.exportPath ?? null,
        manual: Object.fromEntries(Object.entries(manual).map(([role, lf]) => [role, lf.sourcePath])),
        cacheDir: join(config.storageRoot, 'uploads', cityId, 'osm-cache'),
        downloadMs,
        timeoutMs: downloadMs + LAYER_MAKING_MS,
        origin: meta.origin,
        tileSizeM: meta.buildings.tileSizeM,
        onProgress: setProgress,
        signal,
      });

      for (const [role, lf] of Object.entries(manual)) {
        const result = osm.manual[role];
        if (result?.path) { lf.sourcePath = result.path; lf.tiled = Boolean(result.tiled); } // the normalized copy is what gets published
        else { lf.status = 'invalid'; lf.errorMessage = result?.error ?? osm.failed[0]?.error ?? 'could not be processed'; }
      }
      const sourceName = meta.osm.exportName ?? OSM_SOURCE_NAME;
      for (const file of osm.files) {
        meta.pendingLayerFiles.push({
          role: file.role, filename: `${file.role}.geojson`, source: 'osm-derived', originalFilename: sourceName,
          byteSize: file.count, status: 'validated', errorMessage: null, sourcePath: file.path, tiled: Boolean(file.tiled),
        });
      }
      for (const { roles, error } of osm.failed) {
        for (const role of roles ?? OSM_ROLES) {
          if (manual[role]) continue;
          meta.pendingLayerFiles.push({
            role, filename: null, source: 'osm-derived', originalFilename: sourceName,
            byteSize: 0, status: 'invalid', errorMessage: error, sourcePath: null,
          });
        }
      }
      if (osm.railwayStationNames.length) meta.labels = { railwayStationNames: osm.railwayStationNames };
      return [buildingsLog, osm.logText].filter(Boolean).join('\n');
    },

    async onJobSucceeded(cityId, jobId, result, meta) {
      const dataDir = join(result.outputRoot, 'data', cityId);
      mkdirSync(dataDir, { recursive: true });

      const lightLayers = [];
      for (const lf of meta.pendingLayerFiles) {
        if (lf.status !== 'validated') continue; // invalid files are still recorded below for admin visibility, just never copied/wired into the config
        // A large city's roads are a folder of tiles (lib/roadTiles.js), every other layer one GeoJSON file.
        // The folder is copied without blocking: a metro's is 1,400 files, and copied in one go it held up every
        // other request for seconds, status polls included (a Review & build page's poll was cut off by it).
        if (lf.tiled) await cp(lf.sourcePath, join(dataDir, ROAD_TILES_DIR), { recursive: true });
        else copyFileSync(lf.sourcePath, join(dataDir, lf.filename));
        lightLayers.push({ role: lf.role, source: lf.source, tiled: Boolean(lf.tiled) });
      }
      recordLayerFiles(cityId, jobId, meta.pendingLayerFiles);

      const { ok, config: cityConfig, errors } = assembleCityConfig({
        cityId, jobId: String(jobId), displayName: meta.displayName, origin: meta.origin, bbox: meta.bbox,
        buildings: meta.buildings, heightProperty: meta.heightProperty, lightLayers, labels: meta.labels,
        publicApiBaseUrl: config.publicApiBaseUrl,
      });

      if (!ok) {
        // The bake succeeded but the config we built from it doesn't pass
        // the SAME validateCityConfig() the front end trusts -- a real bug
        // (a schema mismatch this backend introduced), not a problem with
        // the uploader's data. Fail loudly rather than serve a city the
        // viewer would refuse to load.
        db.prepare(`UPDATE cities SET status = 'failed', failure_reason = ? WHERE id = ?`)
          .run(`internal: assembled config failed validateCityConfig(): ${errors.join('; ')}`, cityId);
        console.error(`[jobHooks] city ${cityId} job ${jobId}: assembled config invalid:`, errors);
        return;
      }
      // Live from here. The config and the pointer to it are written
      // together: routes/cities.js serves whatever current_job_id points at,
      // so it must never point at a job that has no config.
      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE jobs SET config_json = ? WHERE id = ?`).run(JSON.stringify(cityConfig), jobId);
        db.prepare(`UPDATE cities SET status = 'live', current_job_id = ?, failure_reason = NULL WHERE id = ?`).run(jobId, cityId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    async onJobFailed(cityId, jobId, result, meta) {
      // Record what was submitted even though the bake itself failed -- an
      // admin (or the uploader, via the Review & build page) should be able
      // to see what was actually in it.
      recordLayerFiles(cityId, jobId, meta?.pendingLayerFiles);
    },
  };
}
