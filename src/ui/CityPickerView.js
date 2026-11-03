// ===================================================================
// CityPickerView -- "My cities" (?mycities=1): reads the localStorage
// list (myCities.js) and lets the uploader jump back into any of them.
// Laid out as the AirawatOS desktop: one .tile per city, where Kanpur is
// the pinned built-in (the default boot, can't be removed -- the shell's
// "system app"), each uploaded city gets a ✕ that only drops it from this
// browser's list (the city itself stays live and reachable via its
// link), and a last tile starts a new upload.
//
// Under its name each tile says how the city is doing (live, building,
// failed…), asked from the server when the page opens -- the list in
// localStorage only knows names and links. A city that's live opens in
// the viewer; any other opens on its Review & build page, which is
// where what happened, and what to do about it, is spelled out.
//
// Every tile is a real <a href> (keyboard + middle-click work), built
// with textContent -- displayName is user-supplied upload input.
// ===================================================================
import { getMyCities, removeMyCity } from '../api/myCities.js';
import { apiClient } from '../api/client.js';
import { kanpurConfig } from '../config/cities/kanpur.config.js';

const REFRESH_WHILE_BUILDING_MS = 10_000;

const say = (label, tone = 'muted', needsAttention = false) => ({ label, tone, needsAttention });

/**
 * What a city's tile says under its name, and whether it should be
 * flagged "Needs attention".
 * @param {object|null} status - the server's answer for this city
 *   (apiClient.getStatus), or null when the server no longer has it:
 *   - status: 'processing' | 'live' | 'failed' | 'purged' -- how its LATEST submission went
 *   - hasLiveVersion: boolean -- whether any build of it can be opened right now
 *   - job: { buildsAhead: number, … } | null -- its latest build
 *   - layers: Array<{ role: string, status: 'validated'|'invalid' }> -- 'invalid' = a layer that didn't make it into the build
 * @returns {{label: string, tone: 'good'|'busy'|'warn'|'bad'|'muted', needsAttention: boolean}}
 *   label: a few words (a tile is narrow); tone: its colour (styles.css's .tile__status--<tone>)
 */
export function describeCityStatus(status) {
  if (!status) return say('No longer exists');
  switch (status.status) {
    case 'live': {
      // Said, but not flagged: the city works, and an uploader who leaves it
      // this way on purpose would have no way to make a flag go away.
      const missing = status.layers?.filter((lf) => lf.status !== 'validated').length ?? 0;
      return missing ? say(`Live, ${missing} layer${missing === 1 ? '' : 's'} missing`, 'warn') : say('Live', 'good');
    }
    case 'processing': {
      const ahead = status.job?.buildsAhead ?? 0;
      if (ahead) return say(`Waiting, ${ahead} ahead`, 'busy');
      return say(status.hasLiveVersion ? 'Updating…' : 'Building…', 'busy');
    }
    // The one flagged case: what the uploader last submitted didn't work.
    // After a failed update the earlier build still opens and looks fine,
    // so this tile is the only place that says so.
    case 'failed': return status.hasLiveVersion ? say('Update failed', 'warn', true) : say('Build failed', 'bad', true);
    case 'purged': return say('Files cleared'); // a failed build left alone past the retention period (retentionSweep.js)
    default: return say(status.status);
  }
}

function makeTile({ href, icon, name, modifier }) {
  const tile = document.createElement('div');
  tile.className = modifier ? `tile tile--${modifier}` : 'tile';

  const link = document.createElement('a');
  link.className = 'tile__link';
  link.href = href;
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.setAttribute('aria-hidden', 'true');
  ico.textContent = icon;
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = name;
  link.append(ico, nm);

  tile.append(link);
  return tile;
}

/** The line under a tile's name. */
function statusLine(text, tone = 'muted') {
  const line = document.createElement('div');
  line.className = `tile__status tile__status--${tone}`;
  line.textContent = text;
  return line;
}

export function mountCityPickerView() {
  const page = document.getElementById('cityPickerView');
  const listEl = document.getElementById('cityPickerList');
  const emptyEl = document.getElementById('cityPickerEmpty');
  page.hidden = false;
  let refreshTimer = null;

  function render() {
    clearTimeout(refreshTimer);
    const cities = getMyCities();
    listEl.replaceChildren();
    emptyEl.hidden = cities.length > 0;

    const builtIn = makeTile({ href: '?', icon: '🏙️', name: kanpurConfig.displayName });
    builtIn.querySelector('.tile__link').append(statusLine('Built-in'));
    const pin = document.createElement('span');
    pin.className = 'pin';
    pin.textContent = '📌';
    pin.title = 'Built-in city — always available, cannot be removed';
    builtIn.append(pin);
    listEl.append(builtIn);

    const tiles = cities.map((city) => {
      const name = city.displayName || city.cityId;
      const q = `city=${encodeURIComponent(city.cityId)}&t=${encodeURIComponent(city.accessToken)}`;
      const tile = makeTile({ href: `?${q}`, icon: '🌆', name });
      const link = tile.querySelector('.tile__link');
      const line = statusLine('Checking…');
      link.append(line);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rm';
      rm.textContent = '✕';
      rm.title = 'Remove from this list (the city itself stays on the server)';
      rm.setAttribute('aria-label', `Remove ${name} from this list`);
      rm.addEventListener('click', () => { removeMyCity(city.cityId); render(); });
      tile.append(rm);
      listEl.append(tile);

      /** Fills in the tile from the server's status for the city. @returns {boolean} whether it is still building */
      return async function refresh() {
        let status;
        try {
          status = await apiClient.getStatus(city.cityId, city.accessToken);
        } catch (err) {
          if (err.status !== 404) { line.textContent = 'Status unavailable'; return false; } // server unreachable -- say nothing we don't know
          status = null; // the server no longer has this city
        }
        if (!tile.isConnected) return false; // the list was re-rendered meanwhile
        const { label, tone, needsAttention } = describeCityStatus(status);
        line.textContent = label;
        line.className = `tile__status tile__status--${tone}`;
        tile.classList.toggle('tile--attention', needsAttention);
        tile.querySelector('.tile__flag')?.remove();
        if (needsAttention) {
          const flag = document.createElement('span');
          flag.className = 'tile__flag';
          flag.textContent = 'Needs attention';
          link.append(flag);
        }
        // Live: straight into the viewer. Anything else: the Review & build page, which explains it.
        link.href = status?.status === 'live' ? `?${q}` : `?status=1&${q}`;
        // A live city can take more files (wards, zones, landmarks…) at any time: a revision, built beside it.
        tile.querySelector('.tile__edit')?.remove();
        if (status?.status === 'live') {
          const edit = document.createElement('a');
          edit.className = 'tile__edit';
          edit.href = `?upload=1&revise=${encodeURIComponent(city.cityId)}&t=${encodeURIComponent(city.accessToken)}`;
          edit.textContent = '✎';
          edit.title = 'Add or change this city’s files';
          edit.setAttribute('aria-label', `Add or change files for ${name}`);
          tile.append(edit);
        }
        return status?.status === 'processing';
      };
    });

    listEl.append(makeTile({ href: '?upload=1', icon: '➕', name: 'Upload a city', modifier: 'add' }));

    async function refreshAll() {
      const building = await Promise.all(tiles.map((refresh) => refresh()));
      if (building.some(Boolean)) refreshTimer = setTimeout(refreshAll, REFRESH_WHILE_BUILDING_MS);
    }
    refreshAll();
  }

  render();
}
