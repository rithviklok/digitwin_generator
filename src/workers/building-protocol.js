// @ts-check
// ===================================================================
// postMessage contract between BuildingLayer.js (main thread) and
// building-worker.js. Shared so both sides import the same string
// constants instead of hand-typing message.type twice.
// ===================================================================

/** main -> worker */
export const BuildingWorkerCmd = Object.freeze({
  LOAD: 'load',     // { cityId, url, origin, tileSizeM, minRenderHeightM, windowMinHeightM, heightProperty, sourceLabel }
  ABORT: 'abort',   // {} -- city switch mid-load: the worker stops at its next yield or tile; BuildingLayer.abort() then terminates it
  TILE_ACK: 'tile-ack', // {} -- main thread finished _addTile() for the last TILE message; see postTile()'s backpressure comment
});

/** worker -> main */
export const BuildingWorkerMsg = Object.freeze({
  PROGRESS: 'progress', // { done, total }               -- tile-bucketing progress during Pass 2
  TILE: 'tile',          // one fully-built tile, see building-worker.js's postTile() for the exact payload shape
  DONE: 'done',          // { stats: { tileCount, buildingCount, skippedCount, windowedCount, roofFailedCount, parseMs, buildMs } }
  ERROR: 'error',        // { message }
});
