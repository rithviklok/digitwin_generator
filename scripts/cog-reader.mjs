// ===================================================================
// cog-reader.mjs -- reads blocks of a Cloud-Optimised GeoTIFF (COG) over
// HTTP range requests, for fetch-open-buildings.mjs.
//
// Why: Google's Open Buildings 2.5D height rasters are 12.5 km tiles of
// 100 MB to over 1 GB each (Kanpur needs 12 of them, 4.4 GB). A COG keeps
// every band and every overview level in its own 512 x 512 blocks, with an
// index of where each block sits at the start of the file, so a reader can
// download only the height band's blocks under a city's buildings.
//
// Reads what those files use and the common variants of it: classic TIFF
// or BigTIFF, either byte order, tiled, 32-bit float samples, Deflate or
// no compression, no predictor or the floating-point one, bands stored
// separately or interleaved. Anything else is refused with a message,
// never misread. No dependencies: zlib does the Deflate.
// ===================================================================
import { inflateSync } from 'node:zlib';
import { endianness } from 'node:os';

const TAG = {
  SUBFILE_TYPE: 254, WIDTH: 256, HEIGHT: 257, BITS_PER_SAMPLE: 258, COMPRESSION: 259,
  SAMPLES_PER_PIXEL: 277, PLANAR: 284, PREDICTOR: 317, TILE_WIDTH: 322, TILE_HEIGHT: 323,
  TILE_OFFSETS: 324, TILE_BYTE_COUNTS: 325, SAMPLE_FORMAT: 339,
  PIXEL_SCALE: 33550, TIEPOINT: 33922, GEO_KEYS: 34735, GDAL_NODATA: 42113,
};
/** Bytes per value of each TIFF field type. */
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
const COMPRESSION_NONE = 1, COMPRESSION_DEFLATE = 8, COMPRESSION_DEFLATE_OLD = 32946;
const PREDICTOR_NONE = 1, PREDICTOR_FLOAT = 3;
const PLANAR_SEPARATE = 2;
const SAMPLE_FORMAT_FLOAT = 3;
const GEOKEY_RASTER_TYPE = 1025, GEOKEY_PROJECTED_CRS = 3072, RASTER_PIXEL_IS_POINT = 2;
/** A COG keeps its image directories, and normally their block indexes, at the start of the file. Anything past this is fetched when needed. */
const HEADER_BYTES = 512 * 1024;
/** Blocks this close together in the file are fetched in one request: one round trip beats saving a few kB. */
const MERGE_GAP_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

if (endianness() !== 'LE') throw new Error('cog-reader.mjs assumes a little-endian machine (x86 or ARM)');

/**
 * @callback ReadRange
 * @param {number} offset @param {number} length
 * @returns {Promise<Uint8Array>} those bytes (fewer only at the end of the file)
 */

/**
 * One resolution level of the image (the full one, or an overview).
 * @typedef {object} CogImage
 * @property {number} width @property {number} height
 * @property {number} tileWidth @property {number} tileHeight
 * @property {number} tilesAcross @property {number} tilesDown
 * @property {number} pixelSizeX - map units per pixel, left to right
 * @property {number} pixelSizeY - map units per pixel, top to bottom (positive)
 * @property {number} samples - bands
 * @property {number} planar - 1: bands interleaved in each block; 2: each band in its own blocks
 * @property {number} compression @property {number} predictor
 * @property {Map<number, IfdEntry>} entries
 * @property {{offsets: Float64Array, counts: Float64Array}|null} index - where each block is, once read
 */

/** @typedef {{type: number, count: number, inline: Uint8Array|null, offset: number}} IfdEntry */

/** @param {Uint8Array} u8 */
const viewOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

export class Cog {
  /**
   * @param {ReadRange} readRange
   * @param {Uint8Array} head - the file's first bytes
   * @param {boolean} littleEndian @param {boolean} bigTiff
   */
  constructor(readRange, head, littleEndian, bigTiff) {
    this.readRange = readRange;
    this.head = head;
    this.le = littleEndian;
    this.big = bigTiff;
    /** @type {CogImage[]} full resolution first, then the overviews, finest to coarsest */
    this.images = [];
    /** Map position of the top-left corner of the top-left pixel. */
    this.originX = 0; this.originY = 0;
    /** EPSG code of the map projection, when the file says (null otherwise). */
    this.epsg = null;
    /** The no-data value, when the file says (NaN is always no data). */
    this.nodata = NaN;
  }

