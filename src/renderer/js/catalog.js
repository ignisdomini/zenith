/*
 * ZENIT star catalog: catalog/stars.bin (HYG + Tycho-2, 2.55 million stars) and names.json.
 * Format: see tools/build-catalog.js. 32-byte aligned records are read through typed views without copies.
 * Classic script: window and Web Worker (self.ZCatalog).
 */
(function (root) {
  'use strict';
  const NRA = 360, NDEC = 180, HEADER = 16;
  const tr = (k) => (root.ZI18n ? root.ZI18n.t(k) : k);
  const lang = () => (root.ZI18n ? root.ZI18n.lang : 'en');

  /** Constellation genitives: Latin (English UI) and Russian. */
  const GEN_LA = {
    And: 'Andromedae', Ant: 'Antliae', Aps: 'Apodis', Aqr: 'Aquarii', Aql: 'Aquilae', Ara: 'Arae', Ari: 'Arietis', Aur: 'Aurigae',
    Boo: 'Bootis', Cae: 'Caeli', Cam: 'Camelopardalis', Cnc: 'Cancri', CVn: 'Canum Venaticorum', CMa: 'Canis Majoris',
    CMi: 'Canis Minoris', Cap: 'Capricorni', Car: 'Carinae', Cas: 'Cassiopeiae', Cen: 'Centauri', Cep: 'Cephei', Cet: 'Ceti',
    Cha: 'Chamaeleontis', Cir: 'Circini', Col: 'Columbae', Com: 'Comae Berenices', CrA: 'Coronae Australis', CrB: 'Coronae Borealis',
    Crv: 'Corvi', Crt: 'Crateris', Cru: 'Crucis', Cyg: 'Cygni', Del: 'Delphini', Dor: 'Doradus', Dra: 'Draconis', Equ: 'Equulei',
    Eri: 'Eridani', For: 'Fornacis', Gem: 'Geminorum', Gru: 'Gruis', Her: 'Herculis', Hor: 'Horologii', Hya: 'Hydrae', Hyi: 'Hydri',
    Ind: 'Indi', Lac: 'Lacertae', Leo: 'Leonis', LMi: 'Leonis Minoris', Lep: 'Leporis', Lib: 'Librae', Lup: 'Lupi', Lyn: 'Lyncis',
    Lyr: 'Lyrae', Men: 'Mensae', Mic: 'Microscopii', Mon: 'Monocerotis', Mus: 'Muscae', Nor: 'Normae', Oct: 'Octantis',
    Oph: 'Ophiuchi', Ori: 'Orionis', Pav: 'Pavonis', Peg: 'Pegasi', Per: 'Persei', Phe: 'Phoenicis', Pic: 'Pictoris', Psc: 'Piscium',
    PsA: 'Piscis Austrini', Pup: 'Puppis', Pyx: 'Pyxidis', Ret: 'Reticuli', Sge: 'Sagittae', Sgr: 'Sagittarii', Sco: 'Scorpii',
    Scl: 'Sculptoris', Sct: 'Scuti', Ser: 'Serpentis', Sex: 'Sextantis', Tau: 'Tauri', Tel: 'Telescopii', Tri: 'Trianguli',
    TrA: 'Trianguli Australis', Tuc: 'Tucanae', UMa: 'Ursae Majoris', UMi: 'Ursae Minoris', Vel: 'Velorum', Vir: 'Virginis',
    Vol: 'Volantis', Vul: 'Vulpeculae',
  };
  const GEN_RU = {
    And: 'Андромеды', Ant: 'Насоса', Aps: 'Райской Птицы', Aqr: 'Водолея', Aql: 'Орла', Ara: 'Жертвенника', Ari: 'Овна',
    Aur: 'Возничего', Boo: 'Волопаса', Cae: 'Резца', Cam: 'Жирафа', Cnc: 'Рака', CVn: 'Гончих Псов', CMa: 'Большого Пса',
    CMi: 'Малого Пса', Cap: 'Козерога', Car: 'Киля', Cas: 'Кассиопеи', Cen: 'Центавра', Cep: 'Цефея', Cet: 'Кита',
    Cha: 'Хамелеона', Cir: 'Циркуля', Col: 'Голубя', Com: 'Волос Вероники', CrA: 'Южной Короны', CrB: 'Северной Короны',
    Crv: 'Ворона', Crt: 'Чаши', Cru: 'Южного Креста', Cyg: 'Лебедя', Del: 'Дельфина', Dor: 'Золотой Рыбы', Dra: 'Дракона',
    Equ: 'Малого Коня', Eri: 'Эридана', For: 'Печи', Gem: 'Близнецов', Gru: 'Журавля', Her: 'Геркулеса', Hor: 'Часов',
    Hya: 'Гидры', Hyi: 'Южной Гидры', Ind: 'Индейца', Lac: 'Ящерицы', Leo: 'Льва', LMi: 'Малого Льва', Lep: 'Зайца',
    Lib: 'Весов', Lup: 'Волка', Lyn: 'Рыси', Lyr: 'Лиры', Men: 'Столовой Горы', Mic: 'Микроскопа', Mon: 'Единорога',
    Mus: 'Мухи', Nor: 'Наугольника', Oct: 'Октанта', Oph: 'Змееносца', Ori: 'Ориона', Pav: 'Павлина', Peg: 'Пегаса',
    Per: 'Персея', Phe: 'Феникса', Pic: 'Живописца', Psc: 'Рыб', PsA: 'Южной Рыбы', Pup: 'Кормы', Pyx: 'Компаса',
    Ret: 'Сетки', Sge: 'Стрелы', Sgr: 'Стрельца', Sco: 'Скорпиона', Scl: 'Скульптора', Sct: 'Щита', Ser: 'Змеи',
    Sex: 'Секстанта', Tau: 'Тельца', Tel: 'Телескопа', Tri: 'Треугольника', TrA: 'Южного Треугольника', Tuc: 'Тукана',
    UMa: 'Большой Медведицы', UMi: 'Малой Медведицы', Vel: 'Парусов', Vir: 'Девы', Vol: 'Летучей Рыбы', Vul: 'Лисички',
  };
  // names.json row: [ru, proper, bayer, flamsteed, hd, hr, gl, con, spect, dist_pc]
  const F_RU = 0, F_PROPER = 1, F_BAYER = 2, F_FLAM = 3, F_HD = 4, F_HR = 5, F_GL = 6, F_CON = 7, F_SPECT = 8, F_DIST = 9;
  const gould = (s) => /^\d+ G\. /.test(s);

  function Catalog(buf, names) {
    const head = new DataView(buf, 0, HEADER);
    if (String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3)) !== 'ZNT1')
      throw new Error('stars.bin: bad format');
    const count = head.getUint32(4, true);
    const offsets = new Uint32Array(buf, HEADER, NRA * NDEC + 1);
    const base = HEADER + offsets.byteLength;
    this.count = count;
    this.offsets = offsets;
    this.u32 = new Uint32Array(buf, base, count * 8);
    this.i32 = new Int32Array(buf, base, count * 8);
    this.f32 = new Float32Array(buf, base, count * 8);
    this.i16 = new Int16Array(buf, base, count * 16);
    this.u8 = new Uint8Array(buf, base, count * 32);
    this.u16 = new Uint16Array(buf, base, count * 16);
    this.names = names ? names.names : null;
    this._nameToIdx = null;
  }

  const P = Catalog.prototype;
  P.ra = function (i) { return this.u32[i * 8] / 1e7; };
  P.dec = function (i) { return this.i32[i * 8 + 1] / 1e7; };
  P.pmra = function (i) { return this.f32[i * 8 + 2]; };
  P.pmdec = function (i) { return this.f32[i * 8 + 3]; };
  P.mag = function (i) { return this.i16[i * 16 + 8] / 1000; };
  P.magRaw = function (i) { return this.i16[i * 16 + 8]; };
  P.bv = function (i) { const v = this.i16[i * 16 + 9]; return v === -32768 ? null : v / 1000; };
  P.src = function (i) { return this.u8[i * 32 + 20]; };
  P.nameIndex = function (i) { return this.i32[i * 8 + 7]; };
  P.entry = function (i) { const n = this.nameIndex(i); return n >= 0 && this.names ? this.names[n] : null; };

  /** Catalog number: HIP 91262 / HYG 1234 / TYC 3105-2070-1. */
  P.catalogId = function (i) {
    const s = this.src(i), id1 = this.u32[i * 8 + 6];
    if (s === 1) return 'HIP ' + id1;
    if (s === 2) return 'HYG ' + id1;
    return 'TYC ' + id1 + '-' + this.u16[i * 16 + 11] + '-' + this.u8[i * 32 + 21];
  };

  /** Bayer / Flamsteed designation of a names.json row: «α Lyrae» / «α Лиры», «61 Cygni» / «61 Лебедя». */
  function designation(e, lg) {
    if (!e || !e[F_CON]) return null;
    const gen = (lg === 'ru' ? GEN_RU : GEN_LA)[e[F_CON]];
    if (!gen) return null;
    if (e[F_BAYER]) return e[F_BAYER] + ' ' + gen;
    if (e[F_FLAM]) return e[F_FLAM] + ' ' + gen;
    return null;
  }
  const properName = (e) => (e && e[F_PROPER] && !gould(e[F_PROPER]) ? e[F_PROPER] : null);
  /** Proper name in the UI language (Russian names exist for named stars; English uses IAU names). */
  function localName(e, lg) {
    if (!e) return null;
    return lg === 'ru' ? (e[F_RU] || properName(e)) : properName(e);
  }

  P.isNamed = function (i) { return !!localName(this.entry(i), lang()); };

  /** Map label: proper name → Bayer/Flamsteed → HD → catalog number. */
  P.displayName = function (i) {
    const e = this.entry(i), lg = lang();
    return localName(e, lg) || designation(e, lg) || (e && e[F_HD] ? 'HD ' + e[F_HD] : null) || this.catalogId(i);
  };
  /** Short map label: name or designation only, otherwise null. */
  P.shortLabel = function (i) {
    const e = this.entry(i);
    if (!e) return null;
    const lg = lang();
    return localName(e, lg) || designation(e, lg);
  };

  /** All designations of a star for the object card. */
  P.designations = function (i) {
    const out = [];
    const e = this.entry(i), lg = lang();
    const push = (s) => { if (s && !out.includes(s)) out.push(s); };
    if (e) {
      push(localName(e, lg));
      push(designation(e, lg));
      push(properName(e));
      if (lg === 'ru') push(designation(e, 'en'));
    }
    push(this.catalogId(i));
    if (e) {
      if (e[F_HD]) push('HD ' + e[F_HD]);
      if (e[F_HR]) push('HR ' + e[F_HR]);
      push(e[F_GL]);
    }
    return out;
  };
  P.info = function (i) {
    const e = this.entry(i);
    return {
      idx: i, name: this.displayName(i), designations: this.designations(i), source: tr('src.' + this.src(i)),
      ra: this.ra(i), dec: this.dec(i), pmra: this.pmra(i), pmdec: this.pmdec(i), mag: this.mag(i), bv: this.bv(i),
      spect: e ? e[F_SPECT] : null, distPc: e ? e[F_DIST] : null, con: e ? e[F_CON] : null,
    };
  };

  /** Cells of Dec band [d0, d1] (deg) and RA arc [a0, a0 + span] (deg); span ≥ 360 — all. Callback (first, last). */
  P.forCells = function (d0, d1, a0, span, fn) {
    const r0 = Math.max(0, Math.floor(d0 + 90)), r1 = Math.min(NDEC - 1, Math.floor(d1 + 90));
    const all = span >= 359.999;
    const c0 = all ? 0 : Math.floor(((a0 % 360) + 360) % 360);
    const n = all ? NRA : Math.min(NRA, Math.ceil(span) + 1);
    for (let r = r0; r <= r1; r++) {
      const row = r * NRA;
      for (let k = 0; k < n; k++) {
        const c = row + ((c0 + k) % NRA);
        const first = this.offsets[c], last = this.offsets[c + 1];
        if (last > first && fn(first, last) === false) return;
      }
    }
  };

  /** Find stars by name (English or Russian), designation or number. Returns record indices (up to limit). */
  P.find = function (query, limit) {
    limit = limit || 30;
    const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
    const q = norm(query.trim());
    if (!q) return [];
    let m = q.match(/^(hip|hyg)\s*(\d+)$/);
    if (m) {
      const src = m[1] === 'hip' ? 1 : 2, id = +m[2];
      for (let i = 0; i < this.count; i++) if (this.u8[i * 32 + 20] === src && this.u32[i * 8 + 6] === id) return [i];
      return [];
    }
    m = q.match(/^tyc\s*(\d+)[-\s](\d+)(?:[-\s](\d))?$/);
    if (m) {
      const out = [];
      for (let i = 0; i < this.count; i++) {
        if (this.u8[i * 32 + 20] < 3 || this.u32[i * 8 + 6] !== +m[1] || this.u16[i * 16 + 11] !== +m[2]) continue;
        if (!m[3] || this.u8[i * 32 + 21] === +m[3]) out.push(i);
      }
      return out;
    }
    if (!this.names) return [];
    if (!this._nameToIdx) {
      this._nameToIdx = new Int32Array(this.names.length).fill(-1);
      for (let i = 0; i < this.count; i++) { const n = this.i32[i * 8 + 7]; if (n >= 0) this._nameToIdx[n] = i; }
    }
    m = q.match(/^(hd|hr)\s*(\d+)$/);
    const hits = [];
    for (let n = 0; n < this.names.length; n++) {
      const e = this.names[n];
      let score = -1;
      if (m) { if ((m[1] === 'hd' ? e[F_HD] : e[F_HR]) === +m[2]) score = 0; }
      else {
        const cands = [e[F_RU], properName(e), designation(e, 'ru'), designation(e, 'en'), e[F_GL]];
        for (const s of cands) {
          if (!s) continue;
          const v = norm(s);
          if (v === q) { score = 0; break; }
          if (v.startsWith(q)) score = score < 0 ? 1 : Math.min(score, 1);
          else if (score < 0 && v.includes(q)) score = 2;
        }
      }
      if (score >= 0) { const i = this._nameToIdx[n]; if (i >= 0) hits.push([score, this.mag(i), i]); }
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return hits.slice(0, limit).map(h => h[2]);
  };

  root.ZCatalog = {
    NRA, NDEC,
    async load(binUrl, namesUrl, onProgress) {
      const [buf, names] = await Promise.all([
        fetchBuffer(binUrl, onProgress),
        namesUrl ? fetch(namesUrl).then(r => r.json()) : Promise.resolve(null),
      ]);
      return new Catalog(buf, names);
    },
    fromBuffer(buf, names) { return new Catalog(buf, names); },
  };

  async function fetchBuffer(url, onProgress) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('catalog unavailable: ' + r.status);
    const total = +r.headers.get('content-length') || 0;
    if (!r.body || !onProgress || !total) return r.arrayBuffer();
    const buf = new Uint8Array(total);
    const reader = r.body.getReader();
    let pos = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf.set(value, pos); pos += value.length;
      onProgress(pos / total);
    }
    return buf.buffer;
  }
})(typeof self !== 'undefined' ? self : globalThis);
