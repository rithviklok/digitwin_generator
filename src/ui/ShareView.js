// ===================================================================
// ShareView -- the viewer's Share button (#btnShare) and panel: a link to
// this city (optionally at the current camera view) and an <iframe>
// snippet for embedding it in another site or platform (?embed=1, see
// src/embed/ControlApi.js and public/EMBED.md).
//
// Not mounted in admin preview (its URL carries the admin token) or in
// embed mode (the host page owns sharing there).
// ===================================================================
import { makeViewCodec, formatViewParam, readableUrl } from '../embed/viewParam.js';

const $ = (id) => document.getElementById(id);
const COPIED_FEEDBACK_MS = 1600;
/**
 * The smallest frame in which every control of the embedded viewer fits
 * without overlapping (styles.css's `body.is-embed` note; public/EMBED.md
 * tells host developers the same). The embed code carries it, so a host
 * page can't squeeze the frame below it by accident.
 */
const EMBED_MIN_SIZE = { width: 480, height: 360 };

/**
 * @param {{engine: object, cityConfig: object, access: {cityId: string, token: string} | null}} args
 *   access: the private ?city=&t= pair for an uploaded city; null for the built-in default city.
 */
export function mountShareView({ engine, cityConfig, access }) {
  const btn = $('btnShare'), panel = $('sharePanel');
  const linkInput = $('shareLink'), embedInput = $('shareEmbed'), includeView = $('shareIncludeView');
  const codec = makeViewCodec(cityConfig.origin);

  function buildUrl({ embed = false } = {}) {
    const u = new URL(location.pathname, location.origin);
    if (access) { u.searchParams.set('city', access.cityId); u.searchParams.set('t', access.token); }
    if (includeView.checked) u.searchParams.set('view', formatViewParam(codec.toGeo(engine.cameraRig.getView())));
    if (embed) u.searchParams.set('embed', '1');
    return readableUrl(u);
  }

  function refresh() {
    linkInput.value = buildUrl();
    const title = `${cityConfig.displayName} digital twin`;
    const style = `border:0;min-width:${EMBED_MIN_SIZE.width}px;min-height:${EMBED_MIN_SIZE.height}px`;
    embedInput.value = `<iframe src="${escapeAttr(buildUrl({ embed: true }))}" title="${escapeAttr(title)}" width="100%" height="600" style="${style}" allow="fullscreen" loading="lazy"></iframe>`;
  }

  $('shareAccessNote').textContent = access
    ? 'This link includes the city’s private key, so anyone who has it can open the city. Share it only with people who should see it.'
    : 'Anyone with the link can open it.';

  function open() {
    engine.searchController.close(); // same corner of the screen
    refresh();
    panel.hidden = false;
    btn.setAttribute('aria-pressed', 'true');
  }
  function close() {
    panel.hidden = true;
    btn.setAttribute('aria-pressed', 'false');
  }

  btn.hidden = false;
  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  $('btnSearch').addEventListener('click', close);
  $('btnShareClose').addEventListener('click', close);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  includeView.addEventListener('change', refresh);

  wireCopy($('btnCopyLink'), linkInput, refresh);
  wireCopy($('btnCopyEmbed'), embedInput, refresh);
}

/** Copy button: refreshes first (the camera may have moved since the panel opened), then copies, with feedback on the button. */
function wireCopy(button, field, refresh) {
  const label = button.textContent;
  let timer = null;
  button.addEventListener('click', async () => {
    refresh();
    const ok = await copyText(field);
    button.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = label; }, COPIED_FEEDBACK_MS);
  });
}

/**
 * The async Clipboard API only exists in secure contexts (HTTPS or
 * localhost) -- a LAN address like http://10.x.x.x has none, so fall back
 * to selecting the text and the older copy command. On total failure the
 * text is left selected for the user to copy by hand.
 */
async function copyText(field) {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(field.value); return true; } catch { /* fall through */ }
  }
  field.focus();
  field.select();
  try { return document.execCommand('copy'); } catch { return false; }
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
