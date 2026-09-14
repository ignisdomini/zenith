/*
 * Математика зенитов ЗЕНИТа — развитие модуля «Небесная карта» КАРТОВЕДЪ (SkyMath.kt / SkyBodies.kt).
 *
 * Подзвёздная (подпланетная) точка — место на Земле, где светило в зените:
 *   широта  φ = δ  (видимое склонение на дату; для звезды — геодезическая широта, отвес ⟂ эллипсоиду)
 *   долгота λ = α − GAST, приведённая к (−180°, 180°]
 * GAST растёт на 360,98564736629° за солнечные сутки → точки ползут на запад со скоростью ~0,0041781°/с.
 *
 * Что изменилось против модуля КАРТОВЕДЪ:
 *  • прецессия и нутация — матрицей EQJ→EQD astronomy-engine (IAU 2006 + IAU 2000B, ~1 mas),
 *    а не 4 членами нутации (~0,5″);
 *  • добавлена годичная аберрация (до 20,5″ ≈ 630 м на местности) по барицентрической скорости Земли;
 *  • собственное движение — вектором (корректно у полюсов);
 *  • Солнце, Луна и планеты — VSOP87 / ELP через astronomy-engine с временем света и аберрацией,
 *    и не просто φ = δ: ищется точка эллипсоида WGS-84, чья нормаль смотрит на светило (для Луны это ~1°);
 *  • поправка DUT1 = UT1 − UTC задаётся пользователем (1 с = 15″ долготы ≈ 460 м на экваторе).
 *
 * Не учтено (всё меньше 1″, кроме последнего): суточная аберрация (0,3″), отклонение света Солнцем,
 * движение полюса (~0,3″ ≈ 10 м), уклонение отвеса от нормали эллипсоида (в горах до 30″).
 *
 * Файл — классический скрипт: работает и в окне, и в Web Worker (self.ZAstro). Нужен глобальный Astronomy.
 */
