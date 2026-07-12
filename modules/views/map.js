/* Leaflet map replay — ported from TactFDR and re-themed to ACCS.
   Altitude bands use the ACCS semantic ramp (nominal → caution → critical);
   the helicopter marker is restyled with intel-cyan accents and hairlines.
   Online tile layers remain for Phase 1; offline PMTiles arrive in Phase 4. */

import { trackAt } from '../engine/interpolate.js';

/* ACCS altitude band ramp: green → lime → amber → red (quartiles of max alt) */
const ALT_BANDS = ['#46e08a', '#a8d84b', '#ffc24b', '#ff4d63'];

const HELI_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="40" height="40">
  <ellipse cx="32" cy="22" rx="26" ry="3.2" fill="none" stroke="#38d6ff" stroke-width="1.1" opacity="0.55">
    <animateTransform attributeName="transform" type="rotate" from="0 32 22" to="360 32 22" dur="0.25s" repeatCount="indefinite"/>
  </ellipse>
  <rect x="31" y="19" width="2" height="5" fill="#1a2634"/>
  <path d="M24 27 Q24 23 28 21 L36 21 Q40 23 40 27 L40 38 Q40 42 36 44 L28 44 Q24 42 24 38 Z"
        fill="#101925" stroke="#38d6ff" stroke-width="0.7" opacity="0.95"/>
  <path d="M27 23 Q27 21.5 30 21 L34 21 Q37 21.5 37 23 L37 27 Q37 28 34 28 L30 28 Q27 28 27 27 Z"
        fill="#05080c" stroke="#38d6ff" stroke-width="0.4" opacity="0.7"/>
  <rect x="30.5" y="42" width="3" height="13" rx="0.5" fill="#101925" stroke="#38d6ff" stroke-width="0.4" opacity="0.9"/>
  <ellipse cx="32" cy="56" rx="4.5" ry="1.3" fill="none" stroke="#38d6ff" stroke-width="0.7" opacity="0.45">
    <animateTransform attributeName="transform" type="rotate" from="0 32 56" to="360 32 56" dur="0.15s" repeatCount="indefinite"/>
  </ellipse>
  <circle cx="24" cy="30" r="1" fill="#ff4d63"><animate attributeName="opacity" values="0.9;0.25;0.9" dur="1.2s" repeatCount="indefinite"/></circle>
  <circle cx="40" cy="30" r="1" fill="#46e08a"><animate attributeName="opacity" values="0.9;0.25;0.9" dur="1.2s" repeatCount="indefinite"/></circle>
  <line x1="22" y1="46" x2="30" y2="46" stroke="#5f7488" stroke-width="1.4" stroke-linecap="round"/>
  <line x1="34" y1="46" x2="42" y2="46" stroke="#5f7488" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

