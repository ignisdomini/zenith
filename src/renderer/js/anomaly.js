/*
 * Аномальные точки пересечений зенитов (Web Worker, подключается из search-worker.js).
 *
 * Трасса зенита звезды — параллель φ = δ, которую подзвёздная точка проходит на запад со скоростью
 * ω = 360,9856°/сут. Две звёздные трассы не пересекаются, а совпадают при равных склонениях.
 * Трассы Солнца, Луны и планет — кривые, они пересекают параллели звёзд и друг друга.
 * Поэтому за период [t₀, t₀ + P] ищутся три вида аномалий.
 *
 * 1. Сгущения. Земля делится на ячейки. Для каждой звезды известна дуга трассы длиной L = ω·P, для ячейки —
 *    число проходов зенитов через её центр n. Ожидание при равномерном небе с тем же числом звёзд Nₜ:
 *      E = Nₜ · (sin φ₂ − sin φ₁)/2 · L/360°,
 *    оценка z = (n − E)/√E (Пуассон). Второй вариант базы — средняя по той же широте
 *    (выявляет долготную неравномерность, осмысленна при P < звёздных суток).
 *
 * 2. Совпадения трасс. Звёзды, чьи видимые склонения в середине периода укладываются в допуск,
 *    а дуги трасс за период перекрываются: через общую точку за период проходят зениты всех звёзд группы.
 *    Точка — зенит «ведущей» звезды группы: остальные приходят в неё следом за время Δα/ω.
 *
 * 3. Пересечения со светилами. Трасса светила семплируется по таблице эфемерид (α, δ, расстояние на истинный
 *    экватор даты — через 1 ч для Луны и 6 ч для прочих, между узлами кубическая интерполяция).
 *    Светило × звезда: светило пересекает параллель δ* в момент t в точке λ; звезда приходит в λ в t + Δλ/ω.
 *    Светило × светило: точка пересечения трасс — решение системы φa(t) = φb(u), λa(t) = λb(u) методом Ньютона.
 *    Аномалия — если оба объекта проходят точку в пределах окна |u − t| ≤ Δt.
 */
