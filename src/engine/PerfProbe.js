// ===================================================================
// PerfProbe -- opt-in (add ?perf to the URL) on-screen frame/tile/upload
// probe. Off by default: TwinEngine only constructs it when the query
// string has `perf`, and every hook it uses is an optional call, so there
// is no cost and no panel otherwise.
//
// It exists because a lag ("nothing for a few seconds, then every
// building appears") can depend on the machine, and a headless benchmark
// can't see that machine. Reproduce the lag with the panel open, press
// "Copy report", and paste the text. The report contains:
//   - the environment (browser, GPU, display scaling, memory, cores),
//   - two speed tests (plain JS, and GPU buffer upload),
//   - a timeline: frames that took too long (with a per-phase breakdown
//     of the frame before the gap), long tasks, late timers, tile
//     requests/downloads/builds, GPU uploads, shader compiles, your
//     clicks/zoom/fly-to, and one summary line per active second.
// Nothing is sent anywhere; it only lives in this page.
// ===================================================================

const GAP_LOG_MS = 100;    // log a gap between animation frames longer than this
const SLOW_FRAME_MS = 50;  // log a frame whose own work took longer than this
const LATE_TIMER_MS = 120; // log a 250 ms heartbeat that fires this late
const UPLOAD_LOG_MS = 8;   // log a GPU upload pass at least this long
const MAX_EVENTS = 2500;
const PANEL_LINES = 9;

const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '?');
const mb = (bytes) => (bytes / 1048576).toFixed(1);

export class PerfProbe {
  /** @param {import('./TwinEngine.js').TwinEngine} engine */
  constructor(engine) {
    this.engine = engine;
    this.events = [];
    this.env = null;
    this.speed = null;

    this._prevBegin = null; this._frameStart = 0; this._lapT = 0;
    this._phases = {}; this._lastWork = 0; this._lastPhases = {};
    this._sec = this._newSecond(performance.now());
    this._zone = null; this._flying = false; this._programs = 0;
    this._reqAt = new Map();
    this._tot = { gaps: 0, worstGap: 0, slow: 0, worstSlow: 0, long: 0, worstLong: 0, late: 0, worstLate: 0, req: 0, bodyBytes: 0, bodyMs: 0, bodies: 0, binds: 0, bindMs: 0, worstBind: 0, uploads: 0, uploadBytes: 0, uploadMs: 0, worstUpload: 0, renderedFrames: 0 };
    this._lastWheel = 0;
    this._liveTimer = 0;

    this.env = this._environment();
    this._hook();
    this._buildPanel();
    this.log('probe', 'probe started (press "Copy report" after reproducing the lag)');
    window.__perf = this;
    window.__perfReport = () => this.report();
  }

  /** TwinEngine.boot() finished: measure this machine while it is quiet (the button repeats it). */
  booted() {
    this.log('probe', 'boot finished; loading screen can hide');
    setTimeout(() => this.runSpeedTest(), 1500);
  }

  // -----------------------------------------------------------------
  // Frame hooks -- called from TwinEngine._animate()
  // -----------------------------------------------------------------
  beginFrame() {
    const now = performance.now();
    if (this._prevBegin !== null && document.visibilityState === 'visible') {
      const gap = now - this._prevBegin;
      if (gap > this._sec.maxGap) this._sec.maxGap = gap;
      if (gap > GAP_LOG_MS) this._logGap(gap);
    }
    this._prevBegin = now; this._frameStart = now; this._lapT = now; this._phases = {};
  }

  /** Attribute the time since the previous lap()/beginFrame() to `name`. */
  lap(name) {
    const now = performance.now();
    this._phases[name] = (this._phases[name] ?? 0) + (now - this._lapT);
    this._lapT = now;
  }

  endFrame(rendered) {
    const now = performance.now();
    const work = now - this._frameStart;
    this._lastWork = work; this._lastPhases = this._phases;
    const s = this._sec;
    s.raf++;
    if (rendered) {
      s.rendered++; this._tot.renderedFrames++;
      s.tris = this.engine.renderer.info.render.triangles;
      if (work > s.maxWork) s.maxWork = work;
      if (work > SLOW_FRAME_MS) {
        this._tot.slow++; this._tot.worstSlow = Math.max(this._tot.worstSlow, work);
        this.log('slow', `frame work ${fmt(work)} ms  (${this._phaseText(this._phases)})`);
      }
    }
    this._watchState();
    if (now - s.start >= 1000) this._flushSecond(now);
  }

