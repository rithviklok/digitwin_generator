// @ts-check
// ===================================================================
// escape-html.js -- the one helper for putting DATA into an HTML string.
//
// Why it exists: map data is not trusted text. Road, ward and landmark
// names come from OpenStreetMap (which anyone can edit) and from files
// uploaders attach, and the viewer's origin also holds every private
// city's access key (localStorage "My cities") and, on the admin page, the
// admin token in the address. A name such as `<img src=x onerror=...>`
// written into innerHTML unescaped runs as script there. Prefer
// textContent / DOM nodes; where a template string of HTML is genuinely
// simpler (the inspect card's rows), every data value goes through this.
// ===================================================================

/** @type {Record<string, string>} */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * @param {unknown} value - anything; null/undefined become ''
 * @returns {string} the value as text, safe inside HTML element content and quoted attribute values
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}
