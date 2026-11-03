// ===================================================================
// db.js -- the backend's entire persistence layer: one SQLite file,
// no server process of its own to install or operate (see
// server/README.md's self-hosting rationale).
//
// Uses Node's OWN built-in `node:sqlite` (DatabaseSync), not the
// `better-sqlite3` package: that one has no prebuilt binary for every
// Node version, and then falls back to compiling from source via
// node-gyp, which needs a full C++ toolchain (Visual Studio Build Tools
// on Windows) that a self-hoster is very unlikely to have. node:sqlite
// ships inside Node itself: zero native compilation, ever. It needs no
// flag on Node 24, which is what server/package.json's engines field
// asks for (built and tested on 24.19.0).
//
// The schema (there is no manual review: a build goes live as soon as
// it succeeds -- see migrateToV6):
//   - cities: one row per uploaded city, current_job_id is the ONLY
//     thing the /api/cities/:id/config route reads to decide which
//     job's baked output is actually live (the blue/green pointer
//     that lets a failed or in-progress revision never take down the
//     version already being served). `status` is a different thing:
//     how the city's LATEST submission went. The assembled config
//     lives on `jobs.config_json`, NOT here -- every build has its
//     own, and current_job_id says which one is served.
//   - layer_files: one row per uploaded/derived layer file, `source`
//     distinguishes a manually uploaded file from one the OSM
//     auto-splitter produced -- read by the coverage panel so
//     synthetic road geometry is never presented as if it were
//     surveyed data.
//   - jobs: one row per bake attempt (a city can have several across
//     its revision history).
// ===================================================================
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  migrateToV1(db);
  migrateToV2(db);
  migrateToV3(db);
  migrateToV4(db);
  migrateToV5(db);
  migrateToV6(db);
  return db;
}

function migrate(db) {
  // Table order matters: SQLite resolves REFERENCES targets against tables
  // that already exist, so `jobs` (referenced by both `cities.current_job_id`
  // and `layer_files.job_id`) is created first, even though it's the
  // "child" concept -- a city has jobs, not the other way round.
  db.exec(`
    -- city_id has no REFERENCES here -- not because SQLite couldn't check it
    -- (a forward reference to a table created later in this same script is
    -- fine; FKs are only checked at INSERT/UPDATE/DELETE time), but because
    -- the cities table never gets deleted from by application code, so the
    -- cascade this would enable is untested surface with no real use yet.
    CREATE TABLE IF NOT EXISTS jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id      TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
      created_at   TEXT NOT NULL,
      started_at   TEXT,
      finished_at  TEXT,
      log_text     TEXT,
      exit_code    INTEGER,
      config_json  TEXT
    );

    CREATE TABLE IF NOT EXISTS cities (
      id                TEXT PRIMARY KEY,
      display_name      TEXT NOT NULL,
      uploader_email     TEXT NOT NULL,
      access_token       TEXT NOT NULL UNIQUE,
      status             TEXT NOT NULL CHECK (status IN ('processing','pending_review','approved','rejected','failed')),
      created_at         TEXT NOT NULL,
      reviewed_at        TEXT,
      reject_reason      TEXT,
      origin_lon         REAL,
      origin_lat         REAL,
      bbox_json          TEXT,
      input_bytes_total  INTEGER NOT NULL DEFAULT 0,
      current_job_id     INTEGER REFERENCES jobs(id)
    );

    CREATE TABLE IF NOT EXISTS layer_files (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id            TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      job_id             INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      role               TEXT NOT NULL,
      original_filename  TEXT NOT NULL,
      byte_size          INTEGER NOT NULL,
      status             TEXT NOT NULL CHECK (status IN ('validated','invalid')),
      error_message      TEXT,
      source             TEXT NOT NULL CHECK (source IN ('manual','osm-derived'))
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_city ON jobs(city_id);
    CREATE INDEX IF NOT EXISTS idx_layer_files_job ON layer_files(job_id);
    CREATE INDEX IF NOT EXISTS idx_cities_status ON cities(status);
  `);
}

// ===================================================================
// Versioned migrations, gated by SQLite's own PRAGMA user_version (the
// standard lightweight pattern for a project with no migration
// framework -- one integer, persisted in the DB file itself, no
// separate migrations table needed). migrate() above always creates
// the ORIGINAL (v0) schema via CREATE TABLE IF NOT EXISTS -- a no-op
// on a database that already has these tables, whatever version it's
// at -- so every database, fresh or years-old, ends up here and walks
// forward through the same numbered steps to the current version.
// user_version defaults to 0 on a brand-new database file too, so a
// fresh self-hoster's first boot runs step 1 same as an upgrade would
// (fast: there's no data yet to move).
// ===================================================================
const SCHEMA_VERSION = 6;
// Every step below stamps its version number INSIDE the same transaction as
// its schema change (PRAGMA user_version is part of the database file, so it
// commits or rolls back with everything else). Stamped after COMMIT, a crash
// in between left the change applied but the version not -- and the next
// start re-ran the step, failed on "duplicate column", and refused to start.

