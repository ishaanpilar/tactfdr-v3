/* TACT-FDR v3 — application wiring.
   Owns: upload flow, view switching, transport bar, altitude-profile
   timeline, keyboard shortcuts. All flight state lives in the model;
   all timing lives in the single playback clock. */

import { parseWorkbooks, fromTrackArray } from './data/excel-parser.js';
import { buildModel } from './data/flight-model.js';
import { parseLimitsWorkbook } from './data/limits.js';
import { createPlayback } from './engine/playback.js';
import { smoothArray } from './engine/interpolate.js';
import { createChartView } from './views/chart.js';
import { createMapView } from './views/map.js';
import { createInstruments } from './views/instruments.js';
import { createEventLog } from './views/event-log.js';
import { createCVR } from './views/cvr.js';
import { createReport } from './export/report.js';
import { downloadKML } from './export/kml.js';

const $ = (sel) => document.querySelector(sel);

let model = null, playback = null, chart = null, mapView = null, eventLog = null, report = null, cvr = null;
let currentEvents = [];

/* aircraft dictionary (parameter descriptions, limits, warning triggers) —
   extracted from the client reference workbooks by tools/extract_dictionaries.py */
let DICT = null;
const dictReady = fetch('config/fdr-dictionary.json')
  .then(r => r.ok ? r.json() : null)
  .then(d => { DICT = d; })
  .catch(() => { console.warn('fdr-dictionary.json not found — running with generic labels + placeholder limits'); });

/* ---------------- upload flow ---------------- */
const overlay = $('#upload-overlay');
const dropZone = $('#drop-zone');
const fileInput = $('#file-input');
const statusEl = $('#upload-status');

function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ''; }

dropZone.addEventListener('click', (e) => { if (e.target.id !== 'browse-link') fileInput.click(); });
$('#browse-link').addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFiles([...fileInput.files]); });

/* Multi-file: a flight often ships as gp1.xlsx + gp2.xlsx + … — select or
   drop them together and they merge onto one timeline (absolute GMT). */
async function handleFiles(files) {
  files = files.filter(f => /\.xlsx?$/i.test(f.name));
  if (!files.length) { setStatus('ERROR: only .xlsx / .xls accepted', 'err'); return; }
  setStatus('PROCESSING ' + files.map(f => f.name).join(', ') + ' …', 'busy');
  try {
    await dictReady;
    const entries = [];
    for (const f of files) entries.push({ buffer: await f.arrayBuffer(), name: f.name });
    const parsed = parseWorkbooks(entries, DICT);
    if (parsed.timeSeconds.length < 2) { setStatus('ERROR: no time-coded data rows found', 'err'); return; }
    const skipped = parsed.metadata.skippedSheets || [];
    setStatus(`OK — ${parsed.metadata.records.toLocaleString()} records · groups ${parsed.metadata.groups.join(', ')}` +
      (skipped.length ? ` · ${skipped.length} sheet(s) skipped` : ''), 'ok');
    setTimeout(() => loadFlight(parsed), 400);
  } catch (err) {
    setStatus('ERROR: ' + err.message, 'err');
    console.error(err);
  }
}

/* Demo = the real IA-3101 sortie (gp1 + gp2 merged) with the real CVR
   recording; falls back to the legacy flight_data.js track if the demo
   workbooks are missing from this deployment. */
async function loadDemoFlight() {
  await dictReady;
  try {
    const entries = [];
    for (const url of ['demo/gp1.xlsx', 'demo/gp2.xlsx']) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
      entries.push({ buffer: await res.arrayBuffer(), name: url.split('/').pop() });
    }
    loadFlight(parseWorkbooks(entries, DICT));
    if (cvr) cvr.loadDemo();
    return true;
  } catch (err) {
    console.warn('real demo flight unavailable (' + err.message + ') — falling back to flight_data.js');
    if (typeof FLIGHT_DATA !== 'undefined' && FLIGHT_DATA.length > 1) {
      loadFlight(fromTrackArray(FLIGHT_DATA));
      if (cvr) cvr.loadDemo();
      return true;
    }
    setStatus('ERROR: demo data not found', 'err');
    return false;
  }
}

$('#btn-demo').addEventListener('click', () => {
  setStatus('LOADING demo flight …', 'busy');
  loadDemoFlight();
});

$('#btn-upload-new').addEventListener('click', () => {
  if (playback) playback.pause();
  fileInput.value = '';
  setStatus('', '');
  overlay.classList.remove('hidden');
});

