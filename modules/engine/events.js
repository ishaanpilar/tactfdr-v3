/* Event detection engine — ported from TactFDR graphs/js/app.js and
   generalized to read from the flight model's pre-computed rates.
   Phase 2 will extend this with the limits-sheet engine and discrete
   status-bit transitions feeding the same event ledger. */

export const DEFAULT_THRESHOLDS = {
  overspeed: 140,        // kt
  lowAltitude: 50,       // m
  rapidDescent: -5,      // m/s
  rapidClimb: 8,         // m/s
  excessiveTurnRate: 15, // deg/s
  hardLanding: -3        // m/s descent near ground (<15 m AGL)
};

export const THRESHOLD_LABELS = {
  overspeed: 'Overspeed (kt)',
  lowAltitude: 'Low Alt (m)',
  rapidDescent: 'Rpd Descent (m/s)',
  rapidClimb: 'Rpd Climb (m/s)',
  excessiveTurnRate: 'Turn Rate (°/s)',
  hardLanding: 'Hard Ldg (m/s)'
};

/* severity → ACCS semantic color mapping (DESIGN_SYSTEM.md §3.4):
   critical = --critical red, warning = --caution amber, caution = --intel cyan */
const EVENT_TYPES = {
  OVERSPEED:      { label: 'Overspeed',      severity: 'critical', color: '#ff4d63' },
  LOW_ALT:        { label: 'Low Altitude',   severity: 'warning',  color: '#ffc24b' },
  RAPID_DESCENT:  { label: 'Rapid Descent',  severity: 'critical', color: '#ff4d63' },
  RAPID_CLIMB:    { label: 'Rapid Climb',    severity: 'caution',  color: '#38d6ff' },
  EXCESSIVE_TURN: { label: 'Excessive Turn', severity: 'warning',  color: '#ffc24b' },
  HARD_LANDING:   { label: 'Hard Landing',   severity: 'critical', color: '#ff4d63' }
};

/* Discrete status/warning bits (parsed as 0/1 columns): every rising edge
   is a fault/warning activation, every falling edge a clearance. These are
   exact recorder flags, so no dedup/smoothing applies. */
/* Group semantics: gp9/gp16 are WARNINGS, gp6/gp10/gp11 are AFCS FAILURE
   flags — a rising edge is a fault (warning severity). gp12/gp14/gp15 are
   AFCS mode ENGAGEMENT bits — pilot actions, logged as info (caution) so
   mode history is available without flooding the warning counts. */
const ENGAGEMENT_GROUPS = new Set(['gp12', 'gp14', 'gp15']);

export function detectStatusEvents(model) {
  const events = [];
  const { timeSeconds, timeLabels } = model;
  for (const bit of model.statusBits || []) {
    if (/^wow(lh|rh)$/.test(bit.key || '')) continue; // ground/flight switch, not a fault
    const engagement = ENGAGEMENT_GROUPS.has(bit.group);
    let prev = null;
    for (let i = 0; i < bit.data.length; i++) {
      const v = bit.data[i];
      if (v === null) continue;
      if (prev !== null && v !== prev) {
        const rising = v === 1;
        const warn = rising && !engagement;
        events.push({
          index: i, timeSec: timeSeconds[i], time: timeLabels[i],
          type: 'BIT_' + (bit.id || bit.key), source: 'status',
          label: `${bit.abbr || bit.name} ${rising ? (engagement ? 'ENGAGED' : 'ACTIVE') : (engagement ? 'DISENGAGED' : 'CLEARED')}`,
          detail: bit.desc || '',
          note: bit.trigger || '',
          severity: warn ? 'warning' : 'caution',
          color: warn ? '#ffc24b' : '#38d6ff',
          value: rising ? 'ON' : 'OFF', unit: '', threshold: '—'
        });
      }
      prev = v;
    }
  }
  return events;
}

/* One chronological ledger: derived-rate events + limit exceedances +
   status-bit transitions, sorted by time. `detectors` lets callers omit
   sources (e.g. no limits table loaded yet). */
export function combineEvents(...eventLists) {
  return eventLists.flat().sort((a, b) => a.timeSec - b.timeSec);
}

export function detectEvents(model, th = DEFAULT_THRESHOLDS, groundMask = null) {
  const events = [];
  const { altData, spdData, altRate, hdgRate, timeSeconds, timeLabels } = model;

  const add = (i, type, value, unit, threshold) => {
    events.push({
      index: i, timeSec: timeSeconds[i], time: timeLabels[i],
      type, source: 'rate', value: typeof value === 'number' ? value.toFixed(1) : value,
      unit, threshold, ...EVENT_TYPES[type]
    });
  };

  for (let i = 1; i < timeSeconds.length; i++) {
    if (groundMask && groundMask[i]) continue; // on the ground — not flight anomalies
    if (spdData && spdData[i] !== null && spdData[i] > th.overspeed)
      add(i, 'OVERSPEED', spdData[i], 'kt', th.overspeed);

    if (altData && altData[i] !== null && altData[i] < th.lowAltitude && altData[i] > 0)
      add(i, 'LOW_ALT', altData[i], 'm', th.lowAltitude);

    if (altRate && altRate[i] !== null && altRate[i] < th.rapidDescent)
      add(i, 'RAPID_DESCENT', altRate[i], 'm/s', th.rapidDescent);

    if (altRate && altRate[i] !== null && altRate[i] > th.rapidClimb)
      add(i, 'RAPID_CLIMB', altRate[i], 'm/s', th.rapidClimb);

    // heading is GPS-derived, so it jitters wildly at taxi speeds — only
    // flag turns when actually in translational flight (>10 kt)
    if (hdgRate && hdgRate[i] !== null && Math.abs(hdgRate[i]) > th.excessiveTurnRate &&
        (!spdData || spdData[i] === null || spdData[i] > 10))
      add(i, 'EXCESSIVE_TURN', Math.abs(hdgRate[i]), 'deg/s', th.excessiveTurnRate);

    if (altData && altRate && altData[i] !== null && altRate[i] !== null &&
        altData[i] < 15 && altRate[i] < th.hardLanding)
      add(i, 'HARD_LANDING', altRate[i], 'm/s', th.hardLanding);
  }

  return deduplicate(events);
}

/* merge consecutive same-type events within 5 s, keeping the extreme value */
export function deduplicate(events) {
  if (events.length === 0) return events;
  events.sort((a, b) => a.timeSec - b.timeSec || a.type.localeCompare(b.type));
  const out = [events[0]];
  for (let i = 1; i < events.length; i++) {
    const prev = out[out.length - 1];
    if (events[i].type === prev.type && events[i].timeSec - prev.timeSec < 5) {
      if (Math.abs(parseFloat(events[i].value)) > Math.abs(parseFloat(prev.value))) {
        out[out.length - 1] = events[i];
      }
    } else out.push(events[i]);
  }
  return out;
}
