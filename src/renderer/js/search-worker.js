/*
 * Поиск проходов зенита через участок местности (Web Worker).
 *
 * Участок — «прямоугольник» в географических координатах: широты [S, N], долготы от W на восток на ширину Wd.
 *
 * Звезда. Её подзвёздная точка идёт по параллели φ = δ(t) на запад со скоростью Земли ω = 360,9856°/сут;
 * δ(t) меняется медленно (аберрация ≤ 20,5″ за полгода, прецессия ≤ 20″/год). Поэтому:
 *   1) отбор по J2000-склонению с запасом (сеточный индекс каталога);
 *   2) склонение на дату — через каждые 10 суток; звезда, ни разу не подошедшая к полосе ближе 5″, отбрасывается;
 *   3) моменты прохода над средней долготой участка C: t = t₀ + [(λ(t₀) − C) mod 360°] / ω, далее через звёздные
 *      сутки с уточнением; вход t − (Wd/2)/ω через восточный край, выход t + (Wd/2)/ω через западный.
 *      Проход засчитывается, если δ(t) ∈ [S, N].
 *
 * Солнце, Луна, планеты: склонение Луны меняется до 0,3°/ч, поэтому след над участком не параллель.
 * Для каждого прохода над средней долготой берётся окно пересечения, трасса семплируется,
 * границы входа/выхода уточняются бисекцией по функции «точка внутри участка».
 */
importScripts('../../../node_modules/astronomy-engine/astronomy.browser.min.js', 'astro.js', 'catalog.js', 'anomaly.js');
const Z = self.ZAstro;
let cat = null;
let cancelId = 0;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      cat = self.ZCatalog.fromBuffer(m.buffer, null);
      Z.setDut1(m.dut1 || 0);
      postMessage({ type: 'ready', count: cat.count });
    } else if (m.type === 'dut1') {
      Z.setDut1(m.value);
    } else if (m.type === 'cancel') {
      cancelId = m.id;
    } else if (m.type === 'search') {
      postMessage({ type: 'result', id: m.id, ...(await search(m)) });
    } else if (m.type === 'passes') {
      postMessage({ type: 'passes', id: m.id, ...passesOf(m) });
    } else if (m.type === 'anomalies') {
      const R = m.region ? normRect(m.region) : normRect({ s: -90, n: 90, w: -180, e: 180 });
      m.isCancelled = () => cancelId === m.id;
      const res = await self.ZAnomaly.run(m, cat, R, (p) => postMessage({ type: 'progress', id: m.id, ...p }));
      postMessage({ type: 'anomalies', id: m.id, cancelled: !res, ...(res || {}) });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
  }
};

/** Нормализованный участок: W ∈ [−180, 180), ширина Wd ∈ (0, 360]. */
function normRect(r) {
  const S = Math.max(-90, Math.min(r.s, r.n)), N = Math.min(90, Math.max(r.s, r.n));
  let Wd = r.e - r.w;
  if (Wd <= 0) Wd += 360;
  if (Wd > 360) Wd = 360;
  const W = Z.normLon(r.w);
  return { S, N, W, Wd, C: W + Wd / 2, full: Wd >= 359.999 };
}
/** Смещение долготы от западного края на восток, [0, 360). */
const eastOf = (lon, W) => Z.norm360(lon - W);

const DEC_STEP_MS = 10 * Z.MS_DAY;
const DEC_MARGIN = 5 / 3600;
const EPS = 1e-9;

function starPos(tab, i, t, o) {
  return Z.starApparent(tab.at(t), cat.ra(i), cat.dec(i), cat.pmra(i), cat.pmdec(i), o);
}

/**
 * Проходы звезды i над участком в [t0, t1]. mode: 'first' — первый проход и число проходов, 'all' — список.
 */
