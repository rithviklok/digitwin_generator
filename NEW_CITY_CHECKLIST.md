# New-city parity checklist

For a city added **by hand**, as Kanpur is (`src/config/cities/kanpur.config.js`).
A city uploaded through the site (**Upload a city**) needs none of this: the
server writes its configuration. This is the feature-parity checklist to run
down for every new hand-written city so it
visually and functionally matches what Kanpur already has — not just "does it
boot" (`validateCityConfig()` already guards that) but "does it look and
behave the same." Treat each row as a yes/no/deliberately-skipped decision.

See `README.md`, Part 2, "Hand-authoring a city", for the narrative walkthrough; this is the
itemized checker to tick off against it.

## A. Data layers (one row per `LAYER_ROLES` entry)

| Role | Kanpur's file | If missing / not provided |
|---|---|---|
| `CITY_BOUNDARY` | `Kanpur_city_boundaries.geojson` | No outline ring around the city edge; minor, cosmetic only |
| `LOCALITIES` | `localities.geojson` | Neighborhood names don't appear as labels or in search |
| `ROADS` | `kmc_roads.geojson` | No road surfaces at all — city reads as empty ground between buildings |
| `RAILWAY` | `railways.geojson` | No heavy-rail/metro lines or stations drawn |
| `ADMIN_WARDS` | `kmc_wards.geojson` | No ward boundaries / click-to-inspect-a-ward |
| `ADMIN_ZONES` | `kmc_zones.geojson` | No zone boundaries / click-to-inspect-a-zone |
| `LANDMARKS` | `kmc_landmarks.geojson` | Named landmark points (non-building) don't show or search |
| `BUILDING_LABELS` | `building_labels.geojson` | No building *names* float above the skyline (3D geometry still renders — see B) |
| `BUILDINGS_3D` | `tiles/manifest.json` (baked from `Kanpur_OpenBuildings_2_5D.geojson`) | **Required** — `validateCityConfig` refuses to boot without at least one `buildings-3d` layer |
| `LANDUSE` | `landuse.geojson` | No colored ground fill distinguishing residential/commercial/etc. |
| `VEGETATION` | `vegetation.geojson` | No scattered trees in parks/forests (see E) |
| `WATER` | `water.geojson` | Rivers/lakes/ponds don't render |
| `AMENITIES` | `amenities.geojson` | No amenity markers, and railway-vs-metro station disambiguation (below) has nothing to filter |

All roles are optional at the schema level except `BUILDINGS_3D`, but "optional"
here means "the app boots without it," not "visually equivalent to Kanpur" —
treat every row above as required unless you're deliberately accepting a gap
for a city that genuinely lacks that data (e.g., no metro system).

## B. The buildings pipeline (the one non-trivial layer)

Kanpur actually uses **two separate building datasets** — don't conflate them:

1. **3D geometry source** — `Kanpur_OpenBuildings_2_5D.geojson`: Google Open Buildings v3 footprints, each with its average height from Open Buildings 2.5D Temporal (2023), made in Earth Engine. `node scripts/fetch-open-buildings.mjs --bbox <west>,<south>,<east>,<north> --name <City>` makes the same file for any area with no account (checked against Kanpur's: the same footprints, heights within 1 m for 96%); `public/DATA_SOURCES.md` → Buildings has the Earth Engine and Microsoft fallbacks. Referenced via `sourceUrl` in the `BUILDINGS_3D` layer, with `heightProperty` pointing at whichever field holds meters (`'mean'` for Kanpur and the script's Google files, `'height'` for its Microsoft ones).
2. **Named-building label source** — a separate OSM-tagged `buildings.geojson`, pre-filtered offline by `scripts/extract-building-labels.mjs` down to `building_labels.geojson` (only the ≤400 buildings `LabelLayer` would ever actually label). This is *not* the same file as (1).

Checklist:
- [ ] Both source files acquired and placed under `public/data/<city-id>/` (buildings: `node scripts/fetch-open-buildings.mjs`, using the city's `bbox`)
- [ ] `node scripts/build-building-tiles.mjs --city <city-id>` run to produce `tiles/manifest.json` + coarse/medium/full binary tiles (recommended for any real city — the legacy live-worker path is a slow fallback, not the target experience)
- [ ] `heightProperty` in the config matches the actual field name in the new city's raw data (Kanpur's Open Buildings export uses `mean`; other sources vary)
- [ ] `node scripts/extract-building-labels.mjs` run against the new city's named-building source to produce its `building_labels.geojson`
- [ ] `buildingLod` budgets (`targetFullTierTris`/`targetMediumTierTris`) sanity-checked against the new city's building density — copying Kanpur's numbers blindly may over- or under-size the full-detail bubble for a denser/sparser downtown (re-derive with `--radii-only`, no re-bake needed)

