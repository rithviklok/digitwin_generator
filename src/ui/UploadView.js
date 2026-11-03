// ===================================================================
// UploadView -- the three-step wizard (?upload=1, or ?upload=1&revise=
// <cityId>&t=<token> for a revision):
//   1. Name & area -- find the place (search, or pan/zoom a normal
//      movable map), then press "Draw area" and drag the bounding box.
//      Hand-rolled on Leaflet (no leaflet-draw dependency: one rectangle
//      synced to 4 number fields is the entire feature).
//   2. Connect data -- the buildings (required: downloaded by the server
//      from Google Open Buildings for the drawn area, the default, or the
//      uploader's own file) and the optional municipal layers.
//      Everything OpenStreetMap has (roads, railway,
//      amenities, land use, vegetation, water, localities) is downloaded
//      by the server for the drawn area -- unless the uploader replaces a
//      layer with their own file (e.g. a municipal road survey), or, when
//      the server can't reach OSM, attaches one OSM export they made with
//      the pre-filled Overpass Turbo link. One "Optional files" section, a
//      compact row per file: municipal layers shown, OSM replacements and
//      the export folded under "Replace an OpenStreetMap layer".
//   3. Review & build -- a summary + generation settings, then Build.
//      After submitting, the SAME step becomes the live progress page
//      (BuildStatus.js): ?status=1&city=<id>&t=<token> re-opens it any
//      time, on any device, since everything it shows is server-side.
// Full-page (.app-page) -- there's no live scene to float this over.
// ===================================================================
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LAYER_ROLES, TILE_SIZE_RANGE_M } from '../config/city-schema.js';
import { ROLE_LABELS, OSM_ROLES } from '../config/layer-labels.js';
import { apiClient } from '../api/client.js';
import { addMyCity } from '../api/myCities.js';
import { getDraft, saveDraft, clearDraft } from '../api/uploadDraft.js';
import { mountBuildStatus } from './BuildStatus.js';
import { enhanceFileInput } from './FileDrop.js';
import { OSM_QUERY_GROUPS, buildOsmQuery } from '../config/osm-query.js';

/** Municipal data OpenStreetMap doesn't reliably have. Notes are one short line each: the format in full is in DATA_SOURCES.md. */
const MUNICIPAL_SLOTS = [
  { field: 'adminWards', role: LAYER_ROLES.ADMIN_WARDS, label: 'Wards', note: 'Polygons, each with a name or ward number.' },
  { field: 'adminZones', role: LAYER_ROLES.ADMIN_ZONES, label: 'Zones', note: 'Polygons, one per zone.' },
  { field: 'landmarks', role: LAYER_ROLES.LANDMARKS, label: 'Landmarks', note: 'Points, each with a name.' },
  { field: 'cityBoundary', role: LAYER_ROLES.CITY_BOUNDARY, label: 'City outline', note: 'The municipal boundary, one polygon.' },
];
/** Optional per-layer replacements for what OpenStreetMap would give (server: routes/uploads.js, normalized by osmSplitter.js's createLayerNormalizer). */
const OVERRIDE_SLOTS = [
  { field: 'roads', role: LAYER_ROLES.ROADS, note: 'Road surfaces, or centre-lines (widened by their `width` or `lanes`).' },
  { field: 'railway', role: LAYER_ROLES.RAILWAY, note: 'Track lines.' },
  { field: 'amenities', role: LAYER_ROLES.AMENITIES, note: 'Named points; stations as `amenity: station`.' },
  { field: 'localities', role: LAYER_ROLES.LOCALITIES, note: 'Named points: neighbourhood / mohalla labels.' },
  { field: 'landuse', role: LAYER_ROLES.LANDUSE, note: 'Polygons with a `kind` (residential, industrial…).' },
  { field: 'vegetation', role: LAYER_ROLES.VEGETATION, note: 'Polygons; forest, wood, mangrove and park get trees.' },
  { field: 'water', role: LAYER_ROLES.WATER, note: 'Rivers, lakes, tanks, sea. Replaces all of OSM’s water.' },
].map((s) => ({ ...s, label: ROLE_LABELS[s.role] }));
const GEN_DEFAULTS = { tileSizeM: 2000, minRenderHeightM: 1.5, windowMinHeightM: 12 };
const GEN_FIELD_IDS = Object.keys(GEN_DEFAULTS);
const FILE_FIELD_IDS = ['fileBuildings', 'fileOsmExport', ...[...MUNICIPAL_SLOTS, ...OVERRIDE_SLOTS].map((s) => `file-${s.field}`)];
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_TURBO_URL = 'https://overpass-turbo.eu/';

const $ = (id) => document.getElementById(id);

/** Where the buildings come from: 'google' (the server downloads the drawn area's from Google Open Buildings) or 'file' (the uploader's own). */
const buildingsSource = () => ($('buildingsSourceFile').checked ? 'file' : 'google');
/** The height property Google Open Buildings' buildings arrive with (scripts/fetch-open-buildings.mjs). */
const GOOGLE_HEIGHT_PROPERTY = 'mean';

/** Selects a buildings source and shows the file slot only for the uploader's own file. */
function showBuildingsSource(source) {
  $(source === 'file' ? 'buildingsSourceFile' : 'buildingsSourceGoogle').checked = true;
  $('buildingsFileSlot').hidden = source !== 'file';
}

