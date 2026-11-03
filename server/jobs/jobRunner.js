// ===================================================================
// jobRunner.js -- the whole "job queue": a single always-running loop,
// not BullMQ/Redis. One build at a time, on purpose -- the bake is
// CPU/memory-bound in a way that makes real concurrency pointless on a
// single self-hosted machine, and a hand-rolled queue is the
// correctly-sized tool for "exactly one job kind, one at a time."
//
// Durable across restarts: a job's row -- including everything needed
// to run it (params_json) -- is written the moment it's ENQUEUED, not
// when it starts. The in-memory array only decides order within this
// process's lifetime; reconcileAfterRestart() rebuilds it from the DB.
// So switching the machine off mid-build loses nothing an uploader
// submitted: a queued job simply waits, and a job that was running is
// rebuilt from scratch (its partial output is never trusted -- deleted,
// not resumed), up to MAX_ATTEMPTS so a job that itself crashes the
// process can't take the server down forever.
//
// A build runs in stages (jobs.stage, shown on the uploader's Review &
// build page): 'queued' -> onJobStarting hook (via jobHooks.js: the
// buildings download from Google Open Buildings when the uploader chose
// it, 'buildings', then the OpenStreetMap download, 'osm') -> 'bake' ->
// 'finish'.
// ===================================================================
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runBake } from './bakeJob.js';
import { assertEnoughDiskSpace } from '../lib/diskSpace.js';

const MAX_ATTEMPTS = 3;

