// ===================================================================
// routes/admin.js -- what the admin page runs on (?admin=<token>,
// src/ui/AdminCitiesView.js): list every uploaded city, open one in
// the viewer without its private link, read its build logs, delete it.
// Every route here is gated by requireAdminToken (lib/adminAuth.js) --
// there's no separate login system, just the one shared ADMIN_TOKEN.
//
// There is no approve/reject: a city goes live the moment its build
// succeeds (jobHooks.js). Deleting is the admin's one way to take an
// unwanted city down.
// ===================================================================
import express from 'express';
import { requireAdminToken } from '../lib/adminAuth.js';
import { deleteCity } from '../lib/deleteCity.js';
import { withSiteWeather } from '../lib/siteWeather.js';

const STATUSES = ['processing', 'live', 'failed', 'purged'];

// Mounted at /api/admin in app.js -- every route here is relative to that
// (e.g. `/cities` below is actually GET /api/admin/cities). Deliberately its
// OWN mount point, not shared with uploadsRouter's /api prefix: router.use()
// with no path matches every request that reaches this router, so if this
// were mounted at plain /api, requireAdminToken would intercept /api/health
// and every future non-admin /api/* route too, not just /api/admin/*.
export function adminRouter(db, jobRunner) {
  const router = express.Router();
  router.use(requireAdminToken);

  const cityStmt = db.prepare(`
    SELECT id, display_name, uploader_key, status, created_at, failure_reason, current_job_id
    FROM cities WHERE id = ?
  `);

  // Paginated: cheap insurance against a deployment that's accumulated
  // hundreds of cities returning them all in one response.
  router.get('/cities', (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM cities ${where}`).get(...params).n;
    // The latest job says why a failed build failed (jobRunner stores the
    // plain-words reason in progress_text); failure_reason covers the one
    // failure that isn't the job's own -- see jobHooks.js.
    const cities = db.prepare(`
      SELECT id, display_name, uploader_key, status, created_at, failure_reason, current_job_id, input_bytes_total,
        (SELECT j.progress_text FROM jobs j WHERE j.city_id = cities.id AND j.status = 'failed' ORDER BY j.id DESC LIMIT 1) AS last_failure,
        (SELECT MAX(j.finished_at) FROM jobs j WHERE j.city_id = cities.id) AS last_build_at
      FROM cities ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({
      cities: cities.map((c) => ({
        id: c.id, displayName: c.display_name, status: c.status, uploader: c.uploader_key,
        createdAt: c.created_at, lastBuildAt: c.last_build_at, inputBytes: c.input_bytes_total,
        // True while ANY build of it is being served, whatever `status` says
        // about its latest submission (routes/cities.js gates on the same thing).
        isLive: c.current_job_id != null,
        failureReason: c.status === 'failed' ? (c.failure_reason ?? c.last_failure ?? null) : null,
      })),
      total, limit, offset,
    });
  });

  // "Let the admin see why a build failed without SSHing into the server."
  // Every job for a city regardless of outcome, each with its captured
  // log_text -- including a city that has FAILED on every attempt, which
  // has no built version to open in the viewer at all.
  router.get('/cities/:cityId/jobs', (req, res) => {
    const city = db.prepare(`SELECT id FROM cities WHERE id = ?`).get(req.params.cityId);
    if (!city) return res.status(404).json({ error: 'city not found' });
    const jobs = db.prepare(`
      SELECT id, status, created_at, started_at, finished_at, exit_code, log_text, files_purged_at
      FROM jobs WHERE city_id = ? ORDER BY id DESC
    `).all(city.id);
    res.json({ cityId: city.id, jobs });
  });

  // The admin's way into a city without its private link: the same config
  // the public endpoint (routes/cities.js) serves for it, so what the admin
  // sees in the viewer is exactly what's live.
  router.get('/cities/:cityId/config', (req, res) => {
    const city = cityStmt.get(req.params.cityId);
    if (!city) return res.status(404).json({ error: 'city not found' });
    const job = city.current_job_id ? db.prepare(`SELECT id, config_json FROM jobs WHERE id = ?`).get(city.current_job_id) : null;
    if (!job?.config_json) return res.status(409).json({ error: `"${city.id}" has no finished build to open (status: ${city.status}). See its build log.` });
    res.json({
      city: { id: city.id, displayName: city.display_name, status: city.status, uploader: city.uploader_key, createdAt: city.created_at },
      jobId: job.id,
      config: withSiteWeather(JSON.parse(job.config_json)),
    });
  });

  // POST, not DELETE: this backend's CORS only allows GET/POST (app.js).
  router.post('/cities/:cityId/delete', async (req, res) => {
    try {
      const city = cityStmt.get(req.params.cityId);
      if (!city) return res.status(404).json({ error: 'city not found' });
      const { freedBytes } = await deleteCity(db, jobRunner, city.id);
      console.log(`[admin] city ${city.id} deleted by the admin (${(freedBytes / 1e6).toFixed(1)} MB freed)`);
      res.json({ deleted: true, freedBytes });
    } catch (err) {
      console.error('[admin] delete failed:', err);
      res.status(500).json({ error: `Could not delete: ${err.message}` });
    }
  });

  return router;
}
