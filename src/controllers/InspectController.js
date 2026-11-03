// ===================================================================
// InspectController — click-to-inspect: raycasting across buildings,
// roads, wards, and zones (in that most-specific-first order), the
// matching highlight outline, and the info panel.
// ===================================================================
import * as THREE from 'three';
import { BUILDING_SELECT_COLOR, BUILDING_PICK_MIN_OPACITY, Y_KMC_ROAD, toTitleCase } from '../config/constants.js';
import { escapeHtml } from '../ui/escape-html.js';
import { pickNearest } from '../engine/MeshPicker.js';

const INSPECT_AUTOHIDE_MS = 10000;
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

const BUILDING_TYPE_HEX = { worship: 0xe8c98a, health: 0xf2a6a6, education: 0xb3a6f2, industrial: 0xc9c2b4, commercial: 0xf2d6a6 };
const BUILDING_TYPE_LABELS = { worship: 'Worship', health: 'Health', education: 'Education', industrial: 'Industrial', commercial: 'Commercial' };

// The card is built as an HTML string, so every value from the map data goes
// through escapeHtml(): names come from OpenStreetMap and from uploaded files,
// and one written in raw would run as script in this page (escape-html.js).
/** @param {string} label - a fixed label from this file @param {string} valueHtml - already-escaped HTML */
function inspectRow(label, valueHtml) { return `<dt>${label}</dt><dd>${valueHtml}</dd>`; }
/** @param {unknown} v @param {string} [suffix] @returns {string} escaped text, or an em dash for "no value" */
function fmtOrDash(v, suffix = '') { return v === null || v === undefined || v === '' ? '—' : escapeHtml(`${v}${suffix}`); }
/** @param {unknown} v @param {number} decimals @param {string} [suffix] @returns {string} */
function fmtNum(v, decimals, suffix = '') { return v === null || v === undefined ? '—' : escapeHtml(`${Number(v).toFixed(decimals)}${suffix}`); }

export class InspectController {
  /**
   * @param {object} deps { renderer, camera, dom: {inspectPanel, inspectBody, inspectClose},
   *   highlightRenderer, scheduler, buildingLayer, roadLayer, wardLayer, zoneLayer }
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._inspectHideTimer = null;
    this._ownHighlight = null; // the highlight that belongs to the card now showing

    this.renderer.domElement.addEventListener('click', (ev) => this._onClick(ev));

    // The card goes away by itself after a while, but never from under
    // someone reading it: the countdown stops while the pointer (or keyboard
    // focus) is on the card and starts again when it leaves.
    const { inspectPanel, inspectClose } = this.dom;
    inspectPanel.addEventListener('pointerenter', () => clearTimeout(this._inspectHideTimer));
    inspectPanel.addEventListener('pointerleave', () => this._armAutoHide());
    inspectPanel.addEventListener('focusin', () => clearTimeout(this._inspectHideTimer));
    inspectPanel.addEventListener('focusout', () => this._armAutoHide());
    inspectClose?.addEventListener('click', () => this._dismiss());
  }

  _onClick(event) {
    // The render loop is idle-gated: it only draws a frame marked dirty. Unlike search
    // (whose flyTo() runs a 900ms tween that keeps the loop rendering the
    // whole time, self-resolving this for free), a click has no camera
    // movement of its own -- so a new highlight/panel change here has to
    // mark dirty itself, or it sits fully built in the scene graph but
    // literally never gets drawn until some UNRELATED action (zooming,
    // rotating) happens to trigger the next render. That's exactly the
    // "highlight doesn't appear until I zoom in a bit" symptom.
    this.scheduler?.markDirty();

    this.dom.inspectPanel.hidden = true;
    clearTimeout(this._inspectHideTimer);
    // Unconditional deselect -- a click that hits nothing should clear
    // whatever highlight was showing, whoever set it (a prior click OR a
    // prior search).
    this.highlightRenderer.clearActive();

    this.pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Buildings and roads are picked with MeshPicker, not raycaster.intersectObjects(): three.js tests every
    // triangle of every tile the ray comes near -- over a million at street level, which took 2 s and more
    // per click with the browser's JIT off. MeshPicker returns the same hit (engine/MeshPicker.js).
    const hit = pickNearest(
      this.raycaster,
      this.buildingLayer.pickMeshes.filter((m) => m.visible && m.material.opacity >= BUILDING_PICK_MIN_OPACITY),
      { idAttribute: 'buildingId' },
    );
    if (hit) {
      // buildingMeta is the tile's BuildingMetaTable (layers/building-meta.js): one record, made for this click.
      const meta = hit.object.userData.buildingMeta;
      const bid = meta && hit.object.geometry.attributes.buildingId.getX(hit.faceIndex * 3);
      const b = meta?.get(bid);
      if (b) {
        this._showBuildingHighlight(b);
        this._showBuildingInspect(b, hit.object.userData.buildingSource || 'unknown');
        this._emitPick('building', { height: b.height, type: b.typeKey ?? null, source: hit.object.userData.buildingSource || null });
        return;
      }
    }

    const roadHit = pickNearest(this.raycaster, this.roadLayer.pickMeshes.filter((m) => m.visible), { idAttribute: 'roadId' });
    if (roadHit) {
      const r = this.roadLayer.roadAtHit(roadHit);
      if (r) {
        this._showPolygonHighlight(r.flat, r.n, Y_KMC_ROAD + 0.02);
        this._showRoadInspect(r);
        this._emitPick('road', { name: r.name || null, length_m: r.length_m ?? null, area_m2: r.area_m2 ?? null, ward: r.ward_id ?? null, zone: r.zone_id ?? null });
        return;
      }
    }

    const wardHits = this.raycaster.intersectObjects(this.wardLayer.pickMeshes.filter((m) => m.visible));
    if (wardHits.length) {
      const hit = wardHits[0];
      this._showPolygonHighlight(hit.object.userData.flat, hit.object.userData.n, 0.32);
      this._showAreaInspect(hit.object.userData.areaMeta);
      this._emitPickArea(hit.object.userData.areaMeta);
      return;
    }
    const zoneHits = this.raycaster.intersectObjects(this.zoneLayer.pickMeshes.filter((m) => m.visible));
    if (zoneHits.length) {
      const hit = zoneHits[0];
      this._showPolygonHighlight(hit.object.userData.flat, hit.object.userData.n, 0.34);
      this._showAreaInspect(hit.object.userData.areaMeta);
      this._emitPickArea(hit.object.userData.areaMeta);
      return;
    }
    this._emitPick(null, {});
  }

  /**
   * Tells `onPick` (set by the embed control API, main.js) what was clicked,
   * plus the clicked point on the ground in scene metres -- `ground` is null
   * when the ray misses the ground (a click on the sky).
   */
  _emitPick(kind, details) {
    if (!this.onPick) return;
    const p = this.raycaster.ray.intersectPlane(GROUND_PLANE, new THREE.Vector3());
    this.onPick({ kind, ...details, ground: p ? { x: p.x, z: p.z } : null });
  }

