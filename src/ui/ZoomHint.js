// ===================================================================
// ZoomHint -- "Zoom in to see the buildings in 3D", shown once per
// browser beside the zoom-in button. From the opening view (4.5 km up)
// the city reads as a flat map: buildings only fade in below
// BUILDING_HIDE_ABOVE_HEIGHT, and nothing else says they're there.
// It goes for good once the visitor has zoomed in far enough to see
// them, or dismisses it.
//
// Markup: index.html's #zoomHint, inside #mapControls so it can sit
// beside the button it's about.
// ===================================================================
import { BUILDING_HIDE_ABOVE_HEIGHT, BUILDING_FULL_OPACITY_HEIGHT } from '../config/constants.js';

const KEY = 'digitwin.zoomHintSeen';
/** Halfway through the buildings' fade-in: by here they are plainly on screen. */
const BUILDINGS_IN_VIEW_BELOW_M = (BUILDING_HIDE_ABOVE_HEIGHT + BUILDING_FULL_OPACITY_HEIGHT) / 2;

function alreadySeen() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
function rememberSeen() {
  try { localStorage.setItem(KEY, '1'); } catch { /* storage blocked (a private window, some embeds): the hint just shows again next visit */ }
}

/** @param {{engine: import('../engine/TwinEngine.js').TwinEngine}} args */
export function mountZoomHint({ engine }) {
  const hint = document.getElementById('zoomHint');
  const zoomIn = document.getElementById('btnZoomIn');
  if (!hint || !zoomIn || alreadySeen()) return;
  const buildingsInView = () => engine.camera.position.y < BUILDINGS_IN_VIEW_BELOW_M;
  // A shared link can open right down among the buildings -- nothing left to hint at.
  if (buildingsInView()) { rememberSeen(); return; }

  hint.style.top = `${zoomIn.offsetTop + zoomIn.offsetHeight / 2}px`; // level with the zoom-in button, wherever it is in the column
  hint.hidden = false;

  const { orbit } = engine.cameraRig;
  const onMove = () => { if (buildingsInView()) done(); };
  function done() {
    hint.hidden = true;
    orbit.removeEventListener('change', onMove);
    rememberSeen();
  }
  orbit.addEventListener('change', onMove);
  document.getElementById('btnZoomHintClose')?.addEventListener('click', done);
}