function migrateToV1(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version >= 1) return;

  // v0 -> v1 (the retention sweep): cities gains a 'purged' status
  // (files deleted, row kept -- see retentionSweep.js) and jobs gains
  // files_purged_at, tracking file cleanup SEPARATELY from jobs.status
  // (succeeded/failed) so a purged job's original bake outcome is
  // never overwritten -- the whole point of keeping the row at all.
  //
  // Adding a CHECK value requires recreating `cities` -- SQLite has no
  // ALTER TABLE for constraints. foreign_keys is toggled off for the
  // recreate/drop/rename dance (layer_files.city_id references this
  // table) and back on immediately after, inside the same transaction
  // boundary as everything else here.
  //
  // Order matters, and got this wrong on the first pass: `ALTER TABLE
  // cities RENAME TO cities_v0` doesn't just rename `cities` -- modern
  // SQLite (legacy_alter_table OFF, the default since 3.25) also
  // rewrites every OTHER table's stored schema text that referenced it
  // by name, so layer_files.city_id's `REFERENCES cities(id)` silently
  // became `REFERENCES "cities_v0"(id)`. Dropping cities_v0 afterward
  // then left it pointing at nothing. Building the new table under a
  // throwaway name and renaming THAT into "cities" avoids the problem
  // entirely -- "cities" is only ever DROPped (which does NOT trigger
  // the rewrite), never renamed away, so layer_files' `REFERENCES
  // cities(id)` is never touched and just resolves correctly once a
  // table by that name exists again.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE cities_v1 (
        id                TEXT PRIMARY KEY,
        display_name      TEXT NOT NULL,
        uploader_email     TEXT NOT NULL,
        access_token       TEXT NOT NULL UNIQUE,
        status             TEXT NOT NULL CHECK (status IN ('processing','pending_review','approved','rejected','failed','purged')),
        created_at         TEXT NOT NULL,
        reviewed_at        TEXT,
        reject_reason      TEXT,
        origin_lon         REAL,
        origin_lat         REAL,
        bbox_json          TEXT,
        input_bytes_total  INTEGER NOT NULL DEFAULT 0,
        current_job_id     INTEGER REFERENCES jobs(id)
      );
      INSERT INTO cities_v1 SELECT * FROM cities;
      DROP TABLE cities;
      ALTER TABLE cities_v1 RENAME TO cities;
      CREATE INDEX IF NOT EXISTS idx_cities_status ON cities(status);

      ALTER TABLE jobs ADD COLUMN files_purged_at TEXT;
    `);
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log('[db] migrated schema to v1');
}

function migrateToV2(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version >= 2) return;

  // v1 -> v2: a build must survive the server's computer being switched
  // off, and uploads no longer ask for an email.
  //   - jobs.params_json: everything needed to (re)run a job, written at
  //     ENQUEUE time -- the in-memory queue used to be the only copy, so a
  //     restart silently lost every not-yet-started build. jobRunner's
  //     reconcileAfterRestart() rebuilds the queue from these rows.
  //   - jobs.stage: which step a job is on ('queued' / 'osm' / 'bake' /
  //     'finish'), shown on the uploader's Review & build page.
  //   - jobs.attempts: a job interrupted by a restart is re-run from
  //     scratch, but only up to a cap -- one that keeps crashing the whole
  //     process must not loop forever.
  //   - cities.uploader_email -> uploader_key: the quota key is now the
  //     uploader's IP (see routes/uploads.js); old rows keep their emails
  //     as keys, which is harmless. RENAME COLUMN touches no other table.
  db.exec('BEGIN');
  try {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN params_json TEXT;
      ALTER TABLE jobs ADD COLUMN stage TEXT;
      ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE cities RENAME COLUMN uploader_email TO uploader_key;
    `);
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log('[db] migrated schema to v2');
}

