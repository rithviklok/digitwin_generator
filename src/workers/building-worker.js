// ===================================================================
// building-worker.js — the live, in-browser fallback path: fetch +
// JSON.parse + tile + triangulate a city's raw buildings GeoJSON, off
// the main thread, transferring finished tile geometry back
// tile-by-tile with real backpressure. Used when a city has no
// pre-built tile manifest yet (see BuildingLayer.js) — a city that HAS
// been through scripts/build-building-tiles.mjs skips this entirely
// and streams pre-baked tiers instead, which is where the actual
// render-time-lag and 280MB-payload fixes live.
//
// All the actual tile-building math (Pass 1 bucketing, Pass 2 buffer
// writing) lives in building-tile-builder.js, shared with that
// offline script — this file is just the worker-lifecycle plumbing
// (postMessage contract, abort, TILE_ACK backpressure) around it.
// Always builds TILE_DETAIL.FULL: this path has the one detail level.
// ===================================================================
import { bucketFeatures, buildTileBuffers, TILE_DETAIL } from './building-tile-builder.js';
import { meshBoundsOf } from './tile-bounds.js';
import { BuildingWorkerCmd, BuildingWorkerMsg } from './building-protocol.js';

/**
 * Which load may still post results. Every LOAD (and ABORT) moves it on, so
 * a load that is still running when a newer one starts -- a LOAD after an
 * ABORT on the same worker -- sees it is stale at its next check and stops,
 * instead of carrying on beside the new one and sending the main thread
 * tiles of the wrong city. (A single `aborted` flag was reset to false by
 * the second LOAD, which revived the first.)
 */
let currentRun = 0;
// Resolved by the next TILE_ACK from the main thread -- see postTile()'s
// backpressure comment for why a self-paced timeout isn't enough.
/** @type {(() => void)|null} */
let resolveTileAck = null;

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === BuildingWorkerCmd.ABORT) {
    currentRun++;
    resolveTileAck?.(); // a load waiting for an ack wakes up, sees it is stale, and returns
    return;
  }
  if (msg.type === BuildingWorkerCmd.TILE_ACK) {
    resolveTileAck?.();
    return;
  }
  if (msg.type === BuildingWorkerCmd.LOAD) {
    const run = ++currentRun;
    resolveTileAck?.(); // same for a load this one replaces
    runLoad(msg, () => run !== currentRun).catch((err) => {
      if (run === currentRun) self.postMessage({ type: BuildingWorkerMsg.ERROR, message: err?.message ?? String(err) });
    });
  }
};

/** Waits for the main thread's TILE_ACK -- see postTile()'s comment. @returns {Promise<void>} */
function waitForTileAck() {
  return new Promise((resolve) => { resolveTileAck = () => resolve(); });
}

/**
 * @param {{cityId: string, url: string, origin: {lon: number, lat: number}, tileSizeM: number, windowMinHeightM: number,
 *   heightProperty: string, minRenderHeightM: number, sourceLabel: string}} cfg - the LOAD message
 * @param {() => boolean} isStale - true once this load has been aborted or replaced
 */
async function runLoad(cfg, isStale) {
  const { cityId, url, origin, tileSizeM, windowMinHeightM, heightProperty, minRenderHeightM, sourceLabel } = cfg;

  // ---- FETCH + PARSE, both off the main thread. Parsing a whole city's
  // buildings file is a ~1-2 GB heap spike -- doing it here doesn't shrink
  // it (that's what the offline tile pipeline is for), it just stops it
  // from freezing input/render on the main thread.
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`building-worker: fetch ${url} failed (${res.status})`);
  let parsed = await res.json();
  const parseMs = performance.now() - t0;
  if (isStale()) return;

  let features = parsed.features;
  parsed = null; // the FeatureCollection wrapper is dead weight from here on

  const bucketResult = await bucketFeatures(
    features,
    { origin, tileSizeM, windowMinHeightM, heightProperty, minRenderHeightM },
    { yieldEvery: 20000, isAborted: isStale },
  );
  features = null; // dead weight the moment bucketing has extracted what Pass 2 needs
  if (bucketResult === null) return; // aborted mid-bucketing
  const { tiles, stats } = bucketResult;

  // ---- PASS 2: exact-size allocate per tile, write by index, transfer
  // each finished tile back immediately (progressive rendering).
  let done = 0;
  const buildMsStart = performance.now();
  for (const [tileKey, bucket] of tiles) {
    if (isStale()) return;
    const payload = buildTileBuffers(bucket, TILE_DETAIL.FULL);
    postTile(cityId, sourceLabel, tileKey, bucket, payload);

    done++;
    self.postMessage({ type: BuildingWorkerMsg.PROGRESS, done, total: tiles.size });

    // REAL backpressure, not a self-paced timeout: wait for the main
    // thread to actually finish _addTile() for the tile just sent before
    // building the next one -- see BuildingLayer.js's TILE_ACK send.
    await waitForTileAck();
    if (isStale()) return;
  }

  self.postMessage({
    type: BuildingWorkerMsg.DONE,
    stats: { tileCount: tiles.size, buildingCount: stats.buildingCount, skippedCount: stats.skippedCount, windowedCount: stats.windowedCount, roofFailedCount: stats.roofFailedCount, parseMs, buildMs: performance.now() - buildMsStart },
  });
}

/**
 * Collects every ArrayBuffer in a tile payload so postMessage can transfer, not clone, them.
 * @param {import('./tile-binary-format.js').TilePayload} payload
 * @returns {ArrayBuffer[]}
 */
function collectTransferables(payload) {
  /** @type {ArrayBuffer[]} */
  const bufs = [];
  const grab = (o) => { if (o) for (const v of Object.values(o)) if (v?.buffer) bufs.push(v.buffer); };
  grab(payload.wall); grab(payload.windowWall); grab(payload.roof); grab(payload.outline); grab(payload.meta);
  return bufs;
}

/**
 * @param {string} cityId @param {string} sourceLabel @param {string} tileKey - "ix,iz"
 * @param {{ix: number, iz: number, count: number}} bucket @param {import('./tile-binary-format.js').TilePayload} payload
 */
function postTile(cityId, sourceLabel, tileKey, bucket, payload) {
  const message = {
    type: BuildingWorkerMsg.TILE,
    cityId, sourceLabel, tileKey,
    centerIx: bucket.ix, centerIz: bucket.iz,
    buildingCount: bucket.count,
    // Exact per-mesh bounding boxes, computed here (off the main thread, and BEFORE the buffers are transferred away) so
    // BuildingLayer can hand them to three.js instead of it looping over every vertex -- see layers/known-bounds.js.
    bounds: meshBoundsOf(payload),
    ...payload,
  };
  // Transferable Objects, not structured cloning: ownership of every
  // Float32Array/Int32Array's backing buffer moves to the main thread in
  // O(1), instead of the browser copying tens of MB per tile.
  self.postMessage(message, collectTransferables(payload));
}