(function (root) {
  'use strict';
  const A = root.Astronomy;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const MS_DAY = 86400000;
  const EARTH_DEG_PER_DAY = 360.98564736629;
  const EARTH_DEG_PER_MS = EARTH_DEG_PER_DAY / MS_DAY;
  const C_AU_PER_DAY = 173.1446326742403;
  const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
  const WGS_A = 6378.137, WGS_F = 1 / 298.257223563, WGS_E2 = WGS_F * (2 - WGS_F);
  const KM_PER_AU = 149597870.691;

  const norm360 = d => ((d % 360) + 360) % 360;
  const normLon = d => { const x = norm360(d); return x > 180 ? x - 360 : x; };

  let dut1 = 0; // секунды UT1 − UTC

  /** Светила — порядок и цвета из SkyBodies.kt; Плутон добавлен. */
  const BODIES = [
    { key: 'Sun', name: 'Солнце', sym: '☉', color: '#FFD23F', r: 9 },
    { key: 'Moon', name: 'Луна', sym: '☾', color: '#E8E8F0', r: 8 },
    { key: 'Mercury', name: 'Меркурий', sym: '☿', color: '#B8B0A8', r: 5.5 },
    { key: 'Venus', name: 'Венера', sym: '♀', color: '#FFF1C1', r: 5.5 },
    { key: 'Mars', name: 'Марс', sym: '♂', color: '#FF7A4D', r: 5.5 },
    { key: 'Jupiter', name: 'Юпитер', sym: '♃', color: '#F0C48A', r: 5.5 },
    { key: 'Saturn', name: 'Сатурн', sym: '♄', color: '#E8D49A', r: 5.5 },
    { key: 'Uranus', name: 'Уран', sym: '♅', color: '#9FE3E0', r: 5 },
    { key: 'Neptune', name: 'Нептун', sym: '♆', color: '#7F9CFF', r: 5 },
    { key: 'Pluto', name: 'Плутон', sym: '♇', color: '#C9A98B', r: 4 },
  ];
  // имя светила — на языке интерфейса (ZI18n), без него — русское из списка
  for (const b of BODIES) {
    const ru = b.name;
    Object.defineProperty(b, 'name', { enumerable: true, get() { return root.ZI18n ? root.ZI18n.t('body.' + this.key) : ru; } });
  }
  const BODY_BY_KEY = Object.fromEntries(BODIES.map(b => [b.key, b]));

  function astroDate(ms) { return new Date(ms + dut1 * 1000); }

  /**
   * Опорные величины момента: GAST (°), матрица EQJ→EQD (по строкам), вектор v/c (EQJ), годы от J2000.
   * Всё, что нужно, чтобы дальше считать звёзды одной арифметикой.
   */
  function frame(ms) {
    const d = astroDate(ms);
    const t = A.MakeTime(d);
    const gast = A.SiderealTime(t) * 15;
    const rot = A.Rotation_EQJ_EQD(t).rot;
    const st = A.BaryState(A.Body.Earth, t);
    return {
      ms, gast,
      years: (ms - J2000_MS) / (365.25 * MS_DAY),
      // строки матрицы: x' = r00·x + r10·y + r20·z (у astronomy-engine столбцовая запись)
      m: [rot[0][0], rot[1][0], rot[2][0], rot[0][1], rot[1][1], rot[2][1], rot[0][2], rot[1][2], rot[2][2]],
      vx: st.vx / C_AU_PER_DAY, vy: st.vy / C_AU_PER_DAY, vz: st.vz / C_AU_PER_DAY,
    };
  }

  /**
   * Видимое место звезды на момент кадра. ra, dec — J2000 (°); pmra = μα·cosδ, pmdec — mas/год.
   * Результат (°) пишется в out.ra / out.dec.
   */
  function starApparent(fr, ra, dec, pmra, pmdec, out) {
    const a = ra * D2R, d = dec * D2R;
    const ca = Math.cos(a), sa = Math.sin(a), cd = Math.cos(d), sd = Math.sin(d);
    let x = cd * ca, y = cd * sa, z = sd;
    if (pmra !== 0 || pmdec !== 0) {
      const k = fr.years / 3.6e6 * D2R; // mas → рад за прошедшие годы
      const pa = pmra * k, pd = pmdec * k;
      x += -sa * pa - sd * ca * pd;
      y += ca * pa - sd * sa * pd;
      z += cd * pd;
    }
    // годичная аберрация первого порядка: u' = u + v/c (второй порядок < 0,001″)
    x += fr.vx; y += fr.vy; z += fr.vz;
    const m = fr.m;
    const X = m[0] * x + m[1] * y + m[2] * z;
    const Y = m[3] * x + m[4] * y + m[5] * z;
    const Z = m[6] * x + m[7] * y + m[8] * z;
    const r = Math.sqrt(X * X + Y * Y + Z * Z);
    out.ra = norm360(Math.atan2(Y, X) * R2D);
    out.dec = Math.asin(Z / r) * R2D;
    return out;
  }

  /**
   * Точка эллипсоида WGS-84, из которой светило (вектор B в земной системе, км) видно точно в зените:
   * нормаль в точке P параллельна B − P. Итерация сходится за 3–4 шага (|P|/|B| ≤ 0,017 даже для Луны).
   */
  function zenithOnEllipsoid(bx, by, bz, out) {
    let px = 0, py = 0, pz = 0, lat = 0, lon = 0;
    for (let i = 0; i < 6; i++) {
      const dx = bx - px, dy = by - py, dz = bz - pz;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const nlat = Math.asin(dz / r), nlon = Math.atan2(dy, dx);
      const conv = Math.abs(nlat - lat) < 1e-12 && Math.abs(nlon - lon) < 1e-12;
      lat = nlat; lon = nlon;
      if (conv) break;
      const sl = Math.sin(lat), cl = Math.cos(lat);
      const N = WGS_A / Math.sqrt(1 - WGS_E2 * sl * sl);
      px = N * cl * Math.cos(lon); py = N * cl * Math.sin(lon); pz = N * (1 - WGS_E2) * sl;
    }
    out.lat = lat * R2D; out.lon = lon * R2D;
    return out;
  }

  /** Подзвёздная точка звезды: геодезическая широта = δ (звезда бесконечно далеко), долгота = α − GAST. */
  function starZenith(fr, ra, dec, pmra, pmdec, out) {
    starApparent(fr, ra, dec, pmra, pmdec, out);
    out.lat = out.dec;
    out.lon = normLon(out.ra - fr.gast);
    return out;
  }

  /**
   * Подсветильная точка Солнца, Луны, планеты: геоцентрический вектор с временем света и аберрацией (EQJ),
   * поворот на истинный экватор даты, затем на −GAST в земную систему и поиск точки на эллипсоиде.
   */
  function bodyZenith(key, ms, out) {
    out = out || {};
    const t = A.MakeTime(astroDate(ms));
    const v = key === 'Moon' ? A.GeoMoon(t) : A.GeoVector(A.Body[key], t, true);
    const eqd = A.RotateVector(A.Rotation_EQJ_EQD(t), v);
    const g = A.SiderealTime(t) * 15 * D2R;
    const cg = Math.cos(g), sg = Math.sin(g);
    const x = (eqd.x * cg + eqd.y * sg) * KM_PER_AU;
    const y = (-eqd.x * sg + eqd.y * cg) * KM_PER_AU;
    const z = eqd.z * KM_PER_AU;
    const dist = Math.sqrt(eqd.x * eqd.x + eqd.y * eqd.y + eqd.z * eqd.z);
    out.ra = norm360(Math.atan2(eqd.y, eqd.x) * R2D);
    out.dec = Math.asin(eqd.z / dist) * R2D;
    out.distAu = dist;
    out.distKm = dist * KM_PER_AU;
    zenithOnEllipsoid(x, y, z, out);
    return out;
  }

  /**
   * Таблица опорных величин на интервал — для поиска проходов, где кадр нужен тысячи раз:
   * GAST — почасово (непрерывно, без скачка через 360°), матрица и скорость Земли — посуточно,
   * между узлами — линейно. Ошибка интерполяции < 0,01″.
   */
  function FrameTable(t0, t1) {
    const start = t0 - MS_DAY, end = t1 + MS_DAY;
    const HOUR = 3600000;
    const nh = Math.ceil((end - start) / HOUR) + 2;
    const g = new Float64Array(nh);
    let prev = 0;
    for (let i = 0; i < nh; i++) {
      let v = A.SiderealTime(astroDate(start + i * HOUR)) * 15;
      if (i > 0) { while (v < prev) v += 360; while (v - prev > 360) v -= 360; }
      g[i] = v; prev = v;
    }
    const nd = Math.ceil((end - start) / MS_DAY) + 2;
    const mats = new Float64Array(nd * 12);
    for (let i = 0; i < nd; i++) {
      const f = frame(start + i * MS_DAY);
      mats.set(f.m, i * 12);
      mats[i * 12 + 9] = f.vx; mats[i * 12 + 10] = f.vy; mats[i * 12 + 11] = f.vz;
    }
    const fr = { ms: 0, gast: 0, years: 0, m: new Float64Array(9), vx: 0, vy: 0, vz: 0 };
    return {
      start, end,
      /** Кадр на момент ms (переиспользуемый объект — не хранить!). */
      at(ms) {
        const h = (ms - start) / HOUR;
        let i = Math.floor(h); if (i < 0) i = 0; if (i > nh - 2) i = nh - 2;
        const fh = h - i;
        fr.gast = norm360(g[i] + (g[i + 1] - g[i]) * fh);
        const dd = (ms - start) / MS_DAY;
        let j = Math.floor(dd); if (j < 0) j = 0; if (j > nd - 2) j = nd - 2;
        const fd = dd - j, o = j * 12, p = o + 12;
        for (let k = 0; k < 9; k++) fr.m[k] = mats[o + k] + (mats[p + k] - mats[o + k]) * fd;
        fr.vx = mats[o + 9] + (mats[p + 9] - mats[o + 9]) * fd;
        fr.vy = mats[o + 10] + (mats[p + 10] - mats[o + 10]) * fd;
        fr.vz = mats[o + 11] + (mats[p + 11] - mats[o + 11]) * fd;
        fr.ms = ms;
        fr.years = (ms - J2000_MS) / (365.25 * MS_DAY);
        return fr;
      },
      /** Только GAST — самая частая операция. */
      gast(ms) {
        const h = (ms - start) / HOUR;
        let i = Math.floor(h); if (i < 0) i = 0; if (i > nh - 2) i = nh - 2;
        return norm360(g[i] + (g[i + 1] - g[i]) * (h - i));
      },
    };
  }

  /** Цвет звезды по B−V — те же опорные цвета, что в SubStellarOverlay.kt. */
  const BV_STOPS = [-0.4, 0.0, 0.3, 0.6, 0.9, 1.4, 2.0];
  const BV_COLS = [[155, 176, 255], [202, 215, 255], [248, 247, 255], [255, 244, 234], [255, 226, 180], [255, 200, 130], [255, 160, 100]];
  function bvColor(bv) {
    const b = Math.min(2, Math.max(-0.4, bv == null || isNaN(bv) ? 0.3 : bv));
    for (let i = 1; i < BV_STOPS.length; i++) if (b <= BV_STOPS[i]) {
      const k = (b - BV_STOPS[i - 1]) / (BV_STOPS[i] - BV_STOPS[i - 1]);
      const a = BV_COLS[i - 1], c = BV_COLS[i];
      return `rgb(${Math.round(a[0] + (c[0] - a[0]) * k)},${Math.round(a[1] + (c[1] - a[1]) * k)},${Math.round(a[2] + (c[2] - a[2]) * k)})`;
    }
    return 'rgb(255,160,100)';
  }

  root.ZAstro = {
    D2R, R2D, MS_DAY, EARTH_DEG_PER_DAY, EARTH_DEG_PER_MS, J2000_MS, BODIES, BODY_BY_KEY,
    SIDEREAL_DAY_MS: 360 / EARTH_DEG_PER_MS,
    norm360, normLon, frame, starApparent, starZenith, bodyZenith, zenithOnEllipsoid, FrameTable, bvColor,
    setDut1(s) { dut1 = +s || 0; }, getDut1: () => dut1,
  };
})(typeof self !== 'undefined' ? self : globalThis);
