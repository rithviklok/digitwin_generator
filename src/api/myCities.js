// ===================================================================
// myCities.js -- the localStorage side of "no accounts, no passwords":
// the cities this browser holds the private link of. UploadView.js
// writes an entry here right after a successful submit, and again
// whenever a city's Review & build page (?status=1&city=&t=) is opened
// -- that's how a city gets onto another device's list.
// CityPickerView.js reads the list back. This is a per-browser
// convenience list, NOT the access mechanism itself -- the access token
// in each entry is what actually matters.
// ===================================================================
const STORAGE_KEY = 'digitwin.myCities';

/** @returns {Array<{cityId: string, accessToken: string, displayName: string}>} */
export function getMyCities() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return []; // corrupt/blocked storage -- an empty list is a safe fallback, never throw
  }
}

/** Adds or updates (by cityId) an entry, most-recent first. */
export function addMyCity({ cityId, accessToken, displayName }) {
  try {
    const list = getMyCities().filter((c) => c.cityId !== cityId);
    list.unshift({ cityId, accessToken, displayName });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Private window / blocked storage -- the city is still reachable via
    // its Review & build page link, so losing the local convenience list isn't fatal.
  }
}

export function removeMyCity(cityId) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getMyCities().filter((c) => c.cityId !== cityId)));
  } catch { /* see addMyCity */ }
}