(function (root) {
  'use strict';
  const Z = root.ZAstro, A = root.Astronomy;

  function inRegion(R, lat, lon) {
    return lat >= R.S && lat <= R.N && (R.full || Z.norm360(lon - R.W) <= R.Wd);
  }

  /** Таблица видимых α, δ, расстояния светила; значения — кубическая интерполяция Катмулла — Рома. */
  function BodyEphem(key, t0, t1, stepMs) {
    const start = t0 - 2 * stepMs, n = Math.ceil((t1 - start) / stepMs) + 4;
    const ra = new Float64Array(n), dec = new Float64Array(n), dist = new Float64Array(n);
    let prev = null;
    const o = {};
    for (let i = 0; i < n; i++) {
      Z.bodyZenith(key, start + i * stepMs, o);
      let r = o.ra;
      if (prev != null) { while (r - prev > 180) r -= 360; while (prev - r > 180) r += 360; }
      ra[i] = r; dec[i] = o.dec; dist[i] = o.distKm; prev = r;
    }
    const cr = (arr, i, f) => {
      const p0 = arr[i - 1], p1 = arr[i], p2 = arr[i + 1], p3 = arr[i + 2];
      return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
    };
    const out = {};
    return {
      /** Точка зенита в момент t: долгота = α − GAST, широта — на эллипсоиде по δ и расстоянию. */
      at(t, gast) {
        const x = (t - start) / stepMs;
        let i = Math.floor(x); if (i < 1) i = 1; if (i > n - 3) i = n - 3;
        const f = x - i;
        const a = cr(ra, i, f), d = cr(dec, i, f), r = cr(dist, i, f);
        const cd = Math.cos(d * Z.D2R);
        Z.zenithOnEllipsoid(r * cd, 0, r * Math.sin(d * Z.D2R), out);
        out.lon = Z.normLon(a - gast);
        out.ra = Z.norm360(a); out.dec = d;
        return out;
      },
    };
  }

  /** P(X ≥ n), X ~ Пуассон(μ): прямой суммой хвоста — точно и при очень малых вероятностях. */
  function poissonSf(n, mu) {
    if (n <= 0) return 1;
    if (mu <= 0) return 0;
    if (mu > n + 30) return 1;
    let lt = -mu + n * Math.log(mu);
    for (let i = 2; i <= n; i++) lt -= Math.log(i);
    let term = Math.exp(lt), sum = 0;
    for (let i = n; i < n + 200; i++) {
      sum += term;
      term *= mu / (i + 1);
      if (term < sum * 1e-12) break;
    }
    return Math.min(1, sum);
  }
  function upper(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const md = (lo + hi) >> 1; if (arr[md] <= v) lo = md + 1; else hi = md; } return lo; }

  function periodLabel(ms) {
    const h = ms / 3600000;
    return h <= 1.01 ? 'hour' : h <= 24.1 ? 'day' : h <= 170 ? 'week' : h <= 745 ? 'month' : 'year';
  }

  async function run(m, cat, R, post) {
    const t0 = m.t0, P = m.periodMs, t1 = t0 + P;
    const tmid = t0 + P / 2;
    const tab = Z.FrameTable(t0, t1);
    const L = Z.EARTH_DEG_PER_MS * P;            // длина дуги трассы звезды за период, °
    const omega = Z.EARTH_DEG_PER_MS;
    const cancelled = () => m.isCancelled();
    const rows = [];
    let heat = null;
    const stats = { period: periodLabel(P), L };
    const o = {};
    // tab.at() отдаёт один и тот же объект — снимаем копии кадров
    const copyFrame = (f) => ({ ...f, m: Float64Array.from(f.m) });
    const frMid = copyFrame(tab.at(tmid)), fr0copy = copyFrame(tab.at(t0));

    const magRaw = Math.round(m.magMax * 1000);
    const years = Math.abs(tmid - Z.J2000_MS) / (365.25 * Z.MS_DAY);
    const margin = 32 / 3600 * years + 0.05;

    // ── 1. сгущения ──
    if (m.density) {
      post({ stage: 'an.stage.density', done: 0, total: 1 });
      let cellLat, cellLon, rows_, cols;
      if (R.full && R.S <= -89.9 && R.N >= 89.9) {
        cellLat = cellLon = m.cell; rows_ = Math.round(180 / m.cell); cols = Math.round(360 / m.cell);
      } else {
        rows_ = Math.max(10, Math.min(400, Math.round((R.N - R.S) / m.cell)));
        cols = Math.max(10, Math.min(400, Math.round(R.Wd / m.cell)));
        cellLat = (R.N - R.S) / rows_; cellLon = R.Wd / cols;
      }
      const S0 = (R.full && R.S <= -89.9) ? -90 : R.S;
      const cnt = new Float64Array(rows_ * (cols + 1));
      const flux = new Float64Array(rows_ * (cols + 1));
      const fullRot = new Float64Array(rows_), fullFlux = new Float64Array(rows_);
      const fullRots = Math.floor(L / 360), rem = L - fullRots * 360;
      let nTot = 0;
      const total = cat.count;
      let lastPost = Date.now();
      for (let c = 0; c < 64800; c++) {
        for (let i = cat.offsets[c]; i < cat.offsets[c + 1]; i++) {
          if (cat.i16[i * 16 + 8] > magRaw) break;
          nTot++;
          const d0 = cat.i32[i * 8 + 1] / 1e7;
          if (d0 < S0 - margin || d0 > S0 + rows_ * cellLat + margin) continue;
          const ra = cat.u32[i * 8] / 1e7, pmra = cat.f32[i * 8 + 2], pmdec = cat.f32[i * 8 + 3];
          Z.starApparent(frMid, ra, d0, pmra, pmdec, o);
          const r = Math.floor((o.dec - S0) / cellLat);
          if (r < 0 || r >= rows_) continue;
          Z.starApparent(fr0copy, ra, d0, pmra, pmdec, o);
          const x0 = Z.norm360(Z.normLon(o.ra - fr0copy.gast) - (R.full ? -180 : R.W));
          const w = Math.pow(10, -0.4 * (cat.i16[i * 16 + 8] / 1000));
          if (fullRots) { fullRot[r] += fullRots; fullFlux[r] += fullRots * w; }
          if (rem > 0) {
            const a = x0 - rem, base = r * (cols + 1);
            for (const sh of [-360, 0, 360]) {
              const j0 = Math.max(0, Math.ceil((a + sh) / cellLon - 0.5));
              const j1 = Math.min(cols - 1, Math.floor((x0 + sh) / cellLon - 0.5));
              if (j0 > j1) continue;
              cnt[base + j0] += 1; cnt[base + j1 + 1] -= 1;
              flux[base + j0] += w; flux[base + j1 + 1] -= w;
            }
          }
        }
        if (Date.now() - lastPost > 200) {
          post({ stage: 'an.stage.density', done: cat.offsets[c + 1], total });
          await new Promise(r => setTimeout(r, 0));
          if (cancelled()) return null;
          lastPost = Date.now();
        }
      }
      const west = R.full ? -180 : R.W;
      const cells = [];
      const heatArr = [];
      let maxZ = 0;
      for (let r = 0; r < rows_; r++) {
        const base = r * (cols + 1);
        const lat1 = S0 + r * cellLat, lat2 = lat1 + cellLat;
        let run = 0, runF = 0, sum = 0;
        const obs = new Float64Array(cols), fl = new Float64Array(cols);
        for (let j = 0; j < cols; j++) {
          run += cnt[base + j]; runF += flux[base + j];
          obs[j] = run + fullRot[r]; fl[j] = runF + fullFlux[r]; sum += obs[j];
        }
        const expU = nTot * (Math.sin(lat2 * Z.D2R) - Math.sin(lat1 * Z.D2R)) / 2 * (L / 360);
        const expRow = sum / cols;
        const exp = m.base === 'row' ? expRow : expU;
        if (!(exp > 1e-9)) continue;
        const sq = Math.sqrt(exp);
        // соседние аномальные ячейки одной широты объединяются в отрезок (при P ≥ звёздных суток — вся полоса)
        const segs = [];
        let seg = null;
        for (let j = 0; j < cols; j++) {
          const z = (obs[j] - exp) / sq;
          if (z >= m.zThr && obs[j] >= 3) {
            const lon1 = west + j * cellLon;
            heatArr.push(lat1, lat2, lon1, lon1 + cellLon, z);
            if (z > maxZ) maxZ = z;
            if (!seg) { seg = { j0: j, j1: j, best: j, z }; segs.push(seg); }
            else { seg.j1 = j; if (z > seg.z) { seg.z = z; seg.best = j; } }
          } else seg = null;
        }
        const wholeWorld = R.full || cols * cellLon >= 359.999;
        if (wholeWorld && segs.length > 1 && segs[0].j0 === 0 && segs[segs.length - 1].j1 === cols - 1) {
          const last = segs.pop(), f = segs[0];
          f.j0 = last.j0 - cols; if (last.z > f.z) { f.z = last.z; f.best = last.best; }
        }
        for (const s of segs) {
          cells.push({
            lat1, lat2, lon1: west + s.j0 * cellLon, lon2: west + (s.j1 + 1) * cellLon, lonBest: west + (s.best + 0.5) * cellLon,
            z: s.z, obs: obs[s.best], exp, flux: fl[s.best], width: (s.j1 - s.j0 + 1) * cellLon,
          });
        }
      }
      stats.density = { cells: cells.length, rows: rows_, cols, nTot, cellLat, cellLon };
      heat = { cells: Float32Array.from(heatArr.slice(0, 5 * 80000)), maxZ, zThr: m.zThr };
      cells.sort((a, b) => b.z - a.z);
      // вклад звёзд для верхних ячеек: ярчайшие звёзды, чьи трассы прошли через центр ячейки
      const top = cells.slice(0, 400);
      for (let k = 0; k < top.length; k++) {
        const cl = top[k];
        const latC = (cl.lat1 + cl.lat2) / 2, lonC = Z.normLon(cl.lonBest);
        const contrib = [];
        if (k < 60) {
          cat.forCells(cl.lat1 - margin, cl.lat2 + margin, 0, 360, (a, b) => {
            for (let i = a; i < b; i++) {
              if (cat.i16[i * 16 + 8] > magRaw) break;
              Z.starApparent(frMid, cat.ra(i), cat.dec(i), cat.pmra(i), cat.pmdec(i), o);
              if (o.dec < cl.lat1 || o.dec >= cl.lat2) continue;
              Z.starApparent(fr0copy, cat.ra(i), cat.dec(i), cat.pmra(i), cat.pmdec(i), o);
              const back = Z.norm360(Z.normLon(o.ra - fr0copy.gast) - lonC); // сколько градусов до центра ячейки
              if (back > L) continue;
              contrib.push({ idx: i, mag: cat.mag(i), t: t0 + back / omega });
            }
          });
          contrib.sort((a, b) => a.mag - b.mag);
        }
        const firstT = contrib.length ? Math.min(...contrib.map(c => c.t)) : t0;
        rows.push({
          type: 'density', lat: latC, lon: lonC, cell: [cl.lat1, cl.lat2, cl.lon1, cl.lon2],
          t: firstT, tEnd: t1, z: cl.z, obs: cl.obs, exp: cl.exp, flux: cl.flux, width: cl.width,
          objects: contrib.slice(0, 8).map(c => ({ kind: 'star', idx: c.idx, t: c.t })),
          sort: -cl.z,
        });
      }
    }
    if (cancelled()) return null;

    // ── 2. совпадения трасс ──
    if (m.overlap) {
      post({ stage: 'an.stage.overlap', done: 0, total: 1 });
      const tol = m.tolArcsec / 3600;
      const list = [];
      cat.forCells(R.S - margin, R.N + margin, 0, 360, (a, b) => {
        for (let i = a; i < b; i++) {
          if (cat.i16[i * 16 + 8] > magRaw) break;
          Z.starApparent(frMid, cat.ra(i), cat.dec(i), cat.pmra(i), cat.pmdec(i), o);
          if (o.dec < R.S || o.dec > R.N) continue;
          list.push([o.dec, o.ra, i]);
        }
      });
      list.sort((p, q) => p[0] - q[0]);
      const groups = [];
      let lastK = -1;
      for (let i = 0, k = 0; i < list.length; i++) {
        if (k < i) k = i;
        while (k + 1 < list.length && list[k + 1][0] - list[i][0] <= tol) k++;
        if (k - i + 1 >= 2 && k > lastK) { groups.push(list.slice(i, k + 1)); lastK = k; }
      }
      const sep = (p, q) => { // угловое расстояние, ″
        const d1 = p[0] * Z.D2R, d2 = q[0] * Z.D2R, da = (p[1] - q[1]) * Z.D2R;
        const s = Math.sin((d2 - d1) / 2) ** 2 + Math.cos(d1) * Math.cos(d2) * Math.sin(da / 2) ** 2;
        return 2 * Math.asin(Math.min(1, Math.sqrt(s))) * Z.R2D * 3600;
      };
      const decSorted = Float64Array.from(list.map(s => s[0]));
      const countIn = (a, b) => upper(decSorted, b) - upper(decSorted, a);
      let found = 0, chance = 0;
      for (let g of groups) {
        if (m.noDouble) {
          g = g.slice().sort((p, q) => cat.mag(p[2]) - cat.mag(q[2]));
          const keep = [];
          for (const s of g) if (!keep.some(k => sep(k, s) < 60)) keep.push(s);
          g = keep;
        }
        if (g.length < m.minGroup) continue;
        // значимость: сколько таких групп дало бы случайное небо той же плотности.
        // Число соседей звезды в окне допуска ~ Пуассон(μ), μ = ρ·tol, ρ — звёзд на секунду склонения рядом (±0,5°).
        const decMean = g.reduce((s, v) => s + v[0], 0) / g.length;
        const rho = countIn(decMean - 0.5, decMean + 0.5) / 3600;
        const E = list.length * poissonSf(g.length - 1, rho * m.tolArcsec);
        if (E > m.maxExpected) { chance++; continue; }
        // ведущая звезда: следующая за наибольшим разрывом по α
        const byRa = g.slice().sort((p, q) => p[1] - q[1]);
        let gap = -1, lead = 0;
        for (let k = 0; k < byRa.length; k++) {
          const nx = byRa[(k + 1) % byRa.length];
          const dg = Z.norm360(nx[1] - byRa[k][1]) || (byRa.length === 1 ? 360 : 0);
          if (dg > gap) { gap = dg; lead = (k + 1) % byRa.length; }
        }
        const order = byRa.slice(lead).concat(byRa.slice(0, lead));
        const spanDeg = 360 - gap;                 // за сколько градусов вращения пройдут все звёзды группы
        if (spanDeg > L) continue;                 // все не успеют пройти одну точку за период
        // точка: ведущая звезда в зените в момент t0 + свободный запас (L − span)/2 → вся серия в середине периода
        const slack = (L >= 360 ? Math.min(L, 360) - spanDeg : L - spanDeg) / 2;
        const leadIdx = order[0][2];
        Z.starApparent(fr0copy, cat.ra(leadIdx), cat.dec(leadIdx), cat.pmra(leadIdx), cat.pmdec(leadIdx), o);
        const lonP = Z.normLon(o.ra - fr0copy.gast - slack);
        const decs = g.map(s => s[0]);
        const latP = decs.reduce((s, v) => s + v, 0) / decs.length;
        if (!inRegion(R, latP, lonP)) continue;
        const tLead = t0 + slack / omega;
        const objects = order.map(s => ({ kind: 'star', idx: s[2], t: tLead + Z.norm360(s[1] - order[0][1]) / omega, dec: s[0] }));
        const spread = (Math.max(...decs) - Math.min(...decs)) * 3600;
        const bright = objects.reduce((s, ob) => s + Math.pow(10, -0.4 * cat.mag(ob.idx)), 0);
        rows.push({
          type: 'overlap', lat: latP, lon: lonP, t: objects[0].t, tEnd: objects[objects.length - 1].t,
          size: g.length, spread, bright, objects, expected: E,
          sort: Math.log10(Math.max(E, 1e-300)),
        });
        if (++found >= 3000) break;
      }
      stats.overlap = { stars: list.length, groups: found, chance };
    }
    if (cancelled()) return null;

    // ── 3. пересечения со светилами ──
    if (m.conj) {
      const keys = Z.BODIES.map(b => b.key);
      const ephem = {};
      const tolMs = m.dtMin * 60000;
      for (let k = 0; k < keys.length; k++) {
        post({ stage: 'an.stage.ephem', done: k, total: keys.length });
        ephem[keys[k]] = BodyEphem(keys[k], t0 - 2 * tolMs, t1 + 2 * tolMs, keys[k] === 'Moon' ? 3600000 : 6 * 3600000);
        if (cancelled()) return null;
      }
      const stepFor = key => Math.min(P / 40, key === 'Moon' ? 5 * 60000 : 30 * 60000);
      const cmagRaw = Math.round(m.cmag * 1000);
      const bright = [];
      cat.forCells(-90, 90, 0, 360, (a, b) => {
        for (let i = a; i < b; i++) {
          if (cat.i16[i * 16 + 8] > cmagRaw) break;
          Z.starApparent(frMid, cat.ra(i), cat.dec(i), cat.pmra(i), cat.pmdec(i), o);
          bright.push([o.dec, o.ra, i]);
        }
      });
      bright.sort((p, q) => p[0] - q[0]);
      const decArr = Float64Array.from(bright.map(b => b[0]));
      const lower = (v) => { let lo = 0, hi = decArr.length; while (lo < hi) { const md = (lo + hi) >> 1; if (decArr[md] < v) lo = md + 1; else hi = md; } return lo; };
      const zAt = (key, t) => ({ ...ephem[key].at(t, tab.gast(t)) });
      let nConj = 0;

      for (let k = 0; k < keys.length; k++) {
        const key = keys[k], step = stepFor(key);
        post({ stage: 'an.stage.conj', body: key, done: k, total: keys.length });
        await new Promise(r => setTimeout(r, 0));
        if (cancelled()) return null;
        let pa = zAt(key, t0);
        for (let ta = t0; ta < t1; ta += step) {
          const tb = Math.min(t1, ta + step);
          const pb = zAt(key, tb);
          const lo = Math.min(pa.lat, pb.lat), hi = Math.max(pa.lat, pb.lat);
          if (hi > lo) {
            for (let s = lower(lo); s < bright.length && decArr[s] <= hi; s++) {
              const [, , idx] = bright[s];
              // точное пересечение параллели звезды: бисекция по широте светила
              const starDecAt = (t) => Z.starApparent(tab.at(t), cat.ra(idx), cat.dec(idx), cat.pmra(idx), cat.pmdec(idx), o).dec;
              let a = ta, b = tb;
              const fa = ephem[key].at(a, tab.gast(a)).lat - starDecAt(a);
              for (let it = 0; it < 30 && b - a > 20; it++) {
                const mid = (a + b) / 2;
                const fm = ephem[key].at(mid, tab.gast(mid)).lat - starDecAt(mid);
                if ((fm < 0) === (fa < 0)) a = mid; else b = mid;
              }
              const tc = (a + b) / 2;
              const bz = ephem[key].at(tc, tab.gast(tc));
              const sp = Z.starApparent(tab.at(tc), cat.ra(idx), cat.dec(idx), cat.pmra(idx), cat.pmdec(idx), o);
              if (Math.abs(bz.lat - sp.dec) > 0.01) continue; // не пересекла (граница отрезка)
              const starLon = Z.normLon(sp.ra - tab.gast(tc));
              const dt = Z.normLon(starLon - bz.lon) / omega;
              if (Math.abs(dt) > tolMs || !inRegion(R, bz.lat, bz.lon)) continue;
              rows.push({
                type: 'conj', sub: 'star', lat: bz.lat, lon: bz.lon, t: Math.min(tc, tc + dt), tEnd: Math.max(tc, tc + dt), dt,
                objects: [{ kind: 'body', key, t: tc }, { kind: 'star', idx, t: tc + dt }],
                sort: Math.abs(dt) / 60000 + 0.5 * cat.mag(idx),
              });
              nConj++;
            }
          }
          pa = pb;
        }

        if (!m.bodyBody) continue;
        for (let k2 = k + 1; k2 < keys.length; k2++) {
          const key2 = keys[k2], st = Math.min(stepFor(key), stepFor(key2));
          let ga = zAt(key, t0).lat - zAt(key2, t0).lat;
          for (let ta = t0; ta < t1; ta += st) {
            const tb = Math.min(t1, ta + st);
            const gb = zAt(key, tb).lat - zAt(key2, tb).lat;
            if ((ga < 0) !== (gb < 0)) {
              let a = ta, b = tb;
              for (let it = 0; it < 30 && b - a > 20; it++) {
                const mid = (a + b) / 2;
                const gm = zAt(key, mid).lat - zAt(key2, mid).lat;
                if ((gm < 0) === (ga < 0)) a = mid; else b = mid;
              }
              let t = (a + b) / 2;
              const p1 = zAt(key, t), p2 = zAt(key2, t);
              let u = t + Z.normLon(p2.lon - p1.lon) / omega;
              if (Math.abs(u - t) <= tolMs * 3 + st) {
                // Ньютон: φa(t) = φb(u), λa(t) = λb(u)
                for (let it = 0; it < 8; it++) {
                  const A1 = zAt(key, t), B1 = zAt(key2, u), h = 30000;
                  const F1 = A1.lat - B1.lat, F2 = Z.normLon(A1.lon - B1.lon);
                  if (Math.abs(F1) < 1e-7 && Math.abs(F2) < 1e-7) break;
                  const At = zAt(key, t + h), Bu = zAt(key2, u + h);
                  const a11 = (At.lat - A1.lat) / h, a12 = -(Bu.lat - B1.lat) / h;
                  const a21 = Z.normLon(At.lon - A1.lon) / h, a22 = -Z.normLon(Bu.lon - B1.lon) / h;
                  const det = a11 * a22 - a12 * a21;
                  if (Math.abs(det) < 1e-30) break;
                  t -= (F1 * a22 - F2 * a12) / det;
                  u -= (a11 * F2 - a21 * F1) / det;
                }
                const P1 = zAt(key, t), P2 = zAt(key2, u);
                const ok = Math.abs(P1.lat - P2.lat) < 1e-4 && Math.abs(Z.normLon(P1.lon - P2.lon)) < 1e-4;
                if (ok && Math.abs(u - t) <= tolMs && t >= t0 - tolMs && t <= t1 + tolMs && inRegion(R, P1.lat, P1.lon)) {
                  rows.push({
                    type: 'conj', sub: 'body', lat: P1.lat, lon: P1.lon, t: Math.min(t, u), tEnd: Math.max(t, u), dt: u - t,
                    objects: [{ kind: 'body', key, t }, { kind: 'body', key: key2, t: u }],
                    sort: Math.abs(u - t) / 60000 - 5,
                  });
                  nConj++;
                }
              }
            }
            ga = gb;
          }
        }
      }
      stats.conj = { bright: bright.length, found: nConj };
    }

    const order = { conj: 0, overlap: 1, density: 2 };
    rows.sort((a, b) => order[a.type] - order[b.type] || a.sort - b.sort);
    rows.forEach((r, i) => { r.id = i + 1; });
    return { rows, heat, stats, t0, t1 };
  }

  root.ZAnomaly = { run };
})(self);
