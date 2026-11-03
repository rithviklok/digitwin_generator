// ===================================================================
// CoverageView -- the viewer's "What's on this map" panel: whatever is
// missing, degraded, or not yet built for a given city must be visible
// in the UI itself, not just quietly absent from the render. Computed
// straight off the already-loaded CityConfig, not hand-maintained.
//
// Written for a visitor, not a developer: the list is the map's layers
// in plain words and where each came from. What only someone maintaining
// the city would ask about (label lists, colours, the raw build counts)
// sits behind "Details".
//
// Markup lives in index.html (#coveragePanel and children), styled by
// styles.css's .coverage-panel rules. Mounted once per loaded city
// (main.js calls this right after engine.boot() resolves, for every
// "content" mode: the default city, an uploaded city, admin view).
// ===================================================================
import { LAYER_ROLES, layersWithRole } from '../config/city-schema.js';
import { ROLE_LABELS, OSM_ROLES, MUNICIPAL_ROLES } from '../config/layer-labels.js';

const count = (n) => n.toLocaleString('en-IN');

function layerStatus(layer, role) {
  if (!layer) return { text: 'Not included', missing: true };
  if (layer.source === 'osm-derived') {
    // OSM maps roads as centre-lines; their surfaces are buffered from a
    // per-class width table (server/lib/osmSplitter.js), so only roads are an
    // approximation -- every other OSM layer is the mapped geometry itself.
    return role === LAYER_ROLES.ROADS
      ? { text: 'From OpenStreetMap, widths estimated', degraded: true }
      : { text: 'From OpenStreetMap' };
  }
  return { text: 'Included' };
}

/** The map's layers, in plain words. `stats` (the buildings manifest's sourceStats) arrives a moment later and fills in the building count. */
function layerRows(cityConfig, stats) {
  const buildings = { label: 'Buildings', text: stats ? `${count(stats.buildingCount)} in 3D` : 'In 3D' };
  const layers = [...OSM_ROLES, ...MUNICIPAL_ROLES].map((role) => ({
    label: ROLE_LABELS[role], ...layerStatus(layersWithRole(cityConfig, role)[0] ?? null, role),
  }));
  return [buildings, ...layers];
}

/** What a maintainer of the city would ask about. None of it counts as "missing": each is a valid state for a city to be in. */
function detailRows(cityConfig, stats) {
  const yesNo = (present, no = 'None') => (present ? 'Included' : no);
  const rows = [
    // Building names come from a Kanpur-only offline step (extract-building-labels.mjs), so an uploaded city never has them.
    { label: 'Building name labels', text: yesNo(layersWithRole(cityConfig, LAYER_ROLES.BUILDING_LABELS).length > 0, 'Not available for uploaded cities') },
    { label: 'Hand-picked place labels', text: yesNo((cityConfig.labels?.orientationAllowlist?.length ?? 0) > 0) },
    { label: 'Railway station list', text: yesNo((cityConfig.labels?.railwayStationNames?.length ?? 0) > 0, 'None (stations are labelled as metro)') },
    { label: 'Colours', text: cityConfig.palette != null ? 'Custom' : 'Standard' },
    { label: 'Railway line colours', text: Object.keys(cityConfig.railway?.lineColors ?? {}).length > 0 ? 'Custom' : 'Standard' },
  ];
  if (stats) {
    rows.push({ label: 'Buildings in the source file', text: count(stats.buildingCount + stats.skippedCount) });
    if (stats.skippedCount > 0) rows.push({ label: 'Left out (no usable height)', text: count(stats.skippedCount) });
    if (stats.roofFailedCount > 0) rows.push({ label: 'Drawn with a flat roof', text: count(stats.roofFailedCount) });
  }
  return rows;
}

function rowEl(row) {
  const item = document.createElement('div');
  item.className = 'search-result-item coverage-panel__row';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = row.label;
  const statusSpan = document.createElement('span');
  statusSpan.className = 'coverage-panel__status' + (row.missing ? ' is-missing' : row.degraded ? ' is-degraded' : '');
  statusSpan.textContent = row.text;
  item.append(nameSpan, statusSpan);
  return item;
}