export class JobRunner {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{storageRoot: string,
   *   onJobStarting?: (cityId: string, jobId: number, meta: object, ctx: {setStage: (s: string) => void, setProgress: (pct: number, text: string) => void, signal: AbortSignal}) => Promise<string|void>,
   *   onJobSucceeded: (cityId: string, jobId: number, bakeResult: object, meta: object|undefined) => Promise<void>,
   *   onJobFailed: (cityId: string, jobId: number, bakeResult: object, meta: object|undefined) => Promise<void>}} opts
   *   onJobStarting runs before the bake, may add to `meta` (it's what
   *   later reaches onJobSucceeded), and returns log text for the job
   *   log; its ctx.signal is aborted if the city is deleted mid-build. onJobSucceeded/onJobFailed run AFTER this module's own
   *   bookkeeping of the job (jobs.status) is already committed.
   *   onJobSucceeded is where CityConfig assembly + validateCityConfig()
   *   happens and where the city goes live (cities.status, current_job_id)
   *   -- kept out of this file so the queue mechanics stay testable on
   *   their own.
   */
  constructor(db, opts) {
    this.db = db;
    this.storageRoot = opts.storageRoot;
    this.onJobStarting = opts.onJobStarting;
    this.onJobSucceeded = opts.onJobSucceeded;
    this.onJobFailed = opts.onJobFailed;
    this.queue = [];
    this.processing = false;
    this.current = null; // {jobId, cityId, controller, done: Promise} while a job runs -- what cancelCity() stops
    this.cancelledJobs = new Set();
  }

  /**
   * Stops everything for a city that's being deleted: drops its queued
   * jobs, and if one of its jobs is running, kills the running step
   * (download or bake) and waits for it to actually exit -- so the
   * caller can delete its files without racing a child process still
   * writing into them (on Windows an open file can't even be deleted).
   */
  async cancelCity(cityId) {
    this.queue = this.queue.filter((item) => item.cityId !== cityId);
    if (this.current?.cityId === cityId) {
      this.cancelledJobs.add(this.current.jobId);
      this.current.controller.abort();
      await this.current.done;
    }
  }

  _outputRoot(cityId, jobId) {
    return join(this.storageRoot, 'cities', cityId, String(jobId));
  }

  /** Call once at boot, before accepting new uploads: re-queues whatever this process's predecessor was running or had waiting, then starts working through it. */
  reconcileAfterRestart() {
    const now = new Date().toISOString();

    /** @type {Array<{id: number, city_id: string, attempts: number, params_json: string|null}>} */
    const interrupted = /** @type {any} */ (this.db.prepare(`SELECT id, city_id, attempts, params_json FROM jobs WHERE status = 'running'`).all());
    for (const job of interrupted) {
      // Partial output from an interrupted bake is never trustworthy -- delete it rather than risk half-written tiles being pointed at later.
      rmSync(this._outputRoot(job.city_id, job.id), { recursive: true, force: true });
      if (job.params_json && job.attempts < MAX_ATTEMPTS) {
        this.db.prepare(`UPDATE jobs SET status = 'queued', stage = 'queued', started_at = NULL, log_text = COALESCE(log_text, '') || ? WHERE id = ?`)
          .run(`\n[jobRunner] interrupted by a server restart (attempt ${job.attempts} of ${MAX_ATTEMPTS}) -- rebuilding from scratch`, job.id);
        continue;
      }
      // Pre-v2 job (no params_json to rebuild from) or out of attempts.
      // Unconditional city status change, including when current_job_id is
      // already set (a revision of a city that's live): `status` reflects
      // the LATEST submission's outcome, not whether the city is viewable --
      // routes/cities.js gates on current_job_id, so this can never take
      // down the version being served.
      const why = job.params_json ? `interrupted by restarts ${job.attempts} times -- giving up` : 'was still "running" with no live process behind it';
      this.db.prepare(`UPDATE jobs SET status = 'failed', finished_at = ?, log_text = COALESCE(log_text, '') || ? WHERE id = ?`)
        .run(now, `\n[jobRunner] marked failed on restart -- ${why}`, job.id);
      this.db.prepare(`UPDATE cities SET status = 'failed' WHERE id = ?`).run(job.city_id);
    }

    // A job queued before jobs carried their own parameters (schema v2) has
    // nothing to run from. Failed here, BEFORE the orphan check below, so its
    // city is then marked failed too. (JSON.parse(null) used to stop the
    // whole server from starting.)
    const unrunnable = this.db.prepare(`UPDATE jobs SET status = 'failed', finished_at = ?, log_text = COALESCE(log_text, '') || ? WHERE status = 'queued' AND params_json IS NULL`)
      .run(now, '\n[jobRunner] marked failed on restart -- queued before builds could be resumed, nothing to rebuild it from').changes;

    // A city still 'processing' with no queued/running job behind it had
    // its build queued in memory only (before jobs were durable) -- there's
    // nothing left to rebuild it from, so say so instead of spinning forever.
    const orphaned = this.db.prepare(`
      UPDATE cities SET status = 'failed'
      WHERE status = 'processing'
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.city_id = cities.id AND jobs.status IN ('queued', 'running'))
    `).run().changes;

    const queued = this.db.prepare(`SELECT id, city_id, params_json FROM jobs WHERE status = 'queued' ORDER BY id`).all();
    for (const job of queued) {
      const { bakeParams, meta } = JSON.parse(job.params_json);
      this.queue.push({ jobId: job.id, cityId: job.city_id, bakeParams, meta });
    }

    if (interrupted.length || unrunnable || orphaned || queued.length) {
      console.log(`[jobRunner] after restart: ${interrupted.length} interrupted job(s) handled, ${unrunnable} unrunnable queued job(s) failed, ${orphaned} orphaned city(ies) marked failed, ${queued.length} job(s) queued`);
    }
    this._kick();
  }

  /**
   * Starts the next queued job if none is running. Never lets a rejection
   * escape: _pump() is async and was called without a .catch(), and Node
   * ends the whole process on an unhandled rejection by default -- one
   * database error in a build's bookkeeping would have taken the server down.
   */
  _kick() {
    this._pump().catch((err) => console.error('[jobRunner] the build queue failed to advance:', err));
  }

  /**
   * Records the job durably, then queues it.
   * @param {{cityId: string, bakeParams: object, meta?: object}} item
   *   Both are stored as JSON on the job row, so everything in them must
   *   be JSON-safe; `meta` is otherwise opaque to this module -- passed
   *   through to the hooks as-is.
   * @returns {number} jobId
   */
  enqueue({ cityId, bakeParams, meta }) {
    const jobId = Number(this.db.prepare(`INSERT INTO jobs (city_id, status, stage, created_at, params_json) VALUES (?, 'queued', 'queued', ?, ?)`)
      .run(cityId, new Date().toISOString(), JSON.stringify({ bakeParams, meta })).lastInsertRowid);
    this.queue.push({ jobId, cityId, bakeParams, meta });
    this._kick();
    return jobId;
  }

  /**
   * Queue mechanics only: takes the next job, runs it, and -- however it
   * ends, including a database error in the bookkeeping after the bake --
   * releases the queue and moves on. Before this was a `finally`, an
   * exception after the bake left `processing` true forever: every later
   * upload sat in 'queued' until the server was restarted.
   */
  async _pump() {
    if (this.processing) return; // already draining the queue -- the job that is running starts the next one when it ends
    const item = this.queue.shift();
    if (!item) return;
    this.processing = true;

    const controller = new AbortController();
    /** @type {() => void} */
    let finishCurrent = () => {};
    this.current = { jobId: item.jobId, cityId: item.cityId, controller, done: new Promise((r) => { finishCurrent = () => r(undefined); }) };
    try {
      await this._runJob(item, controller);
    } catch (err) {
      console.error(`[jobRunner] job ${item.jobId} (city ${item.cityId}) could not be finished:`, err);
      // Best effort, so the job and its city don't read "running"/"building" forever.
      try {
        this.db.prepare(`UPDATE jobs SET status = 'failed', finished_at = ?, progress_text = COALESCE(progress_text, ?) WHERE id = ? AND status IN ('queued', 'running')`)
          .run(new Date().toISOString(), `internal: ${err?.message ?? err}`, item.jobId);
        this.db.prepare(`UPDATE cities SET status = 'failed' WHERE id = ? AND status = 'processing'`).run(item.cityId);
      } catch (dbErr) {
        console.error(`[jobRunner] could not record job ${item.jobId} as failed:`, dbErr);
      }
    } finally {
      this.cancelledJobs.delete(item.jobId);
      this.current = null;
      finishCurrent();
      this.processing = false;
      this._kick(); // whatever queued up while this job ran
    }
  }

  /**
   * Runs one job from start to finish: the OpenStreetMap step, the bake,
   * then its bookkeeping and the success/failure hook.
   * @param {{jobId: number, cityId: string, bakeParams: any, meta: any}} item
   * @param {AbortController} controller - aborted when the city is deleted mid-build (cancelCity)
   */
  async _runJob(item, controller) {
    const { jobId, cityId, bakeParams, meta } = item;

    // Live progress for the Review & build page: a percentage within the
    // current stage plus one line of plain text. Written at most every
    // 750 ms -- the child processes can report far more often than the
    // page polls, and every write is a DB transaction -- but the LATEST
    // report is always written in the end (trailing edge): dropping the
    // tail of a burst left the page stuck on a stale "58%" for over a
    // minute while the bake had long moved on.
    let lastWrite = 0;
    let pendingProgress = null;
    let trailingTimer = null;
    const writeProgress = () => {
      trailingTimer = null;
      if (!pendingProgress) return;
      const [pct, text, reportedAt] = pendingProgress;
      pendingProgress = null;
      lastWrite = Date.now();
      this.db.prepare(`UPDATE jobs SET progress = ?, progress_text = ?, progress_at = ? WHERE id = ? AND status = 'running'`)
        .run(Math.max(0, Math.min(100, Math.round(pct))), text ?? null, reportedAt, jobId);
    };
    const setProgress = (pct, text) => {
      // When the report arrived, not when the throttled write lands -- the time-left estimate (lib/eta.js) divides by it.
      pendingProgress = [pct, text, new Date().toISOString()];
      const wait = 750 - (Date.now() - lastWrite);
      if (wait <= 0) writeProgress();
      else trailingTimer ??= setTimeout(writeProgress, wait);
    };
    const setStage = (stage) => {
      clearTimeout(trailingTimer); trailingTimer = null; pendingProgress = null; // a new stage starts from a clean slate
      this.db.prepare(`UPDATE jobs SET stage = ?, stage_started_at = ?, progress = NULL, progress_text = NULL, progress_at = NULL WHERE id = ?`)
        .run(stage, new Date().toISOString(), jobId);
    };
    this.db.prepare(`UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?`).run(new Date().toISOString(), jobId);

    // outputRoot is job-scoped (cities/<cityId>/<jobId>/...), not city-scoped --
    // that's what lets a revision bake alongside the version that's live
    // without touching it.
    const outputRoot = this._outputRoot(cityId, jobId);
    const logParts = [];

    let result;
    try {
      const startLog = await this.onJobStarting?.(cityId, jobId, meta, { setStage, setProgress, signal: controller.signal });
      if (startLog) logParts.push(startLog);
      if (controller.signal.aborted) throw new Error('cancelled: the city is being deleted');

      setStage('bake');
      // Second disk check, against the EXACT uploaded file size (the
      // upload-time check in routes/uploads.js only had Content-Length of
      // the whole multipart body to estimate from, and free space may have
      // changed since then -- other bakes/uploads in between). A failure
      // here flows into the same ok:false path as any other bake failure,
      // including cities.status='failed' below.
      await assertEnoughDiskSpace(this.storageRoot, statSync(bakeParams.inputPath).size);
      const bake = await runBake({ ...bakeParams, outputRoot }, { onProgress: setProgress, signal: controller.signal });
      logParts.push(bake.logText);
      result = { ...bake, logText: logParts.join('\n') };
    } catch (err) {
      // A step that stops the build on purpose (jobHooks.js: no buildings to be had) says why in plain words, and keeps its own log.
      if (err?.logText) logParts.push(err.logText);
      logParts.push(String(err?.stack ?? err));
      result = { ok: false, exitCode: null, logText: logParts.join('\n'), timedOut: false, errorText: err?.userMessage ?? null };
    }
    result.outputRoot = outputRoot; // hooks need this to find the baked manifest/tiles
    clearTimeout(trailingTimer); // the job is over -- no late progress write may land after its final state

    // Cancelled because the city is being deleted: its rows and files are
    // about to go (lib/deleteCity.js), so no bookkeeping or hooks -- _pump()'s
    // `finally` hands control back to cancelCity() and moves on.
    if (this.cancelledJobs.has(jobId)) return;

    if (result.ok) {
      setStage('finish');
    } else {
      // On failure `stage` is left on the step that failed (the Review & build
      // page shows where it stopped), and progress_text becomes the reason, in
      // plain words where there is one.
      const reason = result.errorText
        ?? (result.timedOut ? `It ran longer than the ${Math.round(bakeParams.timeoutMs / 60000)}-minute limit and was stopped.` : null);
      this.db.prepare(`UPDATE jobs SET progress = NULL, progress_text = ? WHERE id = ?`).run(reason, jobId);
    }
    // Appended, not overwritten: an earlier attempt's "interrupted by a restart" note must survive into the final log.
    this.db.prepare(`UPDATE jobs SET status = ?, finished_at = ?, log_text = COALESCE(log_text || char(10), '') || ?, exit_code = ? WHERE id = ?`)
      .run(result.ok ? 'succeeded' : 'failed', new Date().toISOString(), result.logText, result.exitCode, jobId);

    try {
      if (result.ok) {
        // No review step: the hook assembles the city's config and makes this build live (status 'live', current_job_id).
        await this.onJobSucceeded(cityId, jobId, result, meta);
      } else {
        this.db.prepare(`UPDATE cities SET status = 'failed' WHERE id = ?`).run(cityId);
        await this.onJobFailed(cityId, jobId, result, meta);
      }
    } catch (hookErr) {
      // A hook failing (e.g. CityConfig assembly throwing) shouldn't crash the queue loop -- log and move on.
      console.error(`[jobRunner] completion hook threw for job ${jobId} (city ${cityId}):`, hookErr);
      this.db.prepare(`UPDATE cities SET failure_reason = ? WHERE id = ? AND status = 'processing'`).run(`internal: ${hookErr?.message ?? hookErr}`, cityId);
    }
    // However the hooks went, a finished job must never leave its city reading
    // "building" with nothing running behind it (the success hook is what
    // takes it out of 'processing', and it may have thrown before it got there).
    this.db.prepare(`
      UPDATE cities SET status = 'failed'
      WHERE id = ? AND status = 'processing'
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.city_id = cities.id AND jobs.status IN ('queued', 'running'))
    `).run(cityId);
  }
}
