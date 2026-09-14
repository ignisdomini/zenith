/*
 * ZENIT — user interface: map, time, object search, passages through an area, anomalies, export.
 * ЗЕНИТ — интерфейс: карта, время, поиск объектов, проходы через участок, аномалии, экспорт.
 */
(async function () {
  'use strict';
  const Z = window.ZAstro, F = window.ZFmt, X = window.ZExport, I = window.ZI18n;
  const t = I.t, num = I.num;
  const $ = (id) => document.getElementById(id);
  const api = window.zenit;
  const H = 3600000, DAY = 86400000;
  /** Russian plural: 1 звезда, 2 звезды, 5 звёзд. */
  const ruPlural = (n, one, few, many) => {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  };

  let settings = await api.getSettings();
  F.tz = settings.tz || 'local';
  Z.setDut1(settings.dut1 || 0);

  // ── map ──
  const map = L.map('map', { center: [55.75, 37.62], zoom: 4, minZoom: 2, maxZoom: 21, worldCopyJump: false, zoomControl: true, preferCanvas: false });
  map.attributionControl.setPrefix(t('app.name'));
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  ZLayers.mount(map, $('base-list'), $('overlay-list'), 'hybrid');
  try { const v = JSON.parse(localStorage.getItem('zenit.view')); if (v) map.setView(v.c, v.z); } catch { /* no saved view */ }
  map.on('moveend', () => { try { localStorage.setItem('zenit.view', JSON.stringify({ c: map.getCenter(), z: map.getZoom() })); } catch { /* no storage */ } });

  // ── time ──
  const clock = { base: Date.now(), perf: performance.now(), speed: 1, playing: true };
  const now = () => clock.playing ? clock.base + (performance.now() - clock.perf) * clock.speed : clock.base;
  function setTime(ms, playing) {
    clock.base = ms; clock.perf = performance.now();
    if (playing !== undefined) clock.playing = playing;
    updatePlay(); sky.invalidate();
  }
  function updatePlay() { $('play').textContent = clock.playing ? '❚❚' : '▶'; }
  $('play').onclick = () => { const tm = now(); clock.playing = !clock.playing; setTime(tm); };
  $('speed').onchange = () => { const tm = now(); clock.speed = +$('speed').value; setTime(tm); };
  document.querySelectorAll('[data-shift]').forEach(b => b.onclick = () => setTime(now() + +b.dataset.shift));
  $('now').onclick = () => { clock.speed = 1; $('speed').value = '1'; setTime(Date.now(), true); };
  $('clock-input').onchange = () => { const tm = F.parseInput($('clock-input').value); if (!isNaN(tm)) setTime(tm, false); };

  const sky = new SkyLayer(map, now);
  let lastClock = 0;
  sky.onFrame = (ms, n) => { $('st-drawn').textContent = sky.cat ? t('status.onScreen', { n: num(n) }) : ''; };
  setInterval(() => {
    const tm = now();
    $('clock-date').textContent = `${F.date(tm)} · ${F.zone(tm)}`;
    $('clock-time').textContent = F.time(tm);
    const live = clock.playing && clock.speed === 1 && Math.abs(tm - Date.now()) < 2000;
    $('clock-time').classList.toggle('fixed', !live);
    if (document.activeElement !== $('clock-input') && Math.abs(tm - lastClock) >= 1000) { $('clock-input').value = F.input(tm); lastClock = tm; }
    $('st-zoom').textContent = t('status.zoom', { z: map.getZoom() });
  }, 200);

  // ── tabs ──
  function showTab(name) {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  }
  document.querySelectorAll('.tab').forEach(x => x.onclick = () => showTab(x.dataset.tab));

  // ── sky options ──
  const skyOpts = ['stars', 'starLabels', 'deep', 'bodies', 'bodyTrails', 'night', 'grid'];
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('zenit.sky')) || {}; } catch { /* none */ }
  const saveSky = () => { try { localStorage.setItem('zenit.sky', JSON.stringify(sky.opts)); } catch { /* none */ } };
  for (const k of skyOpts) {
    const el = $('o-' + k);
    if (saved[k] !== undefined) el.checked = saved[k];
    el.onchange = () => { sky.set({ [k]: el.checked }); saveSky(); };
    sky.opts[k] = el.checked;
  }
  if (saved.magMax) $('o-magMax').value = saved.magMax;
  if (saved.labelDensity) $('o-labelDensity').value = saved.labelDensity;
  const syncRanges = () => {
    sky.set({ magMax: +$('o-magMax').value, labelDensity: +$('o-labelDensity').value });
    $('mag-val').textContent = `${(+$('o-magMax').value).toFixed(1)}ᵐ`;
    $('lbl-val').textContent = t('sky.density.' + $('o-labelDensity').value);
    saveSky();
  };
  $('o-magMax').oninput = syncRanges; $('o-labelDensity').oninput = syncRanges;
  syncRanges();

  // ── catalog and worker ──
  let cat = null;
  const worker = new Worker('js/search-worker.js');
  let reqId = 0;
  const pending = new Map();
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (m.type === 'ready') { workerReady(m); return; }
    if (!p) return;
    if (m.type === 'progress') { p.onProgress && p.onProgress(m); return; }
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
  };
  const request = (type, payload, onProgress) => new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ type, id, ...payload });
    request.last = id;
  });
  let workerReady;
  const workerReadyP = new Promise(r => { workerReady = r; });

  try {
    cat = await ZCatalog.load('../../catalog/stars.bin', '../../catalog/names.json', f => { $('loading-bar').style.width = (f * 100).toFixed(0) + '%'; });
    const copy = cat.u8.buffer.slice(0);
    worker.postMessage({ type: 'init', buffer: copy, dut1: Z.getDut1() }, [copy]);
    sky.setCatalog(cat);
    let hyg = 0; for (let i = 0; i < cat.count; i++) if (cat.u8[i * 32 + 20] <= 2) hyg++;
    $('catalog-card').innerHTML = t('sky.catalog.card', { total: num(cat.count), hyg: num(hyg), tyc: num(cat.count - hyg) });
  } catch (err) {
    $('loading-text').textContent = t('loading.fail') + err.message;
    return;
  }
  $('loading').remove();
  await workerReadyP;

  // ── object selection ──
  let selected = null;   // {kind, idx|key}
  const tracks = new ZArea.TrackLayer(map, () => cat);
  const objName = (o) => o.kind === 'star' ? cat.displayName(o.idx) : Z.BODY_BY_KEY[o.key].name;

  function zenithNow(o, tm) {
    if (o.kind === 'star') return Z.starZenith(Z.frame(tm), cat.ra(o.idx), cat.dec(o.idx), cat.pmra(o.idx), cat.pmdec(o.idx), {});
    return Z.bodyZenith(o.key, tm, {});
  }

  function select(o, opts = {}) {
    selected = o;
    sky.selected = o;
    sky.invalidate();
    renderObject();
    if (opts.tab !== false) showTab('obj');
    if (opts.goto) gotoObject();
    $('obj-table').querySelector('tbody').innerHTML = '';
    objPasses = [];
    setExportEnabled('obj', false);
    updateObjPassButton();
  }
  function gotoObject() {
    if (!selected) return;
    const z = zenithNow(selected, now());
    map.setView([z.lat, z.lon], Math.max(map.getZoom(), 6));
  }

  map.on('click', (e) => {
    if (area.mode) return;
    const o = sky.hit(e.containerPoint.x, e.containerPoint.y);
    if (o) select(o);
  });
  map.on('mousemove', (e) => {
    $('st-cursor').textContent = `φ ${e.latlng.lat.toFixed(5)}°  λ ${Z.normLon(e.latlng.lng).toFixed(5)}°`;
    const o = sky.hit(e.containerPoint.x, e.containerPoint.y);
    $('st-zenith').textContent = o ? t('status.zenith', { name: objName(o) + (o.kind === 'star' ? ` (${cat.mag(o.idx).toFixed(1)}ᵐ)` : '') }) : '';
  });

  // object card
  function kv(rows) { return rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(''); }
  function renderObject() {
    if (!selected) { $('obj-empty').hidden = false; $('obj-card').hidden = true; return; }
    $('obj-empty').hidden = true; $('obj-card').hidden = false;
    const tm = now();
    const z = zenithNow(selected, tm);
    const vKm = Z.EARTH_DEG_PER_DAY / 86400 * area.kmPerDeg(z.lat)[1];
    if (selected.kind === 'star') {
      const s = cat.info(selected.idx);
      $('obj-glyph').textContent = '✦';
      $('obj-glyph').style.color = Z.bvColor(s.bv);
      $('obj-name').textContent = s.name;
      $('obj-sub').textContent = s.designations.filter(d => d !== s.name).join(' · ');
      $('obj-kv').innerHTML = kv([
        [t('obj.k.catalog'), s.source],
        [t('obj.k.mag'), `${s.mag.toFixed(2)}ᵐ`],
        ['B − V', s.bv != null ? s.bv.toFixed(2) : null],
        [t('obj.k.spect'), s.spect],
        [t('obj.k.dist'), s.distPc ? t('obj.v.dist', { pc: s.distPc.toFixed(1), ly: (s.distPc * 3.26156).toFixed(1) }) : null],
        ['α, δ J2000', `${F.hms(s.ra)} ${F.dms(s.dec)}`],
        [t('obj.k.pm'), t('obj.v.pm', { a: s.pmra.toFixed(1), d: s.pmdec.toFixed(1) })],
        [t('obj.k.apparent'), `${F.hms(z.ra)} ${F.dms(z.dec)}`],
        [t('obj.k.zenith'), `${F.lat(z.lat)}<br>${F.lon(z.lon)}`],
        [t('obj.k.speed'), t('obj.v.speedWest', { v: (vKm * 1000).toFixed(1) })],
      ]);
    } else {
      const b = Z.BODY_BY_KEY[selected.key];
      const z2 = Z.bodyZenith(selected.key, tm + 60000, {});
      const dLat = (z2.lat - z.lat) * area.kmPerDeg(z.lat)[0], dLon = Z.normLon(z2.lon - z.lon) * area.kmPerDeg(z.lat)[1];
      $('obj-glyph').textContent = b.sym;
      $('obj-glyph').style.color = b.color;
      $('obj-name').textContent = b.name;
      $('obj-sub').textContent = t('obj.body.sub');
      $('obj-kv').innerHTML = kv([
        [t('obj.k.apparent'), `${F.hms(z.ra)} ${F.dms(z.dec)}`],
        [t('obj.k.dist'), selected.key === 'Moon' ? `${num(Math.round(z.distKm))} ${t('unit.km')}` : `${z.distAu.toFixed(5)} ${t('unit.au')}`],
        [t('obj.k.zenith'), `${F.lat(z.lat)}<br>${F.lon(z.lon)}`],
        [t('obj.k.speed'), t('obj.v.speed', { v: (Math.hypot(dLat, dLon) / 60 * 1000).toFixed(1) })],
      ]);
    }
  }
  setInterval(() => {
    if (!selected) return;
    if ($('obj-card').offsetParent) renderObject();
    if ($('obj-follow').checked) { const z = zenithNow(selected, now()); map.panTo([z.lat, z.lon], { animate: false }); }
  }, 500);
  $('obj-goto').onclick = gotoObject;
  $('obj-track').onclick = () => { if (selected) { tracks.showAround(selected, now(), 12); gotoObject(); } };

  // ── search ──
  const searchBox = $('search'), searchRes = $('search-results');
  let searchItems = [], searchSel = 0;
  function runSearch() {
    const q = searchBox.value.trim();
    if (!q) { searchRes.hidden = true; return; }
    const ql = q.toLowerCase();
    const bodies = Z.BODIES.filter(b => b.name.toLowerCase().startsWith(ql) || b.key.toLowerCase().startsWith(ql) ||
      I.DICT.ru['body.' + b.key].toLowerCase().startsWith(ql)).map(b => ({ kind: 'body', key: b.key }));
    const stars = cat.find(q, 30).map(i => ({ kind: 'star', idx: i }));
    searchItems = [...bodies, ...stars];
    searchSel = 0;
    searchRes.innerHTML = searchItems.length ? searchItems.map((o, k) => {
      const sub = o.kind === 'star' ? `${cat.catalogId(o.idx)} · ${cat.mag(o.idx).toFixed(1)}ᵐ` : Z.BODY_BY_KEY[o.key].sym;
      return `<div data-k="${k}" class="${k === 0 ? 'sel' : ''}"><span>${X.esc(objName(o))}</span><small>${X.esc(sub)}</small></div>`;
    }).join('') : `<div><span style="color:#8089a0">${t('search.none')}</span></div>`;
    searchRes.hidden = false;
  }
  let searchTimer;
  searchBox.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 180); };
  searchBox.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      searchSel = Math.max(0, Math.min(searchItems.length - 1, searchSel + (e.key === 'ArrowDown' ? 1 : -1)));
      searchRes.querySelectorAll('div').forEach((d, k) => d.classList.toggle('sel', k === searchSel));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      clearTimeout(searchTimer); runSearch();
      if (searchItems[searchSel]) pickSearch(searchItems[searchSel]);
    } else if (e.key === 'Escape') searchRes.hidden = true;
  };
  searchRes.onmousedown = (e) => { const d = e.target.closest('[data-k]'); if (d) pickSearch(searchItems[+d.dataset.k]); };
  searchBox.onblur = () => setTimeout(() => { searchRes.hidden = true; }, 150);
  function pickSearch(o) { searchRes.hidden = true; select(o, { goto: true }); }

  // ── area ──
  const area = new ZArea.AreaTool(map, document.querySelector('.map-wrap'), $('map-hint'), onAreaChange);
  area.onModeEnd = () => { $('area-draw').classList.remove('active-tool'); $('area-square').classList.remove('active-tool'); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') area.cancelMode(); });
  $('area-draw').onclick = () => { area.startDraw(); $('area-draw').classList.add('active-tool'); };
  $('area-square').onclick = () => { area.startSquare(Math.max(0.001, +$('area-km').value || 1)); $('area-square').classList.add('active-tool'); };
  $('area-clear').onclick = () => area.clear();
  $('area-fit').onclick = () => area.fit();
  $('area-apply').onclick = () => {
    const r = { s: +$('a-s').value, n: +$('a-n').value, w: +$('a-w').value, e: +$('a-e').value };
    if ([r.s, r.n, r.w, r.e].some(v => isNaN(v)) || r.s === r.n || r.w === r.e) return;
    if (r.e < r.w) r.e += 360;
    area.set(r, true);
  };
  function onAreaChange(r) {
    if (!r) {
      ['a-n', 'a-s', 'a-w', 'a-e'].forEach(id => { $(id).value = ''; });
      $('area-info').textContent = t('pass.none');
    } else {
      $('a-n').value = r.n.toFixed(6); $('a-s').value = r.s.toFixed(6);
      $('a-w').value = Z.normLon(r.w).toFixed(6); $('a-e').value = Z.normLon(r.e).toFixed(6);
      const mid = (r.s + r.n) / 2, [ky, kx] = area.kmPerDeg(mid);
      const h = (r.n - r.s) * ky, w = (r.e - r.w) * kx;
      const fmtKm = v => v < 1 ? `${(v * 1000).toFixed(0)} ${t('unit.m')}` : `${v.toFixed(v < 10 ? 2 : 1)} ${t('unit.km')}`;
      const tStar = (r.e - r.w) / Z.EARTH_DEG_PER_MS;
      $('area-info').innerHTML = t('pass.info', { w: fmtKm(w), h: fmtKm(h), t: F.dur(tStar), s: F.dms(r.s), n: F.dms(r.n) });
    }
    updateObjPassButton();
  }

  // period
  function setPeriod(fromMs, days) {
    $('p-from').value = F.input(fromMs);
    $('p-to').value = F.input(fromMs + days * DAY);
  }
  setPeriod(Math.floor(now() / 60000) * 60000, 365);
  $('p-presets').querySelectorAll('button').forEach(b => b.onclick = () => {
    $('p-presets').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    const from = F.parseInput($('p-from').value);
    setPeriod(isNaN(from) ? now() : from, +b.dataset.days);
  });
  const period = () => {
    const t0 = F.parseInput($('p-from').value), t1 = F.parseInput($('p-to').value);
    return (isNaN(t0) || isNaN(t1) || t1 <= t0) ? null : { t0, t1 };
  };

  // bodies to search
  $('s-bodies').innerHTML = Z.BODIES.map(b => `<label><input type="checkbox" value="${b.key}" ${['Sun', 'Moon'].includes(b.key) ? 'checked' : ''}><span class="sym" style="color:${b.color}">${b.sym}</span>${b.name}</label>`).join('');

  // ── passage computation ──
  let searchRows = [], searchCtx = null;
  $('s-run').onclick = async () => {
    const rect = area.get(), per = period();
    if (!rect) { $('s-summary').textContent = t('pass.err.area'); return; }
    if (!per) { $('s-summary').textContent = t('pass.err.period'); return; }
    if (per.t1 - per.t0 > 20 * 365.25 * DAY) { $('s-summary').textContent = t('pass.err.long'); return; }
    const bodies = [...$('s-bodies').querySelectorAll('input:checked')].map(i => i.value);
    const stars = $('s-stars').checked;
    $('s-run').disabled = true; $('s-cancel').hidden = false; $('s-progress').hidden = false;
    $('s-summary').textContent = t('common.computing');
    $('s-table').querySelector('tbody').innerHTML = '';
    const started = performance.now();
    try {
      const res = await request('search', { rect, t0: per.t0, t1: per.t1, magMax: +$('s-mag').value, stars, bodies, limit: 5000 }, (p) => {
        $('s-progress').firstElementChild.style.width = (p.done / Math.max(1, p.total) * 100).toFixed(1) + '%';
        $('s-summary').textContent = t('pass.progress', { done: num(p.done), total: num(p.total), found: num(p.found) });
      });
      searchRows = res.rows; searchCtx = { rect, ...per };
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      $('s-summary').textContent = res.cancelled ? t('common.stopped') :
        t('pass.found', { n: num(res.totalFound), more: res.totalFound > res.rows.length ? t('pass.more', { n: num(res.rows.length) }) : '', secs });
      renderSearch();
    } catch (err) {
      $('s-summary').textContent = t('common.error') + err.message;
    } finally {
      $('s-run').disabled = false; $('s-cancel').hidden = true; $('s-progress').hidden = true;
    }
  };
  $('s-cancel').onclick = () => worker.postMessage({ type: 'cancel', id: request.last });

  function rowObj(r) { return r.kind === 'star' ? { kind: 'star', idx: r.idx } : { kind: 'body', key: r.key }; }
  function renderSearch() {
    const tb = $('s-table').querySelector('tbody');
    tb.innerHTML = searchRows.slice(0, 2000).map((r, k) => {
      const o = rowObj(r);
      const name = objName(o);
      const sub = o.kind === 'star' ? cat.catalogId(o.idx) : Z.BODY_BY_KEY[o.key].sym;
      return `<tr data-k="${k}"><td>${X.esc(name)}<div class="sub">${X.esc(sub)}</div></td>` +
        `<td class="num">${r.mag != null ? r.mag.toFixed(1) : '—'}</td>` +
        `<td class="num">${F.date(r.first.tIn)}<div class="sub">${F.time(r.first.tIn)}</div></td>` +
        `<td class="num">${r.first.always ? t('pass.whole') : F.dur(r.first.tOut - r.first.tIn)}</td><td class="num">${r.count}</td></tr>`;
    }).join('');
    setExportEnabled('s', searchRows.length > 0);
  }
  $('s-table').onclick = (e) => {
    const tr = e.target.closest('tr[data-k]'); if (!tr) return;
    $('s-table').querySelectorAll('tr.sel').forEach(x => x.classList.remove('sel'));
    tr.classList.add('sel');
    const r = searchRows[+tr.dataset.k];
    showPassOnMap(rowObj(r), r.first, searchCtx.rect);
  };

  function showPassOnMap(o, pass, rect) {
    const same = selected && selected.kind === o.kind && selected.idx === o.idx && selected.key === o.key;
    selected = o; sky.selected = o;
    if (!same) { objPasses = []; $('obj-table').querySelector('tbody').innerHTML = ''; setExportEnabled('obj', false); }
    renderObject();
    updateObjPassButton(same);
    if (!pass.always) tracks.showPass(o, pass, rect);
    setTime(pass.tc, false);
    area.fit();
  }

  // ── passages of the selected object ──
  let objPasses = [];
  function updateObjPassButton(keepText) {
    const ok = !!(selected && area.get());
    $('obj-passes').disabled = !ok;
    if (!keepText || !ok) $('obj-pass-hint').textContent = t(ok ? 'obj.passes.ready' : 'obj.passes.need');
  }
  $('obj-passes').onclick = async () => {
    const rect = area.get(), per = period();
    if (!rect || !per || !selected) return;
    $('obj-passes').disabled = true;
    $('obj-pass-hint').textContent = t('common.computing');
    try {
      const res = await request('passes', { object: selected, rect, t0: per.t0, t1: per.t1, limit: 5000 });
      objPasses = res.passes; objPasses.ctx = { rect, ...per, obj: selected };
      $('obj-pass-hint').textContent = res.count ? t('obj.passes.count', { n: num(res.count) }) : t('obj.passes.zero');
      $('obj-table').querySelector('tbody').innerHTML = objPasses.slice(0, 3000).map((p, k) =>
        `<tr data-k="${k}"><td class="num">${k + 1}</td><td class="num">${F.date(p.tIn)}<div class="sub">${F.time(p.tIn)}</div></td>` +
        `<td class="num">${F.time(p.tOut)}</td><td class="num">${p.always ? '—' : F.dur(p.tOut - p.tIn)}</td><td class="num">${p.lat.toFixed(5)}°</td></tr>`).join('');
      setExportEnabled('obj', objPasses.length > 0);
    } catch (err) {
      $('obj-pass-hint').textContent = t('common.error') + err.message;
    } finally { $('obj-passes').disabled = false; }
  };
  $('obj-table').onclick = (e) => {
    const tr = e.target.closest('tr[data-k]'); if (!tr) return;
    $('obj-table').querySelectorAll('tr.sel').forEach(x => x.classList.remove('sel'));
    tr.classList.add('sel');
    showPassOnMap(objPasses.ctx.obj, objPasses[+tr.dataset.k], objPasses.ctx.rect);
  };

  // ── anomalies ──
  const marks = new ZArea.AnomalyMarks(map, (r) => pickAnomaly(r, true));
  let anomRows = [], anomCtx = null, anomFilter = 'all';
  let anPeriod = 86400000;
  $('an-period').querySelectorAll('button').forEach(b => b.onclick = () => {
    $('an-period').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    anPeriod = +b.dataset.ms;
  });
  $('an-filter').querySelectorAll('button').forEach(b => b.onclick = () => {
    $('an-filter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    anomFilter = b.dataset.type; renderAnomalies();
  });
  $('an-heat').onchange = () => sky.set({ heat: $('an-heat').checked });
  $('an-clear').onclick = () => { marks.clear(); sky.setHeat(null); tracks.clear(); };

  $('an-run').onclick = async () => {
    const regionMode = $('an-region').value;
    const region = regionMode === 'area' ? area.get() : null;
    if (regionMode === 'area' && !region) { $('an-summary').textContent = t('an.err.area'); return; }
    const payload = {
      t0: Math.floor(now() / 1000) * 1000, periodMs: anPeriod, region, magMax: +$('an-mag').value,
      density: $('an-density').checked, cell: +$('an-cell').value, zThr: +$('an-z').value, base: $('an-base').value,
      overlap: $('an-overlap').checked, tolArcsec: +$('an-tol').value, minGroup: +$('an-group').value, noDouble: $('an-nodouble').checked, maxExpected: +$('an-maxE').value || 1,
      conj: $('an-conj').checked, dtMin: +$('an-dt').value, cmag: +$('an-cmag').value, bodyBody: $('an-bb').checked,
    };
    $('an-run').disabled = true; $('an-cancel').hidden = false; $('an-progress').hidden = false;
    $('an-summary').textContent = t('common.computing');
    const started = performance.now();
    try {
      const res = await request('anomalies', payload, (p) => {
        $('an-progress').firstElementChild.style.width = (p.done / Math.max(1, p.total) * 100).toFixed(1) + '%';
        $('an-summary').textContent = t(p.stage, { body: p.body ? Z.BODY_BY_KEY[p.body].name : '' }) + '…';
      });
      if (res.cancelled) { $('an-summary').textContent = t('common.stopped'); return; }
      anomCtx = { ...payload, t1: res.t1, stats: res.stats };
      anomRows = res.rows.map(r => ({ ...r, ...describe(r) }));
      sky.setHeat(res.heat && res.heat.cells.length ? res.heat : null);
      marks.set(anomRows);
      const st = res.stats, parts = [];
      if (st.density) parts.push(t('an.s.density', { cells: num(st.density.cells), stars: num(st.density.nTot) }));
      if (st.overlap) parts.push(t('an.s.overlap', { n: num(st.overlap.groups) }));
      if (st.conj) parts.push(t('an.s.conj', { n: num(st.conj.found) }));
      $('an-summary').innerHTML = t('an.summary', { period: t('period.' + st.period), from: F.dt(payload.t0), to: F.dt(res.t1),
        L: st.L.toFixed(0), parts: parts.join(' · '), secs: ((performance.now() - started) / 1000).toFixed(1) });
      renderAnomalies();
    } catch (err) {
      $('an-summary').textContent = t('common.error') + err.message;
    } finally {
      $('an-run').disabled = false; $('an-cancel').hidden = true; $('an-progress').hidden = true;
    }
  };
  $('an-cancel').onclick = () => worker.postMessage({ type: 'cancel', id: request.last });

  /** Title, time and score of an anomaly row. */
  function describe(r) {
    const names = r.objects.map(o => objName(o));
    if (r.type === 'density') {
      const band = r.width >= 359.9 ? t('an.d.band') : t('an.d.lonband', { w: r.width.toFixed(r.width < 1 ? 2 : 0) });
      return {
        title: t('an.d.title', { z: r.z.toFixed(1) }),
        when: `${F.dt(r.t)} …`,
        score: t('an.d.score', { obs: num(Math.round(r.obs)), exp: r.exp.toFixed(r.exp < 10 ? 1 : 0) }),
        detail: band + (names.length ? t('an.d.brightest', { names: names.slice(0, 3).join(', ') }) : ''),
      };
    }
    if (r.type === 'overlap') {
      const e = r.expected;
      const list = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
      const title = I.lang === 'ru'
        ? `${r.size} ${ruPlural(r.size, 'звезда', 'звезды', 'звёзд')} на одной трассе: ${list}`
        : t('an.o.title', { n: r.size, names: list });
      return {
        title,
        when: `${F.dt(r.t)} — ${F.time(r.tEnd)}${r.tEnd - r.t > DAY ? t('an.o.days', { n: Math.floor((r.tEnd - r.t) / DAY) }) : ''}`,
        score: t('an.o.score', { e: e < 0.001 ? e.toExponential(1) : e.toFixed(3) }),
        detail: t('an.o.detail', { s: r.spread.toFixed(2), m: (r.spread * 30.9).toFixed(0), t: F.dur(r.tEnd - r.t) }),
      };
    }
    return {
      title: `${names[0]} × ${names[1]}`,
      when: F.dt(r.t),
      score: `Δt ${F.dur(r.dt)}`,
      detail: t(r.sub === 'body' ? 'an.c.body' : 'an.c.star'),
    };
  }

  function renderAnomalies() {
    const rows = anomRows.filter(r => anomFilter === 'all' || r.type === anomFilter).slice(0, 2000);
    $('an-table').querySelector('tbody').innerHTML = rows.map(r =>
      `<tr data-id="${r.id}"><td><span class="tag ${r.type}"></span></td>` +
      `<td>${X.esc(r.title)}<div class="sub">${r.lat.toFixed(4)}°, ${Z.normLon(r.lon).toFixed(4)}° · ${X.esc(r.detail)}</div></td>` +
      `<td class="num">${F.date(r.t)}<div class="sub">${F.time(r.t)}</div></td><td class="num">${X.esc(r.score)}</td></tr>`).join('');
    setExportEnabled('an', anomRows.length > 0);
  }
  $('an-table').onclick = (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    pickAnomaly(anomRows.find(r => r.id === +tr.dataset.id), false);
  };

  const OBJ_COLORS = ['#F2C46D', '#6FD3FF', '#B99BFF', '#6EE7A8', '#FF7A66', '#FFFFFF', '#FFB0E0', '#9FE3E0'];
  function pickAnomaly(r, fromMap) {
    if (!r) return;
    $('an-table').querySelectorAll('tr').forEach(x => x.classList.toggle('sel', +x.dataset.id === r.id));
    if (fromMap) { showTab('anom'); const tr = $('an-table').querySelector(`tr[data-id="${r.id}"]`); if (tr) tr.scrollIntoView({ block: 'nearest' }); }
    marks.highlight(r.id);
    tracks.clear();
    if (r.type === 'conj') {
      r.objects.forEach((o, k) => tracks.showAround(o, o.t, 1, OBJ_COLORS[k], true));
      map.setView([r.lat, r.lon], 8);
    } else if (r.type === 'overlap') {
      r.objects.forEach((o, k) => tracks.showSegment(o, o.t - 20 * 60000, o.t + 20 * 60000, r.lon, OBJ_COLORS[k % OBJ_COLORS.length], true));
      map.setView([r.lat, r.lon], 11);
    } else {
      const [s, n, w, e] = r.cell;
      map.fitBounds([[s, w], [n, e]], { padding: [80, 80], maxZoom: 12 });
      r.objects.slice(0, 5).forEach((o, k) => tracks.showSegment(o, o.t - 10 * 60000, o.t + 10 * 60000, r.lon, OBJ_COLORS[k], true));
    }
    const first = r.objects[0];
    if (first) { selected = first; sky.selected = first; renderObject(); updateObjPassButton(); }
    setTime(r.t, false);
  }

  // ── export ──
  function setExportEnabled(prefix, on) {
    const idBtn = { s: 's-export', an: 'an-export', obj: 'obj-export' }[prefix];
    $(idBtn).disabled = !on;
    document.querySelectorAll(`[data-exp="${prefix}"]`).forEach(b => { b.disabled = !on; });
  }
  const stamp = () => { const p = F.parts(Date.now()); return `${p.Y}${F.pad(p.M)}${F.pad(p.D)}-${F.pad(p.h)}${F.pad(p.m)}`; };
  async function save(kind, fmt, name, csvData, kmlData) {
    const filters = fmt === 'csv' ? [{ name: 'CSV (Excel)', extensions: ['csv'] }] : fmt === 'kml' ? [{ name: 'KML', extensions: ['kml'] }] : [{ name: 'KMZ', extensions: ['kmz'] }];
    const content = fmt === 'csv' ? csvData() : kmlData();
    const path = await saver({ title: t('exp.title'), defaultName: `${name}-${stamp()}.${fmt}`, filters, content, bom: fmt === 'csv', csvSep: I.lang === 'ru' ? ';' : ',' });
    if (path) flash(t('exp.saved', { path }));
  }
  let saver = (opts) => api.saveFile(opts);
  function flash(text) { const h = $('map-hint'); h.textContent = text; h.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => { h.hidden = true; }, 4000); }
  const tzNote = () => F.tz === 'utc' ? t('exp.tz.utc') : t('exp.tz.local', { zone: F.zone(Date.now()) });
  const csv = (header, rows) => X.csv(header, rows, I.lang === 'ru' ? ';' : ',');
  const styles = X.style('area', '#F2C46D', 1) + X.style('in', '#6EE7A8', 0.9) + X.style('out', '#FF7A66', 0.9) +
    X.style('track', '#FFE08A', 1) + X.style('density', '#FF7A66', 1.1) + X.style('overlap', '#6FD3FF', 1.1) + X.style('conj', '#B99BFF', 1.2) +
    OBJ_COLORS.map((c, k) => X.style('obj' + k, c, 0.8)).join('');
  const areaPm = (rect) => rect ? X.placemark({ name: t('exp.area'), styleId: 'area', geom: X.polygonRect(rect.s, rect.n, rect.w, rect.e),
    desc: X.table([[t('pass.n'), rect.n.toFixed(6)], [t('pass.s'), rect.s.toFixed(6)], [t('pass.w'), Z.normLon(rect.w).toFixed(6)], [t('pass.e'), Z.normLon(rect.e).toFixed(6)]]) }) : '';
  const passPms = (o, p, rect, label) => {
    const seg = tracks.path(o, p.tIn, p.tOut, Math.max(50, (p.tOut - p.tIn) / 60), (rect.w + rect.e) / 2);
    const nm = objName(o);
    const info = X.table([[t('exp.object'), nm], [t('exp.in'), `${F.dt(p.tIn)} (${X.iso(p.tIn)})`], [t('exp.out'), `${F.dt(p.tOut)} (${X.iso(p.tOut)})`],
      [t('exp.dur'), F.dur(p.tOut - p.tIn)], [t('exp.lat'), p.lat.toFixed(6) + '°']]);
    let out = '';
    if (seg.length > 1) out += X.placemark({ name: `${label}${nm}`, desc: info, styleId: 'track', t0: p.tIn, t1: p.tOut, geom: X.lineString(seg) });
    if (seg.length) {
      out += X.placemark({ name: t('track.in', { t: F.time(p.tIn) }), styleId: 'in', t0: p.tIn, geom: X.point(seg[0][0], seg[0][1]), desc: info });
      out += X.placemark({ name: t('track.out', { t: F.time(p.tOut) }), styleId: 'out', t0: p.tOut, geom: X.point(seg[seg.length - 1][0], seg[seg.length - 1][1]), desc: info });
    }
    return out;
  };

  $('s-export').onclick = () => exportSearch('csv');
  $('obj-export').onclick = () => exportObj('csv');
  $('an-export').onclick = () => exportAnom('csv');
  document.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => ({ s: exportSearch, obj: exportObj, an: exportAnom })[b.dataset.exp](b.dataset.fmt));

  function exportSearch(fmt) {
    if (!searchRows.length) return;
    const { rect, t0, t1 } = searchCtx;
    save('s', fmt, t('exp.file.passes'), () => csv(
      [t('exp.object'), t('exp.catalog'), t('exp.mag'), t('exp.firstIn'), t('exp.out'), t('exp.inUtc'), t('exp.outUtc'), t('exp.durS'), t('exp.lat'), t('exp.count')],
      searchRows.map(r => {
        const o = rowObj(r);
        return [objName(o), o.kind === 'star' ? cat.catalogId(o.idx) : t('exp.solar'), r.mag, F.dt(r.first.tIn), F.dt(r.first.tOut),
          X.iso(r.first.tIn), X.iso(r.first.tOut), +((r.first.tOut - r.first.tIn) / 1000).toFixed(3), +r.first.lat.toFixed(7), r.count];
      })), () => X.doc(t('exp.passesDoc'), `${F.dt(t0)} — ${F.dt(t1)}, ${tzNote()}`, styles + areaPm(rect) +
        X.folder(t('exp.firstPasses'), searchRows.slice(0, 1500).filter(r => !r.first.always).map(r => passPms(rowObj(r), r.first, rect, '')).join(''))));
  }
  function exportObj(fmt) {
    if (!objPasses.length) return;
    const { rect, obj } = objPasses.ctx;
    const nm = objName(obj);
    save('obj', fmt, `zenit-${nm.replace(/[^\p{L}\d]+/gu, '_')}`, () => csv(
      ['#', t('exp.object'), t('exp.in'), t('exp.out'), t('exp.inUtc'), t('exp.outUtc'), t('exp.durS'), t('exp.lat')],
      objPasses.map((p, k) => [k + 1, nm, F.dt(p.tIn), F.dt(p.tOut), X.iso(p.tIn), X.iso(p.tOut), +((p.tOut - p.tIn) / 1000).toFixed(3), +p.lat.toFixed(7)])),
    () => X.doc(t('exp.objDoc', { name: nm }), tzNote(), styles + areaPm(rect) +
      X.folder(t('exp.passes'), objPasses.slice(0, 2000).filter(p => !p.always).map((p, k) => passPms(obj, p, rect, `#${k + 1} `)).join(''))));
  }
  function exportAnom(fmt) {
    if (!anomRows.length) return;
    const ctx = anomCtx;
    const TYPE = (ty) => t('an.type.' + ty);
    const objList = r => r.objects.map(o => `${objName(o)}${o.kind === 'star' ? ` [${cat.catalogId(o.idx)}]` : ''} — ${F.dt(o.t)}`);
    const periodName = t('period.' + ctx.stats.period);
    const kmlBody = () => {
      const byType = ty => anomRows.filter(r => r.type === ty).slice(0, 3000).map(r => {
        const info = X.table([[t('exp.type'), TYPE(r.type)], [t('exp.point'), `${r.lat.toFixed(6)}°, ${Z.normLon(r.lon).toFixed(6)}°`], [t('exp.when'), r.when], [t('exp.score'), r.score],
          [t('exp.detail'), r.detail], ...objList(r).map((s, k) => [k === 0 ? t('exp.objects') : '', s])]);
        let geom = X.point(r.lat, r.lon);
        if (r.type === 'density') geom = `<MultiGeometry>${geom}${X.polygonRect(r.cell[0], r.cell[1], r.cell[2], r.cell[3])}</MultiGeometry>`;
        let pm = X.placemark({ name: r.title, desc: info, styleId: r.type, t0: r.t, t1: r.tEnd, geom,
          data: { type: r.type, lat: r.lat.toFixed(7), lon: Z.normLon(r.lon).toFixed(7), time_utc: X.iso(r.t), score: r.score } });
        if (r.type === 'conj') {
          // tracks of both objects ±1 h around their passage through the point
          const lines = r.objects.map((o, k) => X.placemark({ name: objName(o), styleId: 'obj' + k, t0: o.t - H, t1: o.t + H,
            geom: X.lineString(tracks.path(o, o.t - H, o.t + H, 2 * 60000, r.lon)) })).join('');
          pm = X.folder(r.title, pm + lines);
        }
        return pm;
      }).join('');
      return X.doc(t('exp.anomDoc', { period: periodName }), `${F.dt(ctx.t0)} — ${F.dt(ctx.t1)}, ${tzNote()}`,
        styles + (ctx.region ? areaPm(ctx.region) : '') +
        X.folder(t('exp.f.conj'), byType('conj')) + X.folder(t('exp.f.overlap'), byType('overlap')) + X.folder(t('exp.f.density'), byType('density')));
    };
    save('an', fmt, `${t('exp.file.anom')}-${ctx.stats.period}`, () => csv(
      ['#', t('exp.type'), t('exp.latC'), t('exp.lonC'), t('exp.time'), t('exp.timeUtc'), t('exp.end'), t('exp.titleC'), t('exp.score'), t('exp.detail'), t('exp.objects')],
      anomRows.map(r => [r.id, TYPE(r.type), +r.lat.toFixed(7), +Z.normLon(r.lon).toFixed(7), F.dt(r.t), X.iso(r.t), F.dt(r.tEnd), r.title, r.score, r.detail, objList(r).join(' | ')])),
    kmlBody);
  }

  // ── settings ──
  $('st-lang').value = I.lang;
  $('st-lang').onchange = async () => {
    await api.setSettings({ lang: $('st-lang').value });
    api.relaunch();
  };
  $('st-tz').value = F.tz;
  $('st-tz').onchange = async () => {
    F.tz = $('st-tz').value; settings = await api.setSettings({ tz: F.tz });
    const per = period();
    lastClock = 0;
    if (per) { $('p-from').value = F.input(per.t0); $('p-to').value = F.input(per.t1); }
    if (searchRows.length) renderSearch();
    if (anomRows.length) { anomRows = anomRows.map(r => ({ ...r, ...describe(r) })); renderAnomalies(); marks.set(anomRows); }
  };
  $('st-dut1').value = settings.dut1 || 0;
  $('st-dut1').onchange = async () => {
    const v = Math.max(-0.9, Math.min(0.9, +$('st-dut1').value || 0));
    $('st-dut1').value = v; Z.setDut1(v); worker.postMessage({ type: 'dut1', value: v });
    settings = await api.setSettings({ dut1: v }); sky.invalidate();
  };
  $('st-offline').checked = !!settings.offline;
  $('st-offline').onchange = async () => { settings = await api.setSettings({ offline: $('st-offline').checked }); };
  const cacheText = s => t('set.cache', { mb: (s.bytes / 1048576).toFixed(1), n: num(s.files) });
  const refreshCache = async () => { $('st-cache').textContent = cacheText(await api.cacheStats()); };
  $('st-cache-open').onclick = () => api.cacheOpen();
  $('st-cache-clear').onclick = async () => { $('st-cache').textContent = cacheText(await api.cacheClear()); };
  document.querySelector('[data-tab="set"]').addEventListener('click', refreshCache);
  api.info().then(i => { $('st-version').textContent = t('set.version', { v: i.version, dir: i.userData }); });

  window.__zenit = { map, sky, cat, select, setTime, now, area, request, tracks, setSaver: (fn) => { saver = fn; } }; // debugging and tests
})();
