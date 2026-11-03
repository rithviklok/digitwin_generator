// @ts-check
// ===================================================================
// tile-binary-format.js — encodes/decodes one tile's finished geometry
// buffers (the exact {wall, windowWall, roof, outline, meta} shape
// building-tile-builder.js's buildTileBuffers() returns) as a single
// binary blob:
//
//   [Uint32 LE header length][header JSON][part fields, raw typed-array bytes]
//
// The header holds element counts (plus meta.count), so decode knows how
// many elements each typed array holds; byte lengths follow from each
// field's fixed dtype below. Parts and fields are written in a fixed order.
//
// This is what lets the offline build script write ready-to-render
// geometry to disk, and the browser (or a Node harness) read it back with
// no JSON.parse of coordinate data and no re-triangulation -- just fetch
// bytes, decode, hand straight to a BufferGeometry.
//
// Why decoding reads arrays IN PLACE where it can: a full-detail tile is
// up to ~17 MB, and copying it field by field cost several milliseconds of
// the ~6 ms per-frame budget BuildingLayer gives tile builds. A typed
// array can only view bytes that start on a multiple of its element size,
// so the encoder pads the header with spaces (valid JSON whitespace, so
// older decoders still read the file) to put the first field on a 4-byte
// boundary. Every geometry field is 4-byte typed, so all of them line up;
// only the few small fields after meta's Uint8 columns can fall off the
// boundary, and those are copied. Tiles baked before the padding existed
// still decode -- they are simply copied where they don't line up.
//
// No parsing library needed: both writer and reader are ours, and the
// schema is fixed (this is a tile format, not a generic serializer).
// ===================================================================

/**
 * @typedef {'f32'|'i32'|'u8'} TileFieldDtype
 *
 * @typedef {Object} TileMeshPart  One mesh's vertex attributes (non-indexed triangles).
 * @property {Float32Array} position     [x, y, z] per vertex, scene metres
 * @property {Float32Array} [color]      [r, g, b] per vertex (outline has none)
 * @property {Float32Array} [uv]         windowWall only: [u, v] per vertex, in window cells
 * @property {Float32Array} [buildingId] per vertex: the building's index within the tile (float, because it is a vertex attribute)
 * @property {Float32Array} [normal]     [x, y, z] per vertex, flat-shaded
 *
 * @typedef {Object} PackedBuildingMeta  Per-building metadata, column-wise (one entry per building unless noted).
 * @property {Float32Array} ringFlat         every footprint end to end, [x, z, x, z, ...]
 * @property {Int32Array}   ringOffsets      count + 1 entries: building i's footprint is ringFlat[ringOffsets[i] .. ringOffsets[i+1])
 * @property {Float32Array} heights          metres
 * @property {Uint8Array}   typeCode         building-style.js TYPE_KEY_CODES
 * @property {Uint8Array}   heightStatusCode building-style.js HEIGHT_STATUS_CODES
 * @property {Uint8Array}   roofIsFastFan    1 = the roof is a triangle fan of the footprint (no stored triangles)
 * @property {Int32Array}   roofTriIndex     corner indices into the building's own footprint, three per triangle, end to end
 * @property {Int32Array}   roofTriOffsets   count + 1 entries into roofTriIndex
 * @property {number}       count            number of buildings
 *
 * @typedef {Object} TilePayload
 * @property {TileMeshPart|null} wall
 * @property {TileMeshPart|null} windowWall
 * @property {TileMeshPart|null} roof
 * @property {TileMeshPart|null} outline
 * @property {PackedBuildingMeta|null} meta
 */

/** @type {Record<TileFieldDtype, Float32ArrayConstructor|Int32ArrayConstructor|Uint8ArrayConstructor>} */
const DTYPE_CTOR = { f32: Float32Array, i32: Int32Array, u8: Uint8Array };

// Field name -> dtype, per part. Order here is the order fields are
// written/read within a part; PART_ORDER is the order parts are written.
/** @type {Record<string, Record<string, TileFieldDtype>>} */
const PART_SCHEMAS = {
  wall: { position: 'f32', color: 'f32', buildingId: 'f32', normal: 'f32' },
  windowWall: { position: 'f32', color: 'f32', uv: 'f32', buildingId: 'f32', normal: 'f32' },
  roof: { position: 'f32', color: 'f32', buildingId: 'f32', normal: 'f32' },
  outline: { position: 'f32' },
  meta: {
    ringFlat: 'f32', ringOffsets: 'i32', heights: 'f32', typeCode: 'u8',
    heightStatusCode: 'u8', roofIsFastFan: 'u8', roofTriIndex: 'i32', roofTriOffsets: 'i32',
  },
};
/** @type {ReadonlyArray<keyof TilePayload>} */
const PART_ORDER = ['wall', 'windowWall', 'roof', 'outline', 'meta'];

