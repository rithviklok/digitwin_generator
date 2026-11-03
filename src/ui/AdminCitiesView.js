// ===================================================================
// AdminCitiesView -- the admin page (?admin=<token>): every uploaded
// city, newest first, with its status, a way to open it as its
// visitors see it, its build log, and Delete.
//
// There is no approval queue: a city goes live the moment its build
// succeeds. This page is for keeping an eye on what has been uploaded
// to the server and removing what shouldn't be there -- Delete is the
// admin's one lever, so it asks first and says what it will remove.
//
// Markup lives in index.html (#adminCitiesView and children), styled
// by styles.css's .admin-cities rules. Everything shown is built with
// textContent: city names are whatever an uploader typed.
// ===================================================================
import { adminApi } from '../api/client.js';
import { fileSizeText } from './FileDrop.js';

const PAGE_SIZE = 50;
const FILTERS = [
  { status: null, label: 'All' },
  { status: 'live', label: 'Live' },
  { status: 'processing', label: 'Building' },
  { status: 'failed', label: 'Failed' },
  { status: 'purged', label: 'Cleared' },
];
const STATUS_TEXT = { live: 'Live', processing: 'Building…', failed: 'Build failed', purged: 'Files cleared' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, kind, onClick) {
  const b = el('button', `app-page__btn app-page__btn--${kind}`, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const when = (iso) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function mountAdminCitiesView({ token }) {
  const $ = (id) => document.getElementById(id);
  const listEl = $('adminCitiesList'), summaryEl = $('adminCitiesSummary'), filtersEl = $('adminCitiesFilters'), moreBtn = $('btnAdminCitiesMore');
  const intro = summaryEl.textContent;
  $('adminCitiesView').hidden = false;

  let status = null; // the filter in force
  let loaded = 0;    // how many of `total` are on the page
  let total = 0;
  let request = 0;   // guards against a slow earlier response landing after a newer one

  const cityHref = (id, extra = '') => `?admin=${encodeURIComponent(token)}&city=${encodeURIComponent(id)}${extra}`;

  function renderFilters() {
    filtersEl.replaceChildren(...FILTERS.map((f) => {
      const b = el('button', 'admin-cities__filter', f.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(f.status === status));
      b.addEventListener('click', () => { status = f.status; renderFilters(); load({ reset: true }); });
      return b;
    }));
  }

  function renderSummary(note = '') {
    const which = FILTERS.find((f) => f.status === status);
    const counted = status ? `${total} ${which.label.toLowerCase()}` : `${total} ${total === 1 ? 'city' : 'cities'}`;
    summaryEl.textContent = `${note}${note ? ' ' : ''}${counted}. ${intro}`;
  }

  function cityRow(city) {
    const row = el('article', 'admin-city');
    const head = el('div', 'admin-city__head');
    head.append(el('strong', 'admin-city__name', city.displayName), el('span', `status-pill status-pill--${city.status}`, STATUS_TEXT[city.status] ?? city.status));
    const facts = [city.id, `uploaded ${when(city.createdAt)}`, `buildings file ${fileSizeText(city.inputBytes)}`, `from ${city.uploader.replace(/^ip:/, '')}`];
    row.append(head, el('div', 'admin-city__facts', facts.join(' · ')));

    if (city.status === 'failed') {
      row.append(el('p', 'admin-city__note', `Why: ${city.failureReason ?? 'see the build log.'}${city.isLive ? ' An earlier build of this city is still live.' : ''}`));
    } else if (city.status === 'processing' && city.isLive) {
      row.append(el('p', 'admin-city__note', 'A revision is building. The earlier build stays live until it finishes.'));
    }

    const actions = el('div', 'admin-city__actions');
    function showActions() {
      const links = [];
      if (city.isLive) {
        const open = el('a', 'app-page__btn app-page__btn--ghost', 'Open');
        open.href = cityHref(city.id);
        links.push(open);
      }
      const log = el('a', 'app-page__btn app-page__btn--ghost', 'Build log');
      log.href = cityHref(city.id, '&logs=1');
      actions.replaceChildren(...links, log, button('Delete…', 'danger', confirmDelete));
    }
    function confirmDelete() {
      const building = city.status === 'processing';
      const yes = button('Delete permanently', 'danger-solid', async () => {
        yes.disabled = no.disabled = true;
        yes.textContent = building ? 'Stopping the build and deleting…' : 'Deleting…';
        try {
          const { freedBytes } = await adminApi.deleteCity(token, city.id);
          row.remove();
          total--; loaded--;
          renderSummary(`Deleted “${city.displayName}” (${fileSizeText(freedBytes)} freed).`);
          if (!listEl.childElementCount) load({ reset: true });
        } catch (err) {
          actions.replaceChildren(el('p', 'admin-city__confirm', `Couldn’t delete: ${err.message ?? err}`), button('Try again', 'danger', confirmDelete), button('Cancel', 'ghost', showActions));
        }
      });
      const no = button('Keep it', 'ghost', showActions);
      const live = city.isLive ? ' It is live right now, and its link will stop working for everyone.' : '';
      actions.replaceChildren(
        el('p', 'admin-city__confirm', `Delete “${city.displayName}”? This ${building ? 'stops its build and ' : ''}permanently removes everything stored for it: the uploaded files, the downloaded map data and the built 3D city.${live} This can’t be undone.`),
        yes, no,
      );
      no.focus();
    }
    showActions();
    row.append(actions);
    return row;
  }

  function message(text, retry = false) {
    const note = el('p', 'admin-cities__message', text);
    listEl.replaceChildren(note, ...(retry ? [button('Try again', 'ghost', () => load({ reset: true }))] : []));
    moreBtn.hidden = true;
  }

  async function load({ reset }) {
    const mine = ++request;
    if (reset) { loaded = 0; message('Loading…'); }
    moreBtn.disabled = true;
    try {
      const page = await adminApi.listCities(token, { status, limit: PAGE_SIZE, offset: loaded });
      if (mine !== request) return;
      if (reset) listEl.replaceChildren();
      total = page.total;
      loaded += page.cities.length;
      listEl.append(...page.cities.map(cityRow));
      if (!loaded) message(status ? 'No cities with this status.' : 'No cities have been uploaded yet.');
      renderSummary();
      moreBtn.hidden = loaded >= total;
    } catch (err) {
      if (mine !== request) return;
      // The one mistake worth explaining: the link itself is the login.
      if (err.status === 401) message('This admin link isn’t valid. The token in the address (?admin=…) has to match ADMIN_TOKEN in the server’s .env file.');
      else message(`Could not load the cities: ${err.message ?? err}`, true);
    } finally {
      moreBtn.disabled = false;
    }
  }

  moreBtn.addEventListener('click', () => load({ reset: false }));
  renderFilters();
  load({ reset: true });
}