export function createMapView(host, hud, model, playback) {
  let map = null, heliMarker = null, heliEl = null, trailLine = null;
  let followMode = true, showTrail = true;
  let maxAlt = 1;
  let initialized = false;
  let layersCtl = null, activeBase = null;

  const fixes = model.track.filter(t => t !== null);

  function altColor(alt) {
    const r = alt / maxAlt;
    return ALT_BANDS[r < 0.25 ? 0 : r < 0.5 ? 1 : r < 0.75 ? 2 : 3];
  }

  function init() {
    if (initialized || !model.hasTrack) return;
    maxAlt = Math.max(1, ...fixes.map(t => t.alt));

    map = L.map(host, { zoomControl: false }).setView([fixes[0].lat, fixes[0].lon], 12);
    L.control.zoom({ position: 'topright' }).addTo(map);
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri', maxZoom: 19 });
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 });
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { attribution: '© OpenTopoMap', maxZoom: 17 });
    sat.addTo(map);
    activeBase = sat;
    layersCtl = L.control.layers({ SAT: sat, MAP: osm, TOPO: topo }, {}, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', (e) => { activeBase = e.layer; });

    // altitude-banded path
    const segs = [];
    for (let i = 0; i < fixes.length - 1; i++) {
      segs.push(L.polyline(
        [[fixes[i].lat, fixes[i].lon], [fixes[i + 1].lat, fixes[i + 1].lon]],
        { color: altColor(fixes[i].alt), weight: 2.5, opacity: 0.7 }
      ));
    }
    L.layerGroup(segs).addTo(map);

    L.circleMarker([fixes[0].lat, fixes[0].lon], { radius: 6, color: '#46e08a', fillColor: '#46e08a', fillOpacity: 0.85, weight: 2 })
      .addTo(map).bindPopup(`<b style="color:#46e08a">ORIGIN</b><br>ALT ${fixes[0].alt.toFixed(0)} m`);
    const last = fixes[fixes.length - 1];
    L.circleMarker([last.lat, last.lon], { radius: 6, color: '#ff4d63', fillColor: '#ff4d63', fillOpacity: 0.85, weight: 2 })
      .addTo(map).bindPopup(`<b style="color:#ff4d63">TERMINUS</b><br>ALT ${last.alt.toFixed(0)} m`);

    map.fitBounds(L.latLngBounds(fixes.map(t => [t.lat, t.lon])), { padding: [30, 30] });

    const icon = L.divIcon({ html: `<div id="heli-rot" style="transition:transform .15s linear">${HELI_SVG}</div>`, iconSize: [40, 40], iconAnchor: [20, 20], className: '' });
    heliMarker = L.marker([fixes[0].lat, fixes[0].lon], { icon, zIndexOffset: 1000 }).addTo(map);
    heliEl = null; // resolved lazily — divIcon DOM exists after add

    trailLine = L.polyline([[fixes[0].lat, fixes[0].lon]], { color: '#38d6ff', weight: 1.5, opacity: 0.5, dashArray: '4 6' }).addTo(map);

    const legend = document.getElementById('map-legend');
    if (legend) {
      legend.innerHTML = '<h4>Altitude Band</h4>' + ALT_BANDS.map((c, i) =>
        `<div class="lg-item"><span class="lg-swatch" style="background:${c}"></span>${Math.round(maxAlt * i / 4)} – ${Math.round(maxAlt * (i + 1) / 4)} m</div>`
      ).join('');
    }

    initialized = true;
  }

  function update(pos) {
    if (!initialized) return;
    const pt = trackAt(model.track, pos);
    if (!pt) return;
    const i = Math.floor(pos);

    heliMarker.setLatLng([pt.lat, pt.lon]);
    const hdg = model.heading ? model.heading[i] : null;
    if (!heliEl) heliEl = heliMarker.getElement() && heliMarker.getElement().querySelector('#heli-rot');
    if (heliEl && hdg !== null) heliEl.style.transform = `rotate(${hdg}deg)`;

    if (showTrail && trailLine) {
      const coords = [];
      const step = Math.max(1, Math.floor(model.n / 2000));
      for (let j = 0; j <= i; j += step) if (model.track[j]) coords.push([model.track[j].lat, model.track[j].lon]);
      coords.push([pt.lat, pt.lon]);
      trailLine.setLatLngs(coords);
    }

    if (followMode) map.panTo([pt.lat, pt.lon], { animate: false });

    // HUD
    if (hud) {
      hud.querySelector('#hud-pos').textContent = `${pt.lat.toFixed(5)} / ${pt.lon.toFixed(5)}`;
      hud.querySelector('#hud-alt').textContent = pt.alt.toFixed(0);
      hud.querySelector('#hud-spd').textContent = pt.spd.toFixed(0);
      hud.querySelector('#hud-hdg').textContent = hdg !== null ? String(Math.round(hdg)).padStart(3, '0') : '---';
    }
  }

  playback.onTick((pos) => { if (isVisible()) update(pos); });

  function isVisible() { return host.offsetParent !== null; }

  /* Offline basemap: a local .pmtiles file (vector protomaps extract or
     raster) replaces the online tile dependency — the client's "proper map
     downloaded and kept" requirement. Extracts come from protomaps.com or
     `pmtiles extract` for the operating region. */
  async function loadOfflineBasemap(source, label) {
    init();
    if (!map) throw new Error('Map unavailable (no GPS track loaded)');
    const p = typeof source === 'string'
      ? new pmtiles.PMTiles(source)
      : new pmtiles.PMTiles(new pmtiles.FileSource(source));
    const header = await p.getHeader();

    let layer;
    if (header.tileType === 1) { // MVT vector — render with protomaps-leaflet
      layer = protomapsL.leafletLayer({ url: p, theme: 'dark', attribution: 'Offline basemap' });
    } else {                     // raster png/jpg/webp — upscale beyond native zoom
      layer = pmtiles.leafletRasterLayer(p, { attribution: 'Offline basemap', maxZoom: 19, maxNativeZoom: header.maxZoom });
    }
    if (activeBase) map.removeLayer(activeBase);
    layer.addTo(map);
    activeBase = layer;
    layersCtl.addBaseLayer(layer, label || 'OFFLINE');
    return { minZoom: header.minZoom, maxZoom: header.maxZoom, tileType: header.tileType };
  }

  return {
    get available() { return model.hasTrack; },
    show() {
      init();
      if (map) { map.invalidateSize(); update(playback.pos); }
    },
    loadOfflineBasemap,
    toggleFollow() { followMode = !followMode; return followMode; },
    toggleTrail() {
      showTrail = !showTrail;
      if (trailLine) trailLine.setStyle({ opacity: showTrail ? 0.5 : 0 });
      return showTrail;
    },
  };
}