  /**
   * Reads the file's header and image directories.
   * @param {ReadRange} readRange
   * @returns {Promise<Cog>}
   */
  static async open(readRange) {
    const head = await readRange(0, HEADER_BYTES);
    if (head.length < 16) throw new Error('not a TIFF file (too short)');
    const le = head[0] === 0x49 && head[1] === 0x49;
    if (!le && !(head[0] === 0x4d && head[1] === 0x4d)) throw new Error('not a TIFF file');
    const dv = viewOf(head);
    const magic = dv.getUint16(2, le);
    if (magic !== 42 && magic !== 43) throw new Error('not a TIFF file');
    const cog = new Cog(readRange, head, le, magic === 43);
    await cog._readDirectories(cog.big ? Number(dv.getBigUint64(8, le)) : dv.getUint32(4, le));
    return cog;
  }

  /** @param {number} offset @param {number} length @returns {Promise<Uint8Array>} */
  async _bytes(offset, length) {
    if (offset + length <= this.head.length) return this.head.subarray(offset, offset + length);
    const got = await this.readRange(offset, length);
    if (got.length < length) throw new Error(`the file ends early (wanted ${length} bytes at ${offset})`);
    return got;
  }

  /** @param {number} firstOffset */
  async _readDirectories(firstOffset) {
    const le = this.le, big = this.big;
    const countSize = big ? 8 : 2, entrySize = big ? 20 : 12, nextSize = big ? 8 : 4, inlineSize = big ? 8 : 4;
    /** @type {Map<number, IfdEntry>[]} */
    const directories = [];
    const seen = new Set();
    for (let at = firstOffset; at && !seen.has(at); ) {
      seen.add(at); // a loop of directories would never end
      const countBytes = await this._bytes(at, countSize);
      const n = big ? Number(viewOf(countBytes).getBigUint64(0, le)) : viewOf(countBytes).getUint16(0, le);
      const body = await this._bytes(at + countSize, n * entrySize + nextSize);
      const v = viewOf(body);
      /** @type {Map<number, IfdEntry>} */
      const entries = new Map();
      for (let k = 0; k < n; k++) {
        const e = k * entrySize;
        const type = v.getUint16(e + 2, le);
        const count = big ? Number(v.getBigUint64(e + 4, le)) : v.getUint32(e + 4, le);
        const valueAt = e + (big ? 12 : 8);
        const size = (TYPE_SIZE[type] ?? 1) * count;
        entries.set(v.getUint16(e, le), size <= inlineSize
          ? { type, count, inline: body.subarray(valueAt, valueAt + size), offset: 0 }
          : { type, count, inline: null, offset: big ? Number(v.getBigUint64(valueAt, le)) : v.getUint32(valueAt, le) });
      }
      directories.push(entries);
      at = big ? Number(v.getBigUint64(n * entrySize, le)) : v.getUint32(n * entrySize, le);
    }
    if (!directories.length) throw new Error('the TIFF has no images');

    const full = directories[0];
    for (const entries of directories) {
      const subfile = (await this._values(entries, TAG.SUBFILE_TYPE))?.[0] ?? 0;
      if (entries !== full && (!(subfile & 1) || (subfile & 4))) continue; // keep the overviews; skip masks and other pages
      this.images.push(await this._image(entries));
    }
    this.images.sort((x, y) => y.width - x.width); // files list overviews in any order (Google's: coarsest first)
    const fullImage = this.images[0];
    for (const im of this.images) {
      if (im.samples !== fullImage.samples || im.planar !== fullImage.planar) throw new Error('an overview is laid out differently from the full image');
    }

    // Georeferencing (on the full image; overviews cover the same ground with bigger pixels).
    const scale = await this._values(full, TAG.PIXEL_SCALE);
    const tie = await this._values(full, TAG.TIEPOINT);
    if (!scale || !tie || tie.length < 6) throw new Error('the GeoTIFF has no pixel size or tie point (only north-up rasters are read)');
    const [sx, sy] = scale;
    this.originX = tie[3] - tie[0] * sx;
    this.originY = tie[4] + tie[1] * sy;
    const keys = await this._values(full, TAG.GEO_KEYS);
    if (keys) {
      for (let k = 4; k + 3 < keys.length && k < 4 + keys[3] * 4; k += 4) {
        const [id, location, , value] = keys.slice(k, k + 4);
        if (location !== 0) continue; // only short values stored in the key itself
        if (id === GEOKEY_PROJECTED_CRS) this.epsg = value;
        if (id === GEOKEY_RASTER_TYPE && value === RASTER_PIXEL_IS_POINT) { this.originX -= sx / 2; this.originY += sy / 2; } // the tie point is a pixel's centre
      }
    }
    const nodata = await this._values(full, TAG.GDAL_NODATA);
    if (typeof nodata === 'string' && nodata.trim() !== '') this.nodata = Number(nodata);
    for (const im of this.images) {
      im.pixelSizeX = sx * fullImage.width / im.width;
      im.pixelSizeY = sy * fullImage.height / im.height;
    }
  }