  _watchState() {
    const e = this.engine, y = e.camera.position.y;
    const zone = y < 500 ? 'buildings visible (<500 m)' : y < 1500 ? 'tiles loading (500-1500 m)' : 'high (>1500 m)';
    if (zone !== this._zone) { this.log('camera', `height ${fmt(y)} m -> ${zone}`); this._zone = zone; }
    const flying = e.cameraRig.flyDestination !== null;
    if (flying !== this._flying) { this.log('camera', flying ? 'fly-to started' : 'fly-to ended'); this._flying = flying; }
    const p = e.renderer.info.programs?.length ?? 0;
    if (p !== this._programs) { if (this._programs) this.log('shader', `${p - this._programs > 0 ? '+' : ''}${p - this._programs} shader program(s) compiled (now ${p})`); this._programs = p; }
  }

  _logGap(gap) {
    const outside = gap - this._lastWork;
    this._tot.gaps++; this._tot.worstGap = Math.max(this._tot.worstGap, gap);
    this.log('gap', `no frame for ${fmt(gap)} ms  (previous frame's own work ${fmt(this._lastWork)} ms: ${this._phaseText(this._lastPhases)}; outside the frame ${fmt(Math.max(outside, 0))} ms)`);
  }

  _phaseText(ph) {
    const parts = Object.entries(ph).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)}`);
    return parts.length ? parts.join(', ') : 'nothing over 1 ms';
  }

  _newSecond(now) { return { start: now, raf: 0, rendered: 0, maxGap: 0, maxWork: 0, tris: 0 }; }

  _flushSecond(now) {
    const s = this._sec;
    this._sec = this._newSecond(now);
    if (s.rendered === 0 && s.maxGap < GAP_LOG_MS) return; // idle second: nothing to say
    const e = this.engine, bl = e.buildingLayer, cam = e.camera.position;
    let near4 = 0, above = 0, pending = 0;
    if (bl.streaming) {
      const byDist = bl.tileRecords.map((t) => [Math.hypot(cam.x - t.centerX, cam.z - t.centerZ), t]).sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < 4 && i < byDist.length; i++) if (byDist[i][1].boundTier && byDist[i][1].boundTier !== 'coarse') near4++;
      for (const t of bl.tileRecords) { if (t.boundTier && t.boundTier !== 'coarse') above++; if (t.pendingFetch || t._queued) pending++; }
    }
    const heap = performance.memory ? ` heap ${fmt(performance.memory.usedJSHeapSize / 1048576)} MB` : '';
    this.log('sec', `${s.rendered} frames drawn, worst gap ${fmt(s.maxGap)} ms, worst frame work ${fmt(s.maxWork)} ms | height ${fmt(cam.y)} m, ${fmt(s.tris / 1000)}k triangles | nearest 4 tiles detailed ${near4}/4, tiles above coarse ${above}, tiles loading ${pending}, uploads waiting ${e.gpuUploads.pending ? 'yes' : 'no'}${heap}`);
  }

  // -----------------------------------------------------------------
  // Everything else that can be observed
  // -----------------------------------------------------------------
  _hook() {
    const e = this.engine;
    e.buildingLayer.onTileEvent = (kind, tile, tier, value) => {
      const key = `${tile.ix},${tile.iz}:${tier}`;
      if (kind === 'request') { this._reqAt.set(key, performance.now()); this._tot.req++; this.log('tile', `request ${tier} ${tile.ix},${tile.iz}`); }
      else if (kind === 'body') {
        const ms = performance.now() - (this._reqAt.get(key) ?? performance.now());
        this._tot.bodies++; this._tot.bodyBytes += value; this._tot.bodyMs += ms;
        this.log('tile', `downloaded ${tier} ${tile.ix},${tile.iz}: ${mb(value)} MB in ${fmt(ms)} ms`);
      } else if (kind === 'bind') {
        this._tot.binds++; this._tot.bindMs += value; this._tot.worstBind = Math.max(this._tot.worstBind, value);
        if (tier !== 'coarse' || value >= 20) this.log('tile', `built ${tier} ${tile.ix},${tile.iz}: ${fmt(value)} ms on the main thread`); // the boot-time coarse builds (one per tile, 153 for Kanpur) would drown the timeline
        const primed = e.buildingLayer.primedTileCount; // this city's own count -- the probe used to assume Kanpur's 153
        if (tier === 'coarse' && primed > 0 && this._tot.binds === primed) this.log('tile', `all ${primed} coarse tiles built (boot priming)`);
      }
    };
    e.gpuUploads.onUpload = (n, bytes, ms) => {
      this._tot.uploads++; this._tot.uploadBytes += bytes; this._tot.uploadMs += ms; this._tot.worstUpload = Math.max(this._tot.worstUpload, ms);
      if (ms >= UPLOAD_LOG_MS) this.log('upload', `GPU upload of ${n} object(s), ${mb(bytes)} MB: ${fmt(ms)} ms`);
    };
    try {
      new PerformanceObserver((list) => {
        for (const en of list.getEntries()) { this._tot.long++; this._tot.worstLong = Math.max(this._tot.worstLong, en.duration); this.log('longtask', `main thread busy for ${fmt(en.duration)} ms`, en.startTime); }
      }).observe({ type: 'longtask', buffered: false });
    } catch { /* longtask isn't available everywhere */ }

    let expect = performance.now() + 250;
    setInterval(() => {
      const now = performance.now(), late = now - expect;
      expect = now + 250;
      if (late > LATE_TIMER_MS && document.visibilityState === 'visible') {
        this._tot.late++; this._tot.worstLate = Math.max(this._tot.worstLate, late);
        this.log('timer', `a 250 ms timer fired ${fmt(late)} ms late (the page's main thread was blocked)`);
      }
    }, 250);

    document.addEventListener('click', (ev) => {
      if (ev.target.closest?.('#perfProbe')) return;
      const t = ev.target.closest?.('button,[id]');
      this.log('input', `click ${t?.id ? '#' + t.id : (t?.tagName ?? ev.target.tagName ?? '?').toLowerCase()}`);
    }, true);
    document.addEventListener('wheel', () => {
      const now = performance.now();
      if (now - this._lastWheel > 400) this.log('input', 'scroll-zoom');
      this._lastWheel = now;
    }, { passive: true, capture: true });
    document.addEventListener('visibilitychange', () => this.log('page', `tab ${document.visibilityState}`));
  }

  log(kind, text, at = performance.now()) {
    this.events.push({ t: at, kind, text });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this._scheduleLive();
  }

  // -----------------------------------------------------------------
  // Environment + speed tests
  // -----------------------------------------------------------------
  _environment() {
    const e = this.engine, r = e.renderer, gl = r.getContext();
    let gpu = '?', vendor = '?';
    try { const x = gl.getExtension('WEBGL_debug_renderer_info'); if (x) { gpu = gl.getParameter(x.UNMASKED_RENDERER_WEBGL); vendor = gl.getParameter(x.UNMASKED_VENDOR_WEBGL); } } catch { /* blocked */ }
    const nav = navigator;
    const outerGap = Math.max(window.outerWidth - window.innerWidth, window.outerHeight - window.innerHeight);
    return {
      'browser': nav.userAgent,
      'GPU (WebGL)': `${gpu} | ${vendor}`,
      'WebGL': gl.getParameter(gl.VERSION),
      'display': `screen ${screen.width}x${screen.height}, window ${window.innerWidth}x${window.innerHeight} css px, devicePixelRatio ${window.devicePixelRatio}, renderer pixel ratio ${r.getPixelRatio()}`,
      'CPU / memory': `${nav.hardwareConcurrency ?? '?'} logical cores, deviceMemory ${nav.deviceMemory ?? '?'} GB (capped by the browser)`,
      'network hint': nav.connection ? `${nav.connection.effectiveType ?? '?'}, downlink ${nav.connection.downlink ?? '?'} Mbps` : 'n/a',
      'page': location.href,
      'DevTools docked?': outerGap > 160 ? `probably yes (window is ${outerGap}px larger than the page)` : 'probably not',
      'automation': nav.webdriver ? 'yes (webdriver)' : 'no',
    };
  }

  /** JS speed (a fixed arithmetic loop) and GPU buffer-upload throughput, on a scratch WebGL context. */
  runSpeedTest() {
    const js = [];
    // Plain JS over a typed array plus a small function call: the kind of work tile decoding and mesh building do, and
    // exactly what the JIT speeds up ~20x (Math.sin-style loops barely change without it, so they can't tell).
    // One short run (1.3M steps): with the JIT off even this takes ~85 ms, and three longer runs used to freeze the page for ~0.8 s.
    const buf = new Float64Array(1 << 16), step = (x, i) => x * 0.5 + i;
    { const t = performance.now(); for (let r = 0; r < 20; r++) for (let i = 0; i < buf.length; i++) buf[i] = step(buf[i], i); js.push(performance.now() - t); if (buf[7] === -1) console.log(buf[7]); }
    let up = null;
    try {
      const c = document.createElement('canvas'); c.width = c.height = 16;
      const gl = c.getContext('webgl2');
      if (gl) {
        const data = new Float32Array(4 * 1048576); // 16 MB
        const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        const times = [];
        for (let k = 0; k < 4; k++) { const t = performance.now(); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); gl.finish(); times.push(performance.now() - t); }
        gl.deleteBuffer(buf); gl.getExtension('WEBGL_lose_context')?.loseContext();
        up = times;
      }
    } catch { /* no second context available */ }
    this.speed = { jsMs: Math.min(...js), jsAll: js, uploadMs: up };
    this.log('probe', `speed test: JS loop ${fmt(this.speed.jsMs, 1)} ms${up ? `, 16 MB GPU upload ${up.map((x) => fmt(x)).join('/')} ms` : ''}`);
  }

  // -----------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------
  report() {
    const T = this._tot, up = performance.now();
    const L = [];
    L.push('=== DigiTwin Generator perf report ===');
    L.push(`generated ${new Date().toString()} | page open for ${fmt(up / 1000, 1)} s`);
    L.push('', '-- environment --');
    for (const [k, v] of Object.entries(this.env)) L.push(`${k}: ${v}`);
    const bl = this.engine.buildingLayer;
    L.push(`tiles: ${bl.streaming ? `${bl.tileRecords.length} tiles, streaming` : 'legacy (no tile manifest) or not loaded yet'}`);
    L.push('', '-- speed tests --');
    L.push('for scale, measured on the developer laptop: JS loop ~5 ms normally, ~17 ms with the CPU throttled 6x, ~90 ms with the JS JIT disabled (Edge "Enhance your security" mode does that); GPU upload of 16 MB ~6 ms after a slower first try');
    if (this.speed) {
      L.push(`JS loop (1.3M typed-array steps, one run): ${fmt(this.speed.jsMs, 1)} ms`);
      L.push(this.speed.uploadMs ? `GPU upload of a 16 MB buffer, 4 tries: ${this.speed.uploadMs.map((x) => fmt(x, 1)).join(', ')} ms  (~${fmt(16 / (Math.min(...this.speed.uploadMs) / 1000))} MB/s at best)` : 'GPU upload test: unavailable');
    } else L.push('not run yet');
    L.push('', '-- totals since page load --');
    L.push(`frames drawn: ${T.renderedFrames}`);
    L.push(`gaps between frames > ${GAP_LOG_MS} ms: ${T.gaps} (worst ${fmt(T.worstGap)} ms)`);
    L.push(`frames whose own work > ${SLOW_FRAME_MS} ms: ${T.slow} (worst ${fmt(T.worstSlow)} ms)`);
    L.push(`long tasks (main thread busy > 50 ms): ${T.long} (worst ${fmt(T.worstLong)} ms)`);
    L.push(`late timers (> ${LATE_TIMER_MS} ms): ${T.late} (worst ${fmt(T.worstLate)} ms)`);
    L.push(`tile requests: ${T.req}; downloaded ${T.bodies} tiles, ${mb(T.bodyBytes)} MB, mean ${fmt(T.bodies ? T.bodyMs / T.bodies : 0)} ms each`);
    L.push(`tile builds: ${T.binds}, mean ${fmt(T.binds ? T.bindMs / T.binds : 0)} ms, worst ${fmt(T.worstBind)} ms`);
    L.push(`GPU upload passes: ${T.uploads}, ${mb(T.uploadBytes)} MB, ${fmt(T.uploadMs)} ms total (${fmt(T.uploadBytes ? T.uploadMs / (T.uploadBytes / 1048576) : 0, 1)} ms per MB), worst pass ${fmt(T.worstUpload)} ms`);
    L.push('', `-- timeline (seconds since page load; last ${this.events.length} events; a "longtask" is stamped when the busy period STARTED) --`);
    for (const ev of [...this.events].sort((a, b) => a.t - b.t)) L.push(`${fmt(ev.t / 1000, 2).padStart(7)}s  ${ev.kind.padEnd(8)} ${ev.text}`);
    return L.join('\n');
  }

  async copyReport() {
    const text = this.report();
    try { await navigator.clipboard.writeText(text); return true; } catch { /* not a secure context or blocked: fall back */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }

  // -----------------------------------------------------------------
  // Panel
  // -----------------------------------------------------------------
  _buildPanel() {
    const el = document.createElement('div');
    el.id = 'perfProbe';
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;width:min(430px,calc(100vw - 24px));font:11px/1.4 ui-monospace,Consolas,monospace;color:#e6edf3;background:rgba(13,17,23,.9);border:1px solid #30363d;border-radius:8px;padding:8px;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    el.innerHTML = '<div data-role="head" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"></div><div data-role="live" style="margin:6px 0 4px;color:#7ee787"></div><div data-role="log" style="white-space:pre-wrap;word-break:break-word;color:#c9d1d9;max-height:30vh;overflow:auto"></div><div data-role="note" style="margin-top:6px;color:#8b949e"></div>';
    const head = el.querySelector('[data-role="head"]');
    const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'font:inherit;color:#e6edf3;background:#21262d;border:1px solid #30363d;border-radius:6px;padding:3px 8px;cursor:pointer'; b.addEventListener('click', fn); head.appendChild(b); return b; };
    const title = document.createElement('b'); title.textContent = 'perf'; title.style.marginRight = '4px'; head.appendChild(title);
    mk('Copy report', async () => { const ok = await this.copyReport(); this._note(ok ? 'Report copied. Paste it into a message or a text file.' : 'Copy was blocked. Press "Show report", select all, and copy by hand.'); });
    mk('Show report', () => { this._showReport(); });
    mk('Speed test', () => { this.runSpeedTest(); this._note('Speed test done (see the report).'); });
    mk('Clear', () => { this.events.length = 0; for (const k of Object.keys(this._tot)) this._tot[k] = 0; this._note('Cleared.'); });
    this.panel = el; this.liveEl = el.querySelector('[data-role="live"]'); this.logEl = el.querySelector('[data-role="log"]'); this.noteEl = el.querySelector('[data-role="note"]');
    this._note('Reproduce the lag, then press "Copy report".');
    (document.body ?? document.documentElement).appendChild(el);
  }

  _note(text) { this.noteEl.textContent = text; }

  _showReport() {
    let box = this.panel.querySelector('textarea');
    if (box) { box.remove(); return; }
    box = document.createElement('textarea');
    box.value = this.report(); box.readOnly = true;
    box.style.cssText = 'width:100%;height:30vh;margin-top:6px;font:inherit;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px';
    this.panel.appendChild(box); box.focus(); box.select();
  }

  _scheduleLive() {
    if (this._liveTimer) return;
    this._liveTimer = setTimeout(() => { this._liveTimer = 0; this._renderLive(); }, 250);
  }

  _renderLive() {
    if (!this.logEl) return;
    const T = this._tot;
    this.liveEl.textContent = `${T.renderedFrames} frames | gaps>${GAP_LOG_MS}ms: ${T.gaps} (worst ${fmt(T.worstGap)}) | long tasks: ${T.long} (worst ${fmt(T.worstLong)}) | tiles: ${T.req} requested, ${T.binds} built`;
    const shown = this.events.filter((e) => e.kind !== 'sec').slice(-PANEL_LINES).sort((a, b) => a.t - b.t);
    this.logEl.textContent = shown.map((ev) => `${fmt(ev.t / 1000, 1).padStart(6)}s ${ev.kind}: ${ev.text}`).join('\n');
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
