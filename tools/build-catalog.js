#!/usr/bin/env node
/*
 * ZENIT star catalog builder: HYG v4.1 (119k stars, names) + Tycho-2 (2.5M) + Tycho-2 Suppl-1.
 * Сборка звёздного каталога ЗЕНИТа.
 *
 *   node tools/build-catalog.js            # downloads missing sources into data/, builds catalog/
 *   node tools/build-catalog.js --offline  # build only from files already in data/
 *
 * Output:
 *   catalog/stars.bin  — 32-byte records sorted by 1°×1° cells (Dec, RA J2000), by magnitude inside a cell
 *   catalog/names.json — names and identifiers of HYG stars (record → row index)
 *
 * stars.bin layout (little-endian, 4-byte aligned):
 *   header 16 B: 'ZNT1', u32 star count, u16 RA cells (360), u16 Dec cells (180), u32 reserved
 *   cell offsets: u32 × (360·180 + 1) — index of the first record of each cell
 *   record (32 B):
 *     0 u32 RA·1e7 (deg, J2000)       4 i32 Dec·1e7 (deg)
 *     8 f32 pmRA·cosDec (mas/yr)     12 f32 pmDec (mas/yr)
 *    16 i16 V·1000                   18 i16 (B−V)·1000, −32768 = none
 *    20 u8 source: 1 HYG+HIP, 2 HYG without HIP, 3 Tycho-2, 4 Tycho-1 (Suppl-1)
 *    21 u8 TYC3   22 u16 TYC2   24 u32 HIP / HYG id / TYC1   28 i32 index in names.json, −1 = none
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'catalog');
const NRA = 360, NDEC = 180;
const OFFLINE = process.argv.includes('--offline');

const SOURCES = [
  { file: 'hyg/hygdata_v41.csv', url: 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv' },
  ...Array.from({ length: 20 }, (_, i) => {
    const n = String(i).padStart(2, '0');
    return { file: `tycho2/tyc2.dat.${n}.gz`, url: `https://cdsarc.cds.unistra.fr/ftp/I/259/tyc2.dat.${n}.gz` };
  }),
  { file: 'tycho2/suppl_1.dat.gz', url: 'https://cdsarc.cds.unistra.fr/ftp/I/259/suppl_1.dat.gz' },
];

const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'star-names.json'), 'utf8'));

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const get = (u, redirects) => https.get(u, { headers: { 'User-Agent': 'zenit-catalog-builder' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume(); return get(new URL(res.headers.location, u).toString(), redirects + 1);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${u}: HTTP ${res.statusCode}`)); }
      const total = +res.headers['content-length'] || 0;
      let got = 0, last = 0;
      const out = fs.createWriteStream(tmp);
      res.on('data', (c) => {
        got += c.length;
        if (total && Date.now() - last > 500) { process.stdout.write(`\r  ${path.basename(dest)} ${(got / total * 100).toFixed(0)}%   `); last = Date.now(); }
      });
      res.pipe(out);
      out.on('finish', () => { out.close(() => { fs.renameSync(tmp, dest); process.stdout.write(`\r  ${path.basename(dest)} ${(got / 1048576).toFixed(1)} MB\n`); resolve(); }); });
      out.on('error', reject);
    }).on('error', reject);
    get(url, 0);
  });
}

/** CSV line split with double-quote support. */
function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (s) => { s = s.trim(); return s === '' ? null : +s; };

/** HYG Bayer code «Alp» / «Kap-1» → «α» / «κ¹». */
function bayerSymbol(code) {
  const m = /^([A-Za-z]{2,3})-?(\d)?$/.exec(code.trim());
  if (!m) return null;
  const g = dict.greek[m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()];
  return g ? g + (m[2] ? dict.sup[m[2]] : '') : null;
}

/** Johnson V and B−V from Tycho BT/VT (ESA 1997, vol. 1, §1.3). */
function tychoMag(bt, vt) {
  if (bt != null && vt != null) return [vt - 0.090 * (bt - vt), 0.850 * (bt - vt)];
  return [vt != null ? vt : bt, null];
}

