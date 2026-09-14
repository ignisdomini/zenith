/*
 * Экспорт результатов: CSV (для Excel — «;» и BOM), KML и KMZ (Google Earth, QGIS, SAS.Planet, OziExplorer).
 * KMZ упаковывает главный процесс (ZIP с doc.kml).
 */
(function () {
  'use strict';
  const Z = window.ZAstro;
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const coord = (lat, lon, h = 0) => `${Z.normLon(lon).toFixed(7)},${lat.toFixed(7)},${h}`;
  // KML цвет aabbggrr
  const kmlColor = (hex, a = 'ff') => { const n = hex.replace('#', ''); return a + n.slice(4, 6) + n.slice(2, 4) + n.slice(0, 2); };

  /** CSV: sep ';' — Russian Excel (decimal comma), ',' — English (decimal point). */
  function csv(header, rows, sep = ',') {
    const cell = v => {
      const s = v == null ? '' : typeof v === 'number' ? (sep === ';' ? String(v).replace('.', ',') : String(v)) : String(v);
      return /[;,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [header, ...rows].map(r => r.map(cell).join(sep)).join('\r\n');
  }

  function style(id, color, scale, icon) {
    return `<Style id="${id}"><IconStyle><color>${kmlColor(color)}</color><scale>${scale}</scale>` +
      `<Icon><href>${icon || 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png'}</href></Icon></IconStyle>` +
      `<LabelStyle><scale>0.8</scale></LabelStyle>` +
      `<LineStyle><color>${kmlColor(color)}</color><width>2.5</width></LineStyle>` +
      `<PolyStyle><color>${kmlColor(color, '55')}</color><outline>1</outline></PolyStyle></Style>`;
  }

  /** Разбивка ломаной на части при переходе через антимеридиан (KML-долготы только в ±180°). */
  function lineParts(pts) {
    const parts = [];
    let cur = [];
    let prev = null;
    for (const p of pts) {
      const lon = Z.normLon(p[1]);
      if (prev != null && Math.abs(lon - prev) > 180) {
        const sign = prev > 0 ? 1 : -1;
        const l2 = lon + 360 * sign;
        const f = (180 * sign - prev) / (l2 - prev);
        const latX = cur[cur.length - 1][0] + (p[0] - cur[cur.length - 1][0]) * f;
        cur.push([latX, 180 * sign - 1e-7 * sign]);
        parts.push(cur);
        cur = [[latX, -180 * sign + 1e-7 * sign]];
      }
      cur.push([p[0], lon]);
      prev = lon;
    }
    if (cur.length > 1) parts.push(cur);
    return parts;
  }
  function lineString(pts) {
    const parts = lineParts(pts);
    const ls = parts.map(pt => `<LineString><tessellate>1</tessellate><coordinates>${pt.map(p => coord(p[0], p[1])).join(' ')}</coordinates></LineString>`);
    return ls.length === 1 ? ls[0] : `<MultiGeometry>${ls.join('')}</MultiGeometry>`;
  }
  function placemark({ name, desc, styleId, t0, t1, geom, data }) {
    const time = t0 != null ? (t1 != null && t1 !== t0 ? `<TimeSpan><begin>${iso(t0)}</begin><end>${iso(t1)}</end></TimeSpan>` : `<TimeStamp><when>${iso(t0)}</when></TimeStamp>`) : '';
    const ext = data ? `<ExtendedData>${Object.entries(data).map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`).join('')}</ExtendedData>` : '';
    return `<Placemark><name>${esc(name)}</name>${desc ? `<description><![CDATA[${desc}]]></description>` : ''}` +
      `${styleId ? `<styleUrl>#${styleId}</styleUrl>` : ''}${time}${ext}${geom}</Placemark>`;
  }
  const point = (lat, lon) => `<Point><coordinates>${coord(lat, lon)}</coordinates></Point>`;
  const polygonRect = (s, n, w, e) => `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${[[s, w], [s, e], [n, e], [n, w], [s, w]].map(p => coord(p[0], p[1])).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
  const doc = (name, desc, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>` +
    `<description>${esc(desc)}</description>${body}</Document></kml>`;
  const folder = (name, inner) => inner ? `<Folder><name>${esc(name)}</name>${inner}</Folder>` : '';
  const table = rows => `<table>${rows.map(([k, v]) => `<tr><td style="color:#666;padding-right:8px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;

  window.ZExport = { csv, doc, folder, placemark, point, polygonRect, lineString, style, table, iso, esc };
})();
