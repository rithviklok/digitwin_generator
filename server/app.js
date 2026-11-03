// ===================================================================
// app.js -- entry point. Wires config/db/storage, the job runner, and
// every route (uploads + revise, the admin page's API, the public
// city-config access gate).
// ===================================================================
import express from 'express';
import { existsSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';

import { config } from './config.js';
import { openDb } from './db.js';
import { JobRunner } from './jobs/jobRunner.js';
import { makeJobHooks } from './lib/jobHooks.js';
import { uploadsRouter } from './routes/uploads.js';
import { adminRouter } from './routes/admin.js';
import { citiesRouter } from './routes/cities.js';
import { runSweep } from './jobs/retentionSweep.js';
import { siteWeather } from './lib/siteWeather.js';

mkdirSync(join(config.storageRoot, 'uploads'), { recursive: true });
mkdirSync(join(config.storageRoot, 'cities'), { recursive: true });
const db = openDb(join(config.storageRoot, 'app.db'));

const jobRunner = new JobRunner(db, { storageRoot: config.storageRoot, ...makeJobHooks(db) });
jobRunner.reconcileAfterRestart();

// Retention sweep. An in-process interval, not a cron job the self-hoster
// has to set up themselves: one process, no extra infrastructure. Runs
// once immediately (covers the gap between restarts) and then
// every 12 hours; a single unhandled throw here must never take the whole
// server down, so it's caught and logged like any other background task.
const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;
function sweepSafely() {
  try { runSweep(db, config.storageRoot); } catch (err) { console.error('[retentionSweep] failed:', err); }
}
sweepSafely();
setInterval(sweepSafely, SWEEP_INTERVAL_MS);

const app = express();
if (config.trustProxy) app.set('trust proxy', config.trustProxy); // see config.js: otherwise req.ip is the reverse proxy's address for everyone
app.use(express.json());

// Who may put the viewer in an iframe (?embed=1 -- AirawatOS, client sites).
// No header = any site; EMBED_ALLOWED_ORIGINS narrows it. Deliberately not
// X-Frame-Options: that only knows DENY/SAMEORIGIN, never a list.
if (config.embedAllowedOrigins) {
  const frameAncestors = `frame-ancestors 'self' ${config.embedAllowedOrigins.join(' ')}`;
  app.use((req, res, next) => { res.setHeader('Content-Security-Policy', frameAncestors); next(); });
}

// The front end is normally served by this same process (see the static
// mount at the bottom), so its own calls are same-origin. CORS still
// matters for a front end on another origin (`npm run dev` without the
// Vite proxy, or a platform calling the API directly). The real access boundary is
// per-route tokens (ADMIN_TOKEN, or a city's own access token) checked by
// the route handlers themselves, not the browser's origin -- so wide-open
// '*' (the default) doesn't weaken anything a caller couldn't already do
// directly (e.g. via curl). Handwritten instead of the `cors` package:
// this is still just a few headers, not worth a new dependency.
//
// ALLOWED_ORIGINS, if set, switches to a strict allowlist -- echoing
// back only a matching request Origin, never '*', which is the correct
// pattern for an allowlist (a literal '*' can't be scoped per-origin).
// Unset (the default) keeps the wide-open '*'.
app.use((req, res, next) => {
  if (config.allowedOrigins) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static bytes (tiles, manifest.json, light-role geojson) -- gated only by
// the unguessable cityId/jobId in the path, never the access token:
// BuildingLayer.js resolves per-tile URLs relative to wherever it fetched
// manifest.json from, which drops any query string a token would need to
// ride along on.
app.use('/files', express.static(join(config.storageRoot, 'cities')));

app.use('/api', uploadsRouter(db, jobRunner));
app.use('/api/admin', adminRouter(db, jobRunner));
app.use('/api/cities', citiesRouter(db));

app.get('/api/health', (req, res) => {
  res.json({ ok: true }); // no server paths: this is reachable by anyone once hosted
});

// What the upload form checks before it sends anything (src/ui/FileDrop.js):
// the server refuses a file over the limit too, but only once it has arrived.
app.get('/api/limits', (req, res) => {
  res.json({ maxUploadBytes: config.maxUploadBytes, maxLayerFileBytes: Math.min(config.maxLayerFileBytes, config.maxUploadBytes) });
});

// What the built-in city needs from this server: it is part of the front
// end, not a built city with a config of its own to add the weather key to
// (lib/siteWeather.js).
app.get('/api/site', (req, res) => {
  res.json({ weather: siteWeather() });
});

// The built front end (dist/), last so /api and /files always win. One
// origin for page + API + tiles is what makes a share link or an embed work
// from any device. index.html is revalidated every time (it names the
// current hashed bundles); everything else under assets/ is immutable.
const serveFrontend = config.frontendDir && existsSync(join(config.frontendDir, 'index.html'));
if (serveFrontend) {
  app.use(express.static(config.frontendDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (filePath.includes(`${sep}assets${sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
}

const server = app.listen(config.port, config.host, () => {
  console.log(`[digitwin-server] listening on http://${config.host ?? 'localhost'}:${config.port}${config.host ? '' : ' (all interfaces)'}`);
  console.log(`[digitwin-server] storage: ${config.storageRoot}`);
  console.log(serveFrontend
    ? `[digitwin-server] serving the front end from ${config.frontendDir}`
    : `[digitwin-server] not serving a front end (${config.frontendDir ? `no index.html in ${config.frontendDir} -- run \`npm run build\` at the project root` : 'FRONTEND_DIR is empty'})`);
});
// Node gives every request 5 minutes to arrive in full, then drops the
// connection -- a buildings file of a GB or two needs far longer on an
// ordinary network (config.js, uploadTimeoutMs).
server.requestTimeout = config.uploadTimeoutMs;

export { app, db };
