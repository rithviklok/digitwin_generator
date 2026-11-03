# Code review — October 2026

A line-by-line review of every source file in `src/`, `scripts/`, `server/` and `index.html`, done for the handover. It fixed 25 issues, 3 of them high severity. Every fix is verified against the original code or by a test, and the click fix (#25) was also timed in Microsoft Edge on the development PC's GPU. One visual change still needs a human eye; see [Check by eye](#check-by-eye).

The codebase was in good shape going in: clear structure, a config-driven engine, measured performance work, and comments that mostly explain *why* already. The issues below are what remained.

## Fixed

Severity: **High** means a security hole or a hang a user would hit. **Medium** means a wrong result, a real performance cost, or a likely operational failure. **Low** means latent or hardening.

| # | Sev. | Area | Finding | Fix |
|---|---|---|---|---|
| 1 | High | Security | **Stored XSS.** The inspect card wrote road, ward, zone and landmark names into `innerHTML` unescaped. Those names come from OpenStreetMap, which anyone can edit, and from uploaded files. The same origin holds every private city's access key (`localStorage`) and, on admin views, the admin token in the URL. | All data goes through `escapeHtml()` (`src/ui/escape-html.js`) in `InspectController`. The weather badge is now built from DOM nodes. |
| 2 | High | Viewer | **Loading screen hangs forever** for a city without baked tiles if its buildings worker fails (404, bad file, module error): `boot()` waited for an `onDone` that never came. | `BuildingLayer._finishLegacyLoad()` ends the load exactly once on `ERROR`, `onerror` or `onmessageerror`, keeping whatever tiles arrived. |
| 3 | High | Server | **Build queue stalls** after any database error in a build's bookkeeping: `processing` stayed true, so every later upload waited for ever. The rejected promise was also unhandled, which by default terminates Node. | `JobRunner._pump()` (queue mechanics) and `_runJob()` (one build) are split. A `finally` always releases the queue, the failed job and its city are marked failed, and `_kick()` catches rejections. |
| 4 | Med | Rendering | **Road classes rendered alike.** Each class's grain and roughness were written into shader source under one `customProgramCacheKey`. three.js reuses programs by key without looking at the source, so every class got the first-compiled class's values, clamping all roads into one roughness range. | Per-class values are now uniforms: one shared program, correct values per material. See *Check by eye*. |
| 5 | Med | Rendering | **Buildings culled at screen edges** in uploaded cities with tiles over 2 km: the frustum test used the global 2 km constant, not the city's tile size. | `BuildingLayer.tileSizeM`, taken from the manifest, is used for culling and tier distances. |
| 6 | Med | Viewer | **Search highlight never cleared** while the user was idle. `SearchController` dropped the `scheduler` it was given, so the 10 s timeout removed the mesh but never redrew. | The scheduler is kept, and the timeout's `markDirty()` now runs. |
| 7 | Med | Memory | **156 MB of JS heap and 233 ms at boot** (Kanpur) spent unpacking per-building metadata into objects, then repeated on every medium or full tile bind. Only a click (one building) and the shadow bake ever read it. | `BuildingMetaTable` (`src/layers/building-meta.js`) reads the packed tile columns on demand. `ShadowLayer` bakes straight from them, with no allocation per building. |
| 8 | Med | Viewer | **Tile failures ran inside the render loop.** HTTP status was ignored (Vite's dev server answers a missing file with HTML and status 200). A decode error threw out of the frame and skipped the render. A failed tile was re-requested on every frame, and the in-flight counter could be decremented twice. | Status is checked. Decoding is in `try` in the build queue. Failures back off for 10 s with a frame scheduled for the retry. The in-flight count is decremented once, in `finally`. |
| 9 | Med | Server | **Blank `.env` numbers became 0.** `BAKE_TIMEOUT_MIN=` killed every build at once, `RETENTION_DAYS=` purged failed cities at the next sweep, a blank quota refused every upload, and `PORT=` picked a random port. | `envNumber()` in `server/config.js`: blank or invalid falls back to the default, with a warning for invalid values. |
| 10 | Med | Security | **Admin token in access logs.** The admin page sent `?token=` on every API call, and HOSTING.md's nginx rule only hides `?admin=` page loads. | The admin client sends `Authorization: Bearer`, which the server already accepted. `?token=` still works for old scripts. |
| 11 | Med | Server | **Unbounded tile size on upload**, checked only after the whole, possibly multi-GB, upload arrived. A 1 m tile is one tile per building: millions of files. | Bounded to 250–20,000 m (`TILE_SIZE_RANGE_M` in `city-schema.js`). Checked in the form before sending and on the server. Existing cities are unaffected. |
| 12 | Med | Streaming | **Tile decode copied every array**, about 3 ms per full-detail tile inside a 6 ms per-frame budget. | Arrays are viewed in place when aligned. The encoder pads the header to 4 bytes; that is JSON whitespace, so old decoders still read new files. |
| 13 | Med | Formats | **Decoders misread Node Buffers.** `Buffer#slice` returns a view, not a copy, so the copying path wrapped the whole pooled buffer. `--bounds-only` worked around it with an extra copy of every file (1.9 GB for Kanpur). | Both decoders normalise their input to a plain `Uint8Array`. `--bounds-only` passes Buffers directly. |
| 14 | Med | GPU | **Invisible pick surfaces drawn every frame.** Ward and zone fills at opacity 0 were two city-wide transparent passes with depth writes. | `material.visible = false`. Raycasting ignores material visibility, so clicks still work. |
| 15 | Low | Worker | A `LOAD` after an `ABORT` on the same worker reset the single `aborted` flag and **revived the old load**. | A run counter makes any older load stale. |
| 16 | Low | Server | DB migrations stamped `user_version` **outside** their transaction (v3 and v5 had none). A crash in between left a DB that failed on the next start. | Each step stamps inside its own transaction. |
| 17 | Low | Server | A queued pre-v2 job (`params_json` null) **crashed startup** at `JSON.parse(null)`. | Such jobs are failed before the orphan check, so their cities are marked failed. |
| 18 | Low | Security | City access tokens were compared with `!==`; the admin token already used constant time. | `accessTokenMatches()` in `server/lib/ids.js`; a missing or array `?t=` never matches. |
| 19 | Low | Data | Valid GeoJSON with **`geometry: null`** (RFC 7946 §3.2; QGIS writes these) was refused. | Allowed and skipped. |
| 20 | Low | CLI | `build-building-tiles.mjs` turned a bare `--tile-size` into 1 (a 1 m grid) and typos into NaN. | `numberArg()` validates numeric flags with ranges. |
| 21 | Low | Maintenance | The stream reader used `Buffer#latin1Slice`, an **undocumented Node internal**. Found by the TypeScript check. | `toString('latin1', …)`. |
| 22 | Low | Architecture | **Kanpur names inside the engine:** two locality names in `LabelLayer`, and the 153-tile count in `PerfProbe`. | Moved to `kanpurConfig.labels.localityNamesCoveredByStations`; the probe uses the city's own count. |
| 23 | Low | Performance | Small waste: a palette switch repainted roads, ground and lights twice; trees allocated two vectors each (up to 40,000); line-colour regexes compiled per call; a lookup table allocated per feature in a 58-lakh-feature extent pass. | Removed. |
| 24 | Low | Robustness | The shadow bake would overrun its buffer on a footprint with fewer than 3 corners. The builder never emits one, but nothing guarded it. | Such footprints are skipped in both passes. |
| 25 | Med | Viewer | **Clicks froze the page.** Picking a building or road tested every triangle of every tile the ray came near, well over a million at street level. In Edge that took 85–123 ms per click, and 2.1–2.7 s with the browser's JavaScript compiler off. Edge's "Enhance your security on the web" does that to sites it treats as unfamiliar, and it did on the development PC. | `pickNearest()` in `src/engine/MeshPicker.js` indexes each mesh's triangles into short runs per building or road, on the first pick, and tests only the runs the ray passes through, nearest mesh first. It uses three.js's own triangle test, so the hit is the same. `setKnownBounds()` now also sets each mesh's exact box. |

## Verification

| Check | Result |
|---|---|
| The six existing harnesses (`scripts/test-*.mjs`) | 3,522 checks pass, before and after |
| Click picking vs three.js on real tiles and roads, five camera poses (`scripts/test-picking.mjs`, new) | The same hit on 900 of 900 rays |
| Clicks in Microsoft Edge 154, driven on the development PC's GPU | See the table below; ward and zone clicks (#14) confirmed working |
| Tile format vs the original, all 459 Kanpur tile files | Identical arrays; Buffer input works; old decoder reads new files |
| Building metadata and shadows vs the original, every tile | 1,855,743 records and 304 shadow meshes (31.9 M vertices) byte-identical |
| Server units: blank settings, v0→v6 migration with data, token checks, queue under a DB error | 17/17 pass. The original fails the settings and queue checks: it stalls with a job stuck "running". |
| Server end to end: upload, bake, live, tiles, admin delete, all local | 18/18 pass |
| TypeScript (`checkJs`) on 14 core modules | 0 errors |
| Production build (`vite build`) | Succeeds |

Measured effect, in Node on Kanpur's real data:

| | Before | After |
|---|---|---|
| Per-building metadata at boot | 156 MB heap, 233 ms | ~0 MB, 0 ms |
| Shadow work for 153 full-tier binds | 379 ms | 276 ms |
| Decoding all full-tier tiles (943 MB) | 468 ms | 280 ms; 6 ms after a re-bake |

Clicks in Microsoft Edge, time until the highlight and card are on screen, ten clicks over central Kanpur:

| | Before | After |
|---|---|---|
| JavaScript compiler on | 95–141 ms | 12–23 ms; 50 ms for the first click in an area, which builds its index |
| JavaScript compiler off | 2.07–2.30 s | 28–45 ms; up to 0.28 s for the first click in an area |

### Check by eye

1. **Road finishes (#4).** Open Kanpur and zoom to about 300 m over a junction. Arterials (class 0) should look smoother and glossier than local lanes (class 2), which are rougher and grainier, as `TIER_STYLE` in `RoadLayer.js` intends. To keep the old uniform look, give the three classes the same `roughness`, `grainScale` and `grainAmount`.
2. **Ward and zone clicks (#14).** Confirmed in Edge: clicks that miss buildings and roads open the ward card as before.

## Recommended next steps (not changed)

1. **CI.** Run the six harnesses and a server end-to-end test on every change. A runner needs Kanpur's 2.2 GB of data.
2. **A browser smoke test** (e.g. Playwright): boot, screenshot, click, search. Findings #4 and #6 would have been caught.
3. **Re-bake Kanpur** (`node scripts/build-building-tiles.mjs --city kanpur`, about 25 s) to get padded headers and the in-place decode.
4. **Sun and time zone.** The sun follows the viewer's clock, not the city's. Uploaded cities share one daylight curve, with a noon elevation of 60°. Derive both from the city's longitude and latitude.
5. **Async deletes.** The retention sweep and city deletion use synchronous `rmSync`, which blocks every request while gigabytes are removed.
6. **Content-Security-Policy** with `script-src 'self'`, as defence in depth behind #1.
7. **Smaller first visits.** Pre-compressed (brotli) tiles or quantised positions; Kanpur's first visit is 205 MB uncompressed.
8. **Free CPU-side colour and normal arrays after GPU upload.** That is about 85 MB for Kanpur's coarse tier. Positions and `buildingId` must stay for picking, and WebGL context loss would then need a re-fetch path.
9. **Abuse controls.** Uploads are open, with a per-IP quota only; consider auth at the reverse proxy for public deployments.
10. **Types.** Add `@types/three` as a dev dependency and extend `// @ts-check` beyond the nine modules that have it.
11. **Index ahead of the first click.** With the compiler off, the first click in a new area still takes up to about a quarter of a second while `MeshPicker` indexes the tiles there. Building those indexes in idle time after a tile loads would remove that.
12. **Edge on demo and kiosk machines.** With the compiler off, boot also takes about 11 s instead of 4 s and new detail stalls briefly as it loads. Adding the site to Edge's "Enhance your security on the web" exceptions is a per-user setting, or use Chrome.

## How comments and types were handled

- **Comments.** Most existing comments already explained the reason, often with the measurement behind it, so they were kept. Rewritten were the ones that were stale ("the worker self-closes", "coarse is never evicted", "the worker loads buildings"), inaccurate (the allocation claim on `projectRingFlat`, which was measured), or tagged with a city name ("[KANPUR][FIX]"). New code is commented with its reason and evidence.
- **Types.** Plain JavaScript with JSDoc was kept; a TypeScript port would touch every file and the build for no runtime gain. Shared typedefs now describe the tile format (`TilePayload`, `PackedBuildingMeta`, `TileMeshPart`), `BuildingTile`, `BuildingRecord` and the bake parameters. Nine browser-safe modules carry `// @ts-check`, and `jsconfig.json` lets editors apply it.

## Files changed

40 modified, 5 new: `src/layers/building-meta.js`, `src/engine/MeshPicker.js`, `src/ui/escape-html.js`, `scripts/test-picking.mjs`, `jsconfig.json`. The largest changes are in `BuildingLayer.js`, `tile-binary-format.js`, `ShadowLayer.js`, `jobRunner.js`, `building-style.js` and `build-building-tiles.mjs`. Also updated: `README.md` (rewritten), `NEW_CITY_CHECKLIST.md` and `server/.env.example` (references only).