/* ---------------- flight load ---------------- */
function loadFlight(parsed) {
  if (playback) playback.destroy();

  model = buildModel(parsed);
  playback = createPlayback(model);

  overlay.classList.add('hidden');

  // topbar
  $('#tb-file').textContent = model.metadata.filename;
  $('#tb-date').textContent = model.metadata.date || '—';
  $('#tb-duration').textContent = model.metadata.duration;
  $('#tb-records').textContent = model.metadata.records.toLocaleString();

  // views
  chart = createChartView($('#chart-host'), model, playback, () => currentEvents,
    () => eventLog ? eventLog.limitsTable : []);
  mapView = createMapView($('#map-host'), $('#map-hud'), model, playback);
  createInstruments($('#instruments'), model, playback);
  eventLog = createEventLog($('#events-panel-root'), model, playback, DICT, (events) => {
    currentEvents = events;
    $('#nav-events-badge').textContent = events.length;
    $('#nav-events-badge').style.display = events.length ? '' : 'none';
    if (chart) chart.refresh();
  });
  const lbl = $('#limits-label');
  lbl.textContent = eventLog.limitsLabel;
  lbl.style.color = eventLog.limitsLabel === 'PLACEHOLDER' ? 'var(--caution)' : 'var(--nominal)';
  report = createReport($('#report-paper'), $('#print-paper'), model, () => currentEvents, $('#chart-host'));
  report.setLimitsSourceLabel(() => eventLog.limitsLabel);
  cvr = createCVR($('#cvr-panel'), model, playback);

  buildParamList();
  buildTimelineProfile();
  buildTransport();

  $('#nav-map').disabled = !mapView.available;
  $('#nav-map').title = mapView.available ? '' : 'No GPS track in this file';

  setView('chart');
  playback.onTick(updateTransport);
  playback.onState(updatePlayButton);
  playback.seek(0);
  chart.refresh();
}

/* ---------------- parameter list ---------------- */
function buildParamList() {
  const listEl = $('#param-list');
  const params = model.paramList;
  const dictGroups = (DICT && DICT.groups) || {};

  let html = '', lastGroup = null;
  for (const p of params) {
    if (p.group !== lastGroup) {
      const title = (dictGroups[p.group] && dictGroups[p.group].title) || '';
      html += `<div class="param-group">${p.group.toUpperCase()}${title ? ' · ' + title : ''}</div>`;
      lastGroup = p.group;
    }
    const tip = p.desc ? `${p.abbr} — ${p.desc}` : p.abbr;
    html += `
      <button class="param-row ${p.visible ? 'on' : ''}" data-id="${p.id}">
        <span class="swatch" style="background:${p.color};color:${p.color}"></span>
        <span class="pname" title="${tip.replace(/"/g, '&quot;')}">${p.abbr}</span>
        <span class="punit">${p.unit}</span>
      </button>`;
  }
  listEl.innerHTML = html;
  listEl.querySelectorAll('.param-row').forEach(row => {
    row.addEventListener('click', () => {
      const p = model.parameters[row.dataset.id];
      p.visible = !p.visible;
      row.classList.toggle('on', p.visible);
      chart.refresh();
    });
  });
  $('#btn-params-all').onclick = () => {
    params.forEach(p => p.visible = true);
    listEl.querySelectorAll('.param-row').forEach(r => r.classList.add('on'));
    chart.refresh();
  };
  $('#btn-params-none').onclick = () => {
    params.forEach(p => p.visible = false);
    listEl.querySelectorAll('.param-row').forEach(r => r.classList.remove('on'));
    chart.refresh();
  };
}

/* ---------------- display controls ---------------- */
$('#ctl-window').addEventListener('change', (e) => chart && chart.setWindow(parseInt(e.target.value)));
$('#ctl-ymode').addEventListener('change', (e) => {
  const mode = e.target.value;
  $('#manual-y').style.display = mode === 'manual' ? '' : 'none';
  applyYMode();
});
$('#y-min').addEventListener('change', applyYMode);
$('#y-max').addEventListener('change', applyYMode);
function applyYMode() {
  if (!chart) return;
  chart.setYMode($('#ctl-ymode').value, parseFloat($('#y-min').value) || 0, parseFloat($('#y-max').value) || 100);
}
$('#ctl-chartmode').addEventListener('change', (e) => chart && chart.setChartMode(e.target.value));
$('#btn-export').addEventListener('click', () => chart && chart.exportPNG());

