// @ts-check
// ===================================================================
// building-meta.js -- one tile's per-building metadata (footprint,
// height, type, roof triangles), read straight from the packed columns
// the tile already carries (tile-binary-format.js's PackedBuildingMeta).
//
// Why not one JavaScript object per building: that is what the layer used
// to build for every tile it bound, and measured on Kanpur's coarse tier
// alone (6.2 lakh buildings, the tiles loaded at boot) it cost 156 MB of
// JavaScript heap and 233 ms of main-thread work during boot -- repeated
// for every medium/full tier bound afterwards, inside the per-frame build
// budget. Yet only two things ever read it: a click (ONE building) and the
// shadow bake (which walks the packed columns directly, ShadowLayer.js).
// So records are made on demand, one per get(), and the table itself is
// just a handful of typed-array references.
// ===================================================================
import { TYPE_KEY_BY_CODE } from '../workers/building-style.js';

/**
 * @typedef {import('../workers/tile-binary-format.js').PackedBuildingMeta} PackedBuildingMeta
 * @typedef {import('../workers/building-style.js').BuildingTypeKey} BuildingTypeKey
 *
 * @typedef {Object} BuildingRecord  One building, as click-to-inspect and the selection cage need it.
 * @property {Float32Array} flat              its footprint, [x, z, x, z, ...] in scene metres (a view, not a copy)
 * @property {number} n                       footprint corner count
 * @property {number} height                  metres
 * @property {BuildingTypeKey|null} typeKey   broad use, for the roof tint and the inspect card
 * @property {Array<[number, number, number]>|null} roofTris  roof triangles as corner indices; null = a fan of the footprint
 */

export class BuildingMetaTable {
  /** @param {PackedBuildingMeta|null|undefined} packed - a decoded tile's `meta` part (null for a tile with no buildings) */
  constructor(packed) {
    /** @type {PackedBuildingMeta|null} */
    this.packed = packed ?? null;
    /** Number of buildings; the `buildingId` vertex attribute indexes into 0..length-1. */
    this.length = packed?.count ?? 0;
  }

  /**
   * @param {number} i - a building's index in its tile (the value of the hit vertex's `buildingId` attribute)
   * @returns {BuildingRecord|null} null when `i` isn't a building of this tile
   */
  get(i) {
    const p = this.packed;
    if (!p || !Number.isInteger(i) || i < 0 || i >= this.length) return null;
    const start = p.ringOffsets[i], end = p.ringOffsets[i + 1];
    /** @type {Array<[number, number, number]>|null} */
    let roofTris = null;
    if (!p.roofIsFastFan[i]) {
      roofTris = [];
      for (let k = p.roofTriOffsets[i], te = p.roofTriOffsets[i + 1]; k < te; k += 3) {
        roofTris.push([p.roofTriIndex[k], p.roofTriIndex[k + 1], p.roofTriIndex[k + 2]]);
      }
    }
    return {
      flat: p.ringFlat.subarray(start, end),
      n: (end - start) / 2,
      height: p.heights[i],
      typeKey: TYPE_KEY_BY_CODE[p.typeCode[i]] ?? null,
      roofTris,
    };
  }
}
