// ===================================================================
// coastline.js -- sea polygons for a coastal city's bounding box.
//
// OpenStreetMap never maps the sea as an area: it maps the COASTLINE, as
// natural=coastline ways drawn with the land on their left and the water
// on their right. Without this, Mumbai, Chennai, Kochi, Visakhapatnam,
// Surat, Puducherry... would render with no Arabian Sea / Bay of Bengal at
// all -- just bare ground where the water is. (Rivers, lakes and creeks
// are proper areas and come through classifyArea() as usual.)
//
// Method -- the standard one for a clip rectangle:
//   1. join coastline ways end-to-start into continuous chains;
//   2. clip each chain to the bounding box: every piece now enters and
//      leaves through the box's edge (or is a closed island inside it);
//   3. walk: follow a piece to where it leaves the box, then go CLOCKWISE
//      along the box edge -- which keeps the water on the right -- to the
//      next piece's entry point, follow that piece, and so on until the
//      loop closes. Each loop is one sea polygon;
//   4. islands (closed rings, land inside = counter-clockwise) become
//      holes in whichever sea polygon contains them.
// Broken coastline data (a chain ending inside the box) yields no sea
// rather than a wrong one: an invisible sea is a smaller error than a
// flooded city.
// ===================================================================
import { bboxClip } from '@turf/turf';

const EPS = 1e-9;
const same = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const isClosed = (c) => c.length >= 4 && same(c[0], c[c.length - 1]);

/** Joins directed segments whose end meets another's start -- never reversing any, since direction is what says which side is water. */
function chain(lines) {
  const pool = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  const chains = [];
  while (pool.length) {
    let c = pool.shift();
    for (let grew = true; grew && !isClosed(c);) {
      grew = false;
      const i = pool.findIndex((s) => same(s[0], c[c.length - 1]));
      if (i !== -1) { c = c.concat(pool.splice(i, 1)[0].slice(1)); grew = true; continue; }
      const j = pool.findIndex((s) => same(s[s.length - 1], c[0]));
      if (j !== -1) { c = pool.splice(j, 1)[0].concat(c.slice(1)); grew = true; }
    }
    chains.push(c);
  }
  return chains;
}

/** Shoelace sum: > 0 means counter-clockwise (x east, y north). */
function signedArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return s / 2;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * @param {number[][][]} coastlines - LineString coordinate arrays of natural=coastline ways, in OSM's own direction
 * @param {{west:number, south:number, east:number, north:number}} bbox
 * @returns {{polygons: number[][][][], warning: string|null}} sea polygons (GeoJSON Polygon coordinate arrays)
 */
export function seaPolygons(coastlines, bbox) {
  if (!coastlines.length) return { polygons: [], warning: null };
  const { west: W, south: S, east: E, north: N } = bbox;

  // Position along the box edge, clockwise from the north-west corner:
  // top 0..1 (W->E), right 1..2 (N->S), bottom 2..3 (E->W), left 3..4 (S->N).
  const edgeT = ([x, y]) => {
    if (Math.abs(y - N) < EPS) return (x - W) / (E - W);
    if (Math.abs(x - E) < EPS) return 1 + (N - y) / (N - S);
    if (Math.abs(y - S) < EPS) return 2 + (E - x) / (E - W);
    if (Math.abs(x - W) < EPS) return 3 + (y - S) / (N - S);
    return null;
  };
  const CORNERS = [[W, N], [E, N], [E, S], [W, S]]; // at t = 0, 1, 2, 3

  const pieces = [];
  const islands = [];
  for (const c of chain(coastlines)) {
    const clipped = bboxClip({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } }, [W, S, E, N]).geometry;
    const parts = clipped.type === 'LineString' ? [clipped.coordinates] : clipped.coordinates;
    for (const p of parts) {
      if (p.length < 2) continue;
      if (isClosed(p) && edgeT(p[0]) === null) { islands.push(p); continue; }
      const tIn = edgeT(p[0]), tOut = edgeT(p[p.length - 1]);
      if (tIn === null || tOut === null) return { polygons: [], warning: 'coastline data is broken inside this area (a coastline stops mid-way), so the sea was left out' };
      pieces.push({ coords: p, tIn, tOut });
    }
  }

  const seaRings = [];
  const used = new Set();
  for (let start = 0; start < pieces.length; start++) {
    if (used.has(start)) continue;
    const ring = [];
    for (let cur = start; !used.has(cur);) {
      used.add(cur);
      for (const c of pieces[cur].coords) ring.push(c); // not push(...coords): a long coastline has more points than a call can take as arguments
      const tOut = pieces[cur].tOut;
      let next = -1, gap = Infinity;
      pieces.forEach((pc, j) => {
        const d = (((pc.tIn - tOut) % 4) + 4) % 4;
        if (d < gap) { gap = d; next = j; }
      });
      for (let c = Math.floor(tOut) + 1; c < tOut + gap; c++) ring.push(CORNERS[c % 4]);
      cur = next;
    }
    ring.push(ring[0]);
    if (ring.length >= 4) seaRings.push(ring);
  }

  // Coastline that never crosses the box edge: the box is all land (a
  // lake shore tagged as coastline is a data error) unless it contains
  // islands -- then it's sea around them (e.g. a box drawn over a harbour).
  const landRings = islands.filter((r) => signedArea(r) > 0);
  if (!seaRings.length && landRings.length) seaRings.push([[W, N], [E, N], [E, S], [W, S], [W, N]]);
  for (const r of islands) if (signedArea(r) < 0) seaRings.push(r); // closed ring with water inside: an enclosed sea/lagoon

  const polygons = seaRings.map((r) => [r]);
  for (const island of landRings) polygons.find(([outer]) => pointInRing(island[0], outer))?.push(island);
  return { polygons, warning: null };
}
