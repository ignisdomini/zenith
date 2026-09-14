/*
 * Слой Leaflet: подзвёздные точки звёзд каталога и подсветильные точки Солнца, Луны, планет.
 * Порт SubStellarOverlay.kt (КАРТОВЕДЪ) на Canvas:
 *  • экранные координаты — формулой Меркатора от одной опорной точки кадра, без объектов LatLng на звезду;
 *  • из каталога берутся только ячейки 1°×1°, попадающие в окно (α = λ + GAST), внутри ячейки — до предела блеска;
 *  • подписи — по масштабу и без наложения (сетка занятых мест);
 *  • перерисовка — когда точки сдвинулись хотя бы на полпикселя или изменился вид.
 * Дополнительно: терминатор (день/ночь), градусная сетка, след светил, выделенный объект.
 */
(function () {
  'use strict';
  const Z = window.ZAstro;
  const MAX_LAT = 85.0511287798;

  const COLOR_BUCKETS = [-0.3, 0.0, 0.3, 0.6, 0.9, 1.3, 1.9].map(bv => Z.bvColor(bv));
  const bucketOf = bv => bv == null ? 2 : bv < -0.15 ? 0 : bv < 0.15 ? 1 : bv < 0.45 ? 2 : bv < 0.75 ? 3 : bv < 1.1 ? 4 : bv < 1.6 ? 5 : 6;

  class SkyLayer {
    constructor(map, getTime) {
      this.map = map;
      this.getTime = getTime;
      this.cat = null;
      this.opts = {
        stars: true, starLabels: true, deep: true, magMax: 12.5, labelDensity: 1,
        bodies: true, bodyTrails: false, night: true, grid: false, heat: true,
      };
      this.selected = null;         // {kind:'star', idx} | {kind:'body', key}
      this.onFrame = null;          // колбэк после кадра (время, число звёзд)

      const pane = map.createPane('sky');
      pane.style.zIndex = 480; // над участком (460), метками аномалий (465) и трассами (470); щелчки проходят насквозь
      pane.style.pointerEvents = 'none';
      this.canvas = L.DomUtil.create('canvas', 'sky-canvas', pane);
      this.ctx = this.canvas.getContext('2d');

      this.hitX = new Float32Array(0); this.hitY = new Float32Array(0); this.hitI = new Int32Array(0); this.hitN = 0;
      this.bodyHits = [];
      this.bodies = []; this.bodiesMs = NaN;
      this.trails = null; this.trailsMs = NaN;
      this.dirty = true; this.lastMs = NaN; this.lastWorld = 0;
      this.occupied = new Set();
      this.tmp = {};
      this.drawnCount = 0;

      map.on('move zoom resize viewreset', () => { this.dirty = true; });
      map.on('zoomstart', () => { this.canvas.style.visibility = 'hidden'; });
      map.on('zoomend', () => { this.canvas.style.visibility = ''; this.dirty = true; });
      const loop = () => { this.tick(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }

    setCatalog(cat) { this.cat = cat; this.dirty = true; }
    set(patch) { Object.assign(this.opts, patch); this.trailsMs = NaN; this.dirty = true; }
    invalidate() { this.dirty = true; this.trailsMs = NaN; }

    tick() {
      const ms = this.getTime();
      const world = 256 * Math.pow(2, this.map.getZoom());
      if (!this.dirty && ms === this.lastMs) return;
      // сдвиг точек с прошлого кадра в пикселях — перерисовываем от полупикселя
      const shift = Math.abs(ms - this.lastMs) * Z.EARTH_DEG_PER_MS * world / 360;
      if (!this.dirty && !(shift >= 0.5) && Math.abs(ms - this.bodiesMs) < 60000) return;
      this.dirty = false; this.lastMs = ms; this.lastWorld = world;
      this.draw(ms);
    }

    autoMag(zoom) {
      return zoom < 2 ? 5 : zoom < 3 ? 6 : zoom < 4 ? 7 : zoom < 5 ? 8 : zoom < 6 ? 9 : zoom < 7 ? 10.5 : 99;
    }

    draw(ms) {
      const map = this.map, size = map.getSize(), dpr = window.devicePixelRatio || 1;
      const cv = this.canvas;
      if (cv.width !== Math.round(size.x * dpr) || cv.height !== Math.round(size.y * dpr)) {
        cv.width = Math.round(size.x * dpr); cv.height = Math.round(size.y * dpr);
        cv.style.width = size.x + 'px'; cv.style.height = size.y + 'px';
      }
      L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([0, 0]));
      const c = this.ctx;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, size.x, size.y);

      const zoom = map.getZoom();
      this.W = size.x; this.H = size.y;
      this.world = 256 * Math.pow(2, zoom);
      const o = map.latLngToContainerPoint([0, 0]);
      this.ox = o.x; this.oy = o.y;
      const fr = Z.frame(ms);
      this.fr = fr;

      if (this.opts.night) this.drawNight(c, ms);
      if (this.heat && this.opts.heat) this.drawHeat(c);
      if (this.opts.grid) this.drawGrid(c);

      this.occupied.clear();
      this.hitN = 0;
      this.drawnCount = 0;
      if (this.opts.stars && this.cat) this.drawStars(c, fr, zoom);
      this.bodyHits = [];
      if (this.opts.bodies) this.drawBodies(c, ms, zoom);
      if (this.selected) this.drawSelected(c, fr, ms);
      if (this.onFrame) this.onFrame(ms, this.drawnCount);
    }

    /** Меркатор от опорной точки кадра. Возвращает x (с переносом копий мира) или NaN, если не видно. */
    px(lat, lon, margin) {
      const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Z.D2R);
      const y = this.oy - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) * this.world;
      let x = this.ox + lon / 360 * this.world;
      const w = this.world;
      while (x < -margin && x + w <= this.W + margin) x += w;
      while (x > this.W + margin && x - w >= -margin) x -= w;
      this._y = y;
      return (x >= -margin && x <= this.W + margin && y >= -margin && y <= this.H + margin) ? x : NaN;
    }
    lonAtX(x) { return (x - this.ox) / this.world * 360; }
    latAtY(y) {
      const m = (this.oy - y) / this.world * 2 * Math.PI;
      return Math.atan(Math.sinh(m)) * Z.R2D;
    }
    yAtLat(lat) {
      const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Z.D2R);
      return this.oy - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) * this.world;
    }

    claim(x, y, w) {
      const cw = 84 / this.opts.labelDensity, ch = 16;
      const cx = Math.floor(x / cw), cy = Math.floor(y / ch);
      const key = cx * 100000 + cy;
      if (this.occupied.has(key)) return false;
      this.occupied.add(key);
      if (w > cw) this.occupied.add((cx + 1) * 100000 + cy);
      return true;
    }

    drawStars(c, fr, zoom) {
      const cat = this.cat, opts = this.opts;
      const magLimit = Math.min(opts.magMax, this.autoMag(zoom));
      const magRaw = Math.round(magLimit * 1000);
      const latTop = Math.min(90, this.latAtY(-20)), latBot = Math.max(-90, this.latAtY(this.H + 20));
      const lonL = this.lonAtX(-20), lonR = this.lonAtX(this.W + 20);
      const span = lonR - lonL;
      // запас: J2000 против даты (прецессия ≤ 0,2° по δ к 2030 г.), у полюсов берём все α
      const dMin = latBot - 0.6, dMax = latTop + 0.6;
      const polar = dMax > 80 || dMin < -80;
      const raSpan = (span >= 356 || polar) ? 360 : span + 2.4;
      const ra0 = lonL + fr.gast - 1.2;

      const cap = 250000;
      if (this.hitX.length < cap) { this.hitX = new Float32Array(cap); this.hitY = new Float32Array(cap); this.hitI = new Int32Array(cap); }
      const buckets = COLOR_BUCKETS.map(() => []);
      const labels = [];
      const nameMag = [1.5, 1.5, 1.5, 2.5, 3.5, 5, 6.5][Math.min(6, Math.max(0, Math.floor(zoom)))] ?? 7;
      const idLabels = zoom >= 9;
      const o = this.tmp;
      let n = 0;
      const deep = opts.deep;

      cat.forCells(dMin, dMax, ra0, raSpan, (first, last) => {
        for (let i = first; i < last; i++) {
          if (cat.i16[i * 16 + 8] > magRaw) break;
          if (!deep && cat.u8[i * 32 + 20] >= 3) continue;
          Z.starApparent(fr, cat.u32[i * 8] / 1e7, cat.i32[i * 8 + 1] / 1e7, cat.f32[i * 8 + 2], cat.f32[i * 8 + 3], o);
          const x = this.px(o.dec, Z.normLon(o.ra - fr.gast), 8);
          if (x !== x) continue;
          const y = this._y;
          const mag = cat.i16[i * 16 + 8] / 1000;
          const r = Math.max(0.8, Math.min(5.5, 4.4 * Math.pow(10, -0.09 * mag)));
          buckets[bucketOf(cat.bv(i))].push(x, y, r, mag);
          if (n < cap) { this.hitX[n] = x; this.hitY[n] = y; this.hitI[n] = i; n++; }
          if (opts.starLabels && (mag <= nameMag || idLabels)) labels.push(i, x, y, r, mag);
          if (n >= cap) return false;
        }
      });
      this.hitN = n;
      this.drawnCount = n;

      for (let b = 0; b < buckets.length; b++) {
        const arr = buckets[b];
        if (!arr.length) continue;
        c.fillStyle = COLOR_BUCKETS[b];
        // тусклые — квадратики (быстро), яркие — кружки
        c.globalAlpha = 0.75;
        for (let k = 0; k < arr.length; k += 4) {
          const r = arr[k + 2];
          if (r < 1.6) c.fillRect(arr[k] - r, arr[k + 1] - r, r * 2, r * 2);
        }
        c.globalAlpha = 1;
        c.beginPath();
        for (let k = 0; k < arr.length; k += 4) {
          const r = arr[k + 2];
          if (r >= 1.6) { c.moveTo(arr[k] + r, arr[k + 1]); c.arc(arr[k], arr[k + 1], r, 0, Math.PI * 2); }
        }
        c.fill();
      }

      if (labels.length) {
        // подписи ярких занимают места первыми
        const order = [];
        for (let k = 0; k < labels.length; k += 5) order.push(k);
        order.sort((a, b) => labels[a + 4] - labels[b + 4]);
        c.textBaseline = 'middle';
        c.shadowColor = 'rgba(0,0,0,0.95)'; c.shadowBlur = 3;
        let drawn = 0;
        for (const k of order) {
          if (drawn > 700) break;
          const i = labels[k], x = labels[k + 1], y = labels[k + 2], r = labels[k + 3], mag = labels[k + 4];
          let text = null, strong = false;
          const short = cat.shortLabel(i);
          if (short && mag <= nameMag) { text = short; strong = cat.isNamed(i); }
          else if (idLabels) text = short || cat.displayName(i);
          if (!text) continue;
          c.font = strong ? '600 12px "Segoe UI", sans-serif' : '11px "Segoe UI", sans-serif';
          const w = c.measureText(text).width;
          if (!this.claim(x + r + 4, y, w)) continue;
          c.fillStyle = strong ? '#F6D494' : 'rgba(232,216,176,0.85)';
          c.fillText(text, x + r + 4, y);
          drawn++;
        }
        c.shadowBlur = 0;
      }
    }

    drawBodies(c, ms, zoom) {
      if (Math.abs(ms - this.bodiesMs) > 20000 || !this.bodies.length) {
        this.bodies = Z.BODIES.map(b => ({ ...b, z: Z.bodyZenith(b.key, ms, {}) }));
        this.bodiesMs = ms;
      }
      if (this.opts.bodyTrails) this.drawTrails(c, ms);
      c.textBaseline = 'middle';
      for (const b of this.bodies) {
        const x = this.px(b.z.lat, b.z.lon, 40);
        if (x !== x) continue;
        const y = this._y;
        const r = b.r;
        const g = c.createRadialGradient(x, y, 0, x, y, r * (b.key === 'Sun' ? 4 : 3));
        g.addColorStop(0, hexA(b.color, 0.6)); g.addColorStop(1, hexA(b.color, 0));
        c.fillStyle = g;
        c.beginPath(); c.arc(x, y, r * (b.key === 'Sun' ? 4 : 3), 0, Math.PI * 2); c.fill();
        c.fillStyle = b.color;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        c.lineWidth = 1.5; c.strokeStyle = 'rgba(0,0,0,0.85)'; c.stroke();
        c.font = '700 13px "Segoe UI", sans-serif';
        c.shadowColor = 'rgba(0,0,0,1)'; c.shadowBlur = 4;
        c.fillStyle = '#fff';
        c.fillText(`${b.sym} ${b.name}`, x + r + 6, y);
        c.shadowBlur = 0;
        this.claim(x + r + 6, y, 80);
        this.bodyHits.push({ x, y, key: b.key });
      }
    }

    /** След светил ±6 ч с часовыми засечками. */
    drawTrails(c, ms) {
      if (!this.trails || Math.abs(ms - this.trailsMs) > 5 * 60000) {
        const step = 10 * 60000;
        this.trails = Z.BODIES.map(b => {
          const pts = [];
          for (let t = ms - 6 * 3600000; t <= ms + 6 * 3600000; t += step) { const z = Z.bodyZenith(b.key, t, {}); pts.push(z.lat, z.lon, t); }
          return { color: b.color, pts };
        });
        this.trailsMs = ms;
      }
      c.lineWidth = 1.2;
      for (const tr of this.trails) {
        c.strokeStyle = hexA(tr.color, 0.55);
        c.setLineDash([4, 4]);
        this.polyline(c, tr.pts, 3);
        c.setLineDash([]);
      }
    }

    /** Ломаная по (lat, lon, …) шагом stride; долгота разворачивается, чтобы не рвалась на 180°. */
    polyline(c, pts, stride) {
      if (pts.length < stride * 2) return;
      let prevLon = pts[1];
      const lons = [prevLon];
      for (let k = stride; k < pts.length; k += stride) {
        let l = pts[k + 1];
        while (l - prevLon > 180) l -= 360;
        while (prevLon - l > 180) l += 360;
        lons.push(l); prevLon = l;
      }
      const w = this.world;
      for (let copy = -1; copy <= 1; copy++) {
        c.beginPath();
        for (let k = 0, j = 0; k < pts.length; k += stride, j++) {
          const x = this.ox + lons[j] / 360 * w + copy * w, y = this.yAtLat(pts[k]);
          if (j === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
      }
    }

    drawSelected(c, fr, ms) {
      const s = this.selected;
      let lat, lon;
      if (s.kind === 'star') {
        const cat = this.cat;
        Z.starZenith(fr, cat.ra(s.idx), cat.dec(s.idx), cat.pmra(s.idx), cat.pmdec(s.idx), this.tmp);
        lat = this.tmp.lat; lon = this.tmp.lon;
      } else {
        const b = this.bodies.find(b => b.key === s.key);
        if (!b) return;
        lat = b.z.lat; lon = b.z.lon;
      }
      const x = this.px(lat, lon, 30);
      if (x !== x) return;
      const y = this._y;
      const pulse = (Math.sin(performance.now() / 300) + 1) / 2;
      c.strokeStyle = '#FFB547'; c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, 11 + pulse * 3, 0, Math.PI * 2); c.stroke();
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(x - 22, y); c.lineTo(x - 13, y); c.moveTo(x + 13, y); c.lineTo(x + 22, y);
      c.moveTo(x, y - 22); c.lineTo(x, y - 13); c.moveTo(x, y + 13); c.lineTo(x, y + 22); c.stroke();
      this.dirty = true; // пульсация
    }

    /** Ночная сторона: высота Солнца < 0. Граница — терминатор tg φ = −cos(λ − λ☉) / tg φ☉. */
    drawNight(c, ms) {
      const sun = Z.bodyZenith('Sun', ms, {});
      const ps = sun.lat * Z.D2R;
      const tps = Math.tan(Math.abs(ps) < 1e-4 ? 1e-4 : ps);
      const step = 4;
      c.beginPath();
      const edgeY = ps > 0 ? this.H + 10 : -10; // ночь у южного полюса летом северного полушария
      c.moveTo(-step, edgeY);
      for (let x = -step; x <= this.W + step; x += step) {
        const lon = this.lonAtX(x);
        const lat = Math.atan(-Math.cos((lon - sun.lon) * Z.D2R) / tps) * Z.R2D;
        c.lineTo(x, this.yAtLat(lat));
      }
      c.lineTo(this.W + step, edgeY);
      c.closePath();
      c.fillStyle = 'rgba(3,6,22,0.5)';
      c.fill();
      // сумеречная кромка
      c.strokeStyle = 'rgba(255,190,90,0.35)'; c.lineWidth = 1;
      c.beginPath();
      for (let x = -step, f = true; x <= this.W + step; x += step, f = false) {
        const lon = this.lonAtX(x);
        const y = this.yAtLat(Math.atan(-Math.cos((lon - sun.lon) * Z.D2R) / tps) * Z.R2D);
        if (f) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    }

    /** Тепловая карта сгущений: ячейки [φ₁, φ₂, λ₁, λ₂, z], цвет — от порога z до максимума. */
    setHeat(heat) { this.heat = heat; this.dirty = true; }
    drawHeat(c) {
      const h = this.heat, a = h.cells;
      const lonL = this.lonAtX(0), w = this.world;
      const span = Math.log(Math.max(h.maxZ, h.zThr + 1) / h.zThr);
      for (let k = 0; k < a.length; k += 5) {
        const y1 = this.yAtLat(a[k + 1]), y2 = this.yAtLat(a[k]);
        if (y2 < 0 || y1 > this.H) continue;
        let x1 = this.ox + a[k + 2] / 360 * w, x2 = this.ox + a[k + 3] / 360 * w;
        // копия мира, ближайшая к левому краю экрана
        const shift = Math.floor((lonL - a[k + 2]) / 360 + 1) * w;
        x1 += shift - w; x2 += shift - w;
        const f = Math.min(1, Math.log(a[k + 4] / h.zThr) / span);
        c.fillStyle = `rgba(255,${Math.round(150 - 110 * f)},${Math.round(90 - 60 * f)},${(0.22 + 0.4 * f).toFixed(2)})`;
        for (let x = x1; x < this.W; x += w) {
          if (x + (x2 - x1) >= 0) c.fillRect(x, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
        }
      }
    }

    drawGrid(c) {
      const lonL = this.lonAtX(0), lonR = this.lonAtX(this.W);
      const span = lonR - lonL;
      const steps = [30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
      let st = steps[0];
      for (const s of steps) { if (span / s <= 14) st = s; else break; }
      c.strokeStyle = 'rgba(160,190,255,0.22)'; c.lineWidth = 1;
      c.fillStyle = 'rgba(200,215,255,0.7)'; c.font = '10px Consolas, monospace';
      c.textBaseline = 'top';
      const dec = st < 0.01 ? 3 : st < 0.1 ? 2 : st < 1 ? 1 : 0;
      c.beginPath();
      for (let l = Math.ceil(lonL / st) * st; l <= lonR; l += st) {
        const x = this.ox + l / 360 * this.world;
        c.moveTo(x, 0); c.lineTo(x, this.H);
        c.fillText(`${Z.normLon(l).toFixed(dec)}°`, x + 3, 3);
      }
      const latT = this.latAtY(0), latB = this.latAtY(this.H);
      for (let p = Math.ceil(latB / st) * st; p <= latT; p += st) {
        const y = this.yAtLat(p);
        c.moveTo(0, y); c.lineTo(this.W, y);
        c.fillText(`${p.toFixed(dec)}°`, 3, y + 2);
      }
      c.stroke();
    }

    /** Объект под курсором: светила в приоритете, среди звёзд — ближе и ярче. */
    hit(x, y) {
      let best = null, bestScore = Infinity;
      for (const b of this.bodyHits) {
        const d = (b.x - x) ** 2 + (b.y - y) ** 2;
        if (d < 18 * 18 && d < bestScore) { bestScore = d; best = { kind: 'body', key: b.key }; }
      }
      if (best) return best;
      const lim = 12;
      for (let k = 0; k < this.hitN; k++) {
        const dx = this.hitX[k] - x, dy = this.hitY[k] - y;
        if (dx > lim || dx < -lim || dy > lim || dy < -lim) continue;
        const score = dx * dx + dy * dy + this.cat.mag(this.hitI[k]) * 6;
        if (score < bestScore) { bestScore = score; best = { kind: 'star', idx: this.hitI[k] }; }
      }
      return best;
    }
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  window.SkyLayer = SkyLayer;
})();
