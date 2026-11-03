// @ts-check
// ===================================================================
// road-tile-format.js -- one road tile as a single binary blob, written
// by the server when it builds a large city (server/lib/roadTiles.js)
// and read by RoadLayer. The counterpart of tile-binary-format.js for
// roads.
//
// A tile holds one or more class tiers (0 = major, 1 = secondary,
// 2 = local -- RoadLayer's class0/class1/class2). For each tier:
//   xz    Float32  every road's outline, end to end: [x, z, x, z, ...]
//                  in scene metres. A road's outline points ARE its
//                  vertices: the mesh is drawn from them with `index`,
//                  and the click/search highlight traces them.
//   end   Uint32   per road: the vertex where its outline ends (it
//                  starts where the road before it ends)
//   index Uint32   triangles, three vertex numbers each
// plus, in the header, what is shown when a road is clicked: `names`,
// and a municipal survey's lengthM / areaM2 / wardId / zoneId when it
// has them.
//
// Layout: [Uint32 header length][header JSON][tier 0: xz, end, index]
// [tier 1: ...]. The header is padded with spaces so that every array
// starts on a 4-byte boundary, which lets the reader use the downloaded
// bytes as they are instead of copying them.
// ===================================================================

export const ROAD_TILE_VERSION = 1;
/** Per-road properties kept besides the name, in the header, when any road in the tier has one. */
const EXTRA_FIELDS = ['lengthM', 'areaM2', 'wardId', 'zoneId'];

/**
 * @param {Array<{tier: number, xz: Float32Array, end: Uint32Array, index: Uint32Array, bounds: number[], names: string[],
 *   lengthM?: Array, areaM2?: Array, wardId?: Array, zoneId?: Array}>} tiers - `bounds` is [minX, minZ, maxX, maxZ] of xz
 * @returns {Uint8Array}
 */
export function encodeRoadTile(tiers) {
  const header = {
    v: ROAD_TILE_VERSION,
    tiers: tiers.map((t) => ({
      tier: t.tier, roads: t.end.length, verts: t.xz.length / 2, indices: t.index.length, bounds: t.bounds, names: t.names,
      ...Object.fromEntries(EXTRA_FIELDS.filter((k) => t[k]?.some((v) => v != null)).map((k) => [k, t[k]])),
    })),
  };
  let headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - (headerBytes.length % 4)) % 4;
  if (pad) headerBytes = new TextEncoder().encode(JSON.stringify(header) + ' '.repeat(pad));

  let total = 4 + headerBytes.length;
  for (const t of tiers) total += t.xz.byteLength + t.end.byteLength + t.index.byteLength;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);
  let w = 4 + headerBytes.length;
  for (const t of tiers) {
    for (const arr of [t.xz, t.end, t.index]) {
      out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), w);
      w += arr.byteLength;
    }
  }
  return out;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Array<{tier: number, roads: number, xz: Float32Array, end: Uint32Array, index: Uint32Array, bounds: number[], names: string[],
 *   lengthM: Array|null, areaM2: Array|null, wardId: Array|null, zoneId: Array|null}>}
 *   The arrays are views of `buffer` itself where its alignment allows (a fetched ArrayBuffer always does).
 */
export function decodeRoadTile(buffer) {
  // A plain Uint8Array view even for a Node Buffer: Buffer#slice() returns a view, not a copy, so the copying fallback
  // in take() below would otherwise wrap the Buffer's whole (often pooled) memory instead of one array (see tile-binary-format.js).
  const bytes = buffer instanceof Uint8Array ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)));
  if (header.v !== ROAD_TILE_VERSION) throw new Error(`road tile format ${header.v}, expected ${ROAD_TILE_VERSION}`);

  let offset = 4 + headerLen;
  /** @template {Float32ArrayConstructor|Uint32ArrayConstructor} T @param {T} ArrayType @param {number} count @returns {InstanceType<T>} */
  const take = (ArrayType, count) => {
    const byteLen = count * ArrayType.BYTES_PER_ELEMENT;
    const aligned = (bytes.byteOffset + offset) % ArrayType.BYTES_PER_ELEMENT === 0;
    const source = /** @type {ArrayBuffer} */ (aligned ? bytes.buffer : bytes.slice(offset, offset + byteLen).buffer);
    const arr = /** @type {InstanceType<T>} */ (aligned ? new ArrayType(source, bytes.byteOffset + offset, count) : new ArrayType(source));
    offset += byteLen;
    return arr;
  };
  return header.tiers.map((t) => ({
    tier: t.tier, roads: t.roads,
    xz: take(Float32Array, t.verts * 2), end: take(Uint32Array, t.roads), index: take(Uint32Array, t.indices),
    bounds: t.bounds, names: t.names,
    ...Object.fromEntries(EXTRA_FIELDS.map((k) => [k, t[k] ?? null])),
  }));
}
