/* Flight model v2 — single source of truth for a loaded flight.
   Consumes the v2 parser output (group-keyed parameters, dictionary
   descriptions, discrete status bits) and derives heading, rates, the
   GPS track helpers, and the WOW ground mask used to gate event
   detection while on the ground. */

import { formatHMS } from './excel-parser.js';

/* ACCS-derived trace palette: semantic hues first, then cool neutrals. */
const TRACE_COLORS = [
  '#38d6ff', '#46e08a', '#ffc24b', '#2f6fd6', '#ff8a3d',
  '#9fb3c6', '#b48ce8', '#5ee8d0', '#ff4d63', '#7a94ad',
  '#8fd14f', '#e8a4c8', '#6fb3e0', '#d9c56b', '#88a0b8'
];

function greatCircleBearing(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
            Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function computeRate(data, timeSeconds) {
  if (!data || data.length < 2) return null;
  const rate = [null];
  for (let i = 1; i < data.length; i++) {
    if (data[i] !== null && data[i - 1] !== null && timeSeconds[i] !== timeSeconds[i - 1]) {
      const dt = timeSeconds[i] - timeSeconds[i - 1];
      rate.push(dt > 0 ? (data[i] - data[i - 1]) / dt : 0);
    } else rate.push(null);
  }
  return rate;
}

/* Light smoothing (radius 2) for rate inputs — 1 Hz sensor jitter otherwise
   floods the event log with phantom exceedances. */
function lightSmooth(data) {
  if (!data) return null;
  const R = 2, out = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (data[i] === null) { out[i] = null; continue; }
    let sum = 0, wt = 0;
    for (let j = Math.max(0, i - R); j <= Math.min(data.length - 1, i + R); j++) {
      if (data[j] === null) continue;
      const w = 1 - Math.abs(j - i) / (R + 1);
      sum += data[j] * w; wt += w;
    }
    out[i] = wt > 0 ? sum / wt : null;
  }
  return out;
}

/* Unwrap compass headings so 359°→1° differentiates to +2°/s, not −358°/s. */
function unwrapHeading(heading) {
  if (!heading) return null;
  const out = new Array(heading.length);
  let acc = null;
  for (let i = 0; i < heading.length; i++) {
    if (heading[i] === null) { out[i] = acc; continue; }
    if (acc === null) { acc = heading[i]; out[i] = acc; continue; }
    let d = heading[i] - (((acc % 360) + 360) % 360);
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    acc += d;
    out[i] = acc;
  }
  return out;
}

export function buildModel(parsed) {
  const { metadata, timeSeconds, timeLabels, parameters, track, statusBits = [], absStartMs = null } = parsed;

  const paramList = Object.values(parameters);
  paramList.sort((a, b) => a.group.localeCompare(b.group, undefined, { numeric: true }) || a.abbr.localeCompare(b.abbr));
  paramList.forEach((p, i) => {
    p.color = TRACE_COLORS[i % TRACE_COLORS.length];
    p.visible = false;
    p.name = p.abbr; // display name; description available as p.desc
  });

  const hasTrack = track.some(t => t !== null);

  /* finders: match key exactly, then abbr/description substring */
  const byKey = (key) => paramList.find(p => p.key === key) || null;
  const findParam = (needle) => {
    const lower = String(needle).toLowerCase();
    return byKey(lower.replace(/[^a-z0-9#]/g, '')) ||
      paramList.find(p => p.abbr.toLowerCase().includes(lower)) ||
      paramList.find(p => p.desc.toLowerCase().includes(lower)) || null;
  };

  // core series: recorded values preferred, GPS-derived as fallback
  const altParam = byKey('radalt') || byKey('zpadc1') || findParam('altitude');
  const spdParam = byKey('gdspd') || findParam('ground speed');
  const hdgParam = byKey('hdg#1') || byKey('hdg1') || findParam('heading');

  let heading = hdgParam ? hdgParam.data.slice() : null;
  if (!heading && hasTrack) {
    heading = new Array(timeSeconds.length).fill(null);
    let prev = null, prevHdg = null;
    for (let i = 0; i < track.length; i++) {
      const t = track[i];
      if (!t) { heading[i] = prevHdg; continue; }
      if (prev && (t.lat !== prev.lat || t.lon !== prev.lon)) {
        prevHdg = greatCircleBearing(prev.lat, prev.lon, t.lat, t.lon);
      }
      heading[i] = prevHdg;
      prev = t;
    }
  }

  // default chart selection: the classic quick-look set, else first 3
  const defaults = ['nmr', 't451', 'q1', 'radalt', 'gdspd'];
  let shown = 0;
  for (const k of defaults) { const p = byKey(k); if (p) { p.visible = true; shown++; } }
  if (!shown) paramList.slice(0, 3).forEach(p => p.visible = true);

  /* WOW (weight-on-wheels, GP9) — the proper ground/flight gate.
     groundMask[i] === true means firmly on the ground. */
  const wowBits = statusBits.filter(b => /^wow(lh|rh)$/.test(b.key));
  let groundMask = null;
  if (wowBits.length) {
    groundMask = new Array(timeSeconds.length).fill(false);
    for (let i = 0; i < timeSeconds.length; i++) {
      groundMask[i] = wowBits.some(b => b.data[i] === 1);
    }
  }

  const model = {
    metadata, timeSeconds, timeLabels, parameters, track, hasTrack, statusBits, absStartMs,
    n: timeSeconds.length,
    paramList,
    heading,
    groundMask,
    altData: altParam ? altParam.data : null,
    altUnit: altParam ? altParam.unit : 'm',
    spdData: spdParam ? spdParam.data : null,
    altRate: altParam ? computeRate(lightSmooth(altParam.data), timeSeconds) : null,
    hdgRate: heading ? computeRate(lightSmooth(unwrapHeading(heading)), timeSeconds) : null,
    findParam, byKey,
    samplesPerSec: timeSeconds.length > 1
      ? (timeSeconds.length - 1) / Math.max(1, timeSeconds[timeSeconds.length - 1] - timeSeconds[0])
      : 1,
    labelAt: (i) => timeLabels[Math.max(0, Math.min(timeLabels.length - 1, Math.floor(i)))] || formatHMS(0)
  };
  return model;
}
