// Проверка математики зенитов: node tools/verify.js
// 1) видимое место звезды — против astronomy-engine DefineStar + Equator(ofdate, aberration);
// 2) подсветильная точка Солнца/Луны/Венеры — светило должно стоять в зените (высота 90°) у наблюдателя в этой точке;
// 3) интерполяционная таблица FrameTable — против прямого расчёта кадра.
globalThis.Astronomy = require('astronomy-engine');
require('../src/renderer/js/astro.js');
const Z = globalThis.ZAstro, A = globalThis.Astronomy;

let fail = 0;
const check = (name, err, tol, unit) => {
  const ok = Math.abs(err) <= tol;
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'ERR'} ${name}: ${err.toFixed(4)} ${unit} (допуск ${tol})`);
};

const ms = Date.UTC(2026, 8, 14, 18, 30, 0);
const stars = [
  ['Вега', 279.23473479, 38.78368896, 200.94, 286.23],
  ['Полярная', 37.95456067, 89.26410897, 44.48, -11.85],
  ['Сириус', 101.28715533, -16.71611586, -546.01, -1223.07],
  ['Ахернар', 24.42852, -57.23675, 88.02, -40.08],
];
const fr = Z.frame(ms);
for (const [name, ra, dec] of stars) {
  // DefineStar не учитывает собственное движение — сравниваем без него
  A.DefineStar(A.Body.Star1, ra / 15, dec, 1000);
  const eq = A.Equator(A.Body.Star1, new Date(ms), new A.Observer(0, 0, 0), true, true);
  const o = Z.starApparent(fr, ra, dec, 0, 0, {});
  const dRa = Z.normLon(o.ra - eq.ra * 15) * 3600 * Math.cos(dec * Z.D2R);
  check(`${name} α·cosδ`, dRa, 0.5, '″');
  check(`${name} δ`, (o.dec - eq.dec) * 3600, 0.5, '″');
}

for (const key of ['Sun', 'Moon', 'Venus', 'Jupiter']) {
  const z = Z.bodyZenith(key, ms, {});
  const obs = new A.Observer(z.lat, z.lon, 0);
  const eq = A.Equator(A.Body[key], new Date(ms), obs, true, true);
  const hor = A.Horizon(new Date(ms), obs, eq.ra, eq.dec, null);
  check(`${key} высота в подсветильной точке (${z.lat.toFixed(4)}, ${z.lon.toFixed(4)})`, (90 - hor.altitude) * 3600, 2, '″');
}

const t0 = Date.UTC(2026, 8, 14), t1 = Date.UTC(2027, 8, 14);
const tab = Z.FrameTable(t0, t1);
let worst = 0, worstG = 0;
for (let i = 0; i < 200; i++) {
  const t = t0 + Math.random() * (t1 - t0);
  const a = Z.starApparent(Z.frame(t), 279.2347, 38.7837, 200, 286, {});
  const b = Z.starApparent(tab.at(t), 279.2347, 38.7837, 200, 286, {});
  worst = Math.max(worst, Math.abs(a.dec - b.dec) * 3600, Math.abs(Z.normLon(a.ra - b.ra)) * 3600);
  worstG = Math.max(worstG, Math.abs(Z.normLon(Z.frame(t).gast - tab.gast(t))) * 3600);
}
check('FrameTable видимое место, худшее', worst, 0.02, '″');
check('FrameTable GAST, худшее', worstG, 0.02, '″');

console.log(fail ? `\nОШИБОК: ${fail}` : '\nвсё сходится');
process.exit(fail ? 1 : 0);