async function main() {
  for (const s of SOURCES) {
    const dest = path.join(DATA, s.file);
    if (fs.existsSync(dest)) continue;
    if (OFFLINE) throw new Error(`missing ${dest}`);
    console.log(`download ${s.url}`);
    await download(s.url, dest);
  }

  const CAP = 2700000;
  const ra = new Float64Array(CAP), dec = new Float64Array(CAP);
  const pmra = new Float32Array(CAP), pmdec = new Float32Array(CAP);
  const mag = new Float64Array(CAP), bv = new Float64Array(CAP).fill(NaN);
  const src = new Uint8Array(CAP), tyc3 = new Uint8Array(CAP), id2 = new Uint16Array(CAP);
  const id1 = new Uint32Array(CAP), nameIdx = new Int32Array(CAP).fill(-1);
  let n = 0;
  const names = [];
  const hipSeen = new Set();

  // ── HYG ──
  const hygText = fs.readFileSync(path.join(DATA, 'hyg/hygdata_v41.csv'), 'utf8');
  const lines = hygText.split(/\r?\n/);
  const head = splitCsv(lines[0]);
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  for (let li = 1; li < lines.length; li++) {
    if (!lines[li]) continue;
    const r = splitCsv(lines[li]);
    const g = (k) => r[col[k]] ?? '';
    if (g('id') === '0' || !g('mag') || !g('ra') || !g('dec')) continue;
    const proper = g('proper').trim();
    const ru = proper ? dict.names_ru[proper] || null : null;
    const bayer = bayerSymbol(g('bayer'));
    const flam = /^\d+$/.test(g('flam').trim()) ? +g('flam') : null;
    const hd = g('hd') ? +g('hd') : null, hr = g('hr') ? +g('hr') : null, gl = g('gl').trim() || null;
    const con = g('con') || null;
    if (ru || proper || bayer || flam || hd || hr || gl) {
      nameIdx[n] = names.length;
      const dist = g('dist') ? +g('dist') : null;
      names.push([ru, proper || null, bayer, flam, hd, hr, gl, con, g('spect') || null,
        dist != null && dist < 100000 ? Math.round(dist * 100) / 100 : null]);
    }
    const hip = g('hip') ? +g('hip') : 0;
    if (hip) hipSeen.add(hip);
    ra[n] = +g('ra') * 15; dec[n] = +g('dec');
    pmra[n] = +(g('pmra') || 0); pmdec[n] = +(g('pmdec') || 0);
    mag[n] = +g('mag'); if (g('ci')) bv[n] = +g('ci');
    src[n] = hip ? 1 : 2; id1[n] = hip || +g('id');
    n++;
  }
  const nHyg = n;
  console.log(`HYG: ${nHyg} stars, ${names.length} name rows`);

  // ── Tycho-2 ──
  let skipped = 0;
  for (let part = 0; part < 20; part++) {
    const text = zlib.gunzipSync(fs.readFileSync(path.join(DATA, `tycho2/tyc2.dat.${String(part).padStart(2, '0')}.gz`))).toString('latin1');
    for (const line of text.split('\n')) {
      if (line.length < 200) continue;
      const hip = line.slice(142, 148).trim();
      if (hip && hipSeen.has(+hip)) { skipped++; continue; }
      const [m, c] = tychoMag(num(line.slice(110, 116)), num(line.slice(123, 129)));
      if (m == null) continue;
      if (line[13] === 'X') { ra[n] = +line.slice(152, 164); dec[n] = +line.slice(165, 177); pmra[n] = 0; pmdec[n] = 0; }
      else { ra[n] = +line.slice(15, 27); dec[n] = +line.slice(28, 40); pmra[n] = num(line.slice(41, 48)) || 0; pmdec[n] = num(line.slice(49, 56)) || 0; }
      mag[n] = m; if (c != null) bv[n] = c;
      src[n] = 3; tyc3[n] = +line[11]; id2[n] = +line.slice(5, 10); id1[n] = +line.slice(0, 4);
      n++;
    }
    process.stdout.write(`\r  Tycho-2 part ${part}: ${n} total   `);
  }
  process.stdout.write('\n');

  // ── Suppl-1: Tycho-1 stars without HIP; J1991.25 → J2000 ──
  const sup = zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'tycho2/suppl_1.dat.gz'))).toString('latin1');
  for (const line of sup.split('\n')) {
    if (line.length < 110) continue;
    const hip = line.slice(115, 121).trim();
    if (line[13] !== 'T' || (hip && hipSeen.has(+hip))) continue;
    const [m, c] = tychoMag(num(line.slice(83, 89)), num(line.slice(96, 102)));
    if (m == null) continue;
    let a = +line.slice(15, 27), d = +line.slice(28, 40);
    const pa = num(line.slice(41, 48)) || 0, pd = num(line.slice(49, 56)) || 0;
    const dy = 2000 - 1991.25, cd = Math.max(Math.cos(d * Math.PI / 180), 1e-9);
    a = ((a + pa / cd * dy / 3.6e6) % 360 + 360) % 360;
    d = Math.max(-90, Math.min(90, d + pd * dy / 3.6e6));
    ra[n] = a; dec[n] = d; pmra[n] = pa; pmdec[n] = pd; mag[n] = m; if (c != null) bv[n] = c;
    src[n] = 4; tyc3[n] = +line[11]; id2[n] = +line.slice(5, 10); id1[n] = +line.slice(0, 4);
    n++;
  }
  console.log(`total ${n} (HYG ${nHyg}, Tycho rows skipped as HIP ${skipped})`);

  // ── sort by cell, then magnitude ──
  const cell = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    ra[i] = ((ra[i] % 360) + 360) % 360;
    dec[i] = Math.max(-90, Math.min(90, dec[i]));
    const cd = Math.min(NDEC - 1, Math.max(0, Math.floor(dec[i] + 90)));
    const cr = Math.min(NRA - 1, Math.max(0, Math.floor(ra[i])));
    cell[i] = cd * NRA + cr;
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => cell[a] - cell[b] || mag[a] - mag[b]);

  const headerBytes = 16 + (NRA * NDEC + 1) * 4;
  const buf = Buffer.alloc(headerBytes + n * 32);
  buf.write('ZNT1', 0, 'latin1');
  buf.writeUInt32LE(n, 4); buf.writeUInt16LE(NRA, 8); buf.writeUInt16LE(NDEC, 10);
  const offsets = new Uint32Array(NRA * NDEC + 1);
  let k = 0;
  for (let c = 0; c <= NRA * NDEC; c++) {
    while (k < n && cell[order[k]] < c) k++;
    offsets[c] = k;
  }
  Buffer.from(offsets.buffer).copy(buf, 16);
  const rec = new DataView(buf.buffer, buf.byteOffset + headerBytes, n * 32);
  const clamp16 = (v) => Math.max(-32000, Math.min(32000, Math.round(v)));
  for (let j = 0; j < n; j++) {
    const i = order[j], o = j * 32;
    rec.setUint32(o, Math.min(3599999999, Math.round(ra[i] * 1e7)), true);
    rec.setInt32(o + 4, Math.round(dec[i] * 1e7), true);
    rec.setFloat32(o + 8, pmra[i], true);
    rec.setFloat32(o + 12, pmdec[i], true);
    rec.setInt16(o + 16, clamp16(mag[i] * 1000), true);
    rec.setInt16(o + 18, isNaN(bv[i]) ? -32768 : clamp16(bv[i] * 1000), true);
    rec.setUint8(o + 20, src[i]); rec.setUint8(o + 21, tyc3[i]);
    rec.setUint16(o + 22, id2[i], true); rec.setUint32(o + 24, id1[i], true);
    rec.setInt32(o + 28, nameIdx[i], true);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'stars.bin'), buf);
  fs.writeFileSync(path.join(OUT, 'names.json'), JSON.stringify({
    version: 2,
    fields: ['ru', 'proper', 'bayer', 'flamsteed', 'hd', 'hr', 'gl', 'con', 'spect', 'dist_pc'],
    source: 'HYG Database v4.1 (CC BY-SA 4.0); Tycho-2 (Høg et al. 2000, CDS I/259)',
    names,
  }));
  const counts = [6, 8, 10, 12].map(l => `≤${l}m: ${mag.subarray(0, n).filter(v => v <= l).length}`).join(', ');
  console.log(`catalog/stars.bin ${(buf.length / 1048576).toFixed(1)} MB, ${n} stars (${counts})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
