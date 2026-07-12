/* Limits engine — per-parameter operating ranges checked against every
   sample. Values in the caution band raise WARNING events; values beyond
   the hard min/max raise CRITICAL events.

   The real aircraft limits Excel (pending from the client) can be imported
   at runtime; until then PLACEHOLDER_LIMITS ships as a clearly-labelled
   stand-in so the pipeline is demonstrable end-to-end.

   Import schema (first sheet, header row anywhere in first 3 rows):
     Parameter | Min | Max | Caution Min | Caution Max
   Parameter names are matched case-insensitively by substring against the
   FDR parameter names. */

export const PLACEHOLDER_LIMITS = [
  { param: 'Ground Speed',   unit: 'kt',  min: null, max: 155, cautionMin: null, cautionMax: 110 },
  { param: 'Radar Altitude', unit: 'm',   min: null, max: 900, cautionMin: null, cautionMax: 800 },
  { param: 'Wind Speed',     unit: 'kt',  min: null, max: 60,  cautionMin: null, cautionMax: 45 },
  { param: 'Static Temp',    unit: '°C',  min: -40,  max: 50,  cautionMin: -30,  cautionMax: 45 },
  { param: 'Impact Temp',    unit: '°C',  min: -40,  max: 55,  cautionMin: -30,  cautionMax: 50 }
];

const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};

/** Build the limits table from the aircraft dictionary (config/
 *  fdr-dictionary.json — extracted from the client's limits workbook).
 *  Dictionary limits are hard extreme limits → critical severity; the
 *  original AEO/OEI conditional text is preserved as `note`. */
export function limitsFromDictionary(dict) {
  if (!dict || !dict.groups) return null;
  const out = [];
  for (const [gid, g] of Object.entries(dict.groups)) {
    for (const [key, p] of Object.entries(g.params)) {
      if (p.min === undefined && p.max === undefined) continue;
      if (p.min === null && p.max === null) continue;
      if (p.min == null && p.max == null) continue;
      out.push({
        param: p.abbr, key, group: gid,
        unit: p.unit || '',
        min: p.min ?? null, max: p.max ?? null,
        cautionMin: null, cautionMax: null,
        note: p.limitNote || '', description: p.description || ''
      });
    }
  }
  return out.length ? out : null;
}

/** Parse a limits workbook (ArrayBuffer) into the limits-table shape. */
export function parseLimitsWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: false });

  // locate the header row within the first 3 rows
  let headerIdx = -1, cols = {};
  for (let r = 0; r < Math.min(3, rows.length); r++) {
    const row = (rows[r] || []).map(c => String(c || '').toLowerCase().trim());
    const pi = row.findIndex(c => c.includes('param'));
    if (pi === -1) continue;
    headerIdx = r;
    cols = {
      param: pi,
      unit: row.findIndex(c => c === 'unit' || c.includes('units')),
      min: row.findIndex(c => c === 'min' || c === 'minimum'),
      max: row.findIndex(c => c === 'max' || c === 'maximum'),
      cautionMin: row.findIndex(c => c.includes('caution') && c.includes('min')),
      cautionMax: row.findIndex(c => c.includes('caution') && c.includes('max'))
    };
    break;
  }
  if (headerIdx === -1) throw new Error('No header row with a "Parameter" column found.');

  const limits = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[cols.param]) continue;
    limits.push({
      param: String(row[cols.param]).trim(),
      unit: cols.unit >= 0 && row[cols.unit] ? String(row[cols.unit]).trim() : '',
      min: cols.min >= 0 ? num(row[cols.min]) : null,
      max: cols.max >= 0 ? num(row[cols.max]) : null,
      cautionMin: cols.cautionMin >= 0 ? num(row[cols.cautionMin]) : null,
      cautionMax: cols.cautionMax >= 0 ? num(row[cols.cautionMax]) : null
    });
  }
  if (!limits.length) throw new Error('No limit rows found under the header.');
  return limits;
}

/** Resolve a limits table against a flight model's parameters — exact
 *  normalized-key match first (v2 tables), name search as fallback. */
export function matchLimits(limitsTable, model) {
  const out = [];
  for (const limit of limitsTable) {
    const p = (limit.key && model.byKey && model.byKey(limit.key)) || model.findParam(limit.param);
    if (p) out.push({ limit, param: p });
  }
  return out;
}

/** Scan every matched parameter against its ranges. A continuous exceedance
 *  collapses into ONE episode event carrying onset time, peak value, and
 *  duration — "GS HIGH from 00:41:05, peak 152 kt, 38 s" — which is what an
 *  investigator reads, not one row per sample. Severity within an episode
 *  escalates to the worst band reached. */
export function detectLimitEvents(limitsTable, model, groundMask = null) {
  const events = [];
  const matched = matchLimits(limitsTable, model);
  const { timeSeconds, timeLabels } = model;

  const classify = (limit, v) => {
    if (limit.max !== null && v > limit.max) return { severity: 'critical', bound: limit.max, side: 'HIGH' };
    if (limit.min !== null && v < limit.min) return { severity: 'critical', bound: limit.min, side: 'LOW' };
    if (limit.cautionMax !== null && v > limit.cautionMax) return { severity: 'warning', bound: limit.cautionMax, side: 'HIGH' };
    if (limit.cautionMin !== null && v < limit.cautionMin) return { severity: 'warning', bound: limit.cautionMin, side: 'LOW' };
    return null;
  };

  for (const { limit, param } of matched) {
    const data = param.data;
    let ep = null; // { startI, side, severity, peak, bound }

    const close = (endI) => {
      const durSec = Math.max(0, timeSeconds[endI] - timeSeconds[ep.startI]);
      events.push({
        index: ep.startI, timeSec: timeSeconds[ep.startI], time: timeLabels[ep.startI],
        type: 'LIMIT_' + (param.id || param.key || param.name) + '_' + ep.side, source: 'limit',
        label: `${param.abbr || param.name} ${ep.side}`,
        detail: limit.description || param.desc || '',
        note: limit.note || '',
        severity: ep.severity,
        color: ep.severity === 'critical' ? '#ff4d63' : '#ffc24b',
        value: ep.peak.toFixed(1), unit: param.unit, threshold: ep.bound,
        durationSec: Math.round(durSec)
      });
      ep = null;
    };

    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v === null) continue;
      if (groundMask && groundMask[i]) { if (ep) close(i); continue; }
      const hit = classify(limit, v);

      if (hit && ep && hit.side === ep.side) {
        // episode continues — track peak and escalate severity
        if (Math.abs(v - ep.bound) > Math.abs(ep.peak - ep.bound)) ep.peak = v;
        if (hit.severity === 'critical' && ep.severity === 'warning') {
          ep.severity = 'critical'; ep.bound = hit.bound;
        }
      } else {
        if (ep) close(i);
        if (hit) ep = { startI: i, side: hit.side, severity: hit.severity, peak: v, bound: hit.bound };
      }
    }
    if (ep) close(data.length - 1);
  }
  return events;
}
