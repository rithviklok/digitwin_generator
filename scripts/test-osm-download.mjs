// Checks the OpenStreetMap download step (server/lib/overpass.js and
// server/jobs/osmFetchChild.js) -- NOT part of the app. Nothing here
// touches the internet: a stand-in Overpass server on this machine plays
// the public servers, refusals included.
//   node scripts/test-osm-download.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createOverpassClient, slotWaitSeconds, splitBbox, downloadParts, explainMissingParts, OUT_OF_TIME } from '../server/lib/overpass.js';

function assert(ok, what) {
  if (ok) console.log(`OK: ${what}`);
  else { console.error(`FAIL: ${what}`); process.exitCode = 1; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- The stand-in server: two "servers" (/a and /b) on one port, each answering from a script the test sets ----
const state = { a: [], b: [], status: { a: '', b: '' }, requests: [], reply: null };
const server = createServer((req, res) => {
  const [, name, , page] = req.url.split('/'); // /a/api/interpreter, /a/api/status
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (page === 'status') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(state.status[name]); return; }
    const query = decodeURIComponent(body.replace(/^data=/, ''));
    state.requests.push({ name, query });
    const answer = state[name].shift() ?? state.reply?.(query, name) ?? { elements: [] }; // the scripted answers first, then whatever the test's city holds
    if (typeof answer === 'number') { res.writeHead(answer, { 'Content-Type': 'text/html' }); res.end(answer === 429 ? 'rate_limited' : answer === 400 ? '<p>Error: line 1: parse error: Unknown type "wai"</p>' : 'The server is probably too busy to handle your request.'); return; }
    if (typeof answer === 'string') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(answer); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const A = `${base}/a/api/interpreter`, B = `${base}/b/api/interpreter`;
const OK_ANSWER = { elements: [{ type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'school', name: 'S' } }] };

// ---- What the servers' status page says about slots ----
assert(slotWaitSeconds('Rate limit: 2\nSlot available after: 2026-09-30T12:55:08Z, in 27 seconds.\nSlot available after: 2026-09-30T12:55:35Z, in 54 seconds.\n') === 27, 'status page: two slots cooling down, the sooner one counts (27 s)');
assert(slotWaitSeconds('Rate limit: 4\n2 slots available now.\nSlot available after: 2026-09-30T12:54:55Z, in 15 seconds.\n') === 0, 'status page: a slot free now means no wait');
assert(slotWaitSeconds('Rate limit: 0\nCurrently running queries (pid, space limit, time limit, start time):\n') === null, 'status page: a server that does not ration says nothing (null)');
assert(slotWaitSeconds('Slot available after: 2026-09-30T12:55:08Z, in -3 seconds.') === 0, 'status page: a slot due a moment ago is no wait, not a negative one');

// ---- The client, on a clock the test owns (a "wait" moves the clock; nothing really sleeps) ----
function makeClient(endpoints, opts = {}) {
  let clock = 1_000_000;
  const waits = [], lines = [];
  const client = createOverpassClient({ endpoints, log: (m) => lines.push(m), now: () => clock, sleep: async (ms) => { waits.push(Math.round(ms / 1000)); clock += ms; }, ...opts });
  return { client, waits, lines, advance: (ms) => { clock += ms; }, now: () => clock };
}
function script(a, b = [], status = {}) { state.a = a; state.b = b; state.status = { a: '', b: '', ...status }; state.requests = []; state.reply = null; }
const asked = () => state.requests.map((r) => r.name).join('');

{
  script([504, OK_ANSWER], [OK_ANSWER]);
  const { client, waits } = makeClient([A, B]);
  const json = await client.query('q');
  assert(json.elements.length === 1 && asked() === 'ab' && waits.length === 0, 'first server too busy (504): the second is asked at once, with no wait');
}
{
  script([504, OK_ANSWER], [429], { b: 'Rate limit: 2\nSlot available after: x, in 27 seconds.\n' });
  const { client, waits, lines } = makeClient([A, B]);
  await client.query('q');
  assert(asked() === 'aba' && same(waits, [20]), `both refuse: waits for the one that is free sooner (20 s for the busy one, not 28 s for the rate-limited one); waited ${waits}`);
  assert(lines.some((l) => /all servers busy -- waiting 20s before retrying/.test(l)), 'the wait is logged in the words the build page looks for');
}
{
  script([429, OK_ANSWER], [], { a: 'Rate limit: 2\nSlot available after: x, in 54 seconds.\nSlot available after: y, in 80 seconds.\n' });
  const { client, waits } = makeClient([A]);
  await client.query('q');
  assert(same(waits, [55]), `rate-limited (429): waits as long as that server's status page says, plus a second (55 s); waited ${waits}`);
}
{
  script([429, OK_ANSWER], [], { a: 'Rate limit: 2\n2 slots available now.\n' });
  const { client, waits } = makeClient([A]);
  await client.query('q');
  assert(same(waits, [1]), 'rate-limited but the status page shows a free slot: asks again after a second');
}
{
  script([429, OK_ANSWER], [], { a: 'Rate limit: 0\n' });
  const { client, waits } = makeClient([A]);
  await client.query('q');
  assert(same(waits, [31]), 'rate-limited and the status page says nothing: a plain 30 s');
}
{
  script([504, 504, 504, OK_ANSWER]);
  const { client, waits } = makeClient([A]);
  await client.query('q');
  assert(same(waits, [20, 40, 60]), `a server that keeps failing is left alone for longer each time (20, 40, 60 s); waited ${waits}`);
}
{
  script([504, OK_ANSWER, 504, OK_ANSWER]);
  const { client, waits } = makeClient([A]);
  await client.query('q');
  await client.query('q');
  assert(same(waits, [20, 20]), 'an answer resets the pause: the next failure starts from 20 s again');
}
{
  script([{ elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 301 seconds.' }, '<html>gateway</html>', OK_ANSWER]);
  const { client } = makeClient([A]);
  const json = await client.query('q');
  assert(json.elements.length === 1 && asked() === 'aaa', 'a result cut short (a "remark") and a page that is not JSON both count as failures and are asked for again');
}
{
  script([400, OK_ANSWER]);
  const { client, waits } = makeClient([A, B]);
  const err = await client.query('q').catch((e) => e);
  assert(err instanceof Error && /HTTP 400/.test(err.message) && asked() === 'a' && waits.length === 0, `a query the server calls wrong (400) is not asked again anywhere: "${err.message}"`);
}
{
  script(Array(40).fill(504));
  const { client, waits } = makeClient([A], { maxAttempts: 5 });
  const err = await client.query('q').catch((e) => e);
  assert(/HTTP 504/.test(err.message) && state.requests.length === 5 && same(waits, [20, 40, 60, 80]), `gives up after maxAttempts requests (5), with the last refusal as the reason: "${err.message}"`);
}
{
  script(Array(40).fill(504));
  const { client, waits } = makeClient([A]);
  await client.query('q').catch((e) => e);
  assert(Math.max(...waits) === 120, `the pause stops growing at 2 minutes; longest was ${Math.max(...waits)} s`);
}
{
  script([504, OK_ANSWER]);
  const t = makeClient([A]);
  const err = await t.client.query('q', { deadline: t.now() + 5000 }).catch((e) => e);
  assert(err.outOfTime === true && t.waits.length === 0 && state.requests.length === 1, `a wait that would run past the deadline is not started: "${err.message}"`);
}
{
  const { client } = makeClient([]);
  const err = await client.query('q').catch((e) => e);
  assert(/no Overpass endpoints/.test(err.message), 'no endpoints at all: says so');
}

// ---- How a failed download is put to the uploader ----
const busy = explainMissingParts(2, 12, 'HTTP 504: server busy');
assert(/^OpenStreetMap’s servers were too busy: 2 of this area’s 12 parts couldn’t be downloaded\. The rest are kept for a week, so revising the city only asks for those 2$/.test(busy), `some parts refused: "${busy}"`);
assert(/only asks for that one$/.test(explainMissingParts(1, 12, 'timed out')) && /The rest is kept/.test(explainMissingParts(1, 2, 'terminated')), 'one part missing, and one part kept, are worded in the singular');
assert(explainMissingParts(1, 1, 'HTTP 429: server busy') === 'OpenStreetMap’s servers were too busy. Revise the city to try again', 'a city asked for in one part: no talk of parts');
assert(/none of this area’s 12 parts could be downloaded/.test(explainMissingParts(12, 12, 'fetch failed')), 'nothing downloaded at all');
assert(/^the download ran out of time while OpenStreetMap’s servers were busy: 3 of this area’s 12 parts/.test(explainMissingParts(3, 12, OUT_OF_TIME)), 'out of time is named as such');
assert(explainMissingParts(1, 4, 'HTTP 400: parse error') === 'the download from OpenStreetMap failed (HTTP 400: parse error)', 'anything else is passed on, not called "busy"');
assert([busy, explainMissingParts(1, 1, 'x'), explainMissingParts(3, 12, OUT_OF_TIME)].every((m) => /^[a-zO]/.test(m) && !/\.$/.test(m)), 'every message fits "Missing because: <message>. You can add..." (no full stop at the end)');

// ---- Splitting an area into parts ----
const box = { west: 76.85, south: 28.30, east: 77.60, north: 28.90 };
{
  const parts = downloadParts(box);
  assert(parts.roads.length === 12 && parts.areas.length === 4 && parts.railway.length === 1, 'Delhi with its satellite cities: roads in 12 parts, areas in 4, railway in 1 (17 requests)');
  const one = downloadParts({ west: 80.2, south: 26.35, east: 80.4, north: 26.55 });
  assert(one.roads.length === 1 && one.areas.length === 1 && one.railway.length === 1, 'a city up to 0.2 degrees across: one part each (3 requests)');
  assert(same(Object.keys(downloadParts(box, ['roads'])), ['roads']), 'only the groups asked for are planned');
}
{
  const cells = splitBbox(box);
  const area = cells.reduce((s, c) => s + (c.east - c.west) * (c.north - c.south), 0);
  assert(Math.abs(area - 0.75 * 0.6) < 1e-9 && cells.every((c) => c.west >= box.west - 1e-9 && c.east <= box.east + 1e-9), 'the parts cover the area exactly, with nothing outside it');
}

// ---- The whole step, run as the server runs it, against the stand-in ----
const CHILD = resolve(import.meta.dirname, '../server/jobs/osmFetchChild.js');
const work = mkdtempSync(join(tmpdir(), 'osm-download-test-'));
async function child(name, plan = {}) {
  const out = join(work, name);
  const planPath = join(work, `${name}-plan.json`);
  mkdirSync(join(work, 'cache'), { recursive: true });
  writeFileSync(planPath, JSON.stringify({ bbox: { west: 77, south: 28.4, east: 77.5, north: 28.7 }, endpoints: [A], exportPath: null, manual: {}, out, cacheDir: join(work, 'cache'), ...plan }));
  state.requests = [];
  // Not spawnSync: that would stop this process's own stand-in server from answering.
  const result = await new Promise((done) => {
    const p = spawn(process.execPath, [CHILD, '--plan', planPath]);
    let log = '';
    p.stdout.on('data', (c) => { log += c; });
    p.stderr.on('data', (c) => { log += c; });
    p.on('close', (status) => done({ status, log }));
  });
  const summary = existsSync(join(out, 'summary.json')) ? JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) : null;
  const layer = (role) => (existsSync(join(out, `${role}.geojson`)) ? JSON.parse(readFileSync(join(out, `${role}.geojson`), 'utf8')) : null);
  return { ...result, summary, layer, out };
}

// What the stand-in holds for the test area (0.5 x 0.3 degrees: roads in 3 x 2 parts, areas in 2 x 1, railway in 1).
const groupOf = (query) => (query.includes('way["highway"]') ? 'roads' : query.includes('way["railway"') ? 'railway' : 'areas');
const cellOf = (query) => /\[bbox:([^\]]+)\]/.exec(query)[1];
const ROADS_PER_PART = 40, PLACES = 150_000;
function cityReply(query) {
  const [south, west, north, east] = cellOf(query).split(',').map(Number);
  const group = groupOf(query);
  const idBase = Math.round(west * 1000) * 100000 + Math.round(south * 1000) * 100;
  if (group === 'roads') {
    const ways = Array.from({ length: ROADS_PER_PART }, (_, k) => ({
      type: 'way', id: idBase + k, tags: { highway: k % 10 === 0 ? 'primary' : 'residential', name: `Road ${idBase + k}` },
      geometry: [{ lat: south + 0.01 + k * 0.001, lon: west + 0.01 }, { lat: south + 0.01 + k * 0.001, lon: west + 0.05 }],
    }));
    // One road that crosses every part's border: every part returns it.
    ways.push({ type: 'way', id: 7, tags: { highway: 'trunk', name: 'Ring Road' }, geometry: [{ lat: 28.5, lon: 77.0 }, { lat: 28.5, lon: 77.5 }] });
    return { elements: ways };
  }
  if (group === 'railway') return { elements: [{ type: 'way', id: 50, tags: { railway: 'rail', name: 'Main line' }, geometry: [{ lat: 28.5, lon: 77.0 }, { lat: 28.6, lon: 77.4 }] }] };
  // Areas and places. More places than one function call can be handed as arguments: gathered with push(...list), as this
  // step used to, 3.16 lakh roads ended in "Maximum call stack size exceeded" and a Delhi-sized city had no roads.
  const nodes = west < 77.2 ? Array.from({ length: PLACES }, (_, k) => ({ type: 'node', id: 1_000_000 + k, lat: south + 0.1, lon: west + 0.1, tags: { amenity: 'school', name: `School ${k}` } })) : [];
  nodes.push({ type: 'node', id: idBase + 5, lat: south + 0.1, lon: west + 0.1, tags: { railway: 'station', name: `Station ${idBase}` } });
  nodes.push({ type: 'way', id: idBase + 6, tags: { leisure: 'park', name: 'A park' }, geometry: [{ lat: south, lon: west }, { lat: south, lon: west + 0.01 }, { lat: south + 0.01, lon: west + 0.01 }, { lat: south, lon: west }] });
  return { elements: nodes };
}

{
  // 1. One road part is refused for good (as a wrong query would be -- a "busy" refusal is retried for minutes).
  script([], []);
  let refusedCell = null;
  state.reply = (query) => {
    if (groupOf(query) !== 'roads') return cityReply(query);
    refusedCell ??= state.requests.filter((r) => groupOf(r.query) === 'roads').length === 4 ? cellOf(query) : null;
    return cellOf(query) === refusedCell ? 400 : cityReply(query);
  };
  const first = await child('first');
  const kinds = state.requests.map((r) => groupOf(r.query));
  assert(first.status === 0 && first.summary, 'a build with one part refused still finishes and writes its summary');
  assert(kinds.filter((k) => k === 'roads').length === 7 && kinds.filter((k) => k === 'railway').length === 1 && kinds.filter((k) => k === 'areas').length === 2,
    `requests: roads in 6 parts (the refused one asked twice), railway in 1, areas in 2; got ${kinds.filter((k) => k === 'roads').length}/${kinds.filter((k) => k === 'railway').length}/${kinds.filter((k) => k === 'areas').length}`);
  assert(first.summary.failed.length === 1 && same(first.summary.failed[0].roles, ['roads']) && /^the download from OpenStreetMap failed \(HTTP 400/.test(first.summary.failed[0].error), `the roads layer is reported missing, with why: "${first.summary.failed[0]?.error}"`);
  assert(first.layer('roads') === null && first.summary.counts.roads === 0, 'no roads layer is written from five parts out of six (half a road network is worse than none)');
  assert(first.summary.counts.amenities === PLACES + 2 && first.layer('amenities').features.length === PLACES + 2, `${PLACES.toLocaleString('en-IN')} places in one part come through (more than a function call can take as arguments)`);
  assert(first.summary.counts.railway === 1 && first.summary.counts.vegetation === 2 && same(first.summary.railwayStationNames.length, 2), 'railway, parks and station names are all there');
  const saved = readdirSync(join(work, 'cache'));
  assert(saved.filter((f) => f.startsWith('roads_')).length === 5 && saved.filter((f) => f.startsWith('areas_')).length === 2 && saved.filter((f) => f.startsWith('railway_')).length === 1 && !saved.some((f) => f.endsWith('.tmp')),
    `every part that arrived is saved (5 of 6 road parts, 2 areas, 1 railway): ${saved.length} files`);

  // 2. Build again with the servers well: only the missing part is asked for.
  state.reply = cityReply;
  writeFileSync(join(work, 'cache', 'roads_leftover.json.tmp'), '[{"half":'); // what a stopped process could leave behind
  const second = await child('second');
  assert(state.requests.length === 1 && groupOf(state.requests[0].query) === 'roads' && cellOf(state.requests[0].query) === refusedCell, `building again asks only for the part that was refused (${state.requests.length} request)`);
  assert(/roads: 5 of 6 parts were downloaded .* ago; only the rest are asked for/.test(second.log) && /railway: reusing this area's download/.test(second.log), 'the log says what was reused');
  assert(second.summary.failed.length === 0 && second.summary.counts.roads === 6 * ROADS_PER_PART + 1, `all roads now, the one crossing every border counted once: ${second.summary.counts.roads}`);
  const roads = second.layer('roads');
  assert(roads.type === 'FeatureCollection' && roads.features.length === 6 * ROADS_PER_PART + 1 && roads.features.every((f) => f.geometry.type === 'Polygon' && f.properties.feature === 'road'), 'the roads file is a valid FeatureCollection of widened road surfaces');
  assert(roads.features.filter((f) => f.properties.name === 'Ring Road').length === 1 && roads.features.find((f) => f.properties.name === 'Ring Road').properties.class === 0, 'the border-crossing trunk road is there once, as a major road');
  assert(same(second.layer('amenities'), first.layer('amenities')) && same(second.layer('vegetation'), first.layer('vegetation')), 'layers built from saved parts are the same as when they were first downloaded');
  assert(!readdirSync(join(work, 'cache')).some((f) => f.endsWith('.tmp')), 'a half-written file left by a stopped build is cleared away');

  // 3. A third build downloads nothing at all.
  const third = await child('third');
  assert(state.requests.length === 0 && same(third.summary.counts, second.summary.counts) && readFileSync(join(third.out, 'roads.geojson'), 'utf8') === readFileSync(join(second.out, 'roads.geojson'), 'utf8'), 'a revision of the same area downloads nothing and writes the same roads file, byte for byte');

  // 4. A saved part that got damaged is dropped and asked for again by the build after.
  const damaged = join(work, 'cache', readdirSync(join(work, 'cache')).find((f) => f.startsWith('roads_') && f.includes('_3of6')));
  writeFileSync(damaged, readFileSync(damaged, 'utf8').slice(0, 500));
  const fourth = await child('fourth');
  assert(fourth.summary.failed.length === 1 && /a saved part of the download was damaged/.test(fourth.summary.failed[0].error) && fourth.layer('roads') === null && !existsSync(damaged), 'a damaged saved part: the roads layer is left out (not written half-made) and the bad file is removed');
  const fifth = await child('fifth');
  assert(state.requests.length === 1 && fifth.summary.failed.length === 0 && fifth.summary.counts.roads === 6 * ROADS_PER_PART + 1, 'the build after that asks for just that part and is complete again');

  // 5. Out of time: nothing waits, what was downloaded before is still used, and the rest is reported.
  for (const f of readdirSync(join(work, 'cache'))) if (/^roads_.*_[3-6]of6/.test(f)) rmSync(join(work, 'cache', f));
  script([], [], { a: 'Rate limit: 2\nSlot available after: x, in 600 seconds.\n' });
  state.reply = (query) => (groupOf(query) === 'roads' ? 429 : cityReply(query));
  const t0 = Date.now();
  const late = await child('late', { deadline: Date.now() + 30_000 });
  const roadsError = late.summary.failed.find((f) => f.roles.includes('roads'))?.error ?? '';
  assert(/^the download ran out of time while OpenStreetMap’s servers were busy: 4 of this area’s 6 parts couldn’t be downloaded\. The rest are kept for a week, so revising the city only asks for those 4$/.test(roadsError), `rate-limited for longer than the build has: "${roadsError}"`);
  assert(state.requests.length === 1 && Date.now() - t0 < 30_000, `the step does not sit out the 10-minute wait, or keep asking (${state.requests.length} request, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  assert(late.summary.counts.railway === 1 && late.summary.counts.amenities === PLACES + 2 && late.layer('roads') === null, 'the layers whose parts were saved earlier are still built');

  // 6. Another area: nothing saved for the old one is used, and it is cleared away.
  state.reply = cityReply;
  const moved = await child('moved', { bbox: { west: 77, south: 28.4, east: 77.1, north: 28.5 } });
  assert(state.requests.length === 3 && moved.summary.counts.roads === ROADS_PER_PART + 1 && readdirSync(join(work, 'cache')).length === 3, 'a redrawn area is downloaded afresh (3 requests) and the parts saved for the old one are removed');

  // 7. An area far too large to be a city: nothing is asked of the servers.
  const state3 = await child('state', { bbox: { west: 77, south: 26, east: 80, north: 29 } });
  const tooLarge = state3.summary.failed[0]?.error ?? '';
  assert(state.requests.length === 0 && state3.summary.failed.flatMap((f) => f.roles).length === 7 && /^the area you drew is too large to download from OpenStreetMap: it would be asked for in 293 parts, and the most is 80 /.test(tooLarge) && !/\.$/.test(tooLarge),
    `a 3 x 3 degree rectangle is not downloaded, and the uploader is told why: "${tooLarge}"`);
}

{
  // 8. The uploader's own OpenStreetMap export instead of a download.
  const exportPath = join(work, 'export.geojson');
  const features = [
    { type: 'Feature', id: 'way/1', properties: { highway: 'secondary', name: 'Export Road' }, geometry: { type: 'LineString', coordinates: [[77.1, 28.5], [77.2, 28.5]] } },
    { type: 'Feature', id: 'node/2', properties: { amenity: 'hospital', name: 'Export Hospital' }, geometry: { type: 'Point', coordinates: [77.1, 28.5] } },
    { type: 'Feature', id: 'way/3', properties: { natural: 'water', name: 'Export Lake' }, geometry: { type: 'Polygon', coordinates: [[[77.1, 28.5], [77.11, 28.5], [77.11, 28.51], [77.1, 28.5]]] } },
  ];
  writeFileSync(exportPath, JSON.stringify({ type: 'FeatureCollection', features }));
  const fromExport = await child('export', { exportPath });
  assert(state.requests.length === 0 && fromExport.summary.source === 'export' && fromExport.summary.counts.roads === 1 && fromExport.summary.counts.amenities === 1 && fromExport.summary.counts.water === 1 && fromExport.summary.failed.length === 0, 'an export is turned into layers with nothing downloaded');

  writeFileSync(exportPath, JSON.stringify({ type: 'FeatureCollection', features }).slice(0, -40));
  const cut = await child('export-cut', { exportPath });
  const error = cut.summary.failed[0]?.error ?? '';
  assert(cut.summary.failed.length === 1 && cut.summary.failed[0].roles.length === 7 && /^your OpenStreetMap export stops partway through \(after 2 features\).*revise$/.test(error), `an export that was cut off: every layer reported missing, in the uploader's words: "${error}"`);
  assert(['roads', 'amenities', 'water'].every((r) => cut.layer(r) === null) && Object.values(cut.summary.counts).every((n) => n === 0), 'and no layer is written from the part of it that could be read');
}

{
  // 9. The uploader's own files for single layers (a municipal survey), with OpenStreetMap out of reach for the rest.
  const own = (name, features) => { const p = join(work, name); writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', name, features })); return p; };
  const square = (x, y, d = 0.001) => [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]];
  const feature = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });
  const manualFile = (r, role) => (existsSync(join(r.out, `manual-${role}.geojson`)) ? JSON.parse(readFileSync(join(r.out, `manual-${role}.geojson`), 'utf8')) : null);
  const unreachable = { endpoints: ['http://127.0.0.1:9/api/interpreter'], cacheDir: join(work, 'cache-own') };

  const roadsFile = own('roads.geojson', [
    feature({ type: 'Polygon', coordinates: square(77.1, 28.5) }, { class: 0, name: 'Surveyed Road', length_m: 120 }),
    feature({ type: 'LineString', coordinates: [[77.2, 28.5], [77.21, 28.5]] }, { name: 'A centre-line', width: '9' }),
    feature({ type: 'Point', coordinates: [77.2, 28.5] }, { name: 'Not a road' }),
  ]);
  const stationsFile = own('stations.geojson', [feature({ type: 'Point', coordinates: [77.2, 28.5] }, { name: 'Own Halt', railway: 'halt' })]);
  const mine = await child('own', { ...unreachable, manual: { roads: roadsFile, amenities: stationsFile } });
  const roads = manualFile(mine, 'roads');
  assert(mine.summary.manual.roads.count === 2 && roads.features.length === 2 && roads.features[0].properties.class === 0 && roads.features[0].properties.length_m === 120, 'a surveyed road surface is kept as it is, with its class and its own properties');
  assert(roads.features[1].geometry.type === 'Polygon' && roads.features[1].properties.class === 2 && roads.features[1].properties.feature === 'road', 'a centre-line is widened into a surface; a point is left out');
  assert(mine.summary.manual.amenities.count === 1 && same(mine.summary.railwayStationNames, ['Own Halt']) && !mine.summary.counts.roads && mine.layer('roads') === null, 'a stations file gives the railway station names; nothing is written under the OpenStreetMap names for layers the uploader supplied');
  const missing = mine.summary.failed.flatMap((f) => f.roles).sort();
  assert(same(missing, ['landuse', 'localities', 'railway', 'vegetation', 'water']), `the layers the uploader did not supply are reported missing, the supplied ones are not (${missing.join(', ')})`);

  const elsewhere = await child('own-elsewhere', { ...unreachable, manual: { roads: own('far.geojson', [feature({ type: 'Polygon', coordinates: square(80.3, 26.4) }, { class: 1 })]) } });
  assert(/^none of its 1 features fall inside the area you drew/.test(elsewhere.summary.manual.roads.error) && manualFile(elsewhere, 'roads') === null, `a file for some other place is refused and nothing is kept of it: "${elsewhere.summary.manual.roads.error}"`);
  const wrongKind = await child('own-wrong', { ...unreachable, manual: { roads: own('points.geojson', [feature({ type: 'Point', coordinates: [77.2, 28.5] })]) } });
  assert(/^no usable roads features/.test(wrongKind.summary.manual.roads.error) && manualFile(wrongKind, 'roads') === null, 'a roads file with no lines or surfaces in it is refused');
  const cutPath = join(work, 'cut.geojson');
  writeFileSync(cutPath, readFileSync(roadsFile, 'utf8').slice(0, -60));
  const cutOwn = await child('own-cut', { ...unreachable, manual: { roads: cutPath } });
  assert(/^this file stops partway through \(after 2 features\).*revise$/.test(cutOwn.summary.manual.roads.error) && manualFile(cutOwn, 'roads') === null, `a file that was cut off is refused in the uploader's words: "${cutOwn.summary.manual.roads.error}"`);
}

{
  // 10. A city with very many roads gets them as tiles, not one file -- when the city's origin and tile size are given.
  rmSync(join(work, 'cache'), { recursive: true, force: true });
  const MANY = 60_000;
  state.reply = (query) => {
    if (groupOf(query) !== 'roads') return { elements: [] };
    const [south, west] = cellOf(query).split(',').map(Number);
    return { elements: Array.from({ length: MANY }, (_, k) => ({ type: 'way', id: k + 1, tags: { highway: k % 50 === 0 ? 'primary' : 'residential', name: k % 1000 === 0 ? `Road ${k}` : undefined },
      geometry: [{ lat: south + 0.0001 + (k % 300) * 0.0003, lon: west + 0.0001 + Math.floor(k / 300) * 0.0004 }, { lat: south + 0.0003 + (k % 300) * 0.0003, lon: west + 0.0003 + Math.floor(k / 300) * 0.0004 }] })) };
  };
  const small = { bbox: { west: 77, south: 28.4, east: 77.1, north: 28.5 } };
  const tiled = await child('tiled', { ...small, origin: { lon: 77.05, lat: 28.45 }, tileSizeM: 2000 });
  const manifestPath = join(tiled.out, 'roads', 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  assert(tiled.summary.tiled?.roads === 'roads' && tiled.summary.counts.roads === MANY && tiled.layer('roads') === null && manifest?.roads === MANY, `${MANY.toLocaleString('en-IN')} roads are written as tiles (${manifest ? Object.values(manifest.bands).reduce((n, b) => n + b.tiles.length, 0) : 0} files), with no roads.geojson`);
  assert(manifest && manifest.bands.major.tiles.reduce((n, t) => n + t.roads, 0) === MANY / 50 && manifest.bands.local.tiles.every((t) => existsSync(join(tiled.out, 'roads', t.url))) && JSON.parse(readFileSync(join(tiled.out, 'roads', 'names.json'), 'utf8')).length === MANY / 1000, 'major and local roads are in their own tile files, and the named ones in the name list');
  const whole = await child('not-tiled', small);
  assert(state.requests.length === 0 && !whole.summary.tiled?.roads && whole.layer('roads')?.features.length === MANY, 'without the city\'s origin and tile size (an older caller) the same roads are one roads.geojson, from the saved download');
}

rmSync(work, { recursive: true, force: true });
server.close();
console.log(process.exitCode === 1 ? '\n=== OSM DOWNLOAD: FAILURES ABOVE ===' : '\n=== OSM DOWNLOAD: ALL CHECKS PASSED ===');
