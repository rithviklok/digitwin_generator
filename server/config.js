// ===================================================================
// config.js -- reads server/.env (via `node --env-file=.env`, see
// package.json's scripts -- no dotenv dependency needed on Node 20.6+)
// into one plain settings object every other module imports from here,
// instead of reading process.env directly in a dozen places.
// ===================================================================
import { resolve } from 'node:path';

const serverRoot = resolve(import.meta.dirname);

/**
 * A numeric setting from .env. Blank or absent means the default -- and so
 * does anything that isn't a number in range, with a warning naming it.
 *
 * Why not just Number(process.env.X ?? default): `??` only catches an ABSENT
 * variable. A line left blank in .env (`BAKE_TIMEOUT_MIN=`) is an empty
 * string, Number('') is 0, and a 0-minute bake timeout killed every build the
 * moment it started; RETENTION_DAYS= purged every failed city at the next
 * sweep; MAX_CONCURRENT_UPLOADS_PER_UPLOADER= refused every upload. A typo
 * gave NaN, which setTimeout treats as 0 too.
 * @param {string} name @param {number} fallback
 * @param {{min?: number}} [opts] - smallest accepted value (inclusive)
 * @returns {number}
 */
function envNumber(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.warn(`[config] ${name}=${raw} is not a number of at least ${min}; using the default, ${fallback}`);
    return fallback;
  }
  return n;
}

// ADMIN_TOKEN gates every /api/admin/* route: the admin page that lists
// every uploaded city, opens any of them without its private link, shows
// build logs and can delete a city. Refuse to start rather than come up
// silently half-configured: a server with nobody able to see what's been
// uploaded to it, or to take an unwanted city down.
const adminToken = process.env.ADMIN_TOKEN || null;
if (!adminToken) {
  throw new Error(
    'ADMIN_TOKEN is not set. This backend has no login system for the ' +
    'admin page -- ADMIN_TOKEN is the only thing gating it, so refusing ' +
    'to start without one rather than run with nobody able to manage ' +
    'uploaded cities. Generate a random value and add it to server/.env, e.g.:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"\n' +
    'then set ADMIN_TOKEN=<that value> in server/.env (see .env.example).'
  );
}

