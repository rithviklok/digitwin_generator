// ===================================================================
// DataLoader — fetches every CityConfig layer EXCEPT role BUILDINGS_3D
// concurrently, keyed by role. Buildings are BuildingLayer's job: they
// stream in as pre-baked tiles (or, for a city never baked, are built
// live in building-worker.js) -- never as one parsed GeoJSON here, since
// the raw file is hundreds of MB (Kanpur's: 283 MB).
// ===================================================================
import { LAYER_ROLES } from '../config/city-schema.js';

/**
 * A layer's parsed JSON, or null for ANY failure: one missing optional
 * layer (a city with no water file, a 404) must not stop the city loading.
 * Which roles came back null is reported by loadCityData().
 * @param {string} url
 * @returns {Promise<any|null>}
 */
async function tryLoad(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * @param {import('../config/city-schema.js').CityConfig} cityConfig
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{data: Record<string, any>, missingRequired: string[], missingOptional: string[]}>}
 */
export async function loadCityData(cityConfig, onProgress) {
  const nonBuildingLayers = cityConfig.layers.filter((l) => l.role !== LAYER_ROLES.BUILDINGS_3D);
  const data = {};
  let done = 0;
  await Promise.all(nonBuildingLayers.map(async (spec) => {
    data[spec.role] = await tryLoad(spec.url);
    done++;
    onProgress?.(done, nonBuildingLayers.length);
  }));

  const missingRequired = nonBuildingLayers.filter((l) => l.required && !data[l.role]).map((l) => l.role);
  // Optional layers that simply didn't load (shown in #missingHint): not a
  // hard failure, but worth surfacing rather than silently rendering an
  // incomplete city.
  const missingOptional = nonBuildingLayers.filter((l) => !l.required && !data[l.role]).map((l) => l.role);
  return { data, missingRequired, missingOptional };
}