  _emitPickArea({ kind, ...rest }) { this._emitPick(kind, rest); }

  _showBuildingHighlight(b) { this.highlightRenderer.setActive(this.highlightRenderer.makeBuildingCage(b, BUILDING_SELECT_COLOR)); }
  _showPolygonHighlight(flat, n, y) { this.highlightRenderer.setActive(this.highlightRenderer.makePolygonOutline(flat, n, y, BUILDING_SELECT_COLOR)); }

  _presentInspect(html) {
    this.dom.inspectBody.innerHTML = html;
    this.dom.inspectPanel.hidden = false;
    // Captured now, checked when the card goes: if something newer (a later
    // click, or a search) has since replaced this highlight, hiding the card
    // must not clear a highlight it no longer owns.
    this._ownHighlight = this.highlightRenderer.active;
    this._armAutoHide();
  }

  /** (Re)starts the countdown to hiding the card -- unless someone is on it right now. */
  _armAutoHide() {
    clearTimeout(this._inspectHideTimer);
    const { inspectPanel } = this.dom;
    if (inspectPanel.hidden || inspectPanel.matches(':hover') || inspectPanel.contains(document.activeElement)) return;
    this._inspectHideTimer = setTimeout(() => this._dismiss(), INSPECT_AUTOHIDE_MS);
  }

  /** Hides the card (its × button, or the countdown running out) and the highlight that came with it. */
  _dismiss() {
    clearTimeout(this._inspectHideTimer);
    this.dom.inspectPanel.hidden = true;
    if (this.highlightRenderer.isActive(this._ownHighlight)) {
      this.highlightRenderer.clearActive();
      // Removing the mesh from the scene graph doesn't erase it from the
      // canvas by itself -- same idle-render gap as the click path, just
      // triggered by a timer or a button instead of a click on the scene.
      this.scheduler?.markDirty();
    }
  }

  /** @param {import('../layers/building-meta.js').BuildingRecord} b @param {string} sourceLabel */
  _showBuildingInspect(b, sourceLabel) {
    // The swatch colour and label come from this file's own tables (typeKey is one of their keys), never from the data.
    const hex = b.typeKey ? BUILDING_TYPE_HEX[b.typeKey] : undefined;
    const dot = hex !== undefined ? `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;background:#${hex.toString(16).padStart(6, '0')};"></span>` : '';
    const typeLabel = (b.typeKey && BUILDING_TYPE_LABELS[b.typeKey]) || 'not tagged';
    this._presentInspect(
      `<div class="inspect__title">Building</div><dl class="inspect__table">` +
      inspectRow('type', `${dot}${escapeHtml(typeLabel)}`) + inspectRow('height', fmtNum(b.height, 1, ' m')) + inspectRow('source', fmtOrDash(sourceLabel)) +
      `</dl>`,
    );
  }

  _showRoadInspect(meta) {
    this._presentInspect(
      `<div class="inspect__title">Road</div><dl class="inspect__table">` +
      inspectRow('name', fmtOrDash(toTitleCase(meta.name))) + inspectRow('length', fmtNum(meta.length_m, 1, ' m')) +
      inspectRow('area', fmtNum(meta.area_m2, 1, ' m²')) + inspectRow('ward', fmtOrDash(meta.ward_id)) + inspectRow('zone', fmtOrDash(meta.zone_id)) +
      `</dl>`,
    );
  }

  _showAreaInspect(meta) {
    if (meta.kind === 'ward') {
      this._presentInspect(`<div class="inspect__title">Ward</div><dl class="inspect__table">` +
        inspectRow('name', fmtOrDash(toTitleCase(meta.name))) + inspectRow('ward', fmtOrDash(meta.wardno)) + inspectRow('zone', fmtOrDash(meta.zone)) + inspectRow('population', fmtOrDash(meta.population)) + `</dl>`);
    } else if (meta.kind === 'zone') {
      this._presentInspect(`<div class="inspect__title">Zone</div><dl class="inspect__table">` + inspectRow('zone', fmtOrDash(meta.zone_id)) + `</dl>`);
    } else {
      this._presentInspect(`<div class="inspect__title">Landmark</div><dl class="inspect__table">` + inspectRow('name', fmtOrDash(toTitleCase(meta.name))) + `</dl>`);
    }
  }

  showLandmarkInspect(name) {
    this._showAreaInspect({ kind: 'landmark', name });
    this.onPick?.({ kind: 'landmark', name, ground: null });
  }
}
