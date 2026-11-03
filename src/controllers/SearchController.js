// ===================================================================
// SearchController — filters LabelLayer.searchIndex by substring match
// (startsWith-first), flies the camera to whichever result is chosen,
// and shows a 10s auto-clearing pin + boundary highlight.
// ===================================================================
import { SEARCH_HIGHLIGHT_COLOR, BUILDING_SELECT_COLOR, Y_KMC_ROAD } from '../config/constants.js';

const SEARCH_PIN_DURATION_MS = 10000;

export class SearchController {
  /**
   * @param {{dom: {btnSearch: HTMLElement, searchPanel: HTMLElement, searchInput: HTMLInputElement, searchResultsEl: HTMLElement},
   *   labelLayer: import('../layers/LabelLayer.js').LabelLayer, cameraRig: import('../engine/CameraRig.js').CameraRig,
   *   highlightRenderer: import('../engine/HighlightRenderer.js').HighlightRenderer,
   *   scheduler: import('../engine/DirtyScheduler.js').DirtyScheduler}} deps
   */
  constructor({ dom, labelLayer, cameraRig, highlightRenderer, scheduler }) {
    this.dom = dom;
    this.labelLayer = labelLayer;
    this.cameraRig = cameraRig;
    this.highlightRenderer = highlightRenderer;
    // Needed to clear the 10-second highlight: the render loop is idle-gated,
    // so removing the mesh draws nothing until someone asks for a frame. It
    // was passed in by TwinEngine but never kept, so the highlight stayed on
    // screen until the camera next moved.
    this.scheduler = scheduler;
    this.currentResults = [];
    this.activeIndex = -1;
    this.pinEntry = null;
    this._pinTimer = null;
    this._highlightTimer = null;

    const { btnSearch, searchPanel, searchInput, searchResultsEl } = dom;
    btnSearch.addEventListener('click', () => (searchPanel.hidden ? this.open() : this.close()));
    searchInput.addEventListener('input', () => this._renderResults(searchInput.value));
    searchInput.addEventListener('keydown', (e) => this._onKeydown(e));
  }

  open() {
    const { btnSearch, searchPanel, searchInput, searchResultsEl } = this.dom;
    searchPanel.hidden = false;
    btnSearch.setAttribute('aria-pressed', 'true');
    searchInput.value = '';
    searchResultsEl.innerHTML = '';
    this.currentResults = [];
    this.activeIndex = -1;
    searchInput.focus();
  }
  close() {
    const { btnSearch, searchPanel } = this.dom;
    searchPanel.hidden = true;
    btnSearch.setAttribute('aria-pressed', 'false');
  }

  /** @param {string} name @param {string} query @returns {-1|1|2} */
  _matchScore(name, query) {
    const idx = name.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return -1;
    return idx === 0 ? 2 : 1; // 2 = prefix match, 1 = substring match elsewhere
  }

  /**
   * Search-index entries matching `query`, best first (prefix before substring, then shorter names).
   * @param {string} query @param {number} [limit]
   */
  rank(query, limit = 8) {
    const q = query.trim();
    if (!q) return [];
    const scored = [];
    for (const entry of this.labelLayer.searchIndex) {
      const s = this._matchScore(entry.name, q);
      if (s >= 0) scored.push({ entry, s });
    }
    scored.sort((a, b) => b.s - a.s || a.entry.name.length - b.entry.name.length);
    return scored.slice(0, limit).map((x) => x.entry);
  }

  _renderResults(query) {
    const { searchResultsEl } = this.dom;
    searchResultsEl.innerHTML = '';
    this.activeIndex = -1;
    this.currentResults = this.rank(query);

    this.currentResults.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = r.name;
      const typeSpan = document.createElement('span');
      typeSpan.className = 'search-result-type';
      typeSpan.textContent = r.type;
      item.append(nameSpan, typeSpan);
      item.addEventListener('click', () => this.select(r));
      searchResultsEl.appendChild(item);
    });
  }

  _onKeydown(e) {
    if (e.key === 'Escape') { this.close(); return; }
    if (e.key === 'Enter') {
      const target = this.currentResults[Math.max(0, this.activeIndex)];
      if (target) this.select(target);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.currentResults.length) return;
      this.activeIndex = e.key === 'ArrowDown' ? Math.min(this.currentResults.length - 1, this.activeIndex + 1) : Math.max(0, this.activeIndex - 1);
      [...this.dom.searchResultsEl.children].forEach((el, i) => el.classList.toggle('active', i === this.activeIndex));
    }
  }

  select(entry) {
    const targetDistance = entry.type === 'building' ? 420 : entry.type === 'road' ? 900 : 650;
    this.cameraRig.flyTo(entry.x, entry.z, targetDistance);
    this._showPin(entry);
    this._showHighlight(entry);
    this.close();
  }

  _showHighlight(entry) {
    clearTimeout(this._highlightTimer);
    // Selecting ANYTHING deselects whatever was highlighted before,
    // even a locality with no ward-polygon match of its own (see
    // LabelLayer's note on why ~72% of localities have none) -- leaving
    // a stale highlight from a previous click/search up would misleadingly
    // read as if it belonged to this new selection.
    this.highlightRenderer.clearActive();
    if (entry.type === 'locality' && !entry.highlightRings && !entry.highlightFlat) return;

    let mesh;
    if (entry.highlightRings || entry.highlightFlat) {
      const rings = entry.highlightRings ?? [entry.highlightFlat];
      mesh = this.highlightRenderer.makeRingsOutline(rings, entry.highlightY ?? Y_KMC_ROAD + 0.04, SEARCH_HIGHLIGHT_COLOR);
    } else {
      // Point result with no polygon of its own (e.g. a metro/orientation label) -- a simple ring marker instead.
      mesh = this.highlightRenderer.makeRingMarker(entry.x, entry.z, BUILDING_SELECT_COLOR);
    }
    this.highlightRenderer.setActive(mesh);
    this._highlightTimer = setTimeout(() => {
      // By now flyTo()'s 900ms tween is long finished -- the idle-gated
      // loop may not render again on its own, so clearing the highlight
      // needs its own markDirty() or it stays drawn until some unrelated
      // camera movement happens to trigger the next frame.
      if (this.highlightRenderer.isActive(mesh)) { this.highlightRenderer.clearActive(); this.scheduler?.markDirty(); }
    }, SEARCH_PIN_DURATION_MS);
  }

  _showPin(entry) {
    this._clearPin();
    // A plain {x,y,z} object works here: LabelLayer.update() only ever
    // reads worldPos.x/y/z (via Vector3.copy()/distanceTo(), both of
    // which read plain properties, not methods) -- no need to construct
    // a real THREE.Vector3 just to carry three numbers.
    this.pinEntry = this.labelLayer.addTransientLabel('label3d search-pin-label', entry.name, { x: entry.x, y: entry.y, z: entry.z });
    this._pinTimer = setTimeout(() => this._clearPin(), SEARCH_PIN_DURATION_MS);
  }
  _clearPin() {
    if (this._pinTimer) { clearTimeout(this._pinTimer); this._pinTimer = null; }
    if (!this.pinEntry) return;
    this.labelLayer.removeLabel(this.pinEntry);
    this.pinEntry = null;
  }
}
