// ===================================================================
// BuildStatus -- live progress of a submitted city, shown on the upload
// wizard's "Review & build" step (UploadView.js) both right after
// submitting and whenever the uploader comes back later (?status=1&
// city=<id>&t=<token>, reachable from "My cities" or the page's own
// link -- there's no email). Polls GET /api/uploads/:id/status and
// renders plain language, never raw internals ("a plain-language
// failure summary, not a raw stderr dump").
//
// There is no review step: the city is live as soon as its build
// finishes, and this page says so.
//
// Everything shown comes from the server's own records (cities + jobs +
// layer_files), so it's the same on any device and survives this
// page -- or the server -- being closed and reopened.
// ===================================================================
import { apiClient } from '../api/client.js';
import { removeMyCity } from '../api/myCities.js';
import { ROLE_LABELS, OSM_ROLES } from '../config/layer-labels.js';

const POLL_BUILDING_MS = 4000;
const POLL_RETRY_MS = 30_000; // the status couldn't be loaded -- the server may just be restarting

const STEPS = [
  { key: 'submitted', label: 'Submitted' },
  { key: 'queued', label: 'Waiting for its turn' },
  // Only when the uploader chose "Get them for me from Google Open Buildings" (server: jobHooks.js).
  { key: 'buildings', label: 'Downloading buildings from Google Open Buildings', detail: 'Every building in your area, with its height. A few minutes for a city.', when: (status) => status.buildingsSource === 'google' },
  { key: 'osm', label: 'Downloading OpenStreetMap data', detail: 'Roads, railways, land use, parks, water…' },
  { key: 'bake', label: 'Building the 3D city', detail: 'The longest step for a large city.' },
  { key: 'live', label: 'Live' },
];

/** The steps this city's build goes through, in order. */
const stepsFor = (status) => STEPS.filter((s) => !s.when || s.when(status));

/** Where the progress line is for a given server status: `{at, state}` -- steps before `at` are done, `at` is active/error/done. */
function progressOf(status, steps) {
  const job = status.job;
  const index = (key) => steps.findIndex((s) => s.key === key);
  switch (status.status) {
    case 'processing': {
      const stage = job?.stage === 'finish' ? 'bake' : (job?.stage ?? 'queued');
      return { at: index(stage) >= 0 ? index(stage) : index('queued'), state: 'active' };
    }
    case 'live': return { at: index('live'), state: 'done' };
    case 'failed': return { at: index(job?.stage) >= 0 ? index(job.stage) : index('bake'), state: 'error' };
    default: return { at: 0, state: 'error' }; // purged
  }
}

function renderProgress(pct, text) {
  const wrap = el('span', 'build-progress');
  if (pct != null) {
    const track = el('span', 'loading-bar-track');
    const fill = el('span', 'loading-bar-fill');
    fill.style.width = `${pct}%`;
    track.append(fill);
    wrap.append(track);
  }
  wrap.append(el('span', 'build-progress__text', `${pct != null ? `${pct}% · ` : ''}${text ?? ''}`));
  return wrap;
}

/**
 * "About 12 min left · done around 14:35" under the 3D build's progress bar.
 * job.eta comes from the server (server/lib/eta.js) as seconds from now, and
 * is null until the buildings file has been read (too early to judge).
 */
