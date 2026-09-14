/*
 * Подложки и слои подписей. Все тайлы идут через app://tiles/… — главный процесс кэширует их на диск.
 */
(function () {
  'use strict';
  const tile = (id, opts) => L.tileLayer(`app://tiles/${id}/{z}/{x}/{y}`, { maxNativeZoom: 19, maxZoom: 21, ...opts });

  const ESRI = 'Imagery © Esri, Maxar, Earthstar Geographics, USDA FSA, USGS, Aerogrid, IGN, IGP, GIS User Community';
  const OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  window.ZLayers = {
    /** Подложки: снимки, топооснова, схема. Метки подписей добавляются к снимкам отдельными слоями. */
    bases: [
      { id: 'hybrid', name: 'Спутник с подписями', make: () => L.layerGroup([tile('esri_img', { attribution: ESRI }), tile('esri_roads', { opacity: 0.8 }), tile('esri_labels')]) },
      { id: 'sat', name: 'Спутник', make: () => tile('esri_img', { attribution: ESRI }) },
      { id: 'otm', name: 'Топокарта OpenTopoMap', make: () => tile('otm', { maxNativeZoom: 17, attribution: `${OSM}, SRTM | style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)` }) },
      { id: 'esri_topo', name: 'Топокарта Esri', make: () => tile('esri_topo', { attribution: 'Map © Esri, HERE, Garmin, FAO, NOAA, USGS, ' + OSM }) },
      { id: 'osm', name: 'OpenStreetMap', make: () => tile('osm', { attribution: OSM }) },
      { id: 'dark', name: 'Тёмная схема', make: () => tile('carto_dark', { maxNativeZoom: 20, attribution: `${OSM} © <a href="https://carto.com/attributions">CARTO</a>` }) },
    ],
    /** Слои поверх подложки. */
    overlays: [
      { id: 'labels', name: 'Названия (Esri)', make: () => tile('esri_labels'), def: false },
      { id: 'roads', name: 'Дороги (Esri)', make: () => tile('esri_roads', { opacity: 0.85 }), def: false },
      { id: 'carto_labels', name: 'Названия (CARTO)', make: () => tile('carto_labels', { maxNativeZoom: 20, attribution: '© CARTO' }), def: false },
    ],

    /** Панель выбора слоёв в углу карты. */
    mount(map, baseList, overlayList, initial) {
      const made = {};
      const get = (def) => made[def.id] || (made[def.id] = def.make());
      let current = null;
      const setBase = (id) => {
        const def = this.bases.find(b => b.id === id) || this.bases[0];
        if (current) map.removeLayer(current);
        current = get(def);
        current.addTo(map);
        if (current.bringToBack) current.bringToBack();
        try { localStorage.setItem('zenit.base', def.id); } catch { /* нет хранилища */ }
      };
      const tr = (d) => window.ZI18n.t('layers.' + d.id);
      for (const b of this.bases) {
        const lab = document.createElement('label');
        lab.innerHTML = `<input type="radio" name="base" value="${b.id}"> ${tr(b)}`;
        lab.querySelector('input').addEventListener('change', () => setBase(b.id));
        baseList.appendChild(lab);
      }
      for (const o of this.overlays) {
        const lab = document.createElement('label');
        lab.innerHTML = `<input type="checkbox"> ${tr(o)}`;
        const cb = lab.querySelector('input');
        let on = o.def;
        try { const v = localStorage.getItem('zenit.ov.' + o.id); if (v != null) on = v === '1'; } catch { /* нет хранилища */ }
        cb.checked = on;
        const apply = () => {
          const layer = get(o);
          if (cb.checked) layer.addTo(map); else map.removeLayer(layer);
          try { localStorage.setItem('zenit.ov.' + o.id, cb.checked ? '1' : '0'); } catch { /* нет хранилища */ }
        };
        cb.addEventListener('change', apply);
        if (on) apply();
        overlayList.appendChild(lab);
      }
      let start = initial;
      try { start = localStorage.getItem('zenit.base') || initial; } catch { /* нет хранилища */ }
      const radio = baseList.querySelector(`input[value="${start}"]`) || baseList.querySelector('input');
      radio.checked = true;
      setBase(radio.value);
    },
  };
})();
