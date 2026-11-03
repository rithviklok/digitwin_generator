// ===================================================================
// AdminLogView -- ?admin=<token>&city=<id>&logs=1: lets the admin see
// why a build failed without logging in to the server's computer.
// Deliberately its own mode, separate from opening the
// city in the viewer: the viewer boots off a job's assembled
// config_json, which only exists for a build that actually SUCCEEDED
// -- a city that has failed on every attempt has nothing to open. This
// lists every job for a city regardless of outcome, reading captured
// stdout/stderr straight from `jobs.log_text` (recorded by
// bakeJob.js/jobRunner.js).
// ===================================================================
import { adminApi } from '../api/client.js';

export function mountAdminLogView({ cityId, token }) {
  const page = document.getElementById('adminLogView');
  const cityIdEl = document.getElementById('adminLogCityId');
  const listEl = document.getElementById('adminLogList');
  page.hidden = false;
  cityIdEl.textContent = cityId;
  document.getElementById('adminLogBackLink').href = `?admin=${encodeURIComponent(token)}`;

  adminApi.listJobs(token, cityId)
    .then(({ jobs }) => renderJobs(listEl, jobs))
    .catch((err) => {
      listEl.textContent = `Could not load job history: ${err.message ?? err}`;
    });
}

function renderJobs(listEl, jobs) {
  listEl.innerHTML = '';
  if (jobs.length === 0) {
    listEl.textContent = 'No build attempts recorded for this city yet.';
    return;
  }
  for (const job of jobs) {
    const details = document.createElement('details');
    details.className = 'admin-log-view__job';
    details.open = job.status === 'failed'; // open failed attempts by default -- that's what an admin's here for

    const summary = document.createElement('summary');
    const purgedNote = job.files_purged_at ? ' · files purged' : '';
    const exitNote = job.exit_code != null ? ` (exit ${job.exit_code})` : '';
    summary.textContent = `Job #${job.id} — ${job.status}${exitNote} — ${job.started_at ?? job.created_at}${purgedNote}`;
    details.appendChild(summary);

    const pre = document.createElement('pre');
    pre.className = 'admin-log-view__log';
    pre.textContent = job.log_text || '(no output captured)';
    details.appendChild(pre);

    listEl.appendChild(details);
  }
}
