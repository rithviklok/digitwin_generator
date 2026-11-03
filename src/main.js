import { kanpurConfig } from './config/cities/kanpur.config.js';
import { validateCityConfig } from './config/city-schema.js';
import { TwinEngine } from './engine/TwinEngine.js';
import { mountAdminBar } from './ui/AdminBar.js';
import { mountCoverageView } from './ui/CoverageView.js';
import { mountWelcomeBackBanner } from './ui/WelcomeBackBanner.js';
import { mountZoomHint } from './ui/ZoomHint.js';
import { mountTopbar, setTopbarCity } from './ui/Topbar.js';
import { apiClient, adminApi } from './api/client.js';
import { getMyCities } from './api/myCities.js';
import { makeViewCodec, parseViewParam, formatViewParam, readableUrl } from './embed/viewParam.js';

// ===================================================================
// Routing: query-param driven, one page, no router.
// Two kinds of mode:
//   - "content" modes boot the real 3D TwinEngine: the default Kanpur
//     boot, an uploaded city (?city=&t=), and the admin's view of one
//     (?admin=<token>&city=<id>).
//   - "chrome" modes (upload / my-cities / status / the admin's list
//     and build log) are full-page panels with NO engine boot at all --
//     there's nothing to render yet (a brand-new upload) or the panel
//     isn't about rendering (picking a city, drawing a bbox). Reached by
//     a real navigation (an <a href> or `location.href = ...`), not by
//     toggling a div in place -- that's what "query-param navigation"
//     means here, as opposed to the Search/Coverage panels, which DO
//     float over a live scene.
// ===================================================================
const params = new URLSearchParams(location.search);

// The AirawatOS top bar is shared by every mode below, content and chrome
// alike -- its Upload / My cities links are plain <a href>s, so it needs
// nothing from the engine.
mountTopbar();

if (params.has('admin') && params.has('logs')) {
  // The build log viewer. Separate from opening the city in the viewer:
  // that needs a build that actually succeeded, so a city that's failed on
  // every attempt has nothing to open. This bypasses the engine entirely.
  const { mountAdminLogView } = await import('./ui/AdminLogView.js');
  mountAdminLogView({ cityId: params.get('city'), token: params.get('admin') });
} else if (params.has('admin') && !params.has('city')) {
  // The admin page: every uploaded city.
  const { mountAdminCitiesView } = await import('./ui/AdminCitiesView.js');
  mountAdminCitiesView({ token: params.get('admin') });
} else if (params.has('upload')) {
  const { mountUploadView } = await import('./ui/UploadView.js');
  mountUploadView({ reviseCityId: params.get('revise'), reviseToken: params.get('t') });
} else if (params.has('mycities')) {
  const { mountCityPickerView } = await import('./ui/CityPickerView.js');
  mountCityPickerView();
} else if (params.has('status')) {
  // A submitted city's progress lives on the upload wizard's own "Review &
  // build" step (tracking mode), not a separate page -- same card, same
  // summary of what was submitted, plus the live build status.
  const { mountUploadView } = await import('./ui/UploadView.js');
  mountUploadView({ tracking: true, trackCityId: params.get('city'), trackToken: params.get('t') });
} else {
  await bootViewer();
}

