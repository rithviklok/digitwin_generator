// ===================================================================
// deleteCity.js -- removes a city completely: stops its build if one is
// queued or running (waiting for the running step to actually exit),
// then deletes everything stored for it -- uploaded files, OpenStreetMap
// downloads and cache, every build's output -- and its database rows.
// Irreversible; both pages that offer it ask for confirmation first.
//
// Two callers, each with its own permission check done BEFORE calling
// this: the uploader (routes/uploads.js -- the city's access token) and
// the admin (routes/admin.js -- ADMIN_TOKEN).
// ===================================================================
import { existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { assertValidCityId } from './ids.js';

/** Total bytes under a directory (0 if it doesn't exist). */
function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('../jobs/jobRunner.js').JobRunner} jobRunner
 * @param {string} cityId - an existing city's id (the caller has already looked the row up)
 * @returns {Promise<{freedBytes: number}>}
 */
export async function deleteCity(db, jobRunner, cityId) {
  assertValidCityId(cityId); // flows into filesystem paths below

  await jobRunner.cancelCity(cityId);
  const dirs = [join(config.storageRoot, 'uploads', cityId), join(config.storageRoot, 'cities', cityId)];
  const freedBytes = dirs.reduce((sum, dir) => sum + dirSize(dir), 0);
  // Files first: if one can't be removed yet, the rows stay and the caller can simply try again.
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM layer_files WHERE city_id = ?`).run(cityId);
    db.prepare(`DELETE FROM cities WHERE id = ?`).run(cityId); // before jobs: cities.current_job_id references jobs(id)
    db.prepare(`DELETE FROM jobs WHERE city_id = ?`).run(cityId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { freedBytes };
}
