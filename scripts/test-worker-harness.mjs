// Checks building-worker.js -- NOT part of the app. Runs the worker's actual
// code path in plain Node by shimming the DOM-worker globals it expects
// (self.onmessage / self.postMessage / fetch), against real building data:
// Kanpur's whole buildings file (about 7 s), or any other buildings GeoJSON
// with heights in a `mean` property:
//
//   node scripts/test-worker-harness.mjs
//   SAMPLE_PATH=<a buildings GeoJSON> node scripts/test-worker-harness.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BuildingWorkerCmd, BuildingWorkerMsg } from '../src/workers/building-protocol.js';

const SAMPLE_PATH = process.env.SAMPLE_PATH ?? fileURLToPath(new URL('../public/data/kanpur/Kanpur_OpenBuildings_2_5D.geojson', import.meta.url));
const raw = readFileSync(SAMPLE_PATH, 'utf8');

// Shim `fetch` so building-worker.js's `await fetch(url)` resolves to our local sample
// without needing a real HTTP server.
globalThis.fetch = async (url) => {
  if (url !== 'test://sample.geojson') throw new Error(`unexpected fetch url in harness: ${url}`);
  return { ok: true, json: async () => JSON.parse(raw) };
};

// Shim the worker-global `self` the module writes `self.onmessage =` /
// `self.postMessage(...)` against.
const messages = [];
let doneStats = null;
let errorMsg = null;
globalThis.self = {
  postMessage(msg) {
    messages.push(msg);
    if (msg.type === BuildingWorkerMsg.DONE) doneStats = msg.stats;
    if (msg.type === BuildingWorkerMsg.ERROR) errorMsg = msg.message;
    // Pass 2 now waits for a TILE_ACK after every tile (real backpressure
    // against the main thread's _addTile() cost -- see building-worker.js).
    // The harness has no real main thread to send one, so it acks
    // immediately, same as a main thread that processes tiles instantly.
    if (msg.type === BuildingWorkerMsg.TILE) {
      queueMicrotask(() => globalThis.self.onmessage({ data: { type: BuildingWorkerCmd.TILE_ACK } }));
    }
  },
};

await import('../src/workers/building-worker.js');

globalThis.self.onmessage({
  data: {
    type: BuildingWorkerCmd.LOAD,
    cityId: 'kanpur',
    url: 'test://sample.geojson',
    origin: { lon: 80.3319, lat: 26.4499 },
    tileSizeM: 2000,
    minRenderHeightM: 1.5,
    windowMinHeightM: 12,
    heightProperty: 'mean',
    sourceLabel: 'buildings-3d',
  },
});

// runLoad() is async and un-awaited from onmessage's perspective (fire-and-forget,
// same as a real worker) -- poll until DONE or ERROR lands.
const start = Date.now();
while (!doneStats && !errorMsg) {
  if (Date.now() - start > 30000) throw new Error('harness timeout waiting for DONE/ERROR');
  await new Promise((r) => setTimeout(r, 20));
}

if (errorMsg) {
  console.error('WORKER ERRORED:', errorMsg);
  process.exit(1);
}

const tileMsgs = messages.filter((m) => m.type === BuildingWorkerMsg.TILE);
const progressMsgs = messages.filter((m) => m.type === BuildingWorkerMsg.PROGRESS);

console.log('--- stats ---');
console.log(doneStats);
console.log('--- message counts ---');
console.log({ tiles: tileMsgs.length, progress: progressMsgs.length, total: messages.length });

// ---- Structural assertions ----
function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else { console.log('OK:', msg); } }

assert(tileMsgs.length > 0, 'at least one tile was emitted');
assert(doneStats.buildingCount > 0, 'buildingCount > 0');
assert(doneStats.tileCount === tileMsgs.length, 'DONE.stats.tileCount matches number of TILE messages actually sent');

let totalBuildingsAcrossTiles = 0;
let sawWall = false, sawRoof = false, sawMeta = false;
for (const t of tileMsgs) {
  totalBuildingsAcrossTiles += t.buildingCount;
  if (t.wall) {
    sawWall = true;
    assert(t.wall.position.length % 9 === 0, `tile ${t.tileKey}: wall position length is a multiple of 9 (3 verts * 3 comps per triangle)`);
    assert(t.wall.position.length / 3 === t.wall.color.length / 3, `tile ${t.tileKey}: wall position/color vertex counts match`);
    assert(t.wall.position.length / 3 === t.wall.buildingId.length, `tile ${t.tileKey}: wall position/buildingId vertex counts match`);
  }
  if (t.roof) {
    sawRoof = true;
    assert(t.roof.position.length % 9 === 0, `tile ${t.tileKey}: roof position length is a multiple of 9`);
  }
  if (t.meta) {
    sawMeta = true;
    const m = t.meta;
    assert(m.ringOffsets.length === m.count + 1, `tile ${t.tileKey}: meta.ringOffsets has count+1 entries`);
    assert(m.roofTriOffsets.length === m.count + 1, `tile ${t.tileKey}: meta.roofTriOffsets has count+1 entries`);
    assert(m.ringOffsets[m.count] === m.ringFlat.length, `tile ${t.tileKey}: meta.ringOffsets final entry matches ringFlat length`);
    // Reconstruct building 0's ring and sanity-check it's a real polygon (>=3 points, finite numbers).
    const start = m.ringOffsets[0], end = m.ringOffsets[1];
    const ring0 = m.ringFlat.subarray(start, end);
    assert(ring0.length >= 6, `tile ${t.tileKey}: building 0 has >=3 ring points (${ring0.length / 2} points)`);
    assert([...ring0].every(Number.isFinite), `tile ${t.tileKey}: building 0 ring coords are all finite`);
  }

  // Transferable-object contract: every typed array's buffer must be a real
  // ArrayBuffer we can hand to postMessage's transfer list (this is what
  // collectTransferables() in the worker relies on).
  for (const part of [t.wall, t.windowWall, t.roof, t.outline]) {
    if (!part) continue;
    for (const arr of Object.values(part)) {
      assert(arr.buffer instanceof ArrayBuffer, `typed array has a real transferable ArrayBuffer backing it`);
    }
  }
}
assert(totalBuildingsAcrossTiles === doneStats.buildingCount, 'sum of buildingCount across tiles equals DONE.stats.buildingCount');
assert(sawWall, 'at least one tile produced wall geometry');
assert(sawRoof, 'at least one tile produced roof geometry');
assert(sawMeta, 'at least one tile produced buildingMeta');

console.log(process.exitCode === 1 ? '\n=== HARNESS: FAILURES ABOVE ===' : '\n=== HARNESS: ALL CHECKS PASSED ===');