  /** @param {Map<number, IfdEntry>} entries @returns {Promise<CogImage>} */
  async _image(entries) {
    const one = async (tag, fallback) => (await this._values(entries, tag))?.[0] ?? fallback;
    const width = await one(TAG.WIDTH), height = await one(TAG.HEIGHT);
    const tileWidth = await one(TAG.TILE_WIDTH), tileHeight = await one(TAG.TILE_HEIGHT);
    if (!width || !height) throw new Error('an image has no size');
    if (!tileWidth || !tileHeight) throw new Error('the TIFF is not tiled, so it is not a Cloud-Optimised GeoTIFF');
    const samples = await one(TAG.SAMPLES_PER_PIXEL, 1);
    const bits = (await this._values(entries, TAG.BITS_PER_SAMPLE)) ?? [1];
    const formats = (await this._values(entries, TAG.SAMPLE_FORMAT)) ?? [1];
    if (bits.some((b) => b !== 32) || formats.some((f) => f !== SAMPLE_FORMAT_FLOAT)) throw new Error('only 32-bit float rasters are read');
    const compression = await one(TAG.COMPRESSION, COMPRESSION_NONE);
    if (![COMPRESSION_NONE, COMPRESSION_DEFLATE, COMPRESSION_DEFLATE_OLD].includes(compression)) throw new Error(`compression ${compression} is not supported (only Deflate or none)`);
    const predictor = await one(TAG.PREDICTOR, PREDICTOR_NONE);
    if (predictor !== PREDICTOR_NONE && predictor !== PREDICTOR_FLOAT) throw new Error(`predictor ${predictor} is not supported for float data`);
    return {
      width, height, tileWidth, tileHeight,
      tilesAcross: Math.ceil(width / tileWidth), tilesDown: Math.ceil(height / tileHeight),
      pixelSizeX: 0, pixelSizeY: 0,
      samples, planar: await one(TAG.PLANAR, 1), compression, predictor,
      entries, index: null,
    };
  }

  /**
   * A field's values: numbers, or a string for ASCII fields. Undefined when the field is absent.
   * @param {Map<number, IfdEntry>} entries @param {number} tag
   * @returns {Promise<number[]|string|undefined>}
   */
  async _values(entries, tag) {
    const e = entries.get(tag);
    if (!e) return undefined;
    const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
    const bytes = e.inline ?? await this._bytes(e.offset, size);
    if (e.type === 2) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1').replace(/\0+$/, '');
    const v = viewOf(bytes), le = this.le, out = new Array(e.count);
    for (let i = 0; i < e.count; i++) {
      switch (e.type) {
        case 1: case 7: out[i] = bytes[i]; break;
        case 6: out[i] = v.getInt8(i); break;
        case 3: out[i] = v.getUint16(i * 2, le); break;
        case 8: out[i] = v.getInt16(i * 2, le); break;
        case 4: out[i] = v.getUint32(i * 4, le); break;
        case 9: out[i] = v.getInt32(i * 4, le); break;
        case 5: out[i] = v.getUint32(i * 8, le) / v.getUint32(i * 8 + 4, le); break;
        case 10: out[i] = v.getInt32(i * 8, le) / v.getInt32(i * 8 + 4, le); break;
        case 11: out[i] = v.getFloat32(i * 4, le); break;
        case 12: out[i] = v.getFloat64(i * 8, le); break;
        case 16: case 18: out[i] = Number(v.getBigUint64(i * 8, le)); break;
        case 17: out[i] = Number(v.getBigInt64(i * 8, le)); break;
        default: throw new Error(`unknown TIFF field type ${e.type}`);
      }
    }
    return out;
  }

  /** @param {CogImage} image */
  async _index(image) {
    if (!image.index) {
      const offsets = await this._values(image.entries, TAG.TILE_OFFSETS);
      const counts = await this._values(image.entries, TAG.TILE_BYTE_COUNTS);
      const expected = image.tilesAcross * image.tilesDown * (image.planar === PLANAR_SEPARATE ? image.samples : 1);
      if (!offsets || !counts || offsets.length < expected || counts.length < expected) throw new Error('the block index is incomplete');
      image.index = { offsets: Float64Array.from(offsets), counts: Float64Array.from(counts) };
    }
    return image.index;
  }

