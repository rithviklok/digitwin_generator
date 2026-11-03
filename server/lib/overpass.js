// ===================================================================
// overpass.js -- downloads OpenStreetMap data for a city's bounding box
// from the Overpass API, and converts Overpass's JSON into plain GeoJSON
// Features (OSM tags kept as `properties`), ready for osmSplitter.js.
//
// Hand-rolled rather than the `osmtogeojson` package: that pulls in XML/
// PBF parsers, a CLI arg parser and several pinned-old transitive deps,
// when all this needs is Overpass's own `out geom` JSON -- where every
// way and relation member already carries its coordinates inline -- plus
// one real algorithm (stitching multipolygon relation members into
// closed rings; big rivers and lakes are almost always relations).
//
// Public Overpass servers are frequently overloaded (504s, "server is
// probably too busy", timeouts are normal, not exceptional), and they
// ration each client to a few query "slots" that stay blocked for a while
// after every query. createOverpassClient() therefore spreads requests
// over a list of endpoints, keeps away from a server for as long as that
// server says (or, when it doesn't say, for a growing pause), and only
// then tries again.
// ===================================================================

import { OSM_QUERY_GROUPS, OSM_QUERY_TIMEOUT_S, buildOsmQuery } from '../../src/config/osm-query.js';

export { OSM_QUERY_GROUPS, buildOsmQuery };

const USER_AGENT = 'DigiTwin-Generator/0.1 (self-hosted city digital-twin builder)';

/**
 * Largest query cell, in degrees (~22 km at Indian latitudes). A small or
 * mid-sized city is one cell; a metro like Delhi or Bengaluru is split
 * into a few, because one metro-wide road query regularly exceeds a public
 * Overpass server's time/memory limits. Features on cell borders come back
 * from both cells and are de-duplicated by OSM id.
 */
const MAX_CELL_DEG = 0.2;

/**
 * @param {{west:number, south:number, east:number, north:number}} bbox
 * @param {number} [maxCellDeg] - a light query (a city's railway lines) can take a much larger cell than the default
 * @returns {Array<{west:number, south:number, east:number, north:number}>}
 */
export function splitBbox(bbox, maxCellDeg = MAX_CELL_DEG) {
  // Less a hair: 80.4 - 80.2 is 0.20000000000000284 in floating point, which would otherwise make two parts of an area exactly one cell wide.
  const nx = Math.max(1, Math.ceil((bbox.east - bbox.west) / maxCellDeg - 1e-9));
  const ny = Math.max(1, Math.ceil((bbox.north - bbox.south) / maxCellDeg - 1e-9));
  const dx = (bbox.east - bbox.west) / nx, dy = (bbox.north - bbox.south) / ny;
  const cells = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      cells.push({ west: bbox.west + i * dx, east: bbox.west + (i + 1) * dx, south: bbox.south + j * dy, north: bbox.south + (j + 1) * dy });
    }
  }
  return cells;
}

/**
 * Largest query cell per group, in degrees, where it isn't MAX_CELL_DEG
 * (which is sized for roads). Fewer, larger requests matter because the
 * public servers refuse more than half of all requests that come one
 * after another. Measured for Delhi with its satellite cities, 0.75 x 0.6
 * degrees, 2026-09-30: the roads are 3.16 lakh lines, up to 38 MB per
 * 0.2-degree cell; all the railway and metro lines together are 3,855
 * lines and 2 MB; all the areas and places 28,304 features and 25 MB,
 * never more than 6 MB per 0.2-degree cell.
 */
const GROUP_CELL_DEG = { railway: 1.5, areas: 0.4 };

/**
 * The parts each query group's download is asked for in, one request each.
 * @param {{west:number, south:number, east:number, north:number}} bbox
 * @param {string[]} [groups] - keys of OSM_QUERY_GROUPS; all of them by default
 * @returns {Record<string, Array<{west:number, south:number, east:number, north:number}>>}
 */
export function downloadParts(bbox, groups = Object.keys(OSM_QUERY_GROUPS)) {
  return Object.fromEntries(groups.map((g) => [g, splitBbox(bbox, GROUP_CELL_DEG[g])]));
}

