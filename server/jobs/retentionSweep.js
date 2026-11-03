// ===================================================================
// retentionSweep.js -- deletes FILES, keeps DB
// ROWS -- the historical record (who uploaded what, when, why it
// failed) stays queryable forever; only the disk-heavy bytes go.
// Three independent kinds of sweep, run every pass:
//
//   1. Full purge: a city with NO live version at all (current_job_id
//      IS NULL) sitting in 'failed' for >= config.retentionDays since
//      that build finished. Its entire uploads/ and cities/ directories
//      are deleted, and cities.status becomes 'purged'. A city WITH a
//      live version is NEVER touched here even if its most recent
//      revision failed -- current_job_id says something is still being
//      served, full stop (routes/cities.js gates on exactly this).
//
//   2. Superseded job sweep: for a city that HAS a live version, any
//      OTHER job belonging to it (an earlier live build now replaced,
//      or a failed revision attempt) has its job-scoped output
//      directory deleted immediately -- no grace period. There's no
//      rollback feature, so a superseded job's files serve no product
//      purpose once a newer job has taken over
//      current_job_id; jobs.files_purged_at marks it swept without
//      touching jobs.status, so whether that attempt originally
//      succeeded or failed stays on the record.
//
//   3. Orphans: a folder under uploads/ or cities/ with no city row at
//      all -- an upload cut off mid-transfer, a crash between receiving
//      files and recording the city, test leftovers. Nothing can ever
//      reach these, so they're deleted once nothing in them has been
//      written for an hour (an upload still streaming in keeps touching
//      its file, so it's never mistaken for an orphan).
//
// A city its uploader or the admin deletes (lib/deleteCity.js) doesn't
// wait for any of this: its files AND rows go immediately.
// ===================================================================
import { rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const ORPHAN_IDLE_MS = 60 * 60 * 1000;

/** Newest modification time of anything inside `dir` (the dir itself included). */
function newestMtime(dir) {
  let newest = statSync(dir).mtimeMs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

function sweepOrphans(db, storageRoot) {
  const known = new Set(db.prepare(`SELECT id FROM cities`).all().map((c) => c.id));
  let removed = 0;
  for (const area of ['uploads', 'cities']) {
    const root = join(storageRoot, area);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || known.has(entry.name)) continue;
      const dir = join(root, entry.name);
      if (Date.now() - newestMtime(dir) < ORPHAN_IDLE_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

export function runSweep(db, storageRoot) {
  const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();

  let purgedCities = 0;
  let sweptJobs = 0;

  // -- 1. Full purge --------------------------------------------------
  const purgeCandidates = db.prepare(`
    SELECT id, created_at,
      (SELECT MAX(finished_at) FROM jobs WHERE jobs.city_id = cities.id) AS latest_job_finished_at
    FROM cities
    WHERE status = 'failed' AND current_job_id IS NULL
  `).all();

  for (const city of purgeCandidates) {
    const outcomeAt = city.latest_job_finished_at ?? city.created_at;
    if (outcomeAt > cutoff) continue; // not old enough yet

    rmSync(join(storageRoot, 'uploads', city.id), { recursive: true, force: true });
    rmSync(join(storageRoot, 'cities', city.id), { recursive: true, force: true });
    db.prepare(`UPDATE cities SET status = 'purged' WHERE id = ?`).run(city.id);
    purgedCities++;
  }

  // -- 2. Superseded job sweep -----------------------------------------
  const supersededJobs = db.prepare(`
    SELECT jobs.id AS job_id, jobs.city_id
    FROM jobs
    JOIN cities ON cities.id = jobs.city_id
    WHERE cities.current_job_id IS NOT NULL
      AND jobs.id != cities.current_job_id
      AND jobs.files_purged_at IS NULL
      AND jobs.status IN ('succeeded', 'failed')
  `).all();

  for (const job of supersededJobs) {
    rmSync(join(storageRoot, 'cities', job.city_id, String(job.job_id)), { recursive: true, force: true });
    db.prepare(`UPDATE jobs SET files_purged_at = ? WHERE id = ?`).run(new Date().toISOString(), job.job_id);
    sweptJobs++;
  }

  // -- 3. Orphans --------------------------------------------------------
  const orphans = sweepOrphans(db, storageRoot);

  if (purgedCities || sweptJobs || orphans) {
    console.log(`[retentionSweep] purged ${purgedCities} inactive failed cit${purgedCities === 1 ? 'y' : 'ies'}, swept ${sweptJobs} superseded job output dir(s), removed ${orphans} orphaned folder(s)`);
  }
  return { purgedCities, sweptJobs, orphans };
}