/** The first field must start on this boundary for every 4-byte field of a part to be readable in place. */
const FIELD_ALIGNMENT = 4;

// One shared encoder/decoder: they are stateless, and the browser decodes
// hundreds of tiles a session -- no reason to construct one per tile.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * @param {TilePayload} payload same shape buildTileBuffers() returns
 * @returns {Uint8Array}
 */
export function encodeTilePayload(payload) {
  /** @type {{parts: Record<string, Record<string, number>|null>}} */
  const header = { parts: {} };
  /** @type {Uint8Array[]} */
  const chunks = [];

  for (const partName of PART_ORDER) {
    const part = /** @type {Record<string, any>|null} */ (payload[partName]);
    if (!part) { header.parts[partName] = null; continue; }
    const schema = PART_SCHEMAS[partName];
    /** @type {Record<string, number>} */
    const fieldCounts = {};
    for (const field of Object.keys(schema)) {
      const arr = part[field];
      if (!arr) continue; // e.g. windowWall's fields are all-or-nothing in practice, but stay defensive
      fieldCounts[field] = arr.length;
      chunks.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
    }
    if (partName === 'meta') fieldCounts.count = part.count;
    header.parts[partName] = fieldCounts;
  }

  // Trailing spaces are JSON whitespace: the header still parses everywhere,
  // and the fields after it start on a 4-byte boundary (see the file comment).
  let headerJson = JSON.stringify(header);
  const unpaddedLength = textEncoder.encode(headerJson).length;
  headerJson += ' '.repeat((FIELD_ALIGNMENT - ((4 + unpaddedLength) % FIELD_ALIGNMENT)) % FIELD_ALIGNMENT);
  const headerBytes = textEncoder.encode(headerJson);

  let total = 4 + headerBytes.length;
  for (const c of chunks) total += c.length;

  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);
  let w = 4 + headerBytes.length;
  for (const c of chunks) { out.set(c, w); w += c.length; }
  return out;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer - a fetched ArrayBuffer, or bytes read in Node (a Buffer is fine)
 * @returns {TilePayload} Arrays are views of `buffer` itself wherever their bytes line up for their type (always, for
 *   the geometry of a tile baked with the padded header), copies otherwise. Don't modify `buffer` while they are in use.
 */
export function decodeTilePayload(buffer) {
  // A plain Uint8Array view, never a Node Buffer: Buffer#slice() returns a
  // VIEW, not a copy, so the copying fallback below would otherwise wrap the
  // whole underlying (often pooled) ArrayBuffer instead of one field -- the
  // reason --bounds-only used to copy every file into a fresh ArrayBuffer first.
  const bytes = buffer instanceof Uint8Array
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const header = JSON.parse(textDecoder.decode(bytes.subarray(4, 4 + headerLen)));

  let offset = 4 + headerLen;
  /** @type {Record<string, any>} */
  const out = {};
  for (const partName of PART_ORDER) {
    const fieldCounts = header.parts[partName];
    if (!fieldCounts) { out[partName] = null; continue; }
    const schema = PART_SCHEMAS[partName];
    /** @type {Record<string, any>} */
    const part = {};
    for (const field of Object.keys(schema)) {
      const count = fieldCounts[field];
      if (count === undefined) continue;
      const Ctor = DTYPE_CTOR[schema[field]];
      const byteLen = count * Ctor.BYTES_PER_ELEMENT;
      const inPlace = (bytes.byteOffset + offset) % Ctor.BYTES_PER_ELEMENT === 0;
      part[field] = inPlace
        ? new Ctor(/** @type {ArrayBuffer} */ (bytes.buffer), bytes.byteOffset + offset, count)
        : new Ctor(/** @type {ArrayBuffer} */ (bytes.slice(offset, offset + byteLen).buffer)); // a typed array can't view misaligned bytes: copy just this field
      offset += byteLen;
    }
    if (partName === 'meta') part.count = fieldCounts.count;
    out[partName] = part;
  }
  return /** @type {TilePayload} */ (out);
}