/**
 * The way to add what's missing, for the city's own uploader only (see
 * mountCoverageView): a revision of the city, which keeps everything it has.
 * @param {string|null} reviseHref
 * @param {boolean} anyMissing
 */
function addFilesEl(reviseHref, anyMissing) {
  if (!reviseHref) return [];
  const wrap = document.createElement('div');
  wrap.className = 'coverage-panel__add';
  const note = document.createElement('p');
  note.textContent = anyMissing
    ? 'City outline, wards, zones and landmarks come from your municipal corporation, not OpenStreetMap. Add them, or replace any layer with better data, by revising the city. It stays live meanwhile.'
    : 'Replace any layer with better data by revising the city. It stays live meanwhile.';
  const link = document.createElement('a');
  link.className = 'app-page__btn app-page__btn--ghost coverage-panel__add-btn';
  link.href = reviseHref;
  link.textContent = 'Add files to this city';
  wrap.append(note, link);
  return [wrap];
}

function render(body, cityConfig, stats, detailsOpen, reviseHref) {
  const details = document.createElement('details');
  details.className = 'coverage-panel__details';
  details.open = detailsOpen;
  const summary = document.createElement('summary');
  summary.textContent = 'Details';
  details.append(summary, ...detailRows(cityConfig, stats).map(rowEl));
  const rows = layerRows(cityConfig, stats);
  body.replaceChildren(...rows.map(rowEl), ...addFilesEl(reviseHref, rows.some((r) => r.missing)), details);
}

/** Fetches the buildings-3d layer's manifest.json purely for sourceStats -- already fetched moments earlier by BuildingLayer.js for the same URL, so this rides the browser's HTTP cache rather than costing a real second download. */
async function fetchSourceStats(cityConfig) {
  const buildingsLayer = layersWithRole(cityConfig, LAYER_ROLES.BUILDINGS_3D)[0];
  if (!buildingsLayer?.url.endsWith('manifest.json')) return null; // legacy (non-tiled) source -- no manifest to read stats from
  try {
    const res = await fetch(buildingsLayer.url);
    if (!res.ok) return null;
    const manifest = await res.json();
    return manifest.sourceStats ?? null;
  } catch {
    return null; // coverage info is a nice-to-have -- never let this break the panel
  }
}

/**
 * @param {{cityConfig: object, reviseHref?: string|null}} opts
 *   reviseHref: the city's revise form, given only when this browser is the
 *   city's uploader's (main.js: it's in My cities) and the viewer isn't
 *   embedded -- a visitor holding a shared link gets no edit button.
 */
export function mountCoverageView({ cityConfig, reviseHref = null }) {
  const panel = document.getElementById('coveragePanel');
  const body = document.getElementById('coverageBody');
  const badge = document.getElementById('coverageBadge');
  const btnOpen = document.getElementById('btnCoverage');
  const btnClose = document.getElementById('btnCoverageClose');
  if (!panel || !body || !btnOpen) return; // defensive -- coverage is informational, never block boot on it

  render(body, cityConfig, null, false, reviseHref);

  // The top-bar pill counts only real map layers someone could still add --
  // not the maintainer's details, which are absent from every uploaded city.
  const missingCount = layerRows(cityConfig, null).filter((r) => r.missing).length;
  badge.hidden = missingCount === 0;
  if (missingCount > 0) badge.textContent = `△ ${missingCount} layer${missingCount === 1 ? '' : 's'} not included`;

  const setOpen = (open) => {
    panel.hidden = !open;
    btnOpen.setAttribute('aria-pressed', String(open));
  };
  btnOpen.addEventListener('click', () => setOpen(panel.hidden));
  badge.addEventListener('click', () => setOpen(true));
  btnClose?.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); btnOpen.focus(); } });

  fetchSourceStats(cityConfig).then((stats) => {
    if (stats) render(body, cityConfig, stats, body.querySelector('details')?.open ?? false, reviseHref);
  });
}
