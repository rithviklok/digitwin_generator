// ===================================================================
// geojson-feature-stream.mjs -- reads the features of a GeoJSON
// FeatureCollection off disk a piece at a time, so
// build-building-tiles.mjs can bake a buildings file of any size (and the
// server can take in a metro's OpenStreetMap export the same way).
//
// Reading the file in one go (readFileSync + JSON.parse) stops working at
// 512 MB -- the longest string Node can hold -- and a metro's buildings
// are well past that: Delhi is about 1.4 GB in the same format as Kanpur's
// 283 MB, about 2.1 GB with its satellite cities (Google Open Buildings
// v3, counted 2026-09-30). Parsing everything at once also kept every
// parsed building in memory at the same time.
//
// How: walk the file's bytes, keeping track of how deep the braces and
// brackets are nested (and skipping over strings, which may contain
// either), find the root object's "features" array, and cut out each of
// its elements as its own small piece of JSON. Counting bytes rather than
// characters is safe: in UTF-8 no byte of a multi-byte character is ever
// an ASCII byte, so a '{' byte is always a real '{'.
//
// Works on any formatting (one feature per line, all on one line,
// pretty-printed), with "features" anywhere in the root object.
// ===================================================================
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

const CHUNK_BYTES = 8 * 1024 * 1024;
/** One feature bigger than this is not a building footprint (or any other single map feature); refuse it rather than grow without limit on a broken file. */
const MAX_FEATURE_BYTES = 256 * 1024 * 1024;

const QUOTE = 0x22, BACKSLASH = 0x5c, COMMA = 0x2c;
const LBRACE = 0x7b, RBRACE = 0x7d, LBRACKET = 0x5b, RBRACKET = 0x5d;
const FEATURES_KEY = 'features';

/**
 * A problem with the file itself, worded for the person who uploaded it
 * (build-building-tiles.mjs prints it as its "ERROR:" line, which the
 * server shows on the Review & build page).
 */
export class GeojsonFileError extends Error {}

/** How the error messages name the file and what is in it. */
const BUILDINGS_WORDING = { file: 'the buildings file', item: 'building', neverThatBig: 'no building footprint is' };

/**
 * @param {string} filePath - a GeoJSON FeatureCollection
 * @param {{chunkBytes?: number, wording?: {file: string, item: string, neverThatBig: string}}} [opts]
 *   chunkBytes: how much of the file is read at a time (tests use tiny values).
 *   wording: for a file other than the buildings, e.g. {file: 'your OpenStreetMap export', item: 'feature', neverThatBig: 'no map feature is'}.
 * @yields {{features: object[], bytesRead: number, totalBytes: number}}
 *   the features that ENDED in the piece just read, in file order. Elements
 *   of "features" that aren't objects are skipped.
 * @throws {GeojsonFileError} no "features" array, a feature that isn't valid JSON, or a file that stops partway through
 */
export function* readFeatureBatches(filePath, { chunkBytes = CHUNK_BYTES, wording = BUILDINGS_WORDING } = {}) {
  const { file, item, neverThatBig } = wording;
  const fd = openSync(filePath, 'r');
  try {
    const totalBytes = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(chunkBytes);

    let depth = 0;          // open { and [ outside strings
    let inString = false, escaped = false;
    let inFeatures = false; // inside the root object's "features" array (its elements sit at depth 2)
    let sawFeatures = false, finished = false;

    // The last string seen directly inside the root object -- a '[' that
    // follows the key "features" opens the array we want. Only its first
    // bytes are kept: enough to tell whether it is that key.
    const key = Buffer.alloc(FEATURES_KEY.length + 1);
    let keyLen = 0, collectingKey = false, lastKey = null;

    // The feature being read: where it starts in `buf`, plus copies of the
    // parts of it that were in earlier pieces.
    let featOpen = false, featStart = 0, carry = null, carryBytes = 0;
    let featureCount = 0, bytesRead = 0;

    while (!finished) {
      const n = readSync(fd, buf, 0, chunkBytes, bytesRead);
      if (n === 0) break;
      const batch = [];

      for (let i = 0; i < n; i++) {
        const c = buf[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === BACKSLASH) escaped = true;
          else if (c === QUOTE) {
            inString = false;
            // toString('latin1', ...), not Buffer#latin1Slice: the latter is an undocumented Node internal that a future version may drop.
            if (collectingKey) { collectingKey = false; lastKey = keyLen <= FEATURES_KEY.length ? key.toString('latin1', 0, keyLen) : null; }
          } else if (collectingKey && keyLen < key.length) key[keyLen++] = c;
          continue;
        }
        switch (c) {
          case QUOTE:
            inString = true;
            if (depth === 1) { collectingKey = true; keyLen = 0; }
            break;
          case LBRACE:
            if (inFeatures && depth === 2) { featOpen = true; featStart = i; }
            depth++;
            break;
          case RBRACE:
            depth--;
            if (featOpen && depth === 2) {
              const text = carry
                ? Buffer.concat([...carry, buf.subarray(0, i + 1)]).toString('utf8') // it began in an earlier piece
                : buf.toString('utf8', featStart, i + 1);
              featOpen = false; carry = null; carryBytes = 0;
              featureCount++;
              try {
                batch.push(JSON.parse(text));
              } catch (err) {
                throw new GeojsonFileError(`${item} number ${featureCount.toLocaleString('en-IN')} in ${file} isn't valid JSON (${err.message}). Export the file again and revise.`);
              }
            }
            break;
          case LBRACKET:
            if (depth === 1 && !sawFeatures && lastKey === FEATURES_KEY) { inFeatures = true; sawFeatures = true; }
            depth++;
            break;
          case RBRACKET:
            depth--;
            if (inFeatures && depth === 1) { inFeatures = false; finished = true; i = n; } // the features array is closed: nothing after it matters
            break;
          case COMMA:
            if (depth === 1) lastKey = null; // the value after a key has ended
            break;
        }
      }

      // A feature still open at the end of this piece: keep a copy of what
      // there is of it (`buf` is about to be overwritten by the next read).
      if (featOpen) {
        const part = Buffer.from(buf.subarray(featStart, n));
        (carry ??= []).push(part);
        carryBytes += part.length;
        featStart = 0;
        if (carryBytes > MAX_FEATURE_BYTES) {
          throw new GeojsonFileError(`${item} number ${(featureCount + 1).toLocaleString('en-IN')} in ${file} is larger than ${MAX_FEATURE_BYTES / (1024 * 1024)} MB, which ${neverThatBig}. The file looks damaged; export it again and revise.`);
        }
      }

      bytesRead += n;
      yield { features: batch, bytesRead: finished ? totalBytes : bytesRead, totalBytes };
    }

    if (!sawFeatures) {
      throw new GeojsonFileError(`${file} has no "features" list, so it isn't a GeoJSON FeatureCollection. Export it as GeoJSON again and revise.`);
    }
    if (!finished) {
      throw new GeojsonFileError(`${file} stops partway through (after ${featureCount.toLocaleString('en-IN')} ${item}${featureCount === 1 ? '' : 's'}), as if the export or the upload was cut off. Export it again and revise.`);
    }
  } finally {
    closeSync(fd);
  }
}
