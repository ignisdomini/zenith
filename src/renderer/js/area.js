/*
 * Участок местности (прямоугольник с ручками), трассы зенитов и метки аномалий на карте.
 */
(function () {
  'use strict';
  const Z = window.ZAstro;
  const t = (k, p) => window.ZI18n.t(k, p);

  // ── форматирование времени и координат ──
  const Fmt = {
    tz: 'local',
    pad: (n, w = 2) => String(n).padStart(w, '0'),
    parts(ms) {
      const d = new Date(ms);
      return this.tz === 'utc'
        ? { Y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() }
        : { Y: d.getFullYear(), M: d.getMonth() + 1, D: d.getDate(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
    },
    zone(ms) {
      if (this.tz === 'utc') return 'UTC';
      const off = -new Date(ms).getTimezoneOffset();
      return 'UTC' + (off >= 0 ? '+' : '−') + this.pad(Math.floor(Math.abs(off) / 60)) + (Math.abs(off) % 60 ? ':' + this.pad(Math.abs(off) % 60) : '');
    },
    date(ms) {
      const p = this.parts(ms);
      return window.ZI18n.lang === 'ru' ? `${this.pad(p.D)}.${this.pad(p.M)}.${p.Y}` : `${p.Y}-${this.pad(p.M)}-${this.pad(p.D)}`;
    },
    time(ms) { const p = this.parts(ms); return `${this.pad(p.h)}:${this.pad(p.m)}:${this.pad(p.s)}`; },
    hm(ms) { const p = this.parts(ms); return `${this.pad(p.h)}:${this.pad(p.m)}`; },
    dt(ms) { return `${this.date(ms)} ${this.time(ms)}`; },
    /** Значение для <input type=datetime-local> в выбранном поясе. */
    input(ms) { const p = this.parts(ms); return `${p.Y}-${this.pad(p.M)}-${this.pad(p.D)}T${this.pad(p.h)}:${this.pad(p.m)}:${this.pad(p.s)}`; },
    parseInput(v) {
      const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(v);
      if (!m) return NaN;
      const a = [+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)];
      return this.tz === 'utc' ? Date.UTC(...a) : new Date(...a).getTime();
    },
    dur(ms) {
      const s = Math.abs(ms) / 1000;
      if (s < 1) return t('dur.ms', { v: (s * 1000).toFixed(0) });
      if (s < 60) return t('dur.s', { v: s.toFixed(s < 10 ? 2 : 1) });
      if (s < 3600) return t('dur.m', { m: Math.floor(s / 60), s: Math.round(s % 60) });
      if (s < 86400) return t('dur.h', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) });
      return t('dur.d', { v: (s / 86400).toFixed(1) });
    },
    lat: (v, d = 5) => `${Math.abs(v).toFixed(d)}° ${t(v >= 0 ? 'fmt.N' : 'fmt.S')}`,
    lon: (v, d = 5) => { const x = Z.normLon(v); return `${Math.abs(x).toFixed(d)}° ${t(x >= 0 ? 'fmt.E' : 'fmt.W')}`; },
    hms(deg) { // α в часах
      let h = Z.norm360(deg) / 15;
      const H = Math.floor(h); h = (h - H) * 60; const M = Math.floor(h); const S = (h - M) * 60;
      return `${this.pad(H)}ʰ${this.pad(M)}ᵐ${S.toFixed(2).padStart(5, '0')}ˢ`;
    },
    dms(deg) {
      const sg = deg < 0 ? '−' : '+'; let a = Math.abs(deg);
      const D = Math.floor(a); a = (a - D) * 60; const M = Math.floor(a); const S = (a - M) * 60;
      return `${sg}${this.pad(D)}°${this.pad(M)}′${S.toFixed(1).padStart(4, '0')}″`;
    },
  };
  window.ZFmt = Fmt;

  /** Длина градуса на эллипсоиде WGS-84, км: [широты, долготы]. */
  function kmPerDeg(lat) {
    const a = 6378.137, e2 = 0.00669437999014, s = Math.sin(lat * Z.D2R);
    const w = 1 - e2 * s * s;
    return [a * (1 - e2) / Math.pow(w, 1.5) * Z.D2R, a / Math.sqrt(w) * Math.cos(lat * Z.D2R) * Z.D2R];
  }

  // ── участок ──
  class AreaTool {
    constructor(map, wrap, hint, onChange) {
      this.map = map; this.wrap = wrap; this.hint = hint; this.onChange = onChange;
      map.createPane('area').style.zIndex = 460;
      this.rect = null; this.bounds = null; this.handles = [];
      this.mode = null;
      this._down = this._down.bind(this); this._move = this._move.bind(this); this._up = this._up.bind(this); this._click = this._click.bind(this);
    }

    kmPerDeg(lat) { return kmPerDeg(lat); }

    startDraw() {
      this.cancelMode();
      this.mode = 'draw';
      this.wrap.classList.add('drawing');
      this.showHint(t('area.drawHint'));
      this.map.dragging.disable();
      this.map.on('mousedown', this._down);
    }
    startSquare(km) {
      this.cancelMode();
      this.mode = 'square'; this.squareKm = km;
      this.wrap.classList.add('drawing');
      this.showHint(t('area.squareHint', { km }));
      this.map.on('click', this._click);
    }
    cancelMode() {
      if (!this.mode) return;
      this.map.off('mousedown', this._down).off('mousemove', this._move).off('mouseup', this._up).off('click', this._click);
      this.map.dragging.enable();
      this.wrap.classList.remove('drawing');
      this.showHint(null);
      this.mode = null;
      if (this.onModeEnd) this.onModeEnd();
    }
    showHint(text) { this.hint.hidden = !text; this.hint.textContent = text || ''; }

    _down(e) { this.start = e.latlng; this.map.on('mousemove', this._move).on('mouseup', this._up); }
    _move(e) { this.setBounds(this.start, e.latlng, false); }
    _up(e) {
      const a = this.map.latLngToContainerPoint(this.start), b = e.containerPoint;
      if (Math.abs(a.x - b.x) > 3 && Math.abs(a.y - b.y) > 3) this.setBounds(this.start, e.latlng, true);
      this.cancelMode();
    }
    _click(e) {
      const km = this.squareKm, [ky, kx] = kmPerDeg(e.latlng.lat);
      const dLat = km / 2 / ky, dLon = km / 2 / kx;
      this.setBounds(L.latLng(e.latlng.lat - dLat, e.latlng.lng - dLon), L.latLng(e.latlng.lat + dLat, e.latlng.lng + dLon), true);
      this.cancelMode();
    }

    /** Две угловые точки (долготы могут выходить за ±180 — так рисуется участок через антимеридиан). */
    setBounds(p1, p2, final) {
      const s = Math.max(-89.999, Math.min(p1.lat, p2.lat)), n = Math.min(89.999, Math.max(p1.lat, p2.lat));
      const w = Math.min(p1.lng, p2.lng), e = Math.max(p1.lng, p2.lng);
      this.bounds = { s, n, w, e };
      const ll = [[s, w], [n, e]];
      if (!this.rect) {
        this.rect = L.rectangle(ll, { pane: 'area', color: '#F2C46D', weight: 2, fillColor: '#F2C46D', fillOpacity: 0.08, dashArray: '6 4', interactive: false }).addTo(this.map);
      } else this.rect.setBounds(ll);
      if (final) { this.makeHandles(); if (this.onChange) this.onChange(this.get()); }
    }
    set(r, fit) {
      this.setBounds(L.latLng(r.s, r.w), L.latLng(r.n, r.e), true);
      if (fit) this.fit();
    }
    fit() { if (this.rect) this.map.fitBounds(this.rect.getBounds(), { padding: [60, 60], maxZoom: 18 }); }
    clear() {
      if (this.rect) this.map.removeLayer(this.rect);
      this.handles.forEach(h => this.map.removeLayer(h));
      this.rect = null; this.bounds = null; this.handles = [];
      if (this.onChange) this.onChange(null);
    }
    /** Участок в нормальном виде: w ∈ [−180, 180), e = w + ширина. */
    get() {
      if (!this.bounds) return null;
      const b = this.bounds;
      const width = Math.min(360, b.e - b.w);
      const w = Z.normLon(b.w);
      return { s: b.s, n: b.n, w, e: w + width };
    }

    makeHandles() {
      this.handles.forEach(h => this.map.removeLayer(h));
      const icon = L.divIcon({ className: 'area-handle', iconSize: [12, 12] });
      const b = this.bounds;
      const corners = [[b.s, b.w], [b.s, b.e], [b.n, b.e], [b.n, b.w]];
      this.handles = corners.map((c, k) => {
        const m = L.marker(c, { icon, draggable: true, pane: 'area', zIndexOffset: 1000 }).addTo(this.map);
        m.on('drag', () => {
          const opp = corners[(k + 2) % 4];
          this.setBounds(m.getLatLng(), L.latLng(opp[0], opp[1]), false);
        });
        m.on('dragend', () => { this.makeHandles(); if (this.onChange) this.onChange(this.get()); });
        return m;
      });
      const center = L.marker([(b.s + b.n) / 2, (b.w + b.e) / 2], { icon: L.divIcon({ className: 'area-handle', iconSize: [16, 16] }), draggable: true, pane: 'area', zIndexOffset: 1000 }).addTo(this.map);
      center.on('drag', () => {
        const c = center.getLatLng(), hl = (b.n - b.s) / 2, hw = (b.e - b.w) / 2;
        this.setBounds(L.latLng(c.lat - hl, c.lng - hw), L.latLng(c.lat + hl, c.lng + hw), false);
        this.handles.slice(0, 4).forEach(h => h.setOpacity(0));
      });
      center.on('dragend', () => { this.makeHandles(); if (this.onChange) this.onChange(this.get()); });
      this.handles.push(center);
    }
  }

  // ── трассы ──
  class TrackLayer {
    constructor(map, getCatalog) {
      this.map = map; this.getCatalog = getCatalog;
      map.createPane('tracks').style.zIndex = 470;
      this.group = L.layerGroup().addTo(map);
    }
    clear() { this.group.clearLayers(); }

    /** Точка зенита объекта в момент t (lat, lon). */
    zenith(obj, t) {
      if (obj.kind === 'star') {
        const cat = this.getCatalog();
        return Z.starZenith(Z.frame(t), cat.ra(obj.idx), cat.dec(obj.idx), cat.pmra(obj.idx), cat.pmdec(obj.idx), {});
      }
      return Z.bodyZenith(obj.key, t, {});
    }

    /**
     * Трасса [t0, t1] с шагом step; долгота разворачивается непрерывно и сдвигается к refLon.
     * Для звезды склонение за сутки меняется на доли секунды — кадр пересчитываем раз в час.
     */
    path(obj, t0, t1, step, refLon) {
      const pts = [];
      let prev = null, fr = null, frT = -Infinity;
      const cat = this.getCatalog();
      const o = {};
      for (let t = t0; t <= t1 + 1; t += step) {
        let lat, lon;
        if (obj.kind === 'star') {
          if (Math.abs(t - frT) > 3600000) { fr = Z.frame(t); frT = t; }
          Z.starApparent(fr, cat.ra(obj.idx), cat.dec(obj.idx), cat.pmra(obj.idx), cat.pmdec(obj.idx), o);
          lat = o.dec;
          lon = o.ra - (fr.gast + (t - frT) * Z.EARTH_DEG_PER_MS);
        } else {
          const z = Z.bodyZenith(obj.key, t, o);
          lat = z.lat; lon = z.lon;
        }
        if (prev == null) { lon = refLon + Z.normLon(lon - refLon); }
        else { while (lon - prev > 180) lon -= 360; while (prev - lon > 180) lon += 360; }
        prev = lon;
        pts.push([lat, lon, t]);
      }
      return pts;
    }

    /** Трасса вокруг прохода: ±12 ч пунктиром, отрезок над участком — сплошной, вход/выход и часовые засечки. */
    showPass(obj, pass, rect, color) {
      this.clear();
      color = color || '#F2C46D';
      const refLon = rect ? (rect.w + rect.e) / 2 : (pass.lon ?? 0);
      const H = 3600000;
      const st = 5 * 60000, t0 = Math.floor((pass.tc - 12 * H) / st) * st;
      const full = this.path(obj, t0, t0 + 24 * H, st, refLon);
      this.addLine(full, { color, weight: 1.6, opacity: 0.8, dashArray: '6 6' });
      const inStep = Math.max(50, (pass.tOut - pass.tIn) / 60);
      const seg = this.path(obj, pass.tIn, pass.tOut, inStep, refLon);
      this.addLine(seg, { color: '#FFE08A', weight: 5, opacity: 0.95 });
      this.ticks(full, color);
      const a = seg[0], b = seg[seg.length - 1];
      // подпись входа — с той стороны, откуда пришёл зенит, выхода — куда ушёл (обычно восток → запад)
      const westward = a && b ? Z.normLon(b[1] - a[1]) <= 0 : true;
      if (a) this.mark([a[0], a[1]], '#6EE7A8', t('track.in', { t: ZFmt.dt(pass.tIn) }), westward ? 'right' : 'left');
      if (b) this.mark([b[0], b[1]], '#FF7A66', t('track.out', { t: ZFmt.dt(pass.tOut) }), westward ? 'left' : 'right');
      return full;
    }

    /** Трасса ±hours вокруг момента t, без участка. */
    showAround(obj, t, hours, color, keep) {
      if (!keep) this.clear();
      const z = this.zenith(obj, t);
      const H = 3600000;
      const st = hours > 6 ? 5 * 60000 : 60000, t0 = Math.floor((t - hours * H) / st) * st;
      const full = this.path(obj, t0, t0 + 2 * hours * H, st, z.lon);
      this.addLine(full, { color: color || '#F2C46D', weight: 2, opacity: 0.85, dashArray: '8 5' });
      this.ticks(full, color || '#F2C46D');
      return full;
    }

    /** Отрезок трассы [t0, t1] сплошной линией, без засечек. */
    showSegment(obj, t0, t1, refLon, color, keep) {
      if (!keep) this.clear();
      const pts = this.path(obj, t0, t1, Math.max(60000, (t1 - t0) / 400), refLon);
      this.addLine(pts, { color, weight: 3, opacity: 0.9 });
      return pts;
    }

    addLine(pts, style) {
      if (pts.length < 2) return;
      const ll = pts.map(p => [p[0], p[1]]);
      // копии на соседние «миры», чтобы трасса была видна при любом сдвиге карты
      for (const k of [-360, 0, 360]) this.group.addLayer(L.polyline(ll.map(p => [p[0], p[1] + k]), { pane: 'tracks', interactive: false, ...style }));
    }
    ticks(pts, color) {
      for (const p of pts) {
        const t = p[2];
        if (Math.abs(t % 3600000) > 1) continue;
        const m = L.circleMarker([p[0], p[1]], { pane: 'tracks', radius: 3, color: '#000', weight: 1, fillColor: color, fillOpacity: 1, interactive: false });
        m.bindTooltip(ZFmt.hm(t), { permanent: true, direction: 'top', className: 'tick', offset: [0, -3] });
        this.group.addLayer(m);
      }
    }
    mark(ll, color, text, dir = 'right') {
      const m = L.circleMarker(ll, { pane: 'tracks', radius: 6, color: '#000', weight: 1.5, fillColor: color, fillOpacity: 1 });
      m.bindTooltip(text, { permanent: true, direction: dir, className: 'zt', offset: [dir === 'left' ? -8 : 8, 0] });
      this.group.addLayer(m);
    }
  }

  // ── метки аномалий ──
  const TYPE_COLOR = { density: '#FF7A66', overlap: '#6FD3FF', conj: '#B99BFF' };
  class AnomalyMarks {
    constructor(map, onPick) {
      this.map = map; this.onPick = onPick;
      map.createPane('anom').style.zIndex = 465;
      this.group = L.layerGroup().addTo(map);
      this.byId = new Map();
    }
    set(rows) {
      this.group.clearLayers(); this.byId.clear();
      for (const r of rows.slice(0, 3000)) {
        const m = L.circleMarker([r.lat, r.lon], { pane: 'anom', radius: r.type === 'density' ? 5 : 6, color: '#000', weight: 1, fillColor: TYPE_COLOR[r.type], fillOpacity: 0.95 });
        m.bindTooltip(`${r.title}<br><span style="color:#8089a0">${r.when}</span>`, { className: 'zt', direction: 'top' });
        m.on('click', () => this.onPick(r));
        this.group.addLayer(m);
        this.byId.set(r.id, m);
      }
    }
    highlight(id) {
      for (const [k, m] of this.byId) m.setStyle({ weight: k === id ? 3 : 1, color: k === id ? '#fff' : '#000', radius: k === id ? 9 : 5 });
    }
    clear() { this.group.clearLayers(); this.byId.clear(); }
  }

  window.ZArea = { AreaTool, TrackLayer, AnomalyMarks, kmPerDeg, TYPE_COLOR };
})();
