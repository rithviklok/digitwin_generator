// ===================================================================
// ControlApi.js -- lets a page that embeds the viewer in an iframe
// (AirawatOS, a client's site) drive it with window.postMessage, and hear
// back what the user does. Protocol reference for other platforms:
// public/EMBED.md (served at /EMBED.md).
//
// Every message both ways is { source: 'digitwin', type, ... }.
//   host -> viewer: hello, getView, setView, flyTo, search, setNight,
//                   resetNorth. An `id` on a command gets a `response`
//                   with the same id: { ok: true, result } | { ok: false, error }.
//   viewer -> host: ready (on load, before any hello), then -- only after
//                   the host's first accepted message -- click, viewChanged.
//
// Why events wait for a message: `ready` says nothing a framing page
// doesn't already know (it chose the URL), so it goes to any parent; click
// and view events go only to the origin that actually spoke to us.
// ===================================================================
import { makeViewCodec, normalizeGeoView, roundGeoView } from './viewParam.js';

const NS = 'digitwin';
export const CONTROL_API_VERSION = 1;
const VIEW_EVENT_DEBOUNCE_MS = 250;

/**
 * @param {{engine: import('../engine/TwinEngine.js').TwinEngine, cityConfig: object}} args
 * @returns {null | {post: (type: string, payload?: object) => void}} null when not inside an iframe
 */
export function mountControlApi({ engine, cityConfig }) {
  if (window.parent === window) return null;

  const codec = makeViewCodec(cityConfig.origin);
  const { cameraRig } = engine;
  let hostOrigin = null; // pinned by the first accepted message

  const currentView = () => roundGeoView(codec.toGeo(cameraRig.getView()));
  const post = (type, payload = {}, targetOrigin = hostOrigin) => {
    if (!targetOrigin) return;
    // A host page opened from disk (file://) or a sandboxed iframe has origin "null", which postMessage can't target by name.
    window.parent.postMessage({ source: NS, type, ...payload }, targetOrigin === 'null' ? '*' : targetOrigin);
  };

  const commands = {
    hello: () => ({ version: CONTROL_API_VERSION, city: { id: cityConfig.id, name: cityConfig.displayName }, view: currentView() }),
    getView: () => currentView(),
    setView: ({ view, animate = true }) => {
      const g = normalizeGeoView(view);
      if (!g) throw new Error('setView needs view: { lat, lon, distance?, heading?, tilt? }');
      cameraRig.setView(codec.fromGeo(g), { animate: animate !== false });
      return null;
    },
    flyTo: ({ lat, lon, distance }) => {
      const g = normalizeGeoView({ lat, lon, distance });
      if (!g) throw new Error('flyTo needs numeric lat and lon');
      cameraRig.setView(codec.fromGeo({ lat: g.lat, lon: g.lon, distance: g.distance ?? 700 }), { animate: true });
      return null;
    },
    search: ({ query }) => {
      if (typeof query !== 'string' || !query.trim()) throw new Error('search needs a non-empty query string');
      const [best] = engine.searchController.rank(query, 1);
      if (!best) return { found: false };
      engine.searchController.select(best);
      const { lat, lon } = codec.pointToGeo(best.x, best.z);
      const r6 = (x) => Math.round(x * 1e6) / 1e6;
      return { found: true, name: best.name, type: best.type, lat: r6(lat), lon: r6(lon) };
    },
    setNight: ({ night }) => {
      if (typeof night !== 'boolean') throw new Error('setNight needs night: true | false');
      const wc = engine.weatherController;
      if (wc) wc.manualOverride = true; // same as the toolbar toggle: live weather stops overriding it
      engine.paletteController.applyPalette(night ? 'night' : 'day');
      engine.scheduler.markDirty();
      return null;
    },
    resetNorth: () => { cameraRig.resetToNorth(); engine.scheduler.markDirty(); return null; },
  };

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== window.parent || !msg || msg.source !== NS) return; // only our direct parent, only our protocol
    // Which sites may drive the viewer is the server's EMBED_ALLOWED_ORIGINS
    // (set by whoever hosts it -- HOSTING.md), not a list in this file: it
    // becomes a CSP frame-ancestors header, so the browser refuses to load
    // the viewer inside any other site at all -- and a message that passed
    // the check above can then only come from an allowed one. Blank = any site.
    hostOrigin ??= event.origin;
    if (event.origin !== hostOrigin) return; // one host per page load

    const handler = Object.hasOwn(commands, msg.type) ? commands[msg.type] : null;
    const reply = (body) => { if (msg.id !== undefined) post('response', { id: msg.id, ...body }); };
    if (!handler) return reply({ ok: false, error: `unknown command "${msg.type}"` });
    try {
      reply({ ok: true, result: handler(msg) ?? null });
    } catch (err) {
      reply({ ok: false, error: String(err.message ?? err) });
    }
  });

  engine.inspectController.onPick = (pick) => {
    const { ground, ...rest } = pick;
    const at = ground && codec.pointToGeo(ground.x, ground.z);
    post('click', { ...rest, ...(at ? { lat: Math.round(at.lat * 1e6) / 1e6, lon: Math.round(at.lon * 1e6) / 1e6 } : {}) });
  };

  // OrbitControls fires 'change' on every moved frame (drags, zoom, and the
  // fly-to/compass tweens) -- report once the camera has settled.
  let viewTimer = null;
  cameraRig.orbit.addEventListener('change', () => {
    if (!hostOrigin) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => post('viewChanged', { view: currentView() }), VIEW_EVENT_DEBOUNCE_MS);
  });

  post('ready', { version: CONTROL_API_VERSION, city: { id: cityConfig.id, name: cityConfig.displayName } }, '*');
  return { post };
}