/** Reads every autosaveable field into a plain object -- see uploadDraft.js for why file CONTENTS never appear here, only names. */
function collectDraft(step) {
  const fileNames = {};
  for (const id of FILE_FIELD_IDS) {
    const name = $(id)?.files[0]?.name;
    if (name) fileNames[id] = name;
  }
  return {
    step,
    displayName: $('uploadDisplayName').value,
    bbox: { west: $('bboxWest').value, south: $('bboxSouth').value, east: $('bboxEast').value, north: $('bboxNorth').value },
    buildingsSource: buildingsSource(),
    heightProperty: heightProperty(),
    generation: { tileSizeM: $('tileSizeM').value, minRenderHeightM: $('minRenderHeightM').value, windowMinHeightM: $('windowMinHeightM').value },
    fileNames,
  };
}

/** @returns {boolean} whether any field actually had a file name to remind the user about */
function restoreDraftFields(draft) {
  $('uploadDisplayName').value = draft.displayName ?? '';
  $('bboxWest').value = draft.bbox?.west ?? '';
  $('bboxSouth').value = draft.bbox?.south ?? '';
  $('bboxEast').value = draft.bbox?.east ?? '';
  $('bboxNorth').value = draft.bbox?.north ?? '';
  // A draft from before the choice existed had a buildings file, if it had anything.
  showBuildingsSource(draft.buildingsSource ?? (draft.fileNames?.fileBuildings ? 'file' : 'google'));
  rememberHeightProperty(draft.heightProperty ?? '');
  if (draft.generation) {
    $('tileSizeM').value = draft.generation.tileSizeM ?? GEN_DEFAULTS.tileSizeM;
    $('minRenderHeightM').value = draft.generation.minRenderHeightM ?? GEN_DEFAULTS.minRenderHeightM;
    $('windowMinHeightM').value = draft.generation.windowMinHeightM ?? GEN_DEFAULTS.windowMinHeightM;
  }
  let anyFileNames = false;
  for (const [id, name] of Object.entries(draft.fileNames ?? {})) {
    // A draft saved before a slot existed/was renamed simply finds no status element -- skipped.
    const statusEl = $(id === 'fileBuildings' ? 'statusBuildings' : id === 'fileOsmExport' ? 'statusOsmExport' : `status-${id.slice('file-'.length)}`);
    if (statusEl) { statusEl.textContent = `Previously attached: ${name}. Please choose it again.`; anyFileNames = true; }
  }
  return anyFileNames;
}

/**
 * One compact row per optional file: its name and a one-line note on the
 * left, a small file button on the right (FileDrop.js, compact), and under
 * them the slot's status (a kept file, on a revision). The section around
 * them has the one "Where do I get these?" link (index.html).
 * Labels and notes are this file's own constants, never user input.
 */
