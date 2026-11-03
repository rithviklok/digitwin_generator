// ===================================================================
// Cross-cutting rendering constants.
// Shared by multiple layers/controllers, kept in one place instead of
// being redeclared (and risking drift) in each file that needs them.
// These are visual-style constants (Y-offsets so nothing z-fights,
// selection colors, LOD curves), not per-city data -- per-city data
// lives in CityConfig, see city-schema.js.
// ===================================================================

// Y-offset stack, lowest to highest -- keeps every flat layer from
// z-fighting the one below it.
export const Y_LANDUSE = 0.05;
export const Y_VEGETATION = 0.06;
export const Y_WATER = 0.12;
export const Y_RAILWAY = 0.24;
export const Y_KMC_ROAD = 0.20;
// Building shadows over the day (ShadowLayer). Strength follows the sun's height -- sin(elevation), normalised so the
// city's highest sun (CityConfig.sun.maxElevationDeg) = 1 -- so noon is strongest and dawn/dusk barely register. Length is
// capped: at a ~2 degree dusk sun a 20 m building would otherwise cast 500+ m of shadow across whole blocks.
export const BUILDING_SHADOW_MAX_LENGTH_PER_HEIGHT = 3; // shadow length <= 3x the building's height (a ~18 degree sun)
export const Y_KMC_WARD = 0.30;
export const Y_KMC_ZONE = 0.32;

export const TILE_SIZE_M = 2000;

// Building LOD: height-based fade curve AND a spatial (distance + frustum)
// reveal radius around the camera -- both factors multiply (see
// TwinEngine.js's updateBuildingLOD()). Height alone would fade
// every tile in the city identically regardless of distance; these two
// together are what makes the reveal look like it's happening "around
// the camera" instead of a flat city-wide opacity slider.
export const BUILDING_HIDE_ABOVE_HEIGHT = 500;
export const BUILDING_FULL_OPACITY_HEIGHT = 50;
export const BUILDING_PICK_MIN_OPACITY = 0.35;
export const BUILDING_LOD_DISTANCE = 3000;        // base spatial reveal radius AT BUILDING_HIDE_ABOVE_HEIGHT
export const BUILDING_LOD_FADE_INNER_FRAC = 0.75; // fraction of the reveal radius that's full-opacity before the fade band starts
export const FOG_FAR_FOR_LOD = 22000;             // reveal radius ceiling -- no point revealing past where fog already hides it

// Streaming-building tier selection (BuildingLayer.updateTiers). A tile's tier
// comes from the camera's 3D distance (x, y, z) to the nearest point of the
// tile's box -- not its centre -- and ignores the view frustum, so tiles are
// already at the right detail before you turn or move toward them. The
// per-tier radii themselves live in the tile manifest (they're derived from
// each city's own triangle density by scripts/build-building-tiles.mjs); the
// buffer around the camera IS that radius, so there's no separate margin.
export const BUILDING_TIER_HYSTERESIS_M = 250;       // extra distance before a tile is downgraded again (stops thrash at a boundary)
export const BUILDING_TIER_PREFETCH_HEIGHT_M = 1000; // tiers only follow the camera below HIDE_ABOVE + this; higher up everything stays coarse. The coarse tier (flat roofs) is nearly invisible next to the ground, so buildings only READ as buildings once their medium/full tier is in: it must be loaded before the camera gets under HIDE_ABOVE. Measured cost of the extra 500 m: hovering at 1.2-1.4 km pulls ~45-55 MB of tiles (0 at the old 500)
export const BUILDING_TIER_DOWNGRADE_DELAY_MS = 5000; // a tile must want a lower tier this long before it gets one (upgrades are immediate) -- a camera orbiting or panning back and forth would otherwise re-fetch the same tiles every lap
export const BUILDING_TIER_MAX_RESIDENT = 16;        // hard cap on tiles held above coarse at once; past it the farthest drop straight back to coarse
export const BUILDING_TIER_MAX_UPGRADE_SPEED_MPS = 1500; // no NEW upgrades while the camera moves faster than this: a fly-to sweeps 10+ km/s (measured ~45 requests / 390MB for tiles it merely passed over), walking/panning/zooming stay far below
export const BUILDING_COARSE_MAX_FETCHES = 8;        // large cities only (BuildingLayer.coarseOnDemand): downloads in flight at once for tiles that hold nothing yet
export const BUILDING_TIER_BIND_BUDGET_MS = 6;       // tiles that finish loading are built in a queue, about this many ms of main-thread work per frame (always at least one), instead of all at once

// Road tiles (RoadLayer.updateTiles) -- only a city large enough for its roads to be written as tiles (a metro; see
// server/lib/roadTiles.js). A tile is loaded while the camera is within its band's radius of the tile's roads, measured
// in 3D like the building tiers, so a high camera holds fewer local tiles than a low one.
export const ROAD_MAJOR_RADIUS_M = FOG_FAR_FOR_LOD;  // class 0 and 1 roads: as far as the fog lets anything be seen
// Class 2 roads: far enough that the opening view, fully zoomed out at its own tilt, has them to the top of the window
// (the ground along the top edge is 11.8 km from the camera, 13.8 km at the corners of a 16:10 window), so streets
// are never seen to stop short or to appear while panning. A 3.75 m street is a third of a pixel wide at 13 km on a
// 1080p screen. Measured on a Delhi-sized city, against 9 km: 184 tiles held instead of 93 at that view, 36 MB of
// road tiles instead of 16, no change in frame rate; at 9 km, 1.2% of the opening view's pixels differed visibly.
export const ROAD_LOCAL_RADIUS_M = 13000;
export const ROAD_TILE_HYSTERESIS_M = 500;           // extra distance before a loaded tile is let go
export const ROAD_TILE_EVICT_DELAY_MS = BUILDING_TIER_DOWNGRADE_DELAY_MS; // and how long it must have been out of range, for the same reason building tiers wait
export const ROAD_TILE_MAX_FETCHES = 8;              // tile downloads in flight at once
export const ROAD_TILE_BIND_BUDGET_MS = 4;           // main-thread time per frame for turning downloaded tiles into meshes (always at least one)

// GPU upload queue (engine/GpuUploadQueue.js): geometry is pushed to the GPU ahead of time, invisibly,
// instead of in the first frame it is drawn (measured 250-400 ms in ONE frame when buildings first appeared).
export const GPU_UPLOAD_BUDGET_MS = 6;        // per rendered frame after boot (always at least one batch)
export const GPU_UPLOAD_BOOT_CHUNK_MS = 25;   // per chunk while the loading screen is up
export const GPU_UPLOAD_BATCH_BYTES = 4 * 1048576; // objects are grouped into one render() pass up to about this many bytes

// Click-to-inspect highlight outline styling.
export const BUILDING_SELECT_COLOR = 0x2dd4ff;
export const SEARCH_HIGHLIGHT_COLOR = 0x7dd3fc;
export const HIGHLIGHT_LINEWIDTH_PX = 3;

export const MIN_CAMERA_HEIGHT_M = 5;

export function buildingHeightFade(y) {
  if (y >= BUILDING_HIDE_ABOVE_HEIGHT) return 0;
  if (y <= BUILDING_FULL_OPACITY_HEIGHT) return 1;
  return 1 - (y - BUILDING_FULL_OPACITY_HEIGHT) / (BUILDING_HIDE_ABOVE_HEIGHT - BUILDING_FULL_OPACITY_HEIGHT);
}

export function darkenHex(THREE, hex, factor) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(factor);
  return c.getHex();
}

export function toTitleCase(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export function normalizeLabelName(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : null;
}