async function bootViewer() {
  // An uploaded city: ?city=<cityId>&t=<accessToken> fetches its config from
  // the access-gated endpoint. The admin's view of one: ?admin=<ADMIN_TOKEN>&
  // city=<cityId> fetches the same config from the admin-gated endpoint
  // instead, so an admin needs no city's private link. Both run through the
  // exact same validateCityConfig -> TwinEngine -> boot() sequence as the
  // default Kanpur boot -- same URLSearchParams pattern as TwinEngine.js's
  // own `?perf` flag. Zero engine/worker changes either way.
  const adminToken = params.get('admin');
  const cityIdParam = params.get('city');
  const tokenParam = params.get('t');
  const isAdminView = Boolean(adminToken) && Boolean(cityIdParam);
  const isPublicCityView = !isAdminView && Boolean(cityIdParam);
  // ?embed=1: shown inside another site/platform's iframe -- no top bar (the
  // host has its own chrome), control API over postMessage (embed/ControlApi.js).
  const isEmbed = !isAdminView && params.get('embed') === '1';
  if (isEmbed) document.body.classList.add('is-embed');

  // Ways onward from a city that couldn't be opened: [label, href, kind].
  const HOME = [`Open ${kanpurConfig.displayName}`, '?', 'primary'];
  const MY_CITIES = ['My cities', '?mycities=1', 'ghost'];
  const TRY_AGAIN = ['Try again', location.href, 'ghost'];
  const ADMIN_LIST = ['All cities', `?admin=${encodeURIComponent(adminToken ?? '')}`, 'ghost'];

  /** Replaces the scene with what went wrong, in plain words, and where to go from here -- never a dead end. */
  function fatal(title, body, actions = []) {
    document.getElementById('fatalTitle').textContent = title;
    document.getElementById('fatalBody').textContent = body;
    document.getElementById('fatalActions').replaceChildren(
      // Inside another site's page there is nowhere of ours to send the visitor.
      ...(isEmbed ? [] : actions).map(([label, href, kind]) => {
        const a = document.createElement('a');
        a.className = `app-page__btn app-page__btn--${kind}`;
        a.textContent = label;
        a.href = href;
        return a;
      }),
    );
    document.getElementById('fatal').classList.add('is-shown');
    document.getElementById('loading')?.classList.add('is-hidden');
  }

  function showLoadFailure(err) {
    const unreachable = `The server didn’t answer (${err.message ?? err}). It may be restarting; try again in a moment.`;
    if (isAdminView) {
      if (err.status === 401) return fatal('This admin link isn’t valid', 'The token in the address (?admin=…) has to match ADMIN_TOKEN in the server’s .env file.');
      if (err.status === 404) return fatal('No such city', `There is no uploaded city with the id “${cityIdParam}”. It may have been deleted.`, [ADMIN_LIST]);
      if (err.status === 409) return fatal('Nothing to open yet', 'This city has no finished build. Its build log says how each attempt went.', [['Build log', `${ADMIN_LIST[1]}&city=${encodeURIComponent(cityIdParam)}&logs=1`, 'primary'], ADMIN_LIST]);
      return fatal('Could not open this city', unreachable, [TRY_AGAIN, ADMIN_LIST]);
    }
    // The server answers a wrong token exactly as it answers a city that doesn't exist, so the two can't be told apart here either.
    if (err.status === 404) return fatal('This link doesn’t work', 'It may be mistyped or incomplete, or the city was deleted.', [HOME, MY_CITIES]);
    return fatal('Could not load this city', unreachable, [TRY_AGAIN, HOME]);
  }

  async function resolveCityConfig() {
    if (isAdminView) {
      const { config, city } = await adminApi.getCityConfig(adminToken, cityIdParam);
      return { cityConfig: config, adminCity: city };
    }
    if (isPublicCityView) {
      if (!tokenParam) throw Object.assign(new Error('the link has no access key'), { status: 404 });
      try {
        const { config } = await apiClient.getCityConfig(cityIdParam, tokenParam);
        return { cityConfig: config, adminCity: null };
      } catch (err) {
        if (err.status === 409) {
          // Nothing built yet (still building, or every build so far failed)
          // -- its Review & build page is the right place for this, not a
          // dead-end error screen.
          location.replace(`?status=1&city=${encodeURIComponent(cityIdParam)}&t=${encodeURIComponent(tokenParam)}`);
          return new Promise(() => {}); // navigating away -- never resolve, boot() below just never runs
        }
        throw err;
      }
    }
    // The built-in city. Its weather settings come from the server, like every
    // uploaded city's (WEATHER_API_KEY in server/.env); without a server, or
    // without a key there, it is shown without live weather.
    const site = await apiClient.getSite().catch(() => null);
    return { cityConfig: { ...kanpurConfig, weather: site?.weather ?? null }, adminCity: null };
  }

  let cityConfig, adminCity;
  try {
    ({ cityConfig, adminCity } = await resolveCityConfig());
  } catch (err) {
    console.warn('[main] could not open the city:', err);
    showLoadFailure(err);
    return;
  }

  const { ok, errors } = validateCityConfig(cityConfig);
  if (!ok) {
    console.error(`[main] invalid CityConfig for "${cityConfig.id ?? '(unknown)'}":`, errors);
    fatal('This city can’t be shown', `Its data doesn’t match what this version of the viewer expects (${errors[0]}).`, isAdminView ? [ADMIN_LIST] : [HOME, MY_CITIES]);
    return;
  }
  setTopbarCity(cityConfig.displayName);

  const loadingText = document.getElementById('loadingText');
  const loadingBarFill = document.getElementById('loadingBarFill');
  const loadingLabel = `Loading ${cityConfig.displayName}…`;
  loadingText.textContent = `${loadingLabel} 0%`;

  // TwinEngine reports three independent stages ('data', 'roads',
  // 'buildings') that each run their own 0->100% internally, overlapping
  // in time (buildings streams in a worker while data/roads load on the
  // main thread) -- displaying any one stage's raw percentage directly
  // made the bar/text visibly restart from a low number multiple times.
  // Weighted so the combined number only ever increases, 0% at the very
  // first byte to 100% once every stage is actually done. Buildings is
  // weighted heaviest since it's by far the largest/slowest fetch (the
  // ~280MB buildings file vs everything else combined).
  const STAGE_WEIGHTS = { data: 0.15, roads: 0.15, buildings: 0.70 };
  const stageFraction = { data: 0, roads: 0, buildings: 0 };
  function onProgress(stage, done, total) {
    if (!total) return;
    stageFraction[stage] = done / total;
    loadingBarFill.classList.remove('is-indeterminate');
    let overall = 0;
    for (const key in STAGE_WEIGHTS) overall += STAGE_WEIGHTS[key] * stageFraction[key];
    const pct = Math.min(100, Math.round(overall * 100));
    loadingBarFill.style.width = `${pct}%`;
    loadingText.textContent = `${loadingLabel} ${pct}%`;
  }

  const canvas = document.getElementById('scene');
  const engine = new TwinEngine(canvas, cityConfig);
  window.__twinEngine = engine; // console access for debugging, harmless in production

  // A shared link's ?view=lat,lon,distance,heading,tilt -- given to boot(), so
  // the first thing shown is the shared view and what gets loaded behind the
  // loading screen is what that view needs.
  const view = parseViewParam(params.get('view'));
  engine.boot({ onProgress, initialView: view ? makeViewCodec(cityConfig.origin).fromGeo(view) : null })
    .then(async () => {
      document.getElementById('loading').classList.add('is-hidden');
      engine.start();
      if (isAdminView) mountAdminBar({ token: adminToken, city: adminCity });
      // Only the plain default boot (no admin view, no specific city
      // requested) -- if you've navigated straight to your own city via a
      // saved link, you're already there and don't need to be told you
      // have cities to go find.
      if (!isAdminView && !isPublicCityView && !isEmbed) mountWelcomeBackBanner();
      // The uploader's own browser (the city is in its My cities) gets a way to
      // add files from "What's on this map"; a visitor with a shared link, or
      // a host site embedding the city, doesn't.
      const ownCity = isPublicCityView && !isEmbed && getMyCities().some((c) => c.cityId === cityIdParam);
      const reviseHref = ownCity ? `?upload=1&revise=${encodeURIComponent(cityIdParam)}&t=${encodeURIComponent(tokenParam)}` : null;
      mountCoverageView({ cityConfig, reviseHref });

      // Extras on a map that already works -- a failure here must not throw
      // into the .catch below, which would cover the map with a fatal screen.
      try {
        mountZoomHint({ engine });
        if (isEmbed) {
          const { mountControlApi } = await import('./embed/ControlApi.js');
          mountControlApi({ engine, cityConfig });
          mountOpenFullLink(engine, cityConfig);
        } else if (!isAdminView) {
          const { mountShareView } = await import('./ui/ShareView.js');
          mountShareView({ engine, cityConfig, access: isPublicCityView ? { cityId: cityIdParam, token: tokenParam } : null });
        }
      } catch (err) {
        console.error('[main] share/embed setup failed:', err);
      }
    })
    .catch((err) => {
      console.error('[main] boot failed:', err);
      fatal(`${cityConfig.displayName} couldn’t finish loading`, `${err.message ?? err}`, isAdminView ? [TRY_AGAIN, ADMIN_LIST] : [TRY_AGAIN, ...(isPublicCityView ? [HOME] : [])]);
    });
}

/** Embed mode's "Open full view" link: this page without ?embed=1, at whatever view the camera is on when it's clicked. */
function mountOpenFullLink(engine, cityConfig) {
  const link = document.getElementById('embedOpenFull');
  const codec = makeViewCodec(cityConfig.origin);
  const update = () => {
    const u = new URL(location.href);
    u.searchParams.delete('embed');
    u.searchParams.set('view', formatViewParam(codec.toGeo(engine.cameraRig.getView())));
    link.href = readableUrl(u);
  };
  update();
  link.addEventListener('pointerdown', update); // before the click navigates, so the href is the current view
  link.addEventListener('focus', update); // keyboard users
  link.hidden = false;
}