function renderEta(job) {
  const { eta } = job;
  const wrap = el('small', 'build-eta');
  if (!eta) {
    wrap.textContent = 'Working out how long this will take…';
    return wrap;
  }
  if (eta.secondsLeft === 0) {
    wrap.textContent = 'Taking a little longer than estimated…';
  } else {
    const doneAt = new Date(Date.now() + eta.secondsLeft * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    wrap.textContent = `${durationText(eta.secondsLeft)} left · done around ${doneAt}`;
  }
  if (eta.overLimit) {
    wrap.append(el('span', 'build-eta__warn', ` At this pace it may pass the ${job.bakeLimitMinutes}-minute limit and be stopped.`));
  }
  return wrap;
}

/** 45 -> "Less than a minute", 720 -> "About 12 min", 5400 -> "About 1 h 30 min". */
function durationText(seconds) {
  if (seconds < 60) return 'Less than a minute';
  const min = Math.round(seconds / 60);
  if (min < 60) return `About ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return `About ${h} h${m ? ` ${m} min` : ''}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderSteps(status) {
  const steps = stepsFor(status);
  const { at, state } = progressOf(status, steps);
  const list = el('ol', 'build-steps');
  steps.forEach((step, i) => {
    let s = i < at || (i === at && state === 'done') ? 'done' : i === at ? state : 'pending';
    if (s === 'done' && step.key === 'osm' && osmMissing(status)) s = 'warn'; // the step finished, but not everything arrived
    const li = el('li', `is-${s}`);
    li.append(el('span', 'dot', s === 'done' ? '✓' : s === 'error' || s === 'warn' ? '!' : ''));
    const text = el('span', null, step.label);
    let detail = s === 'active' || s === 'error' ? step.detail : null;
    if (s === 'warn') detail = 'Some layers couldn’t be downloaded. They are listed below.';
    if (s === 'active' && step.key === 'queued') {
      const ahead = status.job?.buildsAhead ?? 0;
      detail = ahead ? `${ahead} other build${ahead === 1 ? '' : 's'} ahead of yours.` : 'Next up.';
    }
    if (s === 'error' && status.status === 'failed') detail = sentence(status.job?.failureReason) ?? 'This step didn’t finish.'; // the build's own reasons start in lower case
    // Live progress from the server for the step that's running right now.
    const job = status.job;
    if (s === 'active' && job?.status === 'running' && (job.progress != null || job.progressText)) {
      text.append(renderProgress(job.progress, job.progressText ?? detail));
      detail = null;
      if (step.key === 'bake' && job.stage === 'bake') text.append(renderEta(job));
    }
    if (detail) text.append(el('small', null, detail));
    li.append(text);
    list.append(li);
  });
  return list;
}

const osmMissing = (status) => (status.layers ?? []).some((lf) => lf.source === 'osm-derived' && lf.status !== 'validated');
const sentence = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Which layers made it into the finished build -- only known once the job has finished. */
function renderLayers(status) {
  if (!status.layers?.length) return [];
  const byRole = new Map(status.layers.map((lf) => [lf.role, lf]));
  // One failure (typically "can't reach OpenStreetMap") usually hits every
  // layer at once -- say it once under the list, not on every row.
  const errorCounts = new Map();
  for (const lf of status.layers) if (lf.status !== 'validated' && lf.error_message) errorCounts.set(lf.error_message, (errorCounts.get(lf.error_message) ?? 0) + 1);
  const shared = [...errorCounts].filter(([, n]) => n > 1).map(([msg]) => msg);

  const dl = el('dl', 'build-layers');
  const roles = [...OSM_ROLES, ...status.layers.map((lf) => lf.role).filter((r) => !OSM_ROLES.includes(r))];
  for (const role of roles) {
    const lf = byRole.get(role);
    dl.append(el('dt', null, ROLE_LABELS[role] ?? role));
    if (!lf) dl.append(el('dd', null, 'None found in this area'));
    else if (lf.status !== 'validated') dl.append(el('dd', 'is-bad', shared.includes(lf.error_message) ? '✕ Missing' : `✕ ${sentence(lf.error_message ?? 'not usable')}`));
    else if (lf.source === 'manual') dl.append(el('dd', 'is-ok', `✓ Your file (${lf.original_filename})`));
    else if (lf.original_filename === 'OpenStreetMap') dl.append(el('dd', 'is-ok', '✓ From OpenStreetMap'));
    else dl.append(el('dd', 'is-ok', `✓ From your OpenStreetMap export (${lf.original_filename})`));
  }
  const notes = shared.map((msg) => el('p', 'build-layers__why', `Missing because: ${sentence(msg)}. You can add these layers yourself, as your own files or as one OpenStreetMap export (when revising: step 2, “Replace an OpenStreetMap layer with your own”).`));
  return [dl, ...notes];
}

const COPY = {
  processing: ['Building your city…', 'This page updates by itself, and the city goes live as soon as the build finishes. Progress is saved on the server, so you can close this page and come back any time from My cities. If the server itself is switched off, the build starts again when it’s back on.'],
  live: ['Your city is live', 'Anyone with its link can open it.'],
  failed: ['The build didn’t finish', 'Usually this means a data/settings mismatch (for example the wrong height property) rather than a problem with the files themselves. Revise and build again; your files are kept.'],
  purged: ['This submission has been cleared', 'Its files were removed after a period of inactivity. You can start a fresh revision, but you’ll need to attach your files again.'],
};
/** A build that stopped at the buildings download: no data problem of the uploader's, and two ways on. */
const BUILDINGS_FAILED_NOTE = 'The buildings couldn’t be downloaded from Google Open Buildings; the reason is below. Revise and build again later, or revise and choose “Upload my own buildings file” (“Where do I get this?” there lists other sources).';

/**
 * @param {HTMLElement} container - #buildStatus
 * @param {{cityId: string, token: string, onGone?: () => void}} ids - onGone: the city was deleted (here or elsewhere); the page should drop what it shows about it
 * @returns {{stop(): void}}
 */
export function mountBuildStatus(container, { cityId, token, onGone }) {
  container.hidden = false;
  const q = `city=${encodeURIComponent(cityId)}&t=${encodeURIComponent(token)}`;
  const pageUrl = `${location.origin}${location.pathname}?status=1&${q}`;
  const reviseHref = `?upload=1&revise=${encodeURIComponent(cityId)}&t=${encodeURIComponent(token)}`;
  const viewHref = `?${q}`;
  let stopped = false;
  let timer = null;
  let lastStatus = null;

  // Two parts: `body` is re-rendered on every poll; `danger` (delete) is
  // built once, so a confirmation the uploader has open isn't wiped by the
  // next refresh.
  const body = el('div');
  const danger = el('div', 'build-status__danger');
  container.replaceChildren(body, danger);
  renderDeleteButton();

  /** Everything for this city is gone (deleted here, or on another device): stop, forget it locally, say so. */
  function showGone(title, note) {
    stopped = true;
    clearTimeout(timer);
    removeMyCity(cityId);
    container.replaceChildren(el('h2', 'build-status__title', title), el('p', 'build-status__note', note), actionButton('Go to My cities', '?mycities=1', 'ghost'));
    onGone?.();
  }

  function renderDeleteButton() {
    const building = lastStatus?.status === 'processing';
    const btn = el('button', 'app-page__btn app-page__btn--danger', building ? 'Stop and delete this city' : 'Delete this city');
    btn.type = 'button';
    btn.addEventListener('click', renderDeleteConfirm);
    danger.replaceChildren(btn);
  }

  function renderDeleteConfirm() {
    const name = lastStatus?.displayName ? `“${lastStatus.displayName}”` : 'this city';
    const live = lastStatus?.hasLiveVersion ? ' It is live right now, and its link will stop working for everyone.' : '';
    const yes = el('button', 'app-page__btn app-page__btn--danger-solid', 'Delete permanently');
    const no = el('button', 'app-page__btn app-page__btn--ghost', 'Keep it');
    yes.type = no.type = 'button';
    no.addEventListener('click', renderDeleteButton);
    yes.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      yes.textContent = lastStatus?.status === 'processing' ? 'Stopping the build and deleting…' : 'Deleting…';
      try {
        const { freedBytes } = await apiClient.deleteCity(cityId, token);
        showGone(`Deleted ${name}`, `Everything stored for it on the server is gone (${(freedBytes / 1e6).toFixed(freedBytes < 1e7 ? 1 : 0)} MB freed).`);
      } catch (err) {
        danger.replaceChildren(el('p', 'build-status__confirm', `Couldn’t delete: ${err.message ?? err}`));
        const retry = el('button', 'app-page__btn app-page__btn--danger', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', renderDeleteConfirm);
        danger.append(retry);
      }
    });
    const actions = el('div', 'app-page__actions');
    actions.append(yes, no);
    danger.replaceChildren(
      el('p', 'build-status__confirm', `Delete ${name}? This ${lastStatus?.status === 'processing' ? 'stops its build and ' : ''}permanently removes everything stored for it on the server: your uploaded files, the downloaded map data and the built 3D city.${live} This can’t be undone.`),
      actions,
    );
  }

  function actionButton(label, href, kind) {
    const a = el('a', `app-page__btn app-page__btn--${kind}`, label);
    a.href = href;
    return a;
  }

  function render(status) {
    const [title, generalNote] = COPY[status.status] ?? [status.status, ''];
    const note = status.status === 'failed' && status.job?.stage === 'buildings' ? BUILDINGS_FAILED_NOTE : generalNote;
    const actions = el('div', 'app-page__actions');
    if (status.status === 'live') {
      actions.append(actionButton('View your city →', viewHref, 'primary'));
      // A live city can always take more files (wards, zones, landmarks, an
      // outline, a better road survey…) or new ones: a revision builds beside
      // it and replaces it only once it succeeds. Worded for the likelier
      // reason when some layers didn't make it (OSM unreachable, an unusable file).
      const anyMissing = status.layers?.some((lf) => lf.status !== 'validated');
      actions.append(actionButton(anyMissing ? 'Add the missing layers yourself' : 'Add or change files', reviseHref, 'ghost'));
    }
    if (['failed', 'purged'].includes(status.status)) actions.append(actionButton('Revise and build again', reviseHref, 'primary'));
    // A REVISION of an already-live city, building or failed, must never read
    // as "your city is gone": the earlier build serves until a new one succeeds.
    if (status.status !== 'live' && status.hasLiveVersion) actions.append(actionButton('View your current live city →', viewHref, 'ghost'));
    const link = el('p', 'build-status__link', 'Link to this page (open it on any device): ');
    const a = el('a', null, pageUrl);
    a.href = pageUrl;
    link.append(a);

    body.replaceChildren(
      el('h2', 'build-status__title', title),
      ...(note ? [el('p', 'build-status__note', note)] : []),
      renderSteps(status),
      ...renderLayers(status),
      ...(actions.childElementCount ? [actions] : []),
      link,
    );
  }

  async function poll() {
    if (stopped) return;
    try {
      const status = await apiClient.getStatus(cityId, token);
      if (stopped) return; // deleted while this request was in flight
      const wasBuilding = lastStatus?.status === 'processing';
      lastStatus = status;
      render(status);
      if (wasBuilding !== (status.status === 'processing') && danger.querySelector('.app-page__btn--danger:only-child')) renderDeleteButton(); // relabel "Stop and delete" <-> "Delete"
      if (status.status === 'processing') timer = setTimeout(poll, POLL_BUILDING_MS);
    } catch (err) {
      if (err.status === 404) {
        showGone('This city no longer exists', 'It was deleted (perhaps from another device), or this link is incomplete.');
        return;
      }
      body.replaceChildren(
        el('h2', 'build-status__title', 'Could not load the build status'),
        el('p', 'build-status__note', `${err.message ?? err}. Trying again shortly…`),
      );
      timer = setTimeout(poll, POLL_RETRY_MS);
    }
  }

  poll();
  return { stop() { stopped = true; clearTimeout(timer); } };
}
