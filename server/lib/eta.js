// ===================================================================
// eta.js -- estimated time left for the 3D build (the "bake" stage), for
// the uploader's Review & build page.
//
// bakeJob.js maps the bake's phases onto 0-100% in proportion to how long
// each phase took on a real city, so percent done is roughly percent of
// time spent. The estimate projects the stage's total length from the
// LATEST progress report -- total = (report time - stage start) × 100 / % --
// and counts down from there. Anchoring to the report (not to "now")
// matters: the bake is silent for a long stretch while it works out detail
// levels, and dividing the ever-growing elapsed time by a percentage that
// isn't moving would make the estimate climb for minutes instead of
// counting down.
// ===================================================================

/** Below this the bake has only just started reading the file (bakeJob.js: 8% is about a third of the way through it) -- too little to project the rest from. */
const MIN_PERCENT_FOR_ESTIMATE = 8;

/**
 * @param {{stage: string|null, status: string, progress: number|null, stage_started_at: string|null, progress_at: string|null}} job - a jobs row
 * @param {{limitMs?: number, now?: number}} [opts] - limitMs: the bake timeout (config.bakeTimeoutMs)
 * @returns {null | {secondsLeft: number, overLimit: boolean}}
 *   null while there's too little to go on (or it isn't the bake).
 *   secondsLeft 0 = the estimate has run out but the bake is still going.
 *   overLimit = at this pace the whole bake would take longer than the timeout.
 */
export function estimateBakeTimeLeft(job, { limitMs, now = Date.now() } = {}) {
  if (job?.status !== 'running' || job.stage !== 'bake') return null;
  const { progress } = job;
  if (progress == null || progress < MIN_PERCENT_FOR_ESTIMATE || progress >= 100) return null;
  const start = Date.parse(job.stage_started_at), reportedAt = Date.parse(job.progress_at);
  if (!Number.isFinite(start) || !Number.isFinite(reportedAt) || reportedAt <= start) return null;

  const projectedTotalMs = ((reportedAt - start) * 100) / progress;
  return {
    secondsLeft: Math.max(0, Math.round((start + projectedTotalMs - now) / 1000)),
    overLimit: limitMs != null && projectedTotalMs > limitMs,
  };
}