/**
 * The most parts one build will ask the public servers for. Delhi with
 * its satellite cities is 17 (12 of roads, 4 of areas, 1 of railway); the
 * largest metropolitan regions in India (Pune, Bengaluru, Hyderabad: about
 * 1 x 1 degree) are about 35. Past 80 -- roughly 1.5 x 1.5 degrees -- the
 * area is a district or a state, not a city, or a rectangle dragged out by
 * mistake: downloading it would take hours of the volunteer-run servers'
 * time, so it isn't attempted (the uploader is told, and can still supply
 * the layers as files).
 */
export const MAX_DOWNLOAD_PARTS = 80;

/**
 * Which endpoints answer at all, checked cheaply (Overpass's own /status
 * page, 15 s each, all at once) before any real query. Any HTTP response
 * -- even an error page -- means reachable; only a network failure or
 * timeout doesn't. Lets a server with no internet access (or a firewall
 * blocking Overpass) fail in seconds with a clear message, instead of
 * burning the whole download timeout on retries that can't succeed.
 */
export async function reachableEndpoints(endpoints) {
  const checks = await Promise.all(endpoints.map(async (url) => {
    try {
      await fetch(url.replace(/\/interpreter\/?$/, '/status'), { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
      return url;
    } catch {
      return null;
    }
  }));
  return checks.filter(Boolean);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Overpass error pages wrap one useful line in licence boilerplate -- keep just that line, and name the common "overloaded" case plainly. */
function snippet(text) {
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/too busy|rate_limited|Too Many Requests/i.test(plain)) return 'server busy';
  const m = plain.match(/Error\s*:\s*(.*)/);
  return (m ? m[1] : plain).slice(0, 160);
}

/**
 * How long an Overpass server says this client must wait for a free query
 * slot, read from its /api/status page:
 *
 *   Rate limit: 2
 *   Slot available after: 2026-09-30T12:55:08Z, in 27 seconds.
 *   Slot available after: 2026-09-30T12:55:35Z, in 54 seconds.
 *
 * (or "2 slots available now."). A slot stays blocked for a while after
 * every query, longer after a heavy one, so a build that asks for a metro
 * in a dozen parts runs out of them; asking again before one is free only
 * earns another refusal.
 * @returns {number|null} seconds until the first slot; 0 if one is free now; null if the page doesn't say (not every server rations)
 */
export function slotWaitSeconds(statusText) {
  if (/\b[1-9]\d* slots? available now/.test(statusText)) return 0;
  const waits = [...statusText.matchAll(/Slot available after: \S+ in (-?\d+) seconds/g)].map((m) => Number(m[1]));
  return waits.length ? Math.max(0, Math.min(...waits)) : null;
}

/** Pauses when a server doesn't say how long it needs: longer each time it fails in a row, up to a ceiling. */
const BACKOFF_STEP_S = 20;
const BACKOFF_MAX_S = 120;
/** When a rate-limited server's status page can't be read or says nothing. */
const UNKNOWN_SLOT_WAIT_S = 30;

/**
 * One build's connection to the Overpass servers. `query()` POSTs one
 * query to whichever endpoint is free soonest, and when a server refuses
 * it keeps away from that server for as long as it needs:
 *   - HTTP 429 (no query slot left for this client): as long as the
 *     server's own status page says, see slotWaitSeconds();
 *   - anything else -- HTTP 504 "too busy", a dropped connection, a
 *     timeout, a result cut short (Overpass reports a query that ran out
 *     of time or memory as HTTP 200 with a `remark`; that is partial data,
 *     so it counts as a failure, never as a silently incomplete success):
 *     a pause that grows while that server keeps failing.
 * It waits only when every endpoint is being kept away from. Measured on a
 * Delhi-sized area on 2026-09-30, asking for its 36 parts one after
 * another: 93 requests for 36 answers (50 refused with 504, 7 with 429),
 * and a 0.1 MB railway part was refused as readily as a 38 MB road part --
 * the refusals are about slots and load, not about the size of the query.
 * With fixed 30 s and 60 s pauses that took 25 minutes; keeping away from
 * each server only as long as it needs, the 12 road parts took 5.5.
 *
 * @param {object} opts
 * @param {string[]} opts.endpoints
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.maxAttempts] - requests per query before giving up on it
 * @param {number} [opts.requestTimeoutMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - tests pass their own, with `now`, to run without waiting
 * @param {() => number} [opts.now]
 */
export function createOverpassClient({ endpoints, log = () => {}, maxAttempts = 12, requestTimeoutMs = (OSM_QUERY_TIMEOUT_S + 60) * 1000, sleep: pause = sleep, now = Date.now }) {
  const freeAt = new Map(endpoints.map((url) => [url, 0])); // when each endpoint may be asked again (epoch ms)
  const failsInARow = new Map(endpoints.map((url) => [url, 0]));
  const headers = { 'User-Agent': USER_AGENT };

  async function waitForSlot(url) {
    try {
      const res = await fetch(url.replace(/\/interpreter\/?$/, '/status'), { headers, signal: AbortSignal.timeout(10_000) });
      return slotWaitSeconds(await res.text()) ?? UNKNOWN_SLOT_WAIT_S;
    } catch {
      return UNKNOWN_SLOT_WAIT_S;
    }
  }

  return {
    /**
     * @param {string} query - Overpass QL
     * @param {{deadline?: number}} [opts] - epoch ms; no wait is started that would end after it (the error then has `outOfTime`)
     * @returns {Promise<{elements: object[]}>}
     */
    async query(query, { deadline = Infinity } = {}) {
      let lastErr = new Error('no Overpass endpoints configured');
      for (let attempt = 0; attempt < maxAttempts && endpoints.length; attempt++) {
        const url = endpoints.reduce((best, u) => (freeAt.get(u) < freeAt.get(best) ? u : best)); // free soonest; the list's order breaks ties
        const waitMs = freeAt.get(url) - now();
        if (waitMs > 0) {
          if (now() + waitMs > deadline) throw Object.assign(new Error(`out of time (last answer: ${lastErr.message})`), { outOfTime: true });
          log(`[osm]   all servers busy -- waiting ${Math.ceil(waitMs / 1000)}s before retrying`);
          await pause(waitMs);
        }
        const host = new URL(url).host;
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: `data=${encodeURIComponent(query)}`,
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
          const text = await res.text();
          if (res.status === 429) {
            const waitS = await waitForSlot(url);
            freeAt.set(url, now() + (waitS + 1) * 1000); // +1: the page counts in whole seconds
            throw Object.assign(new Error('HTTP 429: server busy'), { keptAway: true });
          }
          if (res.status === 400) throw Object.assign(new Error(`HTTP 400: ${snippet(text)}`), { fatal: true }); // the query itself is wrong: no server will take it
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${snippet(text)}`);
          if (!text.trimStart().startsWith('{')) throw new Error(`not JSON: ${snippet(text)}`);
          const json = JSON.parse(text);
          if (json.remark && /error/i.test(json.remark)) throw new Error(`incomplete result: ${json.remark}`);
          failsInARow.set(url, 0);
          log(`[osm]   ${host}: ${json.elements.length} elements (${(text.length / 1e6).toFixed(1)} MB)`);
          return json;
        } catch (err) {
          lastErr = err;
          log(`[osm]   ${host}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
          if (err.fatal) break;
          if (!err.keptAway) {
            const fails = failsInARow.get(url) + 1;
            failsInARow.set(url, fails);
            freeAt.set(url, now() + Math.min(BACKOFF_STEP_S * fails, BACKOFF_MAX_S) * 1000);
          }
        }
      }
      throw lastErr;
    },
  };
}

/** The `reason` to give explainMissingParts() when the build's time for downloading ran out. */
export const OUT_OF_TIME = 'out of time';

/** Why nothing was downloaded for an area past MAX_DOWNLOAD_PARTS, in the same form as explainMissingParts(). */
export function explainTooLarge(parts) {
  return `the area you drew is too large to download from OpenStreetMap: it would be asked for in ${parts} parts, and the most is ${MAX_DOWNLOAD_PARTS} (Delhi with Gurgaon, Noida, Ghaziabad and Faridabad is 17). Draw a smaller area when revising`;
}

/**
 * Why layers are missing after a download, for the uploader's Review &
 * build page. It is shown as "Missing because: <this>. You can add these
 * layers yourself...", so it starts in lower case and has no full stop at
 * the end.
 * @param {number} missing - parts of the area that couldn't be downloaded
 * @param {number} of - parts the area was asked for in
 * @param {string} reason - what stopped the last part: OUT_OF_TIME, or the client's error message
 */
export function explainMissingParts(missing, of, reason) {
  const busy = /busy|timed out|HTTP 5\d\d|terminated|fetch failed|incomplete result/.test(reason ?? '');
  if (reason !== OUT_OF_TIME && !busy) return `the download from OpenStreetMap failed (${reason})`;
  const cause = reason === OUT_OF_TIME ? 'the download ran out of time while OpenStreetMap’s servers were busy' : 'OpenStreetMap’s servers were too busy';
  if (of === 1) return `${cause}. Revise the city to try again`;
  if (missing === of) return `${cause}: none of this area’s ${of} parts could be downloaded. Revise the city to try again`;
  return `${cause}: ${missing} of this area’s ${of} parts couldn’t be downloaded. The rest ${of - missing === 1 ? 'is' : 'are'} kept for a week, so revising the city only asks for ${missing === 1 ? 'that one' : `those ${missing}`}`;
}

// ------------------------------------------------------------------
// Overpass JSON -> GeoJSON
// ------------------------------------------------------------------

/** natural=* values that are lines even when a way happens to close on itself. */
const LINEAR_NATURAL = new Set(['coastline', 'tree_row', 'cliff', 'ridge', 'arete', 'valley', 'gorge', 'earth_bank', 'gully']);

function isAreaWay(tags) {
  if (tags.area === 'yes') return true;
  if (tags.area === 'no') return false;
  return Boolean(tags.landuse || tags.leisure || tags.water || tags.amenity || tags.building ||
    tags.waterway === 'riverbank' || (tags.natural && !LINEAR_NATURAL.has(tags.natural)));
}

const toCoords = (geometry) => (geometry ?? []).filter(Boolean).map((p) => [p.lon, p.lat]);
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const isClosed = (ring) => ring.length >= 4 && samePoint(ring[0], ring[ring.length - 1]);

/** Joins way segments end-to-end into closed rings (a relation's outer boundary is routinely split across many ways, in any order and direction). Segments that can't be closed -- a broken or partially-downloaded relation -- are dropped rather than guessed at. */
function stitchRings(segments) {
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    while (!isClosed(ring)) {
      const end = ring[ring.length - 1];
      const i = pool.findIndex((s) => samePoint(s[0], end) || samePoint(s[s.length - 1], end));
      if (i === -1) break;
      const seg = pool.splice(i, 1)[0];
      ring = ring.concat((samePoint(seg[0], end) ? seg : seg.reverse()).slice(1));
    }
    if (isClosed(ring)) rings.push(ring);
  }
  return rings;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function multipolygonGeometry(members) {
  const ways = members.filter((m) => m.type === 'way' && m.geometry);
  const outers = stitchRings(ways.filter((m) => m.role !== 'inner').map((m) => toCoords(m.geometry)));
  const inners = stitchRings(ways.filter((m) => m.role === 'inner').map((m) => toCoords(m.geometry)));
  if (!outers.length) return null;
  const polygons = outers.map((outer) => [outer]);
  for (const inner of inners) {
    const owner = polygons.find(([outer]) => pointInRing(inner[0], outer));
    if (owner) owner.push(inner); // an inner ring outside every outer is invalid data -- dropped
  }
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

/**
 * @param {{elements: object[]}} json - an Overpass `[out:json] ... out geom;` response
 * @returns {GeoJSON.Feature[]} one Feature per tagged node / way / multipolygon relation; `id` is "node/123" etc., `properties` are the raw OSM tags
 */
export function overpassToFeatures(json) {
  const features = [];
  for (const el of json.elements ?? []) {
    if (!el.tags) continue; // untagged element -- only ever useful as part of something else
    const tags = el.tags;
    let geometry = null;

    if (el.type === 'node') {
      geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
    } else if (el.type === 'way') {
      const coords = toCoords(el.geometry);
      if (coords.length < 2) continue;
      geometry = isClosed(coords) && isAreaWay(tags)
        ? { type: 'Polygon', coordinates: [coords] }
        : { type: 'LineString', coordinates: coords };
    } else if (el.type === 'relation' && tags.type === 'multipolygon') {
      geometry = multipolygonGeometry(el.members ?? []);
    }

    if (geometry) features.push({ type: 'Feature', id: `${el.type}/${el.id}`, geometry, properties: { ...tags } });
  }
  return features;
}
