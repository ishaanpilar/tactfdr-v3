/* Flight model — the single source of truth for a loaded flight.
   Wraps parsed data with derived quantities (heading, rates) and
   assigns ACCS trace colors. Every view reads from this object. */

import { formatHMS } from './excel-parser.js';

/* ACCS-derived trace palette: semantic hues first, then cool neutrals.
   Deliberately small and ordered — not the 20-color rainbow of v1. */
const TRACE_COLORS = [
  '#38d6ff', // intel cyan
  '#46e08a', // nominal green
  '#ffc24b', // caution amber
  '#2f6fd6', // plan blue
  '#ff8a3d', // warn orange
  '#9fb3c6', // txt-2 neutral
  '#b48ce8', // violet (derived, cool family)
  '#5ee8d0', // teal (derived)
  '#ff4d63', // critical red (last resort)
  '#7a94ad'  // dim neutral
];

function greatCircleBearing(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
            Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** d(value)/dt per second between adjacent samples; null-safe. */
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

/* Light smoothing (radius 2) for rate inputs — 1 Hz GPS altitude/bearing
   jitter otherwise turns into ±several-m/s and ±tens-of-deg/s spikes that
   flood the event log with phantom exceedances. */
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

/* Unwrap compass headings into a continuous series so the 359°→1° crossing
   differentiates to +2°/s, not −358°/s. */
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
  const { metadata, timeSeconds, timeLabels, parameters, track, statusBits = [] } = parsed;

  // color + visibility assignment (first 3 params visible by default, like v1)
  const paramList = Object.values(parameters);
  paramList.forEach((p, i) => {
    p.color = TRACE_COLORS[i % TRACE_COLORS.length];
    p.visible = i < 3;
  });

  const hasTrack = track.some(t => t !== null);

  // derived heading from track (great-circle bearing between consecutive fixes)
  let heading = null;
  if (hasTrack) {
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

  const findParam = (needle) => {
    const lower = needle.toLowerCase();
    for (const p of paramList) if (p.name.toLowerCase().includes(lower)) return p;
    return null;
  };

  const altParam = findParam('altitude') || findParam('alt');
  const spdParam = findParam('ground speed') || findParam('speed');
  const hdgSource = unwrapHeading(heading || (findParam('sel course') || findParam('desired track') || {}).data || null);

  const model = {
    metadata, timeSeconds, timeLabels, parameters, track, hasTrack, statusBits,
    n: timeSeconds.length,
    heading,
    altData: altParam ? altParam.data : null,
    spdData: spdParam ? spdParam.data : null,
    altRate: altParam ? computeRate(lightSmooth(altParam.data), timeSeconds) : null,
    hdgRate: hdgSource ? computeRate(lightSmooth(hdgSource), timeSeconds) : null,
    findParam,
    /* average samples per second — drives real-time playback pacing */
    samplesPerSec: timeSeconds.length > 1
      ? (timeSeconds.length - 1) / Math.max(1, timeSeconds[timeSeconds.length - 1] - timeSeconds[0])
      : 1,
    labelAt: (i) => timeLabels[Math.max(0, Math.min(timeLabels.length - 1, Math.floor(i)))] || formatHMS(0)
  };
  return model;
}
