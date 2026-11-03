// ===================================================================
// road-tile-builder.js -- sorts a city's road surfaces into tiles and
// triangulates them, so a large city's roads can be written as small
// files the viewer loads around the camera (server/lib/roadTiles.js)
// instead of one GeoJSON it has to download, parse and triangulate
// whole. Pure and DOM-free, like building-tile-builder.js.
//
// Why: Delhi with its satellite cities is 3.16 lakh roads in
// OpenStreetMap -- 436 MB as GeoJSON and 1.48 crore triangles (as tiles:
// 144 MB and 68 lakh, see roadTiles.js for the difference). Kanpur's own
// road survey, which RoadLayer loads whole, is 21 thousand roads, 29 MB
// and 5.2 lakh triangles.
//
// The geometry is exactly what RoadLayer builds in the browser from a
// GeoJSON roads layer: every ring of every road is projected with the
// same projector, triangulated with the same function, and put in the
// tile its first point falls in.
//
// Two bands, each on its own grid and in its own files, because they are
// wanted at very different distances:
//   major -- class 0 and 1 (motorway to tertiary): 9% of Delhi's roads,
//            the ones that still read from far away. Tiles four times
//            the building tile size, so a whole metro is a few dozen
//            meshes.
//   local -- class 2 (residential streets, service roads): the other
//            91%, under a pixel wide beyond a few kilometres. Tiles the
//            size of the building tiles.
// ===================================================================
import * as THREE from 'three';
import { makeProjector, projectRingFlat, collectRings } from './geo-utils.js';
import { Growable } from './building-tile-builder.js';
import { normalizeLabelName } from '../config/constants.js';

export const ROAD_BANDS = Object.freeze({
  major: Object.freeze({ tiers: [0, 1], gridFactor: 4 }),
  local: Object.freeze({ tiers: [2], gridFactor: 1 }),
});
const BAND_OF_TIER = ['major', 'major', 'local'];

/** A road's class tier, as RoadLayer reads it: 0 and 1 are themselves, everything else (including no class at all) is local. */
export function roadTier(cls) {
  return cls === 0 ? 0 : cls === 1 ? 1 : 2;
}

function newTier(tier) {
  return {
    tier, count: 0,
    xz: new Growable(Float32Array), end: new Growable(Uint32Array), index: new Growable(Uint32Array),
    names: [], lengthM: [], areaM2: [], wardId: [], zoneId: [],
    minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity,
  };
}

/**
 * Takes road features one at a time (nothing here holds on to a feature
 * once add() returns) and keeps each tile's roads in a few growing arrays.
 *
 * @param {{origin: {lon: number, lat: number}, tileSizeM: number}} params - the city's origin and building tile size
 * @returns {{add(feature: GeoJSON.Feature): void, result(): {
 *   bands: Record<'major'|'local', {tileSizeM: number, tiles: Map<string, {ix: number, iz: number, tiers: Array<object|null>}>}>,
 *   names: Array<{name: string, x: number, z: number, rings: Float32Array[]}>,
 *   stats: {roads: number, pieces: number, skippedDegenerate: number, vertices: number, triangles: number}}}}
 *   `names`: one entry per distinct road name, for search -- where its first
 *   road is and that road's outline, which is what LabelLayer takes from a
 *   GeoJSON roads layer.
 */
export function createRoadTileBucketer({ origin, tileSizeM }) {
  const project = makeProjector(origin);
  const bands = Object.fromEntries(Object.entries(ROAD_BANDS).map(([name, b]) => [name, { tileSizeM: tileSizeM * b.gridFactor, tiles: new Map() }]));
  const names = new Map();
  const stats = { roads: 0, pieces: 0, skippedDegenerate: 0, vertices: 0, triangles: 0 };

  function add(feature) {
    const p = feature.properties || {};
    const tier = roadTier(p.class);
    const band = bands[BAND_OF_TIER[tier]];
    const outlines = [];
    stats.roads++;

    for (const ring of collectRings(feature)) {
      const flat = projectRingFlat(ring, project);
      const n = flat.length / 2;
      if (n < 3) { stats.skippedDegenerate++; continue; }
      outlines.push(flat);

      let tris = [];
      const shapePts = new Array(n);
      for (let i = 0; i < n; i++) shapePts[i] = new THREE.Vector2(flat[i * 2], flat[i * 2 + 1]);
      try { tris = THREE.ShapeUtils.triangulateShape(shapePts, []); } catch { tris = []; }
      if (tris.length === 0) { stats.skippedDegenerate++; continue; }

      const ix = Math.floor(flat[0] / band.tileSizeM), iz = Math.floor(flat[1] / band.tileSizeM);
      const key = `${ix},${iz}`;
      let tile = band.tiles.get(key);
      if (!tile) { tile = { ix, iz, tiers: [null, null, null] }; band.tiles.set(key, tile); }
      const t = (tile.tiers[tier] ??= newTier(tier));

      const base = t.xz.length / 2;
      t.xz.pushAll(flat);
      for (let i = 0; i < n; i++) {
        const x = flat[i * 2], z = flat[i * 2 + 1];
        if (x < t.minX) t.minX = x; if (x > t.maxX) t.maxX = x;
        if (z < t.minZ) t.minZ = z; if (z > t.maxZ) t.maxZ = z;
      }
      for (const [a, b, c] of tris) {
        // Every triangle is wound to face up, so the viewer can give the whole mesh one upward normal instead of working normals out per vertex.
        const up = (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]) - (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]);
        t.index.push(base + a);
        t.index.push(base + (up < 0 ? c : b));
        t.index.push(base + (up < 0 ? b : c));
      }
      t.end.push(base + n);
      t.names.push(p.name || '');
      t.lengthM.push(p.length_m ?? null); t.areaM2.push(p.area_m2 ?? null); t.wardId.push(p.ward_id ?? null); t.zoneId.push(p.zone_id ?? null);
      t.count++;
      stats.pieces++; stats.vertices += n; stats.triangles += tris.length;
    }

    const key = normalizeLabelName(p.name);
    if (key && outlines.length && !names.has(key)) {
      const first = outlines[0];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < first.length; i += 2) {
        minX = Math.min(minX, first[i]); maxX = Math.max(maxX, first[i]);
        minZ = Math.min(minZ, first[i + 1]); maxZ = Math.max(maxZ, first[i + 1]);
      }
      names.set(key, { name: p.name, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, rings: outlines });
    }
  }

  return { add, result: () => ({ bands, names: [...names.values()], stats }) };
}

/**
 * One tile's finished tiers, in the shape road-tile-format.js writes: exact-size arrays (views of the bucket's own, not copies).
 * @param {{tiers: Array<object|null>}} tile - from createRoadTileBucketer().result()
 */
export function roadTilePayload(tile) {
  return tile.tiers.filter(Boolean).map((t) => ({
    tier: t.tier,
    xz: t.xz.data.subarray(0, t.xz.length), end: t.end.data.subarray(0, t.end.length), index: t.index.data.subarray(0, t.index.length),
    bounds: [t.minX, t.minZ, t.maxX, t.maxZ],
    names: t.names, lengthM: t.lengthM, areaM2: t.areaM2, wardId: t.wardId, zoneId: t.zoneId,
  }));
}
