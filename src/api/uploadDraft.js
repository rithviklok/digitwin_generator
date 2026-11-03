// ===================================================================
// uploadDraft.js -- localStorage persistence for an IN-PROGRESS, not
// yet submitted "Upload a city" form (UploadView.js), so closing the
// tab mid-wizard doesn't lose everything. Deliberately does NOT (and
// cannot) hold the actual File objects a user picked in a <input
// type="file"> -- browsers never let a page restore a file selection
// across a reload, for the same reason they never let a page read an
// arbitrary file off disk without an explicit user gesture each time.
// Only `fileNames` (what the user picked, by name, for a "previously
// attached: X -- please re-select it" reminder) is kept.
//
// Single slot, not a list -- this is a lightweight "continue where you
// left off" convenience, not a multi-draft manager. Starting a fresh
// upload overwrites whatever draft existed.
// ===================================================================
const STORAGE_KEY = 'digitwin.uploadDraft';

/**
 * @typedef {Object} UploadDraft
 * @property {number} step
 * @property {string} displayName
 * @property {{west:number,south:number,east:number,north:number}|null} bbox
 * @property {string} heightProperty
 * @property {{tileSizeM:string,minRenderHeightM:string,windowMinHeightM:string}} generation
 * @property {Record<string,string>} fileNames - DOM field id -> file name, for slots that had a file picked
 * @property {string} savedAt
 */

/** @returns {UploadDraft|null} */
export function getDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // corrupt/blocked storage -- treat as "no draft", never throw
  }
}

/** @param {UploadDraft} draft */
export function saveDraft(draft) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
  } catch { /* private window / blocked storage -- losing autosave isn't fatal, the form still works this session */ }
}

export function clearDraft() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* see saveDraft */ }
}

export function hasDraft() {
  return getDraft() != null;
}