function buildSlots(container, slots) {
  container.replaceChildren(...slots.map(({ field, label, note }) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `
      <div class="file-row__text">
        <label class="file-row__label" for="file-${field}">${label}</label>
        <span class="file-row__note">${note.replace(/`([^`]+)`/g, '<code>$1</code>')}</span>
      </div>
      <input type="file" id="file-${field}" accept=".geojson,.json" />
      <span class="upload-view__slot-status file-row__status" id="status-${field}"></span>
    `;
    return row;
  }));
}

/** Number-valued property names found at the start of the chosen buildings file (null = not inspected / unreadable). */
let buildingNumberProps = null;
/** Common names for a building's height, most specific first. `mean` is Google Open Buildings 2.5D's (Kanpur's own source). */
const HEIGHT_NAME_GUESSES = ['height', 'height_m', 'building:height', 'mean', 'bldg_ht', 'ht'];
/** The height property from a restored draft or the previous submission -- what the control falls back to while no file is attached to read choices from. */
let savedHeightProperty = '';

/** The height property currently chosen (dropdown) or typed (text box), whichever of the two is showing. */
function heightProperty() {
  const select = $('heightProperty');
  return (select.hidden ? $('heightPropertyText').value : select.value).trim();
}

/** The control the uploader is actually looking at -- where an error about the height property belongs. */
const heightControlId = () => ($('heightProperty').hidden ? 'heightPropertyText' : 'heightProperty');

/**
 * The height-property control. With the file's number properties known,
 * it is a dropdown of exactly those -- nothing to mistype. When they
 * aren't (a draft or revision with no file attached on this page, or a
 * file whose start couldn't be read), it is a text box, so a name can
 * still be given. With nothing attached and nothing saved, it waits.
 * @param {string[]|null} props - the file's number properties; [] = file read, none found; null = no file to read
 * @param {string} [preferred] - kept selected when it's among the choices
 */
function showHeightChoices(props, preferred = heightProperty()) {
  const select = $('heightProperty'), text = $('heightPropertyText');
  if (props?.length) {
    const pick = props.includes(preferred) ? preferred : (HEIGHT_NAME_GUESSES.find((n) => props.includes(n)) ?? '');
    select.replaceChildren(...(pick ? [] : [new Option('Choose one…', '')]), ...props.map((p) => new Option(p, p)));
    select.value = pick;
    select.disabled = false;
  } else if (!props && !preferred) {
    select.replaceChildren(new Option('Attach the buildings file first', ''));
    select.disabled = true;
  }
  const typed = !props?.length && Boolean(props || preferred);
  if (typed) text.value = preferred;
  select.hidden = typed;
  text.hidden = !typed;
}

function rememberHeightProperty(name) {
  savedHeightProperty = name;
  showHeightChoices(null, name);
}

/**
 * Reads only the start of the chosen buildings file -- instant even for a
 * 300 MB file -- to list its number-valued properties and offer them as the
 * height property. A wrong name there used to surface only after the whole
 * upload, as a build that never finished.
 */
async function inspectBuildingsFile(file) {
  const statusEl = $('statusBuildings');
  buildingNumberProps = null;
  if (!file) {
    statusEl.textContent = $('fileBuildings').dataset.hasExisting === '1' ? ON_FILE_BUILDINGS : '';
    showHeightChoices(null, savedHeightProperty);
    return;
  }
  const head = await file.slice(0, 512 * 1024).text();
  const samples = [...head.matchAll(/"properties"\s*:\s*(\{[^{}]*\})/g)].slice(0, 50)
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
  if (!samples.length) {
    statusEl.textContent = 'Couldn’t find building properties at the start of this file. Is it GeoJSON?';
    showHeightChoices([]);
    return;
  }
  buildingNumberProps = [...new Set(samples.flatMap((p) => Object.keys(p).filter((k) => p[k] !== null && p[k] !== '' && Number.isFinite(Number(p[k])))))];
  statusEl.textContent = buildingNumberProps.length ? '' : 'This file’s buildings have no number properties, so there is nothing to read a height from.';
  showHeightChoices(buildingNumberProps);
}

/** Keeps the Overpass Turbo link pointing at the query for the area currently drawn -- the same query the server itself would run. */
function updateTurboLink() {
  const link = $('btnOverpassTurbo');
  if (!bboxComplete()) {
    link.setAttribute('aria-disabled', 'true');
    link.removeAttribute('href');
    link.title = 'Draw the area in step 1 first';
    return;
  }
  const query = buildOsmQuery(Object.keys(OSM_QUERY_GROUPS), readBbox());
  link.href = `${OVERPASS_TURBO_URL}?Q=${encodeURIComponent(query)}&R`; // R = run it straight away
  link.removeAttribute('aria-disabled');
  link.title = '';
}

function initMap() {
  // A normal, movable map -- dragging pans. Drawing the area is a separate,
  // explicit mode (wireBboxDraw), so finding the city and marking it never
  // fight over the same mouse gesture.
  const map = L.map('uploadMap').setView([22.0, 79.0], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18,
  }).addTo(map);
  return map;
}

/**
 * "Draw area" mode: while on, map dragging is off and a drag draws the
 * rectangle; releasing finishes it and drops back to panning. Esc cancels.
 * Mouse or trackpad only, like the rest of the app (no touch drawing).
 * @param {L.Map} map
 * @param {() => void} onDrawn - called after a new box lands in the fields (draft autosave)
 */
function wireBboxDraw(map, onDrawn) {
  const fields = { west: $('bboxWest'), south: $('bboxSouth'), east: $('bboxEast'), north: $('bboxNorth') };
  const toggle = $('btnDrawArea');
  const container = map.getContainer();
  const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f4703a';
  let rect = null;
  let dragStart = null;
  let drawing = false;

  function drawRect(bounds) {
    if (rect) rect.setBounds(bounds);
    else rect = L.rectangle(bounds, { color, weight: 2, interactive: false }).addTo(map);
  }
  function setDrawing(on) {
    drawing = on;
    dragStart = null;
    toggle.setAttribute('aria-pressed', String(on));
    toggle.textContent = on ? 'Drag across the city…' : rect ? '▭ Redraw area' : '▭ Draw area';
    container.classList.toggle('is-drawing', on);
    if (on) map.dragging.disable(); else map.dragging.enable();
  }
  function setRectFromFields() {
    if (!bboxComplete()) return;
    const { west: w, south: s, east: e, north: n } = readBbox();
    drawRect(L.latLngBounds([s, w], [n, e]));
    setDrawing(false); // refresh the button label (Draw -> Redraw)
  }
  function setFieldsFromBounds(bounds) {
    fields.west.value = bounds.getWest().toFixed(5);
    fields.south.value = bounds.getSouth().toFixed(5);
    fields.east.value = bounds.getEast().toFixed(5);
    fields.north.value = bounds.getNorth().toFixed(5);
  }

  toggle.addEventListener('click', () => setDrawing(!drawing));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawing) setDrawing(false); });
  map.on('mousedown', (e) => {
    if (!drawing) return;
    e.originalEvent.preventDefault(); // with map dragging off, the browser would otherwise treat this drag as a text selection
    dragStart = e.latlng;
  });
  map.on('mousemove', (e) => { if (drawing && dragStart) drawRect(L.latLngBounds(dragStart, e.latlng)); });
  map.on('mouseup', (e) => {
    if (!drawing || !dragStart) return;
    const bounds = L.latLngBounds(dragStart, e.latlng);
    dragStart = null;
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) return; // a click, not a drag -- stay in draw mode
    drawRect(bounds);
    setFieldsFromBounds(bounds);
    setDrawing(false);
    onDrawn();
  });
  for (const input of Object.values(fields)) input.addEventListener('change', setRectFromFields);

  return {
    /** Puts a known bbox (draft / revision) in the fields, on the map, and in view. */
    showBbox(bbox) {
      setFieldsFromBounds(L.latLngBounds([bbox.south, bbox.west], [bbox.north, bbox.east]));
      setRectFromFields();
      if (rect) map.fitBounds(rect.getBounds(), { maxZoom: 12 });
    },
  };
}

/**
 * Place search: OpenStreetMap's Nominatim geocoder, queried on submit
 * (Enter / Search) -- never per keystroke: Nominatim's usage policy
 * forbids client-side autocomplete against the public server. The map
 * flies to the best match straight away; other matches are listed to
 * switch to.
 * @param {L.Map} map
 * @param {(place: object) => void} onPick
 */
function wirePlaceSearch(map, onPick) {
  const form = $('placeSearch');
  const input = $('placeSearchInput');
  const list = $('placeSearchResults');
  let results = [];
  let current = -1;

  function message(text) {
    const msg = document.createElement('div');
    msg.className = 'place-search__msg';
    msg.textContent = text;
    list.replaceChildren(msg);
    list.hidden = false;
  }
  function renderList() {
    list.hidden = results.length < 2; // one match needs no list -- the map already went there
    list.replaceChildren(...results.map((r, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-current', String(i === current));
      // A city search typically returns the city AND its district/sub-divisions
      // under the same name -- the place type is what tells them apart.
      const [first, ...rest] = r.display_name.split(', ');
      btn.append(r.name || first);
      const detail = document.createElement('small');
      detail.textContent = ` — ${(r.addresstype ?? r.type ?? '').replace(/_/g, ' ')} · ${rest.join(', ')}`;
      btn.append(detail);
      btn.addEventListener('click', () => pick(i));
      return btn;
    }));
  }
  function pick(i) {
    current = i;
    const [south, north, west, east] = results[i].boundingbox.map(Number);
    map.flyToBounds([[south, west], [north, east]], { maxZoom: 13, duration: 0.8 });
    renderList();
    onPick(results[i]);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    message('Searching…');
    try {
      const url = `${NOMINATIM_URL}?${new URLSearchParams({ q, format: 'jsonv2', limit: '5' })}`;
      const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      results = await res.json();
    } catch {
      message('Place search is unavailable right now. Pan and zoom the map to find the city instead.');
      return;
    }
    if (!results.length) { message(`Nothing found for “${q}”. Try the city's name with its state or country.`); return; }
    pick(0);
  });
}