function starPasses(tab, i, R, t0, t1, mode, limit) {
  const o = {};
  // склонение по узлам — отбор
  const n = Math.max(1, Math.ceil((t1 - t0) / DEC_STEP_MS));
  let near = false, allInside = true;
  for (let k = 0; k <= n; k++) {
    const t = Math.min(t1, t0 + k * DEC_STEP_MS);
    const d = starPos(tab, i, t, o).dec;
    if (d >= R.S - DEC_MARGIN && d <= R.N + DEC_MARGIN) near = true;
    if (!(d >= R.S + DEC_MARGIN && d <= R.N - DEC_MARGIN)) allInside = false;
  }
  if (!near) return null;
  const P = Z.SIDEREAL_DAY_MS, omega = Z.EARTH_DEG_PER_MS, half = R.Wd / 2 / omega;

  if (R.full) { // участок во всю ширину: звезда в полосе постоянно, проход = всё время в полосе
    return allInside ? { first: { tIn: t0, tOut: t1, tc: t0, lat: starPos(tab, i, t0, o).dec, lon: null, always: true }, count: 1 } : null;
  }

  // первый момент над средней долготой, чей выход после t0
  starPos(tab, i, t0, o);
  let tc = t0 + Z.norm360(Z.normLon(o.ra - tab.gast(t0)) - R.C) / omega;
  if (tc - P + half > t0) tc -= P;
  const refine = (t) => {
    for (let k = 0; k < 2; k++) {
      starPos(tab, i, t, o);
      t += Z.normLon(Z.normLon(o.ra - tab.gast(t)) - R.C) / omega;
    }
    starPos(tab, i, t, o);
    return t;
  };

  if (allInside && mode === 'first') {
    const t = refine(tc);
    const count = Math.max(0, Math.floor((t1 + half - t) / P) + 1);
    return { first: { tIn: t - half, tOut: t + half, tc: t, lat: o.dec, lon: R.C }, count };
  }

  let first = null, count = 0;
  const list = mode === 'all' ? [] : null;
  for (let t = tc; t - half < t1; t += P) {
    const tr = refine(t);
    if (tr + half <= t0 || tr - half >= t1) continue;
    if (o.dec < R.S || o.dec > R.N) continue;
    const pass = { tIn: tr - half, tOut: tr + half, tc: tr, lat: o.dec, lon: R.C };
    if (!first) first = pass;
    count++;
    if (list) { list.push(pass); if (list.length >= limit) break; }
  }
  if (!count) return null;
  return list ? { passes: list, count } : { first, count };
}

// ── Солнце, Луна, планеты ──

function bodyPasses(key, R, t0, t1, limit, cancelled) {
  const o = {};
  const at = (t) => Z.bodyZenith(key, t, o);
  const inside = (t) => {
    at(t);
    return o.lat >= R.S && o.lat <= R.N && (R.full || eastOf(o.lon, R.W) <= R.Wd);
  };
  const out = [];

  if (R.full) { // полоса широт во всю ширину — ищем входы/выходы по широте каждые 30 мин
    const step = 30 * 60000;
    let prev = inside(t0), start = prev ? t0 : null;
    for (let t = t0 + step; t <= t1 + step && out.length < limit; t += step) {
      const tt = Math.min(t, t1), cur = inside(tt);
      if (cur !== prev) {
        const edge = bisect(inside, tt - step, tt, prev);
        if (cur) start = edge; else { out.push(mkBodyPass(key, start, edge)); start = null; }
      }
      prev = cur;
      if (tt >= t1) break;
    }
    if (start != null) out.push(mkBodyPass(key, start, t1));
    return out;
  }

  const lonAt = (t) => at(t).lon;
  // скорость долготы светила, °/мс (отрицательная — на запад)
  const rate = (t) => Z.normLon(lonAt(t + 600000) - lonAt(t - 600000)) / 1200000;
  let t = t0 - Z.MS_DAY;
  let guard = 0;
  while (t < t1 + Z.MS_DAY && out.length < limit && guard++ < 100000) {
    if (cancelled()) break;
    // ближайший момент над средней долготой после t
    let w = -rate(t);
    let tc = t + Z.norm360(lonAt(t) - R.C) / w;
    for (let k = 0; k < 4; k++) {
      const dl = Z.normLon(lonAt(tc) - R.C);
      tc += dl / w;
      if (Math.abs(dl) < 1e-7) break;
    }
    w = -rate(tc);
    const lat = at(tc).lat;
    const latRate = Math.abs(at(tc + 600000).lat - at(tc - 600000).lat) / 1200000;
    const h = (R.Wd / 2) / w * 1.25 + 60000;
    const band = latRate * h + 0.01;
    if (lat >= R.S - band && lat <= R.N + band) {
      // окно пересечения: семплируем и уточняем края
      const steps = 160, a = tc - h, b = tc + h;
      let prev = inside(a), start = prev ? a : null;
      for (let s = 1; s <= steps; s++) {
        const ts = a + (b - a) * s / steps, cur = inside(ts);
        if (cur !== prev) {
          const edge = bisect(inside, a + (b - a) * (s - 1) / steps, ts, prev);
          if (cur) start = edge;
          else if (start != null) { pushClipped(out, key, start, edge, t0, t1); start = null; }
        }
        prev = cur;
      }
      if (start != null) pushClipped(out, key, start, b, t0, t1);
    }
    t = tc + Math.max(0.3 * Z.MS_DAY, h * 2);
  }
  return out;
}

