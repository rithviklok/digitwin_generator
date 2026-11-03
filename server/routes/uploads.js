// ===================================================================
// routes/uploads.js -- POST /api/uploads (start a new city),
// GET /api/uploads/:cityId/status (poll it -- the uploader's Review &
// build page), GET /api/uploads/:cityId (what was submitted), and
// POST /api/uploads/:cityId/revise. One named multer field per upload
// slot (one file per slot, no merging), not a generic multi-file array.
//
// Required: buildings with heights -- a file the uploader attaches, or,
// with buildingsSource=google, none: the build downloads the drawn area's
// buildings from Google Open Buildings itself (jobHooks.js). Optional: the
// municipal layers OSM doesn't reliably have (wards, zones, landmarks,
// city outline).
// Everything OSM does have -- roads, railway, amenities, localities, land
// use, vegetation, water -- is downloaded for the drawn bounding box
// during the build itself (jobHooks.js), so it arrives fresh on every
// revision and never needs finding by hand. Two opt-in escapes from that:
//   - a per-layer file (e.g. a municipal road survey) replaces OSM for
//     that one layer;
//   - one OSM export the uploader made themselves (the fallback when this
//     server can't reach OSM) replaces the download entirely.
//
// No email is asked for: the uploader follows their build on the
// Review & build page, reachable later from "My cities" or its link.
// ===================================================================
import express from 'express';
import multer from 'multer';
import { mkdirSync, existsSync, statSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../config.js';
import { LAYER_ROLES, TILE_SIZE_RANGE_M } from '../../src/config/city-schema.js';
import { newCityId, newAccessToken, assertValidCityId, accessTokenMatches } from '../lib/ids.js';
import { assertValidHeightProperty, assertPositiveNumber, assertNumberInRange } from '../lib/sanitize.js';
import { validateGeojsonFile, sampleProperties } from '../lib/geojsonValidate.js';
import { assertWithinQuota } from '../lib/quota.js';
import { assertEnoughDiskSpace } from '../lib/diskSpace.js';
import { estimateBakeTimeLeft } from '../lib/eta.js';
import { deleteCity } from '../lib/deleteCity.js';
import { MAX_AREA_SQ_DEG } from '../../scripts/open-buildings-lib.mjs';

/** Where a city's buildings downloaded from Google Open Buildings are kept (in its uploads dir, beside any file of its own), and the height property they come with. */
const GOOGLE_BUILDINGS_FILE = 'google-buildings.geojson';
const GOOGLE_HEIGHT_PROPERTY = 'mean';

// role -> {field, filename} -- filename matches assembleConfig.js's ROLE_FILENAME table exactly, so a job's output directory always has the same shape whichever way a file got there.
const LIGHT_ROLE_FIELDS = [
  // Municipal data OpenStreetMap doesn't reliably have.
  { field: 'cityBoundary', role: LAYER_ROLES.CITY_BOUNDARY, filename: 'city-boundary.geojson' },
  { field: 'adminWards', role: LAYER_ROLES.ADMIN_WARDS, filename: 'admin-wards.geojson' },
  { field: 'adminZones', role: LAYER_ROLES.ADMIN_ZONES, filename: 'admin-zones.geojson' },
  { field: 'landmarks', role: LAYER_ROLES.LANDMARKS, filename: 'landmarks.geojson' },
  // Optional replacements for single OpenStreetMap layers (e.g. a municipal
  // road survey). Each wins over OSM for its layer; the build normalizes it
  // (jobs/osmFetchChild.js) before it's published.
  { field: 'roads', role: LAYER_ROLES.ROADS, filename: 'roads.geojson' },
  { field: 'railway', role: LAYER_ROLES.RAILWAY, filename: 'railway.geojson' },
  { field: 'amenities', role: LAYER_ROLES.AMENITIES, filename: 'amenities.geojson' },
  { field: 'localities', role: LAYER_ROLES.LOCALITIES, filename: 'localities.geojson' },
  { field: 'landuse', role: LAYER_ROLES.LANDUSE, filename: 'landuse.geojson' },
  { field: 'vegetation', role: LAYER_ROLES.VEGETATION, filename: 'vegetation.geojson' },
  { field: 'water', role: LAYER_ROLES.WATER, filename: 'water.geojson' },
];
/** The uploader's own all-layers OpenStreetMap export -- the fallback when this server can't reach OSM. When present, nothing is downloaded. */
const OSM_EXPORT_FIELD = 'osmExport';
/** Every file field a revision may ask to drop ("use OpenStreetMap again" / "remove this file"). */
const CLEARABLE_FIELDS = new Set([...LIGHT_ROLE_FIELDS.map((r) => r.field), OSM_EXPORT_FIELD]);

/** The layer_files columns safe to show an uploader -- never sourcePath (a server filesystem path). */
const publicLayerFile = (lf) => ({
  role: lf.role, source: lf.source, status: lf.status,
  original_filename: lf.original_filename ?? lf.originalFilename, error_message: lf.error_message ?? lf.errorMessage ?? null,
});

export function uploadsRouter(db, jobRunner) {
  const router = express.Router();

  // Each field's stored filename is stable (`<field>.geojson`) *within one
  // cityId's uploads dir* -- a revision (same cityId, reachable via POST
  // /:cityId/revise below) reuses this same directory, so re-uploading
  // only the fields that actually changed leaves the others' files
  // sitting there untouched from the previous submission. handleUpload
  // reads those in as this revision's input for any slot the request
  // didn't re-attach.
  //
  // Files stream in under a TEMPORARY name and only take the stable one
  // once the whole request has arrived (commitUploadedFiles): an upload
  // cut off halfway -- tab closed, network dropped -- must never replace
  // a revision's previously kept, complete file with a truncated one.
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        // req.cityId is set by the handler below, before multer's fields
        // are processed by Express -- see the manual cityId pre-step.
        const dir = join(config.storageRoot, 'uploads', req.cityId);
        mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `${file.fieldname}${TEMP_SUFFIX}`),
    }),
    limits: { fileSize: config.maxUploadBytes },
  });

  const multerFields = upload.fields([
    { name: 'buildings', maxCount: 1 },
    { name: OSM_EXPORT_FIELD, maxCount: 1 },
    ...LIGHT_ROLE_FIELDS.map((r) => ({ name: r.field, maxCount: 1 })),
  ]);
  // An interrupted or refused transfer leaves nothing behind: its partial
  // temp files go, and for a brand-new city (no row yet) the whole folder.
  const uploadFields = (req, res, next) => multerFields(req, res, (err) => {
    if (!err) return next();
    discardFailedUpload(req);
    // multer's own "File too large" says neither which file nor what the limit is.
    if (err.code === 'LIMIT_FILE_SIZE') {
      const which = err.field === 'buildings' ? 'The buildings file' : 'One of your files';
      return res.status(413).json({ error: `${which} is larger than the ${sizeText(config.maxUploadBytes)} this server accepts. Upload a smaller area, or ask whoever runs the server to raise its limit.` });
    }
    res.status(400).json({ error: `Upload failed: ${err.message}` });
  });

  router.post('/uploads', async (req, res, next) => {
    // cityId has to exist before multer's destination() callback runs (it
    // needs a directory to stream the first file into), so it's generated
    // here, ahead of the body being fully parsed -- displayName arrives as
    // a query param on this first request for that reason; the rest of
    // the form is read from req.body after multer finishes.
    //
    // Quota and disk checks both happen HERE, before uploadFields (multer)
    // below ever starts streaming the file body to disk -- rejecting fast,
    // before spending bandwidth/time/disk on an upload that's going to be
    // refused anyway.
    try {
      const displayName = String(req.query.displayName ?? '').slice(0, 200) || 'Untitled city';
      // Quota key, not an identity -- see lib/quota.js. req.ip is the socket
      // address unless the self-hoster enables Express's `trust proxy`.
      const uploaderKey = `ip:${req.ip}`;

      assertWithinQuota(db, uploaderKey);
      // Content-Length covers the whole multipart body (every file field,
      // not just buildings), which is a conservative OVER-estimate of the
      // raw input the bake actually processes -- fine for a fast pre-check;
      // the bake-time check in jobRunner.js re-checks against the EXACT
      // buildings file size once it's known.
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > 0) await assertEnoughDiskSpace(config.storageRoot, contentLength);

      req.cityId = newCityId(displayName);
      req.displayName = displayName;
      req.uploaderKey = uploaderKey;
      next();
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
  }, uploadFields, (req, res) => {
    try {
      handleUpload(db, jobRunner, req, res);
    } catch (err) {
      console.error('[uploads] failed:', err);
      discardFailedUpload(req);
      res.status(err.status ?? 400).json({ error: err.message });
    }
  });

  router.get('/uploads/:cityId/status', (req, res) => {
    const city = db.prepare(`SELECT id, display_name, status, access_token, current_job_id FROM cities WHERE id = ?`).get(req.params.cityId);
    if (!city || !accessTokenMatches(city.access_token, req.query.t)) return res.status(404).json({ error: 'not found' });

    // The latest build of this city, for the Review & build page's
    // progress steps: which stage it's on, how many builds are ahead of it
    // (one runs at a time), and -- once finished -- which layers made it.
    const job = db.prepare(`SELECT id, status, stage, progress, progress_text, started_at, finished_at, stage_started_at, progress_at, params_json FROM jobs WHERE city_id = ? ORDER BY id DESC LIMIT 1`).get(city.id);
    const buildsAhead = job?.status === 'queued'
      ? db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE id < ? AND status IN ('queued', 'running')`).get(job.id).n
      : 0;
    const layers = job ? db.prepare(`SELECT role, source, status, original_filename, error_message FROM layer_files WHERE job_id = ?`).all(job.id).map(publicLayerFile) : [];

    res.json({
      job: job ? {
        status: job.status, stage: job.stage, buildsAhead, startedAt: job.started_at, finishedAt: job.finished_at,
        progress: job.status === 'running' ? job.progress : null, progressText: job.status === 'running' ? job.progress_text : null,
        failureReason: job.status === 'failed' ? job.progress_text : null, // jobRunner stores the plain-words reason there on failure
        // Time left while the 3D build runs, as seconds from now -- the page adds them to its own clock, so a device with a wrong clock still shows the right "done around".
        eta: estimateBakeTimeLeft(job, { limitMs: config.bakeTimeoutMs }),
        bakeLimitMinutes: Math.round(config.bakeTimeoutMs / 60000),
      } : null,
      layers,
      // 'google' adds the "Downloading buildings" step to the page's progress list.
      buildingsSource: buildingsSourceOf(job),
      cityId: city.id, displayName: city.display_name, status: city.status,
      // True while ANY build of this city is being served, independent of
      // `status` -- a later revision can be status='processing' or 'failed'
      // while an earlier build still serves unbroken. The Review & build
      // page uses this to offer "View your current live city" even while
      // status itself reads badly.
      hasLiveVersion: city.current_job_id != null,
      // Only meaningful for a failed city with no live version, the one
      // case retentionSweep.js actually purges. Sent unconditionally
      // anyway: cheap, and keeps this endpoint's shape uniform rather than
      // presence-testing a field that's sometimes there.
      retentionDays: config.retentionDays,
    });
  });

  // What was submitted, for two readers: the revise form's pre-fill (a
  // revision only shows fields that need to change, not a blank form)
  // and the Review & build page's read-only summary. Read from the
  // latest job's params_json -- exactly what the uploader last sent, even
  // while it's still queued or after it failed. Jobs from before
  // params_json existed fall back to the latest job with an assembled
  // config.
  router.get('/uploads/:cityId', (req, res) => {
    const city = db.prepare(`
      SELECT id, display_name, status, access_token, origin_lon, origin_lat, bbox_json
      FROM cities WHERE id = ?
    `).get(req.params.cityId);
    if (!city || !accessTokenMatches(city.access_token, req.query.t)) return res.status(404).json({ error: 'not found' });

    const latest = db.prepare(`SELECT id, params_json FROM jobs WHERE city_id = ? ORDER BY id DESC LIMIT 1`).get(city.id);
    const submitted = latest?.params_json ? JSON.parse(latest.params_json).meta : null;
    const job = submitted
      ? latest
      : db.prepare(`SELECT id, config_json FROM jobs WHERE city_id = ? AND config_json IS NOT NULL ORDER BY id DESC LIMIT 1`).get(city.id);
    const jobConfig = job?.config_json ? JSON.parse(job.config_json) : null;
    const buildingsLayer = jobConfig?.layers?.find((l) => l.role === LAYER_ROLES.BUILDINGS_3D);

    // Recorded rows once the job has finished; until then, the files as submitted.
    const recorded = job ? db.prepare(`SELECT role, original_filename, status, error_message, source FROM layer_files WHERE job_id = ?`).all(job.id) : [];
    const layerFiles = (recorded.length ? recorded : submitted?.pendingLayerFiles ?? []).map(publicLayerFile);

    res.json({
      cityId: city.id, displayName: city.display_name, status: city.status,
      origin: { lon: city.origin_lon, lat: city.origin_lat }, bbox: JSON.parse(city.bbox_json),
      heightProperty: submitted?.heightProperty ?? buildingsLayer?.heightProperty ?? null,
      buildingsSource: submitted?.buildingsSource ?? 'file',
      buildingsFileName: submitted?.buildingsFileName ?? null,
      osmExportFileName: submitted?.osm?.exportName ?? null,
      buildings: submitted?.buildings ?? jobConfig?.buildings ?? null,
      layerFiles,
    });
  });

  // A revision: SAME cityId and access_token (never a new city record --
  // that's the whole point), a fresh bake, and the version that's live
  // (if any) keeps serving unbroken throughout, since current_job_id only
  // moves forward once THIS new job has built successfully.
  router.post('/uploads/:cityId/revise', async (req, res, next) => {
    // No quota check here -- a revision doesn't grow this uploader's city
    // count, it reuses an existing one (see assertWithinQuota's own note on
    // why it's only ever called from the fresh-upload path). Disk space
    // still gets checked, though: a revision can attach a brand-new,
    // larger buildings file just like a fresh upload can.
    try {
      const city = db.prepare(`SELECT id, display_name, access_token FROM cities WHERE id = ?`).get(req.params.cityId);
      if (!city || !accessTokenMatches(city.access_token, req.query.t)) return res.status(404).json({ error: 'not found' });

      const existingJob = db.prepare(`SELECT id FROM jobs WHERE city_id = ? AND status IN ('queued', 'running')`).get(city.id);
      if (existingJob) {
        const err = new Error('A build is already in progress for this city. Wait for it to finish before submitting another revision.');
        err.status = 409;
        throw err;
      }

      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > 0) await assertEnoughDiskSpace(config.storageRoot, contentLength);

      req.cityId = city.id;
      req.isRevision = true;
      req.displayName = req.query.displayName ? String(req.query.displayName).slice(0, 200) : city.display_name;
      req.accessToken = city.access_token;
      next();
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
  }, uploadFields, (req, res) => {
    try {
      handleUpload(db, jobRunner, req, res, { isRevision: true });
    } catch (err) {
      console.error('[uploads] revise failed:', err);
      discardFailedUpload(req);
      res.status(err.status ?? 400).json({ error: err.message });
    }
  });

  // Deletes a city completely, by its uploader (the city's own access
  // token is the permission) -- see lib/deleteCity.js for what goes. The
  // page asks for confirmation first. POST, not DELETE: this backend's
  // CORS only allows GET/POST.
  router.post('/uploads/:cityId/delete', async (req, res) => {
    try {
      const city = db.prepare(`SELECT id, access_token FROM cities WHERE id = ?`).get(req.params.cityId);
      if (!city || !accessTokenMatches(city.access_token, req.query.t)) return res.status(404).json({ error: 'not found' });
      const { freedBytes } = await deleteCity(db, jobRunner, city.id);
      console.log(`[uploads] city ${city.id} deleted by its uploader (${(freedBytes / 1e6).toFixed(1)} MB freed)`);
      res.json({ deleted: true, freedBytes });
    } catch (err) {
      console.error('[uploads] delete failed:', err);
      res.status(500).json({ error: `Could not delete: ${err.message}` });
    }
  });

  return router;
}

const TEMP_SUFFIX = '.upload-tmp';

/** 'google' when a job's buildings come from Google Open Buildings, else 'file' (and for jobs from before the choice existed). */
function buildingsSourceOf(job) {
  try { return JSON.parse(job?.params_json ?? 'null')?.meta?.buildingsSource ?? 'file'; } catch { return 'file'; }
}

/** 524288000 -> "524 MB", 4294967296 -> "4.3 GB" -- the same decimal units the upload form shows a file's size in. */
const sizeText = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

/** Gives every file that arrived in this request its permanent name (`<field>.geojson`), replacing any kept copy -- only called once the submission has passed every check that could refuse it. */
function commitUploadedFiles(req, uploadsDir) {
  for (const [field, [file]] of Object.entries(req.files ?? {})) {
    const stablePath = join(uploadsDir, `${field}.geojson`);
    renameSync(file.path, stablePath);
    file.path = stablePath;
  }
}

/**
 * Leaves nothing behind for a submission that didn't go through: this
 * request's temp files always; and for a brand-new city (which has no DB
 * row yet, so nothing else would ever find or clean its folder) the whole
 * uploads folder. A revision's folder holds the city's kept files -- only
 * its temp files go.
 */
function discardFailedUpload(req) {
  if (!req.cityId) return;
  const dir = join(config.storageRoot, 'uploads', req.cityId);
  if (req.isRevision) {
    for (const [file] of Object.values(req.files ?? {})) if (file.path.endsWith(TEMP_SUFFIX)) rmSync(file.path, { force: true });
  } else {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * A field's file for this submission: the one just uploaded, or -- on a
 * revision only -- whatever already sits at that field's stable path in
 * this cityId's uploads dir from an earlier submission, so re-attaching
 * every slot on every revision isn't required. `req.files[field]` always
 * wins when present.
 */
function resolveSubmittedFile(req, field, uploadsDir, { isRevision, previousNames = {} }) {
  const uploaded = req.files?.[field]?.[0];
  if (uploaded) return uploaded;
  if (!isRevision) return null;
  const stablePath = join(uploadsDir, `${field}.geojson`);
  if (!existsSync(stablePath)) return null;
  const { size } = statSync(stablePath);
  return { path: stablePath, originalname: previousNames[field] ?? `${field}.geojson`, size };
}

/** field -> the uploader's own filename, from the city's previous submission -- a kept file is stored as "<field>.geojson", so its real name would otherwise be lost on every revision. */
function previousFileNames(db, cityId) {
  const job = db.prepare(`SELECT params_json FROM jobs WHERE city_id = ? AND params_json IS NOT NULL ORDER BY id DESC LIMIT 1`).get(cityId);
  const meta = job ? JSON.parse(job.params_json).meta ?? {} : {};
  const fieldByRole = Object.fromEntries(LIGHT_ROLE_FIELDS.map((r) => [r.role, r.field]));
  const names = {};
  for (const lf of meta.pendingLayerFiles ?? []) if (lf.source === 'manual' && fieldByRole[lf.role]) names[fieldByRole[lf.role]] = lf.originalFilename;
  if (meta.osm?.exportName) names[OSM_EXPORT_FIELD] = meta.osm.exportName;
  if (meta.buildingsFileName) names.buildings = meta.buildingsFileName;
  return names;
}

function handleUpload(db, jobRunner, req, res, { isRevision = false } = {}) {
  const cityId = req.cityId; // already validated shape by newCityId(), but re-assert since it now flows into filesystem paths
  assertValidCityId(cityId);
  const uploadsDir = join(config.storageRoot, 'uploads', cityId);

  const previousNames = isRevision ? previousFileNames(db, cityId) : {};
  // 'google': no file -- the build downloads the area's buildings itself, with
  // their height in `mean` (jobHooks.js). A file sent along anyway isn't used.
  const buildingsSource = req.body.buildingsSource === 'google' ? 'google' : 'file';
  if (buildingsSource === 'google' && req.files?.buildings) {
    for (const file of req.files.buildings) rmSync(file.path, { force: true });
    delete req.files.buildings;
  }
  let buildingsFile = buildingsSource === 'file' ? resolveSubmittedFile(req, 'buildings', uploadsDir, { isRevision, previousNames }) : null;
  if (buildingsSource === 'file' && !buildingsFile) throw new Error(isRevision ? 'a buildings-3d file is required (this city has none on record to reuse)' : 'a buildings-3d file is required');
  const heightProperty = buildingsSource === 'google' ? GOOGLE_HEIGHT_PROPERTY : assertValidHeightProperty(req.body.heightProperty);

  const originLon = Number(req.body.originLon), originLat = Number(req.body.originLat);
  const bbox = {
    west: Number(req.body.bboxWest), south: Number(req.body.bboxSouth),
    east: Number(req.body.bboxEast), north: Number(req.body.bboxNorth),
  };
  if (![originLon, originLat, bbox.west, bbox.south, bbox.east, bbox.north].every(Number.isFinite)) {
    throw new Error('The city’s area is missing or incomplete. Draw it on the map in step 1 before building.');
  }
  // Refused now rather than after the build has queued: the download script would refuse it anyway.
  if (buildingsSource === 'google' && (bbox.east - bbox.west) * (bbox.north - bbox.south) > MAX_AREA_SQ_DEG) {
    throw new Error('The area you drew is larger than any city (more than about 1.5 × 1.5 degrees), too large to download buildings for. Draw the city, not the district or the state.');
  }

  // The generation settings came from the form the uploader actually saw,
  // and are not silently re-applied here -- the request must include them
  // (the front end pre-fills the same defaults build-building-tiles.mjs
  // uses, but as visible, editable values, not a fallback this code chooses).
  // Bounded, unlike the other two: the tile size decides how many files a
  // bake writes. 1 m means a tile per building -- millions of files and a
  // server's disk and inodes gone -- and 1,000 km one tile too large for a
  // browser to download. Any value a person would choose deliberately is inside.
  const tileSizeM = assertNumberInRange(req.body.tileSizeM, 'Tile size (m)', TILE_SIZE_RANGE_M);
  const minRenderHeightM = assertPositiveNumber(req.body.minRenderHeightM, 'minRenderHeightM');
  const windowMinHeightM = assertPositiveNumber(req.body.windowMinHeightM, 'windowMinHeightM');

  const layerFileRows = []; // rows to insert once we have a jobId -- see the "job_id NOT NULL" schema note below

  // Everything that can refuse this submission is checked BEFORE any file
  // takes its permanent name -- a refused revision must leave the city's
  // previously kept files exactly as they were. (For a file over 25 MB this
  // is only a quick look at its start; see geojsonValidate.js.)
  if (buildingsFile) {
    const buildingsCheck = validateGeojsonFile(buildingsFile.path);
    if (!buildingsCheck.ok) throw new Error(`buildings file: ${buildingsCheck.error}`);
    // A height property the file doesn't have used to be discovered only by
    // the bake -- after the whole upload, and (before the bake's own guard)
    // by hanging until its timeout. Caught here instead, while the uploader
    // is still on the form, naming the properties the file does have.
    const sample = sampleProperties(buildingsFile.path);
    if (sample.length && !sample.some((p) => p[heightProperty] != null)) {
      const keys = [...new Set(sample.flatMap(Object.keys))].slice(0, 12);
      throw new Error(`buildings file: its buildings have no "${heightProperty}" property. Properties found: ${keys.join(', ') || 'none'}. Choose the one that holds the height in metres.`);
    }
  }
  // Only the buildings file is read a piece at a time by the build. Every
  // other file is still read whole, which can't work past 512 MB (Node's
  // longest string) -- refused here, by name, rather than accepted and then
  // quietly left out of the city.
  for (const [field, [file]] of Object.entries(req.files ?? {})) {
    if (field !== 'buildings' && file.size > config.maxLayerFileBytes) {
      throw new Error(`“${file.originalname}” is ${sizeText(file.size)}. Only the buildings file can be that large; every other file can be at most ${sizeText(config.maxLayerFileBytes)}.`);
    }
  }
  // The uploader's own OSM export, if any -- checked now, not at build time,
  // so a wrong file is reported while they're still on the form.
  const exportCandidate = resolveSubmittedFile(req, OSM_EXPORT_FIELD, uploadsDir, { isRevision, previousNames });
  if (exportCandidate && !(req.body.clearFiles ?? '').split(',').includes(OSM_EXPORT_FIELD)) {
    const check = validateGeojsonFile(exportCandidate.path);
    if (!check.ok) throw new Error(`OpenStreetMap export: ${check.error}`);
  }

  commitUploadedFiles(req, uploadsDir);
  // A revision can drop files kept from an earlier submission (e.g. go back
  // to OpenStreetMap for roads). Never a file re-attached in this same request.
  if (isRevision) {
    for (const field of String(req.body.clearFiles ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (CLEARABLE_FIELDS.has(field) && !req.files?.[field]) rmSync(join(uploadsDir, `${field}.geojson`), { force: true });
    }
  }
  if (buildingsSource === 'file') buildingsFile = resolveSubmittedFile(req, 'buildings', uploadsDir, { isRevision, previousNames }); // now at its permanent path
  else mkdirSync(uploadsDir, { recursive: true }); // with no file attached, nothing has made it yet -- the download goes here
  // What the bake reads: the uploaded file, or where the build downloads the buildings to.
  const inputPath = buildingsFile?.path ?? join(uploadsDir, GOOGLE_BUILDINGS_FILE);
  const inputBytes = buildingsFile?.size ?? 0; // a download's size is recorded once it has happened (jobHooks.js)
  const osmExportFile = resolveSubmittedFile(req, OSM_EXPORT_FIELD, uploadsDir, { isRevision, previousNames });

  // Manually uploaded light-role files: validate + note for later copy into the job's output dir.
  // On a revision, a slot the request didn't re-attach falls back to whatever's
  // already on disk from an earlier submission (resolveSubmittedFile) -- still
  // re-validated here, not just trusted, since it was never re-checked since
  // that earlier submission.
  for (const { field, role, filename } of LIGHT_ROLE_FIELDS) {
    const file = resolveSubmittedFile(req, field, uploadsDir, { isRevision, previousNames });
    if (!file) continue;
    const result = validateGeojsonFile(file.path);
    layerFileRows.push({
      role, filename, source: 'manual', originalFilename: file.originalname, byteSize: file.size,
      status: result.ok ? 'validated' : 'invalid', errorMessage: result.ok ? null : result.error,
      sourcePath: file.path,
    });
  }

  const now = new Date().toISOString();
  let accessToken;
  if (isRevision) {
    // SAME row, SAME token: a new token on every edit would break every
    // link already shared (it's the whole privacy/access mechanism).
    // current_job_id is deliberately left alone: whatever is live now
    // keeps serving until THIS revision has built successfully.
    accessToken = req.accessToken; // set by the /revise route's pre-step from the city row it already looked up
    db.prepare(`UPDATE cities SET status = 'processing', failure_reason = NULL, display_name = ?, origin_lon = ?, origin_lat = ?, bbox_json = ?, input_bytes_total = ? WHERE id = ?`)
      .run(req.displayName, originLon, originLat, JSON.stringify(bbox), inputBytes, cityId);
  } else {
    accessToken = newAccessToken();
    db.prepare(`
      INSERT INTO cities (id, display_name, uploader_key, access_token, status, created_at, origin_lon, origin_lat, bbox_json, input_bytes_total)
      VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)
    `).run(cityId, req.displayName, req.uploaderKey, accessToken, now, originLon, originLat, JSON.stringify(bbox), inputBytes);
  }

  jobRunner.enqueue({
    cityId,
    bakeParams: {
      inputPath,
      heightProperty,
      cityId,
      tileSizeM, minRenderHeightM, windowMinHeightM,
      origin: { lon: originLon, lat: originLat },
      timeoutMs: config.bakeTimeoutMs,
    },
    // meta is opaque to jobRunner -- stored on the job row (so a restart
    // can re-run it) and passed straight through to the hooks (wired in
    // app.js): onJobStarting downloads the OSM layers for meta.osm.bbox,
    // onJobSucceeded copies pendingLayerFiles into the job-scoped output
    // dir and assembles the CityConfig once the jobId exists.
    meta: {
      pendingLayerFiles: layerFileRows,
      displayName: req.displayName,
      origin: { lon: originLon, lat: originLat },
      bbox,
      osm: osmExportFile ? { bbox, exportPath: osmExportFile.path, exportName: osmExportFile.originalname } : { bbox },
      buildings: { tileSizeM, minRenderHeightM, windowMinHeightM },
      heightProperty,
      buildingsSource,
      // 'google': onJobStarting downloads the buildings here before the bake reads them.
      buildingsPath: buildingsSource === 'google' ? inputPath : null,
      buildingsFileName: buildingsFile?.originalname ?? null,
    },
  });

  res.status(202).json({ cityId, accessToken, statusUrl: `/api/uploads/${cityId}/status?t=${accessToken}` });
}