const BBOX_FIELD_IDS = ['bboxWest', 'bboxSouth', 'bboxEast', 'bboxNorth'];

function readBbox() {
  return { west: Number($('bboxWest').value), south: Number($('bboxSouth').value), east: Number($('bboxEast').value), north: Number($('bboxNorth').value) };
}

/** All four fields hold numbers. Checked on the raw strings: Number('') is 0, a perfectly valid-looking coordinate. */
function bboxComplete() {
  return BBOX_FIELD_IDS.every((id) => $(id).value.trim() !== '' && Number.isFinite(Number($(id).value)));
}

function showStep(n) {
  for (let i = 1; i <= 3; i++) {
    document.querySelector(`[data-step-panel="${i}"]`).hidden = i !== n;
    const pill = document.querySelector(`[data-step="${i}"]`);
    pill.classList.toggle('is-active', i === n);
    pill.classList.toggle('is-done', i < n);
  }
  $('btnUploadBack').hidden = n === 1;
  $('btnUploadNext').hidden = n === 3;
  $('btnUploadSubmit').hidden = n !== 3;
}

/**
 * Everything wrong with step `n`, each problem tied to the control it's
 * about: `anchor` is outlined and gets the message under it, `focus` (the
 * anchor unless given) gets the cursor.
 * @returns {Array<{anchor: string, focus?: string, message: string}>} element ids; empty = the step is fine
 */
function validateStep(n) {
  const problems = [];
  if (n === 1) {
    const bbox = readBbox();
    if (!$('uploadDisplayName').value.trim()) problems.push({ anchor: 'uploadDisplayName', message: 'Give your city a name.' });
    if (!bboxComplete()) problems.push({ anchor: 'uploadMapWrap', focus: 'btnDrawArea', message: 'Mark the city: press “Draw area” and drag across it on the map, or fill in all four fields below.' });
    else if (bbox.west >= bbox.east || bbox.south >= bbox.north) problems.push({ anchor: 'bboxFields', focus: 'bboxWest', message: 'This area isn’t valid: west must be less than east, and south less than north.' });
  }
  if (n === 2 && buildingsSource() === 'file') { // from Google Open Buildings there is nothing to attach or choose
    const hasExisting = $('fileBuildings').dataset.hasExisting === '1';
    if (!$('fileBuildings').files[0] && !hasExisting) problems.push({ anchor: 'drop-fileBuildings', focus: 'fileBuildings', message: 'Attach your buildings file, or choose “Get them for me from Google Open Buildings” above.' });
    const name = heightProperty();
    if (!name) {
      // With no file there's nothing to choose from yet -- the error above already says what to do first.
      if ($('fileBuildings').files[0] || hasExisting) problems.push({ anchor: heightControlId(), message: 'Choose the property that holds each building’s height.' });
    } else if (buildingNumberProps?.length && !buildingNumberProps.includes(name)) {
      problems.push({ anchor: heightControlId(), message: `Your buildings file has no number property called “${name}”. Its number properties: ${buildingNumberProps.join(', ')}.` });
    }
  }
  if (n === 3) {
    // Checked before anything is sent: the server refuses the same values,
    // but only once the whole upload -- possibly gigabytes -- has arrived.
    const tile = Number($('tileSizeM').value);
    const { min, max } = TILE_SIZE_RANGE_M;
    if (!Number.isFinite(tile) || tile < min || tile > max) {
      problems.push({ anchor: 'tileSizeM', message: `Tile size must be from ${min.toLocaleString('en-IN')} to ${max.toLocaleString('en-IN')} m (the default, 2,000, suits almost every city).` });
    }
    for (const id of ['minRenderHeightM', 'windowMinHeightM']) {
      const v = Number($(id).value);
      if (!Number.isFinite(v) || v <= 0) problems.push({ anchor: id, message: 'This must be a positive number of metres.' });
    }
  }
  return problems;
}

