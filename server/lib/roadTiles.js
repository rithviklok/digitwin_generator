// ===================================================================
// roadTiles.js -- writes a large city's roads as tiles the viewer loads
// around the camera, instead of one roads.geojson it would have to
// download, parse and triangulate whole at every first load.
//
//   <dir>/manifest.json          what RoadLayer reads first: both bands' tiles
//   <dir>/major/<ix>_<iz>.bin    class 0 and 1 roads, on a grid 4x the building tiles
//   <dir>/local/<ix>_<iz>.bin    class 2 roads, on the building tiles' grid
//   <dir>/names.json             one entry per distinct road name, for search
//
// The sorting and triangulating is src/workers/road-tile-builder.js, the
// file layout src/workers/road-tile-format.js; this file only decides
// when and writes to disk.
// ===================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoadTileBucketer, roadTilePayload, ROAD_BANDS } from '../../src/workers/road-tile-builder.js';
import { encodeRoadTile } from '../../src/workers/road-tile-format.js';

/** The roads layer's folder in a built city when its roads are tiles (its file is roads.geojson when they aren't). */
export const ROAD_TILES_DIR = 'roads';

/**
 * From this many roads up, a city's roads are written as tiles. Below it
 * they stay one roads.geojson, loaded whole, exactly as before: Kanpur's
 * own survey is 21 thousand roads and OpenStreetMap has 26 thousand for
 * central Kanpur, both of which load in a few seconds. Delhi with its
 * satellite cities is 3.16 lakh.
 */
export const ROAD_TILES_MIN_ROADS = 60_000;

/**
 * How finely the round ends and bends of a widened road are drawn in
 * tiles (turf's `steps`: segments per quarter circle; roads.geojson keeps
 * turf's default of 8). At 2 a road is 27 outline points instead of 52,
 * which halves every tile and every triangle count, and the end of a
 * 3.75 m street differs from a true half-circle by 14 cm.
 */
export const ROAD_TILE_BUFFER_STEPS = 2;

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * @param {{dir: string, origin: {lon: number, lat: number}, tileSizeM: number}} opts - `dir` is created; origin and tileSizeM are the city's own
 * @returns {{write(feature: GeoJSON.Feature): void, close(): {roads: number, triangles: number, tiles: number, bytes: number}}}
 *   `write` takes road SURFACES (Polygon / MultiPolygon, `class` and `name` in properties) one at a time; `close` writes every file.
 */
export function createRoadTileWriter({ dir, origin, tileSizeM }) {
  const bucketer = createRoadTileBucketer({ origin, tileSizeM });

  function close() {
    const { bands, names, stats } = bucketer.result();
    const manifest = {
      format: 'road-tiles', version: 1, origin, tileSizeM,
      roads: stats.roads, pieces: stats.pieces, triangles: stats.triangles,
      bands: {}, names: 'names.json', generatedAt: new Date().toISOString(),
    };
    let bytes = 0, tileCount = 0;
    for (const [bandName, band] of Object.entries(bands)) {
      mkdirSync(join(dir, bandName), { recursive: true });
      const tiles = [];
      for (const tile of band.tiles.values()) {
        const payload = roadTilePayload(tile);
        const encoded = encodeRoadTile(payload);
        const url = `${bandName}/${tile.ix}_${tile.iz}.bin`;
        writeFileSync(join(dir, url), encoded);
        tiles.push({
          ix: tile.ix, iz: tile.iz, url, byteSize: encoded.length,
          roads: payload.reduce((n, t) => n + t.end.length, 0), triangles: payload.reduce((n, t) => n + t.index.length / 3, 0),
          // Of the roads themselves, not of the grid cell: a road belongs to the tile its first point is in and may run on beyond it.
          bounds: [Math.min(...payload.map((t) => t.bounds[0])), Math.min(...payload.map((t) => t.bounds[1])), Math.max(...payload.map((t) => t.bounds[2])), Math.max(...payload.map((t) => t.bounds[3]))].map(round2),
        });
        tile.tiers = []; // written: let its arrays go
        bytes += encoded.length;
        tileCount++;
      }
      manifest.bands[bandName] = { tileSizeM: band.tileSizeM, classes: ROAD_BANDS[bandName].tiers, tiles };
    }
    const nameIndex = names.map((n) => ({ name: n.name, x: round2(n.x), z: round2(n.z), rings: n.rings.map((flat) => Array.from(flat, round2)) }));
    writeFileSync(join(dir, manifest.names), JSON.stringify(nameIndex));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    return { roads: stats.roads, triangles: stats.triangles, tiles: tileCount, bytes };
  }

  mkdirSync(dir, { recursive: true });
  return { write: (feature) => bucketer.add(feature), close };
}