## C. Georeference & scene setup

- [ ] `origin` — a meaningful, central real-world point (Kanpur uses Mall Road / Kanpur Central), not just a bbox centroid — everything else is scene-relative to this
- [ ] `bbox` — padded past the real municipal boundary (Kanpur pads ~0.02°)
- [ ] `buildings.tileSizeM` / `minRenderHeightM` / `windowMinHeightM` — carried over or deliberately re-tuned
- [ ] `sun.dayStartHour` / `dayEndHour` / `maxElevationDeg` / `minElevationDeg` — set for the new city's actual latitude, not copied from Kanpur. `maxElevationDeg` also sets shadow strength at noon (see `ShadowLayer.js`) — a wrong value makes shadows too strong/weak all day, not just at the wrong hour

## D. Curated, hand-authored content (easy to forget — nothing fails loudly if skipped)

- [ ] `labels.orientationAllowlist` — the ~10-25 places that should *always* show a label regardless of zoom (airports, depots, well-known colonies). Kanpur's list is Kanpur-specific place names; a new city needs its own hand-picked set, or the map will feel unlabeled at a glance even with data loaded
- [ ] `labels.railwayStationNames` — which `amenity=station` points in `AMENITIES` are genuine heavy-rail stations vs. metro, so `LabelLayer` doesn't mislabel one as the other
- [ ] `railway.lineColors` — Kanpur actually sets **none** and relies on automatic detection (color word in the line name → inherited from the city's main named line → stable fallback, see README.md, Part 2, "Data quality checklist"). Verify the new city's line names actually contain color words, or its lines will silently collapse to the fallback color; only add explicit overrides if they don't
- [ ] `palette` — Kanpur uses `null` (pure `DEFAULT_PALETTES`). Only needed if the new city wants different day/night coloring; otherwise explicitly confirm the default palette reads correctly against the new city's building/road density (a very different urban fabric can make a shared palette look off even though nothing is "wrong")

## E. Live systems

- [ ] Live weather — nothing to set in the city's config: the server adds its one OpenWeatherMap key (`WEATHER_API_KEY` in `server/.env`) to every city when it is opened, so the site needs the server running with that key. **Without it**, the app shows "Weather: API key not configured" and the automatic sunrise/sunset-driven day/night switch + rain/cloud mood don't run (the day colours stay, and the Day / Night button switches by hand)
- [ ] `trees.kindDensityM2PerTree` / `orchardGridSpacingM` / `instanceCap` — Kanpur's values (`forest:90, wood:90, park:350`, cap 40000) happen to equal the engine defaults, so omitting this block is safe *only if* the new city's vegetation polygons use the same `kind` tagging convention. Different tagging or much larger green spaces can blow past `instanceCap` or look sparse/dense wrong — check visually, don't assume

## F. Wiring & validation

- [ ] New `src/config/cities/<city-id>.config.js` created (copy of `kanpur.config.js`, every field reviewed against this list — not just the ones that are obviously different)
- [ ] `public/data/<city-id>/` populated with all files the new config's `layers` array points at
- [ ] `main.js` pointed at the new config, if it is to be the city the site opens with (the import that is now `kanpurConfig`). A hand-written city has no address of its own: uploaded cities are reached by their links, the built-in city by the plain site address
- [ ] `npm run dev` boots clean with no `validateCityConfig()` errors
- [ ] `node scripts/test-layers-harness.mjs` and `test-worker-harness.mjs` still pass

## G. Manual visual-parity pass (do this even if F is all green)

Walk through the same interactions on the new city that work on Kanpur today:

- [ ] Search box finds roads, localities, landmarks, and named buildings
- [ ] Click-to-inspect works on: a building, a road, a ward, a zone, a landmark, an amenity
- [ ] Fly-to from search lands with buildings already at medium/full detail, not flat coarse boxes
- [ ] Day → night transition (manual toggle if no weather key yet) repaints buildings/roads/water/sky correctly
- [ ] Building shadows appear, scale with time of day, and aren't wildly too long/short (checks `sun.maxElevationDeg`)
- [ ] Metro/rail lines (if any) show distinct, correct-looking colors, and stations are labeled rail vs. metro correctly
- [ ] Orientation labels are visible without needing to zoom in first
- [ ] Trees appear inside parks/forests at a density that doesn't look obviously sparse or like a solid green block
- [ ] `?perf` panel shows boot download / heap numbers in the same ballpark as Kanpur's (a very different city size will naturally scale, but a 10x blowup signals a config problem, e.g. wrong `buildingLod` budgets)