/* ---------------- view switching ---------------- */
function setView(name) {
  document.querySelector('.app').dataset.view = name;
  for (const v of ['chart', 'map', 'report']) {
    $('#view-' + v).classList.toggle('active', name === v);
    $('#nav-' + v).classList.toggle('active', name === v);
  }
  if (name === 'map' && mapView) mapView.show();
  if (name === 'chart' && chart) { chart.resize(); chart.refresh(); }
  if (name === 'report' && report) report.generate();
}
$('#nav-chart').addEventListener('click', () => setView('chart'));
$('#nav-map').addEventListener('click', () => setView('map'));
$('#nav-report').addEventListener('click', () => setView('report'));
$('#btn-print-report').addEventListener('click', async () => {
  if (report) { await report.generate(); report.print(); }
});

/* ---------------- map: KML export + offline basemap ---------------- */
$('#btn-export-kml').addEventListener('click', () => {
  if (!model) return;
  try { downloadKML(model, currentEvents); }
  catch (err) { alert('KML export failed: ' + err.message); }
});
$('#btn-offline-map').addEventListener('click', () => $('#pmtiles-input').click());
$('#pmtiles-input').addEventListener('change', async () => {
  const file = $('#pmtiles-input').files[0];
  if (!file || !mapView) return;
  await applyOfflineBasemap(file, file.name);
});
async function applyOfflineBasemap(source, label) {
  try {
    const info = await mapView.loadOfflineBasemap(source, label.toUpperCase());
    const tag = $('#map-mode-tag');
    tag.textContent = `OFFLINE · ${label} · z${info.minZoom}–${info.maxZoom}`;
    tag.classList.add('g');
  } catch (err) {
    alert('Offline basemap load failed: ' + err.message);
  }
}

/* ---------------- CVR file loading ---------------- */
$('#btn-cvr-audio').addEventListener('click', () => $('#cvr-audio-input').click());
$('#cvr-audio-input').addEventListener('change', async () => {
  const file = $('#cvr-audio-input').files[0];
  if (!file || !cvr) return;
  try { await cvr.loadAudioFile(file); }
  catch (err) { alert('CVR audio load failed: ' + err.message); }
});
$('#btn-cvr-transcript').addEventListener('click', () => $('#cvr-transcript-input').click());
$('#cvr-transcript-input').addEventListener('change', async () => {
  const file = $('#cvr-transcript-input').files[0];
  if (!file || !cvr) return;
  try { await cvr.loadTranscriptFile(file); }
  catch (err) { alert('Transcript load failed: ' + err.message); }
});

/* ---------------- limits import ---------------- */
$('#btn-import-limits').addEventListener('click', () => $('#limits-input').click());
$('#limits-input').addEventListener('change', () => {
  const file = $('#limits-input').files[0];
  if (!file || !eventLog) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const table = parseLimitsWorkbook(e.target.result);
      eventLog.setLimits(table, file.name);
      const lbl = $('#limits-label');
      lbl.textContent = `${file.name} (${table.length})`;
      lbl.style.color = 'var(--nominal)';
      chart.refresh();
    } catch (err) {
      alert('Limits import failed: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
});

/* ---------------- timeline profile ---------------- */
function buildTimelineProfile() {
  const canvas = $('#alt-profile');
  const wrap = $('#profile-wrap');
  const cursor = $('#profile-cursor');

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(255,255,255,.02)';
    ctx.fillRect(0, 0, w, h);

    const alt = model.altData, spd = model.spdData;
    if (!alt) return;
    const sAlt = smoothArray(alt.map(v => v || 0));
    const maxA = Math.max(1, ...sAlt);
    const x = (i) => (i / (model.n - 1)) * w;

    // altitude area — caution amber, per ACCS map of alt readouts
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < model.n; i++) ctx.lineTo(x(i), h - (sAlt[i] / maxA) * (h - 8));
    ctx.lineTo(w, h); ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,194,75,.30)');
    grad.addColorStop(1, 'rgba(255,194,75,.02)');
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < model.n; i++) {
      const y = h - (sAlt[i] / maxA) * (h - 8);
      i === 0 ? ctx.moveTo(x(i), y) : ctx.lineTo(x(i), y);
    }
    ctx.strokeStyle = 'rgba(255,194,75,.75)'; ctx.lineWidth = 1.2; ctx.stroke();

    // speed trace — nominal green
    if (spd) {
      const sSpd = smoothArray(spd.map(v => v || 0));
      const maxS = Math.max(1, ...sSpd);
      ctx.beginPath();
      for (let i = 0; i < model.n; i++) {
        const y = h - (sSpd[i] / maxS) * (h - 8);
        i === 0 ? ctx.moveTo(x(i), y) : ctx.lineTo(x(i), y);
      }
      ctx.strokeStyle = 'rgba(70,224,138,.55)'; ctx.lineWidth = 1; ctx.stroke();
    }

    // event ticks
    for (const evt of currentEvents) {
      ctx.fillStyle = evt.color;
      ctx.fillRect(x(evt.index) - 0.5, 0, 1, 6);
    }
  }

  draw();
  new ResizeObserver(draw).observe(wrap);

  wrap.addEventListener('click', (e) => {
    const rect = wrap.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    playback.seek(frac * (model.n - 1));
  });

  playback.onTick((pos) => {
    cursor.style.left = (pos / (model.n - 1)) * 100 + '%';
  });
}

