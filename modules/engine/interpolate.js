/* Catmull-Rom spline interpolation + Gaussian smoothing,
   ported from TactFDR (index.html:645-677). */

export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Interpolated track sample at float position `pos`. Track entries may be
 *  null (no GPS fix) — falls back to the nearest non-null neighbour. */
export function trackAt(track, pos) {
  const n = track.length;
  const clamped = Math.max(0, Math.min(n - 1, pos));
  let idx = Math.floor(clamped);
  const t = clamped - idx;

  const at = (i) => {
    i = Math.max(0, Math.min(n - 1, i));
    if (track[i]) return track[i];
    for (let d = 1; d < n; d++) {
      if (track[i - d]) return track[i - d];
      if (track[i + d]) return track[i + d];
    }
    return null;
  };

  const p1 = at(idx);
  if (!p1) return null;
  if (t < 1e-4 || idx >= n - 1) return p1;
  const p0 = at(idx - 1), p2 = at(idx + 1), p3 = at(idx + 2);
  return {
    lat: catmullRom(p0.lat, p1.lat, p2.lat, p3.lat, t),
    lon: catmullRom(p0.lon, p1.lon, p2.lon, p3.lon, t),
    alt: Math.max(0, catmullRom(p0.alt, p1.alt, p2.alt, p3.alt, t)),
    spd: Math.max(0, catmullRom(p0.spd, p1.spd, p2.spd, p3.spd, t))
  };
}

const SMOOTH_R = 8;
export function smoothArray(arr) {
  return arr.map((_, i) => {
    let sum = 0, wt = 0;
    for (let j = Math.max(0, i - SMOOTH_R); j <= Math.min(arr.length - 1, i + SMOOTH_R); j++) {
      const d = Math.abs(j - i) / (SMOOTH_R + 1);
      const w = Math.exp(-3 * d * d);
      sum += (arr[j] || 0) * w; wt += w;
    }
    return sum / wt;
  });
}