// Each step checks and stamps its OWN number, never SCHEMA_VERSION --
// otherwise a database several versions behind would be stamped current
// by an older step and silently skip the newer ones.
function migrateToV3(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version >= 3) return;

  // v2 -> v3: live build progress for the Review & build page -- a
  // percentage within the current stage and one line of plain text
  // ("Placing buildings: 310,000 of 725,627").
  db.exec('BEGIN');
  try {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN progress INTEGER;
      ALTER TABLE jobs ADD COLUMN progress_text TEXT;
    `);
    db.exec('PRAGMA user_version = 3');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log('[db] migrated schema to v3');
}

function migrateToV4(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version >= 4) return;

  // v3 -> v4 (data only): cities built before PUBLIC_API_BASE_URL defaulted
  // to blank have "http://localhost:8787/files/..." baked into their stored
  // config, which only resolves on the server's own machine -- a client
  // opening the city's link fetches from THEIR localhost. Rewritten to the
  // relative "/files/..." every new build now writes (see config.js). Only
  // loopback hosts: a deliberately external PUBLIC_API_BASE_URL is left alone.
  const LOOPBACK_FILES = /"https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/files\//g;
  const rows = db.prepare('SELECT id, config_json FROM jobs WHERE config_json IS NOT NULL').all();
  const update = db.prepare('UPDATE jobs SET config_json = ? WHERE id = ?');
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const { id, config_json: json } of rows) {
      const fixed = json.replace(LOOPBACK_FILES, '"/files/');
      if (fixed !== json) { update.run(fixed, id); changed++; }
    }
    db.exec('PRAGMA user_version = 4');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`[db] migrated schema to v4 (${changed} built cit${changed === 1 ? 'y' : 'ies'} switched to relative file URLs)`);
}

function migrateToV5(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version >= 5) return;

  // v4 -> v5: an estimated time left for the 3D build (lib/eta.js) needs
  // when the current stage began and when its latest progress report
  // arrived -- `progress` alone says how far, not how fast.
  db.exec('BEGIN');
  try {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN stage_started_at TEXT;
      ALTER TABLE jobs ADD COLUMN progress_at TEXT;
    `);
    db.exec('PRAGMA user_version = 5');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log('[db] migrated schema to v5');
}

function migrateToV6(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version >= 6) return;

  // v5 -> v6: no manual review any more -- a city goes live the moment its
  // build succeeds (jobHooks.js's onJobSucceeded). The statuses that only
  // existed for review go, and 'approved' is renamed to what it now means:
  //   approved       -> live
  //   pending_review -> live, on its latest built job (it was only waiting
  //                     for a reviewer); 'failed' if it has no built job
  //   rejected       -> failed. current_job_id is left alone, so an earlier
  //                     live version keeps serving; the reviewer's note is kept.
  // reject_reason becomes failure_reason (what it holds from here on: why
  // the latest build didn't go live) and reviewed_at goes.
  //
  // A CHECK constraint can't be altered, so `cities` is recreated -- in the
  // same order as v1, and for the reason spelled out there: the new table
  // is renamed INTO "cities", never "cities" away.
  const LATEST_BUILT_JOB = `(SELECT MAX(j.id) FROM jobs j WHERE j.city_id = cities.id AND j.config_json IS NOT NULL)`;
  const before = db.prepare(`SELECT status, COUNT(*) AS n FROM cities GROUP BY status`).all();
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE cities_v6 (
        id                TEXT PRIMARY KEY,
        display_name      TEXT NOT NULL,
        uploader_key      TEXT NOT NULL,
        access_token      TEXT NOT NULL UNIQUE,
        status            TEXT NOT NULL CHECK (status IN ('processing','live','failed','purged')),
        created_at        TEXT NOT NULL,
        failure_reason    TEXT,
        origin_lon        REAL,
        origin_lat        REAL,
        bbox_json         TEXT,
        input_bytes_total INTEGER NOT NULL DEFAULT 0,
        current_job_id    INTEGER REFERENCES jobs(id)
      );
      INSERT INTO cities_v6 (id, display_name, uploader_key, access_token, status, created_at, failure_reason,
                             origin_lon, origin_lat, bbox_json, input_bytes_total, current_job_id)
      SELECT id, display_name, uploader_key, access_token,
        CASE status
          WHEN 'approved' THEN 'live'
          WHEN 'pending_review' THEN CASE WHEN ${LATEST_BUILT_JOB} IS NULL THEN 'failed' ELSE 'live' END
          WHEN 'rejected' THEN 'failed'
          ELSE status
        END,
        created_at, reject_reason, origin_lon, origin_lat, bbox_json, input_bytes_total,
        CASE status WHEN 'pending_review' THEN COALESCE(${LATEST_BUILT_JOB}, current_job_id) ELSE current_job_id END
      FROM cities;
      DROP TABLE cities;
      ALTER TABLE cities_v6 RENAME TO cities;
      CREATE INDEX IF NOT EXISTS idx_cities_status ON cities(status);
    `);
    db.exec('PRAGMA user_version = 6');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const count = (status) => before.find((r) => r.status === status)?.n ?? 0;
  console.log(`[db] migrated schema to v6 (no review step: ${count('pending_review')} cit${count('pending_review') === 1 ? 'y' : 'ies'} waiting for review made live, ${count('rejected')} rejected marked failed)`);
}
