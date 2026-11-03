// ===================================================================
// viewParam.js -- one camera view in the form share links and the embed
// control API use: { lat, lon, distance, heading, tilt }.
//   lat/lon   the point on the ground the camera orbits (WGS 84)
//   distance  camera-to-that-point, metres
//   heading   compass degrees the camera faces (0 = north, 90 = east)
//   tilt      degrees from straight down (0 = top-down, ~88 = horizon)
// In a URL it's `view=lat,lon,distance,heading,tilt`; only lat,lon are
// required, the rest keep the current camera's values.
// CameraRig speaks scene metres (x/z around the city's origin); this
// converts through the same projection the layers use (geo-utils.js).
// ===================================================================
import { makeProjector, makeUnprojector } from '../workers/geo-utils.js';

/** CameraRig view <-> lat/lon view, for one city's origin. */
export function makeViewCodec(origin) {
  const project = makeProjector(origin);
  const unproject = makeUnprojector(origin);
  return {
    /** @param {{x:number, z:number, distance:number, headingDeg:number, tiltDeg:number}} v - CameraRig.getView() */
    toGeo(v) {
      const { lat, lon } = unproject(v.x, v.z);
      return { lat, lon, distance: v.distance, heading: v.headingDeg, tilt: v.tiltDeg };
    },
    /** For CameraRig.setView(); missing distance/heading/tilt stay undefined, which setView reads as "keep current". */
    fromGeo(g) {
      const { x, z } = project(g.lon, g.lat);
      return { x, z, distance: g.distance, headingDeg: g.heading, tiltDeg: g.tilt };
    },
    /** Scene x/z -> {lat, lon} (a clicked ground point). */
    pointToGeo(x, z) { return unproject(x, z); },
  };
}

/**
 * Validates a view from outside (a URL or a postMessage) -- never trust its
 * shape. Returns null when lat/lon are missing or out of range; drops
 * (rather than rejects) optional fields that aren't finite numbers.
 */
export function normalizeGeoView(v) {
  if (!v || typeof v !== 'object') return null;
  const lat = Number(v.lat), lon = Number(v.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const opt = (x) => (x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? undefined : Number(x));
  return { lat, lon, distance: opt(v.distance), heading: opt(v.heading), tilt: opt(v.tilt) };
}

/** "lat,lon,distance,heading,tilt" -> view, or null. */
export function parseViewParam(s) {
  if (!s) return null;
  const [lat, lon, distance, heading, tilt] = String(s).split(',');
  return normalizeGeoView({ lat, lon, distance, heading, tilt });
}

/** view -> "lat,lon,distance,heading,tilt" (~1 m / 1° precision -- enough for a link, short enough to paste). */
export function formatViewParam(g) {
  return [g.lat.toFixed(5), g.lon.toFixed(5), Math.round(g.distance), Math.round(g.heading), Math.round(g.tilt)].join(',');
}

/** URLSearchParams escapes the view's commas as %2C; commas are legal in a query string and far easier to read and edit by hand. */
export function readableUrl(url) {
  return url.href.replace(/%2C/gi, ',');
}

/** Rounded copy of a view for sending out (the API's events and replies). */
export function roundGeoView(g) {
  const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  return { lat: r(g.lat, 6), lon: r(g.lon, 6), distance: r(g.distance, 1), heading: r(g.heading, 1), tilt: r(g.tilt, 1) };
}
