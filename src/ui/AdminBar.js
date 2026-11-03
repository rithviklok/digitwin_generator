// ===================================================================
// AdminBar -- the small bar shown when an admin opens a city from the
// admin page (?admin=<token>&city=<id>, wired up by main.js): which
// city this is, its build log, and the way back to the list. The 3D
// view under it is the city's live build, exactly as its visitors see
// it. There is nothing to approve: a city is live once it has built.
//
// Markup lives in index.html (#adminBar and children), styled by
// styles.css's .admin-bar rules.
// ===================================================================
export function mountAdminBar({ token, city }) {
  const q = `?admin=${encodeURIComponent(token)}`;
  document.getElementById('adminBarCityName').textContent = city.displayName;
  document.getElementById('adminBarCityId').textContent = city.id;
  // A new tab: reading the log and looking at the city make sense side by
  // side, and this view (a live TwinEngine boot) shouldn't be lost to it.
  document.getElementById('adminBarLogsLink').href = `${q}&city=${encodeURIComponent(city.id)}&logs=1`;
  document.getElementById('adminBarListLink').href = q;
  document.getElementById('adminBar').hidden = false;
}
