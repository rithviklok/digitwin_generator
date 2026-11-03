// ===================================================================
// api/client.js -- the app's first real networked module beyond ad hoc
// per-layer fetch()s (DataLoader.js etc. fetch static files; this
// talks to the self-hosted backend, server/, over VITE_API_BASE_URL).
// Thin wrappers, one per backend route actually used by the front end
// -- no generic request builder, since the routes don't share enough
// shape (multipart vs JSON, query-string vs path tokens) to make one
// worthwhile.
// ===================================================================

// Blank = same origin: in production the backend serves this page itself,
// and `npm run dev` / `npm run preview` proxy /api and /files to it
// (vite.config.js) -- so links work from any device, not just the server's.
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

/**
 * A multipart POST that reports how much has been SENT -- fetch() can't
 * (no upload progress events), and a city's buildings file is often
 * hundreds of MB, which otherwise looks exactly like a frozen page.
 * @param {(sent: number, total: number) => void} [onProgress] - once everything is sent, the server is still checking the files until this resolves
 */
function postWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      const body = xhr.response ?? {};
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      const err = new Error(body.error ?? `request failed (${xhr.status})`);
      err.status = xhr.status;
      err.body = body;
      reject(err);
    };
    xhr.onerror = () => reject(new Error('Could not reach the server. Nothing was saved; check that it is running and try again.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(formData);
  });
}

async function parseJsonResponse(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const apiClient = {
  baseUrl: API_BASE_URL,

  /**
   * @param {{displayName: string, formData: FormData}} args
   *   formData carries every multipart field (buildings, the optional
   *   municipal files, heightProperty, origin/bbox, generation settings)
   *   -- see routes/uploads.js for the exact field names.
   * @param {(sent: number, total: number) => void} [onProgress]
   * @returns {Promise<{cityId: string, accessToken: string, statusUrl: string}>}
   */
  async uploadCity({ displayName, formData }, onProgress) {
    const url = `${API_BASE_URL}/api/uploads?displayName=${encodeURIComponent(displayName)}`;
    return postWithProgress(url, formData, onProgress);
  },

  /**
   * The largest files this server takes: `maxUploadBytes` for the buildings
   * file, `maxLayerFileBytes` for every other one -- so the form can turn a
   * file away when it's chosen, not after it has been uploaded.
   * @returns {Promise<{maxUploadBytes: number, maxLayerFileBytes: number}>}
   */
  async getLimits() {
    return parseJsonResponse(await fetch(`${API_BASE_URL}/api/limits`));
  },

  /**
   * What the built-in city takes from the server it is served by: the
   * site's weather settings, or null when no key is set there.
   * @returns {Promise<{weather: {endpoint: string, refreshMs: number, apiKey: string}|null}>}
   */
  async getSite() {
    return parseJsonResponse(await fetch(`${API_BASE_URL}/api/site`));
  },

  /** Stops the city's build if one is running and permanently deletes everything stored for it. @returns {Promise<{deleted: true, freedBytes: number}>} */
  async deleteCity(cityId, token) {
    const url = `${API_BASE_URL}/api/uploads/${encodeURIComponent(cityId)}/delete?t=${encodeURIComponent(token)}`;
    return parseJsonResponse(await fetch(url, { method: 'POST' }));
  },

  /**
   * `status` is how the city's LATEST submission went ('processing' | 'live' | 'failed' | 'purged');
   * `hasLiveVersion` is whether any build of it can be viewed right now -- a failed or still-building
   * revision leaves the previous build live.
   * @returns {Promise<{cityId, displayName, status, hasLiveVersion, job: {status, stage, buildsAhead}|null, layers: object[]}>}
   */
  async getStatus(cityId, token) {
    const url = `${API_BASE_URL}/api/uploads/${encodeURIComponent(cityId)}/status?t=${encodeURIComponent(token)}`;
    return parseJsonResponse(await fetch(url));
  },

  /** Pre-fill data for the revise form. @returns {Promise<object>} */
  async getUploadDetails(cityId, token) {
    const url = `${API_BASE_URL}/api/uploads/${encodeURIComponent(cityId)}?t=${encodeURIComponent(token)}`;
    return parseJsonResponse(await fetch(url));
  },

  /** @returns {Promise<{cityId, accessToken, statusUrl}>} */
  async reviseCity(cityId, token, { displayName, formData }, onProgress) {
    const qs = new URLSearchParams({ t: token });
    if (displayName) qs.set('displayName', displayName);
    const url = `${API_BASE_URL}/api/uploads/${encodeURIComponent(cityId)}/revise?${qs}`;
    return postWithProgress(url, formData, onProgress);
  },

  /** @returns {Promise<{config: import('../config/city-schema.js').CityConfig}>} */
  async getCityConfig(cityId, token) {
    const url = `${API_BASE_URL}/api/cities/${encodeURIComponent(cityId)}/config?t=${encodeURIComponent(token)}`;
    return parseJsonResponse(await fetch(url));
  },
};

/**
 * The admin page's calls (server/routes/admin.js). `adminToken` is the
 * server's ADMIN_TOKEN, taken from the page's own ?admin=<token> address.
 *
 * Sent as an `Authorization: Bearer` header, which the server has always
 * accepted (lib/adminAuth.js), not as `?token=`: a URL lands in every
 * reverse-proxy access log, and HOSTING.md's nginx rule only keeps the
 * page's own `?admin=` addresses out of the log -- every API call the admin
 * page made was writing the token there.
 * @param {string} adminToken @param {RequestInit} [init]
 * @returns {RequestInit}
 */
const withAdminToken = (adminToken, init = {}) => ({ ...init, headers: { ...init.headers, Authorization: `Bearer ${adminToken}` } });

export const adminApi = {
  /** @returns {Promise<{cities: Array<{id, displayName, status, isLive, uploader, createdAt, lastBuildAt, inputBytes, failureReason}>, total: number, limit: number, offset: number}>} */
  async listCities(adminToken, { status = null, limit = 50, offset = 0 } = {}) {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (status) qs.set('status', status);
    return parseJsonResponse(await fetch(`${API_BASE_URL}/api/admin/cities?${qs}`, withAdminToken(adminToken)));
  },

  /** The config of the city's live build -- what the viewer boots from in admin view. @returns {Promise<{city: object, jobId: number, config: object}>} */
  async getCityConfig(adminToken, cityId) {
    return parseJsonResponse(await fetch(`${API_BASE_URL}/api/admin/cities/${encodeURIComponent(cityId)}/config`, withAdminToken(adminToken)));
  },

  /** Every build attempt of a city, newest first, each with its captured log. @returns {Promise<{cityId: string, jobs: object[]}>} */
  async listJobs(adminToken, cityId) {
    return parseJsonResponse(await fetch(`${API_BASE_URL}/api/admin/cities/${encodeURIComponent(cityId)}/jobs`, withAdminToken(adminToken)));
  },

  /** Stops the city's build if one is running and permanently deletes everything stored for it. @returns {Promise<{deleted: true, freedBytes: number}>} */
  async deleteCity(adminToken, cityId) {
    const url = `${API_BASE_URL}/api/admin/cities/${encodeURIComponent(cityId)}/delete`;
    return parseJsonResponse(await fetch(url, withAdminToken(adminToken, { method: 'POST' })));
  },
};
