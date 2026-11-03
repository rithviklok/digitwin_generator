// ===================================================================
// WelcomeBackBanner -- shown on the plain default boot (no ?city=,
// no ?admin=) when localStorage says there's something to come back
// to: previously-uploaded cities (myCities.js) and/or an in-progress
// upload draft (uploadDraft.js). Makes "come back tomorrow and find
// what you were doing" a banner you see immediately, instead of
// something you only find by already knowing to click "My cities".
// ===================================================================
import { getMyCities } from '../api/myCities.js';
import { hasDraft } from '../api/uploadDraft.js';

export function mountWelcomeBackBanner() {
  const cities = getMyCities();
  const draftPresent = hasDraft();
  if (cities.length === 0 && !draftPresent) return; // nothing to welcome back to -- stay silent

  const banner = document.getElementById('welcomeBackBanner');
  const textEl = document.getElementById('welcomeBackText');
  const actionsEl = document.getElementById('welcomeBackActions');
  const closeBtn = document.getElementById('btnWelcomeBackClose');
  if (!banner) return;

  const parts = [];
  if (cities.length > 0) {
    // Shown over the built-in city, so the uploader's own are "more" cities, named so it's
    // clear which (names are upload input: textContent below, never HTML).
    const names = cities.map((c) => c.displayName || c.cityId);
    const others = names.length - 2;
    const named = others > 0 ? `${names.slice(0, 2).join(', ')} and ${others} other${others === 1 ? '' : 's'}` : names.join(' and ');
    parts.push(`${cities.length} more ${cities.length === 1 ? 'city' : 'cities'} (${named})`);
  }
  if (draftPresent) parts.push('a draft in progress');
  textEl.textContent = `Welcome back. You have ${parts.join(' and ')}.`;

  actionsEl.innerHTML = '';
  if (cities.length > 0) {
    const a = document.createElement('a');
    a.href = '?mycities=1';
    a.className = 'welcome-back-banner__btn';
    a.textContent = 'View my cities →';
    actionsEl.appendChild(a);
  }
  if (draftPresent) {
    const a = document.createElement('a');
    a.href = '?upload=1';
    a.className = 'welcome-back-banner__btn';
    a.textContent = 'Resume draft →';
    actionsEl.appendChild(a);
  }

  banner.hidden = false;
  closeBtn?.addEventListener('click', () => { banner.hidden = true; });
}