function clearFieldErrors() {
  const view = $('uploadView');
  for (const el of view.querySelectorAll('.field-error')) el.remove();
  for (const el of view.querySelectorAll('.is-invalid')) el.classList.remove('is-invalid');
  for (const el of view.querySelectorAll('[aria-invalid]')) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
}

/** Puts each problem under its own control, outlined, and moves the cursor to the first. */
function showFieldErrors(problems) {
  clearFieldErrors();
  problems.forEach(({ anchor, focus = anchor, message }, i) => {
    const anchorEl = $(anchor), focusEl = $(focus);
    const note = document.createElement('p');
    note.className = 'field-error';
    note.id = `${anchor}-error`;
    note.setAttribute('role', 'alert');
    note.textContent = message;
    anchorEl.classList.add('is-invalid');
    anchorEl.after(note);
    focusEl.setAttribute('aria-invalid', 'true');
    focusEl.setAttribute('aria-describedby', note.id);
    if (i === 0) {
      focusEl.focus({ preventScroll: true });
      anchorEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}

/** "12.4 × 9.8 km" for a lon/lat box -- a sanity check that the drawn area is city-sized. */
function areaText(b) {
  const midLat = ((b.south + b.north) / 2) * (Math.PI / 180);
  const w = (b.east - b.west) * 111.32 * Math.cos(midLat);
  const h = (b.north - b.south) * 110.57;
  return `${w.toFixed(1)} × ${h.toFixed(1)} km`;
}

/** "2000 m tiles · buildings from 1.5 m · windows from 12 m", and whether those are the defaults. */
function settingsText(s) {
  const isDefault = GEN_FIELD_IDS.every((k) => Number(s[k]) === GEN_DEFAULTS[k]);
  return `${s.tileSizeM} m tiles · buildings from ${s.minRenderHeightM} m · windows from ${s.windowMinHeightM} m${isDefault ? ' (the defaults)' : ''}`;
}

/**
 * Step 3's "what's about to be built" list -- also the read-only record
 * of what WAS submitted, once the page is tracking a build. The settings
 * are always a row here, so they're never applied unseen even with the
 * "Advanced settings" form folded away.
 * @param {{displayName: string, bbox: object, buildingsSource?: string, buildingsFile: string|null, heightProperty: string,
 *   ownFiles: Array<{role: string, label: string, file: string}>, osmExport: string|null,
 *   settings?: {tileSizeM: number, minRenderHeightM: number, windowMinHeightM: number}}} s
 */
function renderSummary(s) {
  const replaced = new Set(s.ownFiles.map((f) => f.role));
  const fromOsm = OSM_ROLES.filter((r) => !replaced.has(r)).map((r) => ROLE_LABELS[r]).join(', ') || 'Nothing: every layer is your own file';
  const buildings = s.buildingsSource === 'google'
    ? 'From Google Open Buildings: every building in your area, with its height, downloaded while the city builds'
    : s.buildingsFile ? `${s.buildingsFile} — height from “${s.heightProperty}”` : `Height from “${s.heightProperty}”`;
  const rows = [
    ['City', s.displayName],
    ['Area', `${areaText(s.bbox)}  (${[s.bbox.west, s.bbox.south, s.bbox.east, s.bbox.north].map((v) => Number(v).toFixed(3)).join(', ')})`],
    ['Buildings', buildings],
    s.osmExport ? ['From your OpenStreetMap export', `${s.osmExport}: ${fromOsm}`] : ['From OpenStreetMap', fromOsm],
    ['Your files', s.ownFiles.length ? s.ownFiles.map((f) => `${f.label} (${f.file})`).join(', ') : 'None'],
  ];
  if (s.settings) rows.push(['Settings', settingsText(s.settings)]);
  $('reviewSummary').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

/** Files kept from the previous submission (revision mode), by field -- and the ones the uploader chose to drop. */
const onFile = new Map();
const clearedFields = new Set();

function fileNameFor(field, inputId = `file-${field}`) {
  const picked = $(inputId).files[0]?.name;
  if (picked) return picked;
  return onFile.has(field) && !clearedFields.has(field) ? `${onFile.get(field)}, kept` : null;
}

function summaryFromForm() {
  return {
    displayName: $('uploadDisplayName').value.trim(),
    bbox: readBbox(),
    buildingsSource: buildingsSource(),
    buildingsFile: $('fileBuildings').files[0]?.name ?? ($('fileBuildings').dataset.hasExisting === '1' ? 'unchanged from last time' : null),
    heightProperty: heightProperty(),
    ownFiles: [...MUNICIPAL_SLOTS, ...OVERRIDE_SLOTS].map((s) => ({ role: s.role, label: s.label, file: fileNameFor(s.field) })).filter((f) => f.file),
    osmExport: fileNameFor('osmExport', 'fileOsmExport'),
    settings: Object.fromEntries(GEN_FIELD_IDS.map((id) => [id, $(id).value])),
  };
}

const ON_FILE_BUILDINGS = 'On file from last time. Leave this empty to keep it.';

/** Revision mode: shows a kept file in its slot, with a way to drop it (for an OSM layer, that means "use OpenStreetMap again"). */
function showOnFile(field, statusId, filename, isOsmLayer) {
  const statusEl = $(statusId);
  if (!statusEl) return;
  onFile.set(field, filename);
  statusEl.textContent = `On file: ${filename}. Leave this empty to keep it.`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'slot-clear';
  btn.textContent = isOsmLayer ? 'Remove, use OpenStreetMap again' : 'Remove';
  btn.addEventListener('click', () => {
    clearedFields.add(field);
    statusEl.textContent = isOsmLayer ? 'Will be removed. This layer comes from OpenStreetMap again.' : 'Will be removed.';
  });
  statusEl.append(btn);
}

async function prefillFromExisting(cityId, token) {
  const details = await apiClient.getUploadDetails(cityId, token);
  $('uploadTitle').textContent = `Revise "${details.displayName}"`;
  $('uploadDisplayName').value = details.displayName;
  if (details.buildings) {
    $('tileSizeM').value = details.buildings.tileSizeM;
    $('minRenderHeightM').value = details.buildings.minRenderHeightM;
    $('windowMinHeightM').value = details.buildings.windowMinHeightM;
    showSettingsIfChanged();
  }
  showBuildingsSource(details.buildingsSource ?? 'file');
  // Only a city built from its own file has one kept on the server to reuse.
  if (details.buildingsSource !== 'google') {
    rememberHeightProperty(details.heightProperty ?? '');
    $('fileBuildings').dataset.hasExisting = '1';
    $('statusBuildings').textContent = ON_FILE_BUILDINGS;
  }

  const slotByRole = new Map([...MUNICIPAL_SLOTS, ...OVERRIDE_SLOTS].map((s) => [s.role, s]));
  for (const lf of details.layerFiles ?? []) {
    const slot = slotByRole.get(lf.role);
    if (slot && lf.source === 'manual' && lf.status === 'validated') showOnFile(slot.field, `status-${slot.field}`, lf.original_filename, OSM_ROLES.includes(lf.role));
  }
  if (details.osmExportFileName) showOnFile('osmExport', 'statusOsmExport', details.osmExportFileName, false);
  // Anything of the uploader's own replacing OpenStreetMap -> show that section open, not hidden away.
  if (details.osmExportFileName || [...onFile.keys()].some((f) => OVERRIDE_SLOTS.some((s) => s.field === f))) $('osmOwnFiles').open = true;
  return details.bbox;
}

/** Settings someone changed from the defaults are shown open -- "Advanced" only folds away what's standard. */
function showSettingsIfChanged() {
  if (GEN_FIELD_IDS.some((id) => Number($(id).value) !== GEN_DEFAULTS[id])) $('reviewSettings').open = true;
}

const mb = (bytes) => (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0);

/** The upload bar under step 3. Once every byte is sent the server still has to accept the files, so 100% becomes "checking", not "done". */
function showUploadProgress(sent, total) {
  $('uploadProgress').hidden = false;
  const pct = total ? Math.floor((sent / total) * 100) : 0;
  $('uploadProgressFill').style.width = `${pct}%`;
  const done = sent >= total;
  $('uploadProgressText').textContent = done ? 'Uploaded. The server is checking your files…' : `Uploading your files: ${mb(sent)} of ${mb(total)} MB`;
  $('uploadProgressPct').textContent = done ? '' : `${pct}%`;
  $('uploadProgressFill').classList.toggle('is-indeterminate', done);
}

/** While files are still going up, leaving the page would cancel the upload -- say so instead of silently losing it. */
const warnBeforeLeaving = (e) => { e.preventDefault(); e.returnValue = ''; };

async function submit({ reviseCityId, reviseToken }) {
  const errEl = $('uploadError');
  errEl.hidden = true;
  const submitBtn = $('btnUploadSubmit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading…';
  for (const id of ['btnUploadBack', 'btnUploadClose']) $(id).disabled = true;
  window.addEventListener('beforeunload', warnBeforeLeaving);
  showUploadProgress(0, 1);

  try {
    const displayName = $('uploadDisplayName').value.trim();
    const bbox = readBbox();
    const formData = new FormData();
    const source = buildingsSource();
    formData.set('buildingsSource', source);
    const buildingsFile = source === 'file' ? $('fileBuildings').files[0] : null; // a file left attached under the other choice isn't sent
    if (buildingsFile) formData.set('buildings', buildingsFile);
    for (const { field } of [...MUNICIPAL_SLOTS, ...OVERRIDE_SLOTS]) {
      const file = $(`file-${field}`).files[0];
      if (file) formData.set(field, file);
    }
    const osmExport = $('fileOsmExport').files[0];
    if (osmExport) formData.set('osmExport', osmExport);
    if (clearedFields.size) formData.set('clearFiles', [...clearedFields].join(','));
    formData.set('heightProperty', source === 'google' ? GOOGLE_HEIGHT_PROPERTY : heightProperty());
    formData.set('originLon', (bbox.west + bbox.east) / 2);
    formData.set('originLat', (bbox.south + bbox.north) / 2);
    formData.set('bboxWest', bbox.west);
    formData.set('bboxSouth', bbox.south);
    formData.set('bboxEast', bbox.east);
    formData.set('bboxNorth', bbox.north);
    formData.set('tileSizeM', $('tileSizeM').value);
    formData.set('minRenderHeightM', $('minRenderHeightM').value);
    formData.set('windowMinHeightM', $('windowMinHeightM').value);

    const result = reviseCityId
      ? await apiClient.reviseCity(reviseCityId, reviseToken, { displayName, formData }, showUploadProgress)
      : await apiClient.uploadCity({ displayName, formData }, showUploadProgress);

    window.removeEventListener('beforeunload', warnBeforeLeaving);
    addMyCity({ cityId: result.cityId, accessToken: result.accessToken, displayName });
    clearDraft(); // successfully submitted -- nothing left to resume
    // The progress page for this build -- replace(), so Back doesn't return to a stale, already-submitted form.
    location.replace(`?status=1&city=${encodeURIComponent(result.cityId)}&t=${encodeURIComponent(result.accessToken)}`);
  } catch (err) {
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    $('uploadProgress').hidden = true;
    errEl.textContent = err.message ?? String(err);
    errEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Build my city';
    for (const id of ['btnUploadBack', 'btnUploadClose']) $(id).disabled = false;
  }
}

/**
 * Review & build for an already-submitted city: step 3, read-only, with
 * live progress. Also remembers the city in "My cities" -- opening its
 * link on another device is how it gets onto that device's list.
 */
async function mountTracking(cityId, token) {
  for (const id of ['btnUploadClose', 'btnUploadBack', 'btnUploadNext', 'btnUploadSubmit']) $(id).hidden = true;
  $('uploadTitle').textContent = 'Review & build';
  document.querySelector('[data-step-panel="1"]').hidden = true;
  document.querySelector('[data-step-panel="3"]').hidden = false;
  for (let i = 1; i <= 3; i++) {
    const pill = document.querySelector(`[data-step="${i}"]`);
    pill.classList.toggle('is-done', i < 3);
    pill.classList.toggle('is-active', i === 3);
  }
  // Coming back to check on a build, the progress is what matters -- it goes
  // first, and the submitted settings become one summary line, not a form.
  $('reviewSettings').hidden = true;
  const statusEl = $('buildStatus');
  statusEl.classList.add('build-status--top');
  document.querySelector('[data-step-panel="3"]').prepend(statusEl);

  const errEl = $('uploadError');
  if (!cityId || !token) {
    errEl.textContent = 'This link is missing its city or token. Open the city from My cities instead.';
    errEl.hidden = false;
    return;
  }
  mountBuildStatus(statusEl, {
    cityId, token,
    onGone: () => {
      $('reviewSummary').hidden = true;
      $('uploadTitle').textContent = 'Review & build';
      document.querySelector('.upload-view__steps').hidden = true;
    },
  });

  try {
    const d = await apiClient.getUploadDetails(cityId, token);
    $('uploadTitle').textContent = `“${d.displayName}” — Review & build`;
    addMyCity({ cityId, accessToken: token, displayName: d.displayName });
    renderSummary({
      displayName: d.displayName, bbox: d.bbox, buildingsSource: d.buildingsSource, buildingsFile: d.buildingsFileName, heightProperty: d.heightProperty ?? '?',
      ownFiles: (d.layerFiles ?? []).filter((lf) => lf.source === 'manual').map((lf) => ({ role: lf.role, label: ROLE_LABELS[lf.role] ?? lf.role, file: lf.original_filename })),
      osmExport: d.osmExportFileName,
      settings: d.buildings,
    });
  } catch (err) {
    if (err.status === 404) return; // BuildStatus is already saying the city no longer exists
    errEl.textContent = `Could not load this submission: ${err.message ?? err}`;
    errEl.hidden = false;
  }
}

/**
 * @param {{reviseCityId?: string|null, reviseToken?: string|null, trackCityId?: string|null, trackToken?: string|null, tracking?: boolean}} opts
 *   `tracking` = the ?status=1 page: an already-submitted city's Review & build step.
 */
export function mountUploadView({ reviseCityId, reviseToken, trackCityId, trackToken, tracking = false } = {}) {
  $('uploadView').hidden = false;
  buildSlots($('uploadOptionalSlots'), MUNICIPAL_SLOTS);
  buildSlots($('osmOverrideSlots'), OVERRIDE_SLOTS);
  if (tracking) { mountTracking(trackCityId, trackToken); return; }

  // The server's size limits, so a file that's too large is turned away when
  // it's chosen rather than after minutes of uploading. If they can't be
  // fetched the form simply doesn't check; the server still does.
  let limits = null;
  apiClient.getLimits().then((l) => { limits = l; }).catch(() => {});
  for (const id of FILE_FIELD_IDS) {
    // The buildings file keeps a full-width zone; every optional file is a small button in its row.
    enhanceFileInput($(id), { maxBytes: () => (id === 'fileBuildings' ? limits?.maxUploadBytes : limits?.maxLayerFileBytes) ?? null, compact: id !== 'fileBuildings' });
  }
  // A file dropped beside a zone would otherwise make the browser open it, replacing this page and everything filled in.
  for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());

  const isRevision = Boolean(reviseCityId);
  // Defaults are shown as editable values, never silently applied unseen.
  // Same numbers build-building-tiles.mjs itself falls back to in --input mode.
  $('tileSizeM').value = GEN_DEFAULTS.tileSizeM;
  $('minRenderHeightM').value = GEN_DEFAULTS.minRenderHeightM;
  $('windowMinHeightM').value = GEN_DEFAULTS.windowMinHeightM;

  let step = 1;
  function persistDraft() { if (!isRevision) saveDraft(collectDraft(step)); }

  $('fileBuildings').addEventListener('change', (e) => inspectBuildingsFile(e.target.files[0]).then(persistDraft));
  for (const id of ['buildingsSourceGoogle', 'buildingsSourceFile']) {
    $(id).addEventListener('change', () => { showBuildingsSource(buildingsSource()); persistDraft(); });
  }

  const map = initMap();
  const bbox = wireBboxDraw(map, () => { clearFieldErrors(); persistDraft(); updateTurboLink(); });
  for (const id of BBOX_FIELD_IDS) $(id).addEventListener('change', updateTurboLink);
  updateTurboLink();
  wirePlaceSearch(map, (place) => {
    // Saves a step for the common case (search "Lucknow" -> city is "Lucknow"); never overwrites a name already typed.
    if (!$('uploadDisplayName').value.trim() && place.name) { $('uploadDisplayName').value = place.name; clearFieldErrors(); persistDraft(); }
  });
  requestAnimationFrame(() => map.invalidateSize()); // container was hidden=false only just now; Leaflet measured 0x0 if it sized itself earlier

  // Draft autosave/restore -- revision mode has its own server-side pre-fill
  // (prefillFromExisting below) and shouldn't be mixed with a stale local
  // draft from some unrelated earlier upload attempt.
  const draftNotice = $('draftNotice');
  if (!isRevision) {
    const draft = getDraft();
    if (draft) {
      step = Math.min(3, Math.max(1, draft.step ?? 1));
      restoreDraftFields(draft);
      showSettingsIfChanged();
      if (Object.keys(draft.fileNames ?? {}).some((id) => id === 'fileOsmExport' || OVERRIDE_SLOTS.some((s) => id === `file-${s.field}`))) $('osmOwnFiles').open = true;
      const b = draft.bbox;
      if (b && [b.west, b.south, b.east, b.north].every((v) => v !== '' && Number.isFinite(Number(v)))) {
        bbox.showBbox({ west: Number(b.west), south: Number(b.south), east: Number(b.east), north: Number(b.north) });
      }
      $('draftNoticeText').textContent = 'Restored your saved draft from earlier.';
      draftNotice.hidden = false;
    }
    $('btnDraftStartOver')?.addEventListener('click', () => {
      clearDraft();
      location.reload(); // simplest way back to a genuinely blank form -- avoids duplicating the "defaults" logic above
    });
    // Autosave on every meaningful change, not just step transitions -- a
    // browser can close at any moment, not conveniently between steps.
    const autosaveFieldIds = ['uploadDisplayName', ...BBOX_FIELD_IDS, 'heightProperty', 'heightPropertyText', ...GEN_FIELD_IDS, ...FILE_FIELD_IDS];
    for (const id of autosaveFieldIds) $(id)?.addEventListener('change', persistDraft);
  }

  // An error under a field goes as soon as the field is touched again.
  for (const type of ['input', 'change']) $('uploadView').addEventListener(type, clearFieldErrors);
  // The summary's "Settings" row follows the Advanced settings form as it's edited.
  for (const id of GEN_FIELD_IDS) $(id).addEventListener('input', () => { if (step === 3) renderSummary(summaryFromForm()); });

  function goTo(n) {
    step = n;
    showStep(step);
    if (step === 1) requestAnimationFrame(() => map.invalidateSize());
    if (step === 2) updateTurboLink(); // the area may have come from a draft/revision, set without change events
    if (step === 3) renderSummary(summaryFromForm());
    persistDraft();
  }
  showStep(step);
  if (step === 2) updateTurboLink();
  if (step === 3) renderSummary(summaryFromForm());

  $('btnUploadNext').addEventListener('click', () => {
    $('uploadError').hidden = true;
    const problems = validateStep(step);
    if (problems.length) { showFieldErrors(problems); return; }
    clearFieldErrors();
    goTo(Math.min(3, step + 1));
  });
  $('btnUploadBack').addEventListener('click', () => { clearFieldErrors(); goTo(Math.max(1, step - 1)); });
  $('btnUploadClose').addEventListener('click', () => { location.href = '?'; });
  $('btnUploadSubmit').addEventListener('click', () => {
    const problems = validateStep(3);
    if (problems.length) {
      $('reviewSettings').open = true; // the settings are collapsed by default: open them so the message is seen
      showFieldErrors(problems);
      return;
    }
    clearFieldErrors();
    submit({ reviseCityId, reviseToken });
  });

  if (reviseCityId) {
    prefillFromExisting(reviseCityId, reviseToken)
      .then((b) => bbox.showBbox(b))
      .catch((err) => {
        $('uploadError').textContent = `Could not load your previous submission: ${err.message ?? err}`;
        $('uploadError').hidden = false;
      });
  }
}