  /**
   * Reads blocks of one band, merging requests for blocks that sit close together in the file.
   * @param {CogImage} image
   * @param {number} band - 0-based
   * @param {Array<{col: number, row: number}>} blocks
   * @returns {Promise<Map<number, Float32Array|null>>} keyed row * tilesAcross + col; null for a block the file leaves out (all no data)
   */
  async readBlocks(image, band, blocks) {
    if (band < 0 || band >= image.samples) throw new Error(`band ${band} does not exist`);
    const { offsets, counts } = await this._index(image);
    const perBand = image.tilesAcross * image.tilesDown;
    /** @type {Map<number, Float32Array|null>} */
    const out = new Map();
    const wanted = [];
    for (const { col, row } of blocks) {
      const key = row * image.tilesAcross + col;
      if (out.has(key)) continue;
      const i = image.planar === PLANAR_SEPARATE ? band * perBand + key : key;
      if (!counts[i]) { out.set(key, null); continue; } // sparse file: block never written
      out.set(key, null);
      wanted.push({ key, offset: offsets[i], count: counts[i] });
    }
    wanted.sort((a, b) => a.offset - b.offset);
    const groups = [];
    for (const w of wanted) {
      const g = groups[groups.length - 1];
      if (g && w.offset - g.end <= MERGE_GAP_BYTES && w.offset + w.count - g.start <= MAX_REQUEST_BYTES) {
        g.items.push(w); g.end = Math.max(g.end, w.offset + w.count);
      } else {
        groups.push({ start: w.offset, end: w.offset + w.count, items: [w] });
      }
    }
    await Promise.all(groups.map(async (g) => {
      const bytes = await this.readRange(g.start, g.end - g.start);
      if (bytes.length < g.end - g.start) throw new Error('the file ends early');
      for (const w of g.items) out.set(w.key, this.decodeBlock(image, band, bytes.subarray(w.offset - g.start, w.offset - g.start + w.count)));
    }));
    return out;
  }

  /**
   * One block's stored bytes -> its values for `band`, row by row (tileWidth per row).
   * @param {CogImage} image @param {number} band @param {Uint8Array} stored
   * @returns {Float32Array}
   */
  decodeBlock(image, band, stored) {
    const raw = image.compression === COMPRESSION_NONE ? Uint8Array.from(stored) : new Uint8Array(inflateSync(stored));
    const perPixel = image.planar === PLANAR_SEPARATE ? 1 : image.samples;
    const rowValues = image.tileWidth * perPixel;
    if (raw.length < rowValues * image.tileHeight * 4) throw new Error('a block is shorter than its size says');
    let values;
    if (image.predictor === PREDICTOR_FLOAT) {
      values = new Float32Array(undoFloatPredictor(raw, image.tileHeight, rowValues, perPixel).buffer);
    } else {
      if (!this.le) for (let i = 0; i < raw.length; i += 4) { const a = raw[i], b = raw[i + 1]; raw[i] = raw[i + 3]; raw[i + 1] = raw[i + 2]; raw[i + 2] = b; raw[i + 3] = a; }
      values = new Float32Array(raw.buffer, raw.byteOffset, rowValues * image.tileHeight);
    }
    if (perPixel === 1) return values;
    const one = new Float32Array(image.tileWidth * image.tileHeight);
    for (let i = 0; i < one.length; i++) one[i] = values[i * perPixel + band];
    return one;
  }
}

/**
 * Undoes TIFF predictor 3 (Adobe's floating-point predictor, as libtiff's
 * fpAcc does): each row was split into byte planes, most significant byte
 * first, then byte-differenced across the row. Returns the values' bytes
 * in little-endian order, the same in either kind of file.
 * @param {Uint8Array} raw - decompressed rows (changed in place)
 * @param {number} rows @param {number} rowValues - values per row
 * @param {number} stride - samples per pixel within the block
 * @returns {Uint8Array}
 */
export function undoFloatPredictor(raw, rows, rowValues, stride) {
  const rowBytes = rowValues * 4;
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes;
    for (let i = base + stride; i < base + rowBytes; i++) raw[i] = (raw[i] + raw[i - stride]) & 0xff;
    for (let k = 0; k < rowValues; k++) {
      const o = base + 4 * k;
      out[o + 3] = raw[base + k];
      out[o + 2] = raw[base + rowValues + k];
      out[o + 1] = raw[base + 2 * rowValues + k];
      out[o] = raw[base + 3 * rowValues + k];
    }
  }
  return out;
}