/* ---------------- transport ---------------- */
function buildTransport() {
  $('#btn-start').onclick = () => { playback.pause(); playback.seek(0); };
  $('#btn-end').onclick = () => { playback.pause(); playback.seek(model.n - 1); };
  $('#btn-play').onclick = () => playback.toggle();
  $('#speed-select').onchange = (e) => playback.setSpeed(parseFloat(e.target.value));
  playback.setSpeed(parseFloat($('#speed-select').value));

  $('#btn-follow').onclick = () => $('#btn-follow').classList.toggle('engaged', mapView.toggleFollow());
  $('#btn-trail').onclick = () => $('#btn-trail').classList.toggle('engaged', mapView.toggleTrail());

  const scrub = $('#scrub');
  let dragging = false;
  const seekFromEvent = (e) => {
    const rect = scrub.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    playback.seek(frac * (model.n - 1));
  };
  scrub.addEventListener('pointerdown', (e) => { dragging = true; scrub.setPointerCapture(e.pointerId); seekFromEvent(e); });
  scrub.addEventListener('pointermove', (e) => { if (dragging) seekFromEvent(e); });
  scrub.addEventListener('pointerup', () => { dragging = false; });
}

function updateTransport(pos) {
  const frac = (pos / (model.n - 1)) * 100;
  $('#scrub-fill').style.width = frac + '%';
  $('#scrub-handle').style.left = frac + '%';
  $('#time-display').textContent = model.labelAt(pos) + ' / ' + model.metadata.duration;
}

function updatePlayButton(playing) {
  $('#icon-play').style.display = playing ? 'none' : '';
  $('#icon-pause').style.display = playing ? '' : 'none';
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', (e) => {
  if (!playback || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const step = Math.max(1, Math.floor(model.n * 0.02));
  switch (e.key) {
    case ' ': e.preventDefault(); playback.toggle(); break;
    case 'ArrowLeft': e.preventDefault(); playback.nudge(e.shiftKey ? -step * 2.5 : -step); break;
    case 'ArrowRight': e.preventDefault(); playback.nudge(e.shiftKey ? step * 2.5 : step); break;
    case 'Home': e.preventDefault(); playback.pause(); playback.seek(0); break;
    case 'End': e.preventDefault(); playback.pause(); playback.seek(model.n - 1); break;
    case 'f': case 'F':
      if (mapView && mapView.available) $('#btn-follow').classList.toggle('engaged', mapView.toggleFollow());
      break;
  }
});

/* ---------------- clock ---------------- */
setInterval(() => { $('#tb-clock').textContent = new Date().toTimeString().slice(0, 8); }, 1000);

/* ---------------- URL params (dev/demo convenience) ----------------
   ?demo         auto-load the bundled demo flight
   ?view=map     switch to map replay after load                     */
const urlParams = new URLSearchParams(location.search);
async function bootFromParams() {
  const load = urlParams.get('load'); // ?load=path1,path2 — fetch + parse workbooks (dev)
  if (load) {
    await dictReady;
    try {
      const entries = [];
      for (const url of load.split(',')) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
        entries.push({ buffer: await res.arrayBuffer(), name: decodeURIComponent(url.split('/').pop()) });
      }
      loadFlight(parseWorkbooks(entries, DICT));
    } catch (err) {
      setStatus('ERROR: ' + err.message, 'err');
      console.error(err);
      return;
    }
  } else if (urlParams.has('demo')) {
    if (!await loadDemoFlight()) return;
  } else return;

  const v = urlParams.get('view');
  if (v === 'map' || v === 'report') setView(v);
  const pm = urlParams.get('pmtiles');
  if (pm && mapView && mapView.available) {
    applyOfflineBasemap(pm, pm.split('/').pop().replace(/\.pmtiles$/, ''));
  }
}
bootFromParams();
