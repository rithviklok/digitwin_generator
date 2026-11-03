// ===================================================================
// Topbar -- the AirawatOS top bar (index.html's <header class="topbar">).
// Mounted by main.js in EVERY mode (the 3D viewer and the chrome pages
// alike), before routing. Owns the clock, the current-page highlight on
// the nav links, and the city-name crumb. Light/dark follows the OS
// (see /shared/aos.css) -- there's no in-app theme picker.
//
// The clock is here, not in the engine, so that it also ticks on the
// chrome pages, where no engine ever boots.
// ===================================================================
export function mountTopbar() {
  startClock();
  markCurrentNav();
}

/** Shows the loaded city's name after "DigiTwin" in the crumb (viewer mode only). */
export function setTopbarCity(name) {
  const el = document.getElementById('topbarCity');
  if (!el) return;
  el.textContent = name ?? '';
  el.hidden = !name;
}

function startClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const tick = () => {
    const text = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (el.textContent !== text) el.textContent = text; // only touch the DOM when the minute actually changes
  };
  tick();
  setInterval(tick, 1000);
}

/** Highlights the nav link for the page we're on (?upload=… / ?mycities=…). */
function markCurrentNav() {
  const params = new URLSearchParams(location.search);
  for (const a of document.querySelectorAll('.topnav .navbtn')) {
    const [key] = new URL(a.href).searchParams.keys();
    if (key && params.has(key)) a.setAttribute('aria-current', 'page');
  }
}