function pushClipped(out, key, a, b, t0, t1) {
  if (b <= t0 || a >= t1) return;
  out.push(mkBodyPass(key, a, b));
}
function mkBodyPass(key, tIn, tOut) {
  const tc = (tIn + tOut) / 2;
  const z = Z.bodyZenith(key, tc, {});
  return { tIn, tOut, tc, lat: z.lat, lon: z.lon };
}
/** Граница смены inside() на [a, b] с точностью ~5 мс. */
function bisect(inside, a, b, valA) {
  for (let k = 0; k < 40 && b - a > 5; k++) {
    const m = (a + b) / 2;
    if (inside(m) === valA) a = m; else b = m;
  }
  return (a + b) / 2;
}

// ── запросы ──

async function search(m) {
  const R = normRect(m.rect);
  const t0 = m.t0, t1 = m.t1;
  const tab = Z.FrameTable(t0, t1);
  const results = [];
  const cancelled = () => cancelId === m.id;
  let scanned = 0, total = 0;

  if (m.bodies && m.bodies.length) {
    for (const key of m.bodies) {
      const ps = bodyPasses(key, R, t0, t1, 5000, cancelled);
      if (ps.length) results.push({ kind: 'body', key, name: Z.BODY_BY_KEY[key].name, mag: null, first: ps[0], count: ps.length });
    }
  }

  if (m.stars) {
    const years = Math.max(Math.abs(t0 - Z.J2000_MS), Math.abs(t1 - Z.J2000_MS)) / (365.25 * Z.MS_DAY);
    const margin = 20.1 / 3600 * years + 12 / 3600 * years + 0.02; // прецессия + собственное движение до 12″/год + аберрация/нутация
    const magMax = Math.round(m.magMax * 1000);
    const cells = [];
    cat.forCells(R.S - margin, R.N + margin, 0, 360, (a, b) => { cells.push(a, b); total += b - a; });
    let lastPost = Date.now();
    for (let c = 0; c < cells.length; c += 2) {
      for (let i = cells[c]; i < cells[c + 1]; i++) {
        if (cat.magRaw(i) > magMax) break; // внутри ячейки звёзды отсортированы по блеску
        const d = cat.dec(i);
        if (d < R.S - margin || d > R.N + margin) continue;
        const r = starPasses(tab, i, R, t0, t1, 'first');
        if (r) results.push({ kind: 'star', idx: i, name: null, mag: cat.mag(i), first: r.first, count: r.count });
      }
      scanned += cells[c + 1] - cells[c];
      if (Date.now() - lastPost > 150) {
        postMessage({ type: 'progress', id: m.id, done: scanned, total, found: results.length });
        await new Promise(r => setTimeout(r, 0));
        if (cancelled()) return { cancelled: true, rows: [], totalFound: results.length };
        lastPost = Date.now();
      }
    }
  }

  results.sort((a, b) => a.first.tIn - b.first.tIn);
  const limit = m.limit || 5000;
  return { rows: results.slice(0, limit), totalFound: results.length, rect: R, t0, t1 };
}

function passesOf(m) {
  const R = normRect(m.rect);
  const tab = m.object.kind === 'star' ? Z.FrameTable(m.t0, m.t1) : null;
  if (m.object.kind === 'star') {
    const r = starPasses(tab, m.object.idx, R, m.t0, m.t1, 'all', m.limit || 3000);
    return { passes: r ? (r.passes || [r.first]) : [], count: r ? r.count : 0 };
  }
  const ps = bodyPasses(m.object.key, R, m.t0, m.t1, m.limit || 3000, () => false);
  return { passes: ps, count: ps.length };
}