export const config = {
  port: envNumber('PORT', 8787, { min: 1 }),
  // Network interface to listen on. Blank = all (reachable from the LAN
  // directly). Behind a reverse proxy on the same machine use 127.0.0.1, so
  // the only way in is through the proxy (HTTPS, upload limits, logging).
  host: process.env.HOST || undefined,
  storageRoot: resolve(serverRoot, process.env.STORAGE_ROOT ?? './storage'),
  // The largest single file accepted. 4 GB is about twice the largest
  // Indian metro's buildings file: counted in Google Open Buildings v3
  // (2026-09-30), Delhi is 36 lakh buildings, about 1.4 GB in the usual
  // export format, and Delhi with Gurgaon, Noida, Ghaziabad and Faridabad
  // 54 lakh, about 2.1 GB. (Kanpur: 7.3 lakh, 283 MB.) The build reads the
  // file a piece at a time, so its size is no limit in itself; what a build
  // needs is memory in proportion to the number of buildings (about 1 GB
  // for a 58-lakh test file, 0.5 GB for Kanpur) and disk for its tiles
  // (bakeSizeMultiplier below).
  maxUploadBytes: envNumber('MAX_UPLOAD_MB', 4096, { min: 1 }) * 1024 * 1024,
  // Every file other than buildings (a roads survey, an OpenStreetMap
  // export…). The build reads these a feature at a time too, but what it
  // makes of each is one GeoJSON layer that the viewer loads whole (only
  // roads are written as tiles when there are very many), so a layer has to
  // stay a size a browser can open. Not a setting: raising it would only
  // move the failure from the upload to the visitor.
  maxLayerFileBytes: 500 * 1000 * 1000,
  // How long one request may take to arrive in full. Node's own default is
  // 5 minutes, which cuts off a large upload on anything but a fast
  // network: 2 GB in 2 hours needs only 2.4 Mbit/s.
  uploadTimeoutMs: envNumber('UPLOAD_TIMEOUT_MIN', 120, { min: 1 }) * 60 * 1000,
  // 2 h. Kanpur (283 MB, 7.3 lakh buildings) bakes in under a minute on a desktop PC and a Delhi-sized file (2.3 GB, 58 lakh) in a few minutes; this leaves room for slower servers.
  bakeTimeoutMs: envNumber('BAKE_TIMEOUT_MIN', 120, { min: 1 }) * 60 * 1000,
  // The one OpenWeatherMap key for the whole site, added to a city when it is
  // opened (lib/siteWeather.js). Blank = no live weather.
  weatherApiKey: process.env.WEATHER_API_KEY || null,
  // Prefix for the tile/layer URLs written into each built city's config.
  // Blank (the default) writes relative "/files/..." URLs, which work on
  // whatever address the site is reached at -- LAN IP, domain, or an iframe
  // on another platform. Only set it if /files is served from a different
  // host than the page (e.g. a CDN); a value like http://localhost:8787 gets
  // stored in every city built with it and breaks those links off this machine.
  publicApiBaseUrl: (process.env.PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, ''),
  adminToken,

  // The built front end (`npm run build` at the project root) is served by
  // this same process, so the page, /api and /files share one origin and
  // every link works from any device. Set FRONTEND_DIR= (empty) to turn this
  // off when a reverse proxy serves dist/ itself.
  frontendDir: process.env.FRONTEND_DIR === '' ? null : resolve(serverRoot, process.env.FRONTEND_DIR ?? '../dist'),

  // Express's `trust proxy`. Behind nginx/Apache every request arrives from
  // the proxy's own address, so without this all uploaders share one IP
  // quota. e.g. "loopback" when the proxy runs on this machine, or the
  // proxy's IP. Blank = don't trust X-Forwarded-For (direct connections).
  trustProxy: process.env.TRUST_PROXY || null,

  // Which sites may show the viewer in an iframe (Content-Security-Policy
  // frame-ancestors) -- and so, the only sites that can drive it through the
  // embed control API (src/embed/ControlApi.js has no list of its own).
  // Blank = any site. Comma-separated origins to restrict,
  // e.g. "https://airawat.example.in,https://partner.example.com".
  // The hosting team's decision: HOSTING.md, "Decision for IT".
  embedAllowedOrigins: process.env.EMBED_ALLOWED_ORIGINS ? process.env.EMBED_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : null,

  // Retention sweep. A failed city with no live
  // (current_job_id) version is fully purged (files deleted, DB row kept
  // as 'purged') this many days after the build that failed.
  // 0 is allowed on purpose (purge at the next sweep); blank is the default.
  retentionDays: envNumber('RETENTION_DAYS', 7, { min: 0 }),

  // Per-uploader quota, keyed by cities.uploader_key (the uploading
  // browser's IP -- uploads ask for no email or account; see
  // routes/uploads.js): how many of one uploader's cities may be building
  // or waiting to build at once.
  maxConcurrentUploadsPerUploader: envNumber('MAX_CONCURRENT_UPLOADS_PER_UPLOADER', 2, { min: 1 }),

  // Roads, railway, amenities, land use, vegetation, water and locality
  // names are downloaded from OpenStreetMap (Overpass API) for the drawn
  // area as part of every build -- see jobs/osmFetchChild.js. Public
  // Overpass servers are often overloaded, so several are tried in order,
  // each with retries. Comma-separated; first reachable one wins.
  overpassEndpoints: (process.env.OVERPASS_ENDPOINTS || [
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ].join(',')).split(',').map((s) => s.trim()).filter(Boolean),
  osmFetchTimeoutMs: envNumber('OSM_FETCH_TIMEOUT_MIN', 20, { min: 1 }) * 60 * 1000,

  // When the uploader chooses "Get them for me from Google Open Buildings",
  // the build first downloads the drawn area's buildings from Google's
  // public storage (scripts/fetch-open-buildings.mjs): Kanpur is about
  // 0.7 GB and 6 minutes on a fast line. This is how long that may take.
  buildingsFetchTimeoutMs: envNumber('BUILDINGS_FETCH_TIMEOUT_MIN', 90, { min: 1 }) * 60 * 1000,

  // Disk pre-flight checks. A bake needs roughly
  // 7x its raw input size on disk (Kanpur's own measured ratio: 282.9MB
  // in, ~1.9GB of tiles out, plus intermediate tiers) -- refuse an
  // upload/bake rather than let it run the host out of disk mid-write.
  minFreeSpaceGb: envNumber('MIN_FREE_SPACE_GB', 5, { min: 0 }),
  bakeSizeMultiplier: 7,

  // CORS. Wide open by default, unless the self-hoster opts into a strict
  // allowlist by setting this. Comma-separated origins,
  // e.g. "https://mytwin.example.com,https://admin.example.com".
  allowedOrigins: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : null,
};
