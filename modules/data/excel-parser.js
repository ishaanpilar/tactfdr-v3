/* FDR parser v2 — header-driven, built against the real export format
   documented in REFERENCE_DATA.md (analysed from client reference files).

   Real export layout (every group sheet):
     R1  <tail/sim>_<ddmmyy…> | export datetime
     R2  Relative | dd mm yy hh min sec | <param names, line 1>
     R3  Time     |                     | <param names, line 2 — join with R2!>
     R4  HH:MM:SS |                     | <units>
     R5+ data — ~2 rows per second; the 2nd row of each second is sparse
         (fast-sampled params only) and must be MERGED, not treated as a
         separate sample.

   Format facts the v1 parser got wrong, all handled here:
   - column layouts vary per aircraft (GP1 ships as 38/40/43 cols) → columns
     are matched by NAME, never by index
   - cols 1–6 carry absolute GMT date/time → true flight dates
   - gp9/gp16 discretes are "ON"/"OFF" strings
   - groups live in separate sheets/files with different start times →
     everything merges onto one master timeline (absolute time when
     available)
   - lat/lon are DMS strings in GP2's "pp lat"/"pp long"
*/

export function dmsToDecimal(dmsStr) {
  if (!dmsStr || typeof dmsStr !== 'string') return null;
  const m = dmsStr.trim().match(/([NSEW])\s*(\d+)\s+(\d+)'(\d+)"/);
  if (!m) return null;
  let d = parseInt(m[2]) + parseInt(m[3]) / 60 + parseInt(m[4]) / 3600;
  if (m[1] === 'S' || m[1] === 'W') d = -d;
  return Math.round(d * 1e6) / 1e6;
}

export function formatHMS(totalSec) {
  totalSec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/* Same normalization as tools/extract_dictionaries.py: lowercase,
   alphanumerics + '#' (Q1 torque ≠ q#1 pitch rate), TGT→T alias. */
export function norm(name) {
  let n = String(name).toLowerCase().replace(/[^a-z0-9#]/g, '');
  n = n.replace(/^tgt(\d)/, 't$1');
  return n;
}

const TIME_KEYS = new Set(['relativetime', 'time', 'dd', 'mm', 'yy', 'hh', 'min', 'sec',
  'gmthh', 'gmtmin', 'gmtectens', 'gmtsectens', 'gmt152', 'gmt153', 'gmttenth']);

/* ---------------- sheet-level parsing ---------------- */

function parseCell(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const up = s.toUpperCase();
  if (up === 'ON') return 1;
  if (up === 'OFF') return 0;
  const n = parseFloat(s);
  return isNaN(n) ? s : n; // keep strings (DMS coords) as-is
}

function relToSec(str) {
  const m = String(str).trim().match(/^(\d+):(\d+):(\d+)$/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}

/* Group identification: header fingerprint first (the sim export has a
   sheet named gp6 carrying GP10 parameters — sheet names lie), sheet-name
   hint to disambiguate twins (gp12/gp14 share BACON1). */
function classifyGroup(keys, sheetName) {
  const hintMatch = String(sheetName).toLowerCase().match(/g\s*p\s*-?\s*(\d+)/);
  const hint = hintMatch ? 'gp' + hintMatch[1] : null;
  const has = (k) => keys.has(k);
  let fp = null, family = null;
  if (has('nmr')) { fp = 'gp1'; family = ['gp1']; }
  else if (has('pplat') || has('gdspd')) { fp = 'gp2'; family = ['gp2']; }
  else if (has('chp1') || has('mw1')) { fp = 'gp9'; family = ['gp9']; }
  else if (has('pwrloss') || has('engchp1')) { fp = 'gp16'; family = ['gp16']; }
  else if (has('afd1')) { fp = 'gp10'; family = ['gp10', 'gp6']; }
  else if (has('afd2')) { fp = 'gp11'; family = ['gp11']; }
  else if (has('bacon1')) { fp = 'gp14'; family = ['gp14', 'gp12']; }
  else if (has('bacon2')) { fp = 'gp15'; family = ['gp15']; }
  else if (has('zpadc1') || has('iasadc1')) { fp = 'gp5'; family = ['gp5', 'gp6']; }
  if (fp && hint && family.includes(hint)) return hint;
  return fp || hint;
}

/** Parse one worksheet into a group block, or null if it isn't an FDR sheet. */
function parseSheet(ws, sheetName) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  if (rows.length < 5) return null;

  const h2 = rows[1] || [], h3 = rows[2] || [], h4 = rows[3] || [];
  const width = Math.max(h2.length, h3.length, h4.length);
  const cols = [];
  for (let c = 0; c < width; c++) {
    const name = [h2[c], h3[c]]
      .map(v => v === null || v === undefined ? '' : String(v).trim())
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    cols.push({
      idx: c, name,
      unit: h4[c] !== null && h4[c] !== undefined ? String(h4[c]).trim() : '',
      key: norm(name)
    });
  }
  if (!cols.length || cols[0].key !== 'relativetime') return null; // not an FDR sheet

  const timeIdx = {};
  for (const c of cols) if (TIME_KEYS.has(c.key)) timeIdx[c.key] = c.idx;
  const dataCols = cols.filter(c => c.name && !TIME_KEYS.has(c.key));
  if (!dataCols.length) return null;

  const keys = new Set(dataCols.map(c => c.key));
  const group = classifyGroup(keys, sheetName) || 'gp?';

  // data rows: merge consecutive rows sharing a Relative Time (subframes)
  const samples = [];
  let prev = null;
  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const relSec = relToSec(row[0]);
    if (relSec === null) continue;

    let s = (prev && prev.relSec === relSec) ? prev : null;
    if (!s) {
      s = { relSec, absSec: null, vals: Object.create(null) };
      samples.push(s);
      prev = s;
    }
    if (s.absSec === null &&
        ['dd', 'mm', 'yy', 'hh', 'min', 'sec'].every(k => timeIdx[k] !== undefined)) {
      const g = (k) => parseFloat(row[timeIdx[k]]);
      const dd = g('dd'), mm = g('mm'), yy = g('yy'), hh = g('hh'), mi = g('min'), ss = g('sec');
      // real recorders emit garbage date rows (observed: dd=0 mm=0) — validate
      // strictly or one bad row poisons the whole absolute timeline
      if ([dd, mm, yy, hh, mi, ss].every(v => !isNaN(v)) &&
          yy > 1990 && yy < 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 &&
          hh < 24 && mi < 60 && ss < 60) {
        s.absSec = Date.UTC(yy, mm - 1, dd, hh, mi, ss) / 1000;
      }
    }
    for (const c of dataCols) {
      if (s.vals[c.key] === undefined || s.vals[c.key] === null) {
        const v = parseCell(row[c.idx]);
        if (v !== null) s.vals[c.key] = v;
      }
    }
  }
  if (samples.length < 2) return null;

  return {
    sheetName, group,
    source: rows[0] && rows[0][0] ? String(rows[0][0]).trim() : '',
    exportStamp: rows[0] && rows[0][1] ? String(rows[0][1]).trim() : '',
    cols: dataCols, samples
  };
}

/* ---------------- block merge onto a master timeline ---------------- */

function mergeBlocks(blocks, dict, filename) {
  // timebase: absolute GMT when every block has it, else relative
  const useAbs = blocks.every(b => b.samples.some(s => s.absSec !== null));

  for (const b of blocks) {
    if (!useAbs) continue;

    // glitch rejection: a lone dated sample whose clock offset disagrees
    // with BOTH neighbours (which agree with each other) is recorder noise
    const dated = b.samples.filter(s => s.absSec !== null);
    for (let i = 1; i < dated.length - 1; i++) {
      const o = (s) => s.absSec - s.relSec;
      if (Math.abs(o(dated[i]) - o(dated[i - 1])) > 60 &&
          Math.abs(o(dated[i]) - o(dated[i + 1])) > 60 &&
          Math.abs(o(dated[i - 1]) - o(dated[i + 1])) < 60) {
        dated[i].absSec = null;
      }
    }

    // fill missing absSec from the nearest dated sample's offset
    let anchor = b.samples.find(s => s.absSec !== null);
    let offset = anchor ? anchor.absSec - anchor.relSec : 0;
    for (const s of b.samples) {
      if (s.absSec !== null) offset = s.absSec - s.relSec;
      else s.absSec = s.relSec + offset;
    }
  }
  const tOf = (s) => useAbs ? s.absSec : s.relSec;

  const tSet = new Set();
  for (const b of blocks) for (const s of b.samples) tSet.add(tOf(s));
  const master = [...tSet].sort((a, b) => a - b);
  const tIndex = new Map(master.map((t, i) => [t, i]));
  const n = master.length;
  const t0 = master[0];

  const dictParams = {};
  if (dict && dict.groups) {
    for (const [gid, g] of Object.entries(dict.groups)) {
      for (const [key, p] of Object.entries(g.params)) dictParams[gid + ':' + key] = p;
    }
  }
  const lookupDict = (group, key) =>
    dictParams[group + ':' + key] ||
    Object.entries(dictParams).find(([k]) => k.endsWith(':' + key))?.[1] || null;

  const parameters = {}, statusBits = [];
  let latCol = null, lonCol = null;

  for (const b of blocks) {
    for (const c of b.cols) {
      const data = new Array(n).fill(null);
      for (const s of b.samples) {
        const v = s.vals[c.key];
        if (v !== undefined && v !== null) data[tIndex.get(tOf(s))] = v;
      }

      if (c.key === 'pplat') { latCol = data.map(v => typeof v === 'string' ? dmsToDecimal(v) : null); continue; }
      if (c.key === 'pplong') { lonCol = data.map(v => typeof v === 'string' ? dmsToDecimal(v) : null); continue; }

      // numeric coercion; leftover strings become null
      for (let i = 0; i < n; i++) if (typeof data[i] === 'string') data[i] = null;

      const de = lookupDict(b.group, c.key);
      const vals = data.filter(v => v !== null);
      if (!vals.length) continue;
      const isDiscrete = (de && de.discrete) || vals.every(v => v === 0 || v === 1);

      const id = b.group + ':' + c.key;
      const entry = {
        id, key: c.key, group: b.group,
        abbr: (de && de.abbr) || c.name,
        desc: (de && de.description) || '',
        unit: c.unit || (de && de.unit) || '',
        data
      };
      if (isDiscrete) {
        entry.trigger = (de && de.trigger) || '';
        statusBits.push(entry);
      } else if (parameters[id]) {
        // same param from a second file — fill gaps
        const ex = parameters[id].data;
        for (let i = 0; i < n; i++) if (ex[i] === null && data[i] !== null) ex[i] = data[i];
      } else {
        parameters[id] = entry;
      }
    }
  }

  // forward-fill continuous params (subframe gaps + cross-group alignment)
  for (const p of Object.values(parameters)) {
    let last = null;
    for (let i = 0; i < p.data.length; i++) {
      if (p.data[i] !== null) last = p.data[i];
      else if (last !== null) p.data[i] = last;
    }
  }
  // status bits: forward-fill so transitions stay sharp but gaps don't read as OFF
  for (const bit of statusBits) {
    let last = null;
    for (let i = 0; i < bit.data.length; i++) {
      if (bit.data[i] !== null) last = bit.data[i];
      else if (last !== null) bit.data[i] = last;
    }
  }

  // track from GP2 lat/lon (+ radalt / GD SPD when present)
  let track = new Array(n).fill(null);
  if (latCol && lonCol) {
    const altP = Object.values(parameters).find(p => p.key === 'radalt');
    const spdP = Object.values(parameters).find(p => p.key === 'gdspd');
    let lastLat = null, lastLon = null;
    for (let i = 0; i < n; i++) {
      if (latCol[i] !== null) lastLat = latCol[i];
      if (lonCol[i] !== null) lastLon = lonCol[i];
      if (lastLat !== null && lastLon !== null) {
        track[i] = {
          lat: lastLat, lon: lastLon,
          alt: altP && altP.data[i] !== null ? altP.data[i] : 0,
          spd: spdP && spdP.data[i] !== null ? spdP.data[i] : 0
        };
      }
    }
  }

  const timeSeconds = master.map(t => t - t0);
  const first = blocks[0];
  let dateStr = '';
  if (useAbs) {
    const d = new Date(t0 * 1000);
    dateStr = String(d.getUTCDate()).padStart(2, '0') + '-' +
              String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + d.getUTCFullYear();
  }

  return {
    metadata: {
      filename,
      source: first.source,
      date: dateStr,
      records: n,
      duration: formatHMS(timeSeconds[n - 1]),
      groups: [...new Set(blocks.map(b => b.group))]
    },
    timeSeconds,
    timeLabels: timeSeconds.map(formatHMS),
    absStartMs: useAbs ? t0 * 1000 : null,
    parameters, statusBits, track
  };
}

/* ---------------- public API ---------------- */

/** Parse one or more workbooks ([{buffer, name}]) into a single flight. */
export function parseWorkbooks(files, dict) {
  const blocks = [];
  const skipped = [];
  for (const f of files) {
    const wb = XLSX.read(f.buffer, { type: 'array', cellDates: false });
    for (const sn of wb.SheetNames) {
      const block = parseSheet(wb.Sheets[sn], sn);
      if (block) blocks.push(block);
      else skipped.push(f.name + ' / ' + sn);
    }
  }
  if (!blocks.length) {
    throw new Error('No FDR group sheets recognized. Expected the standard export layout (Relative Time / dd mm yy hh min sec headers).');
  }
  const filename = files.map(f => f.name).join(' + ');
  const result = mergeBlocks(blocks, dict, filename);
  result.metadata.skippedSheets = skipped;
  return result;
}

export function parseWorkbook(arrayBuffer, filename, dict) {
  return parseWorkbooks([{ buffer: arrayBuffer, name: filename }], dict);
}

/** Adapt TactFDR's pre-processed FLIGHT_DATA array ({lat,lon,alt,spd,time})
 *  into the v2 shape — used by the bundled demo. */
export function fromTrackArray(trackArray, filename = 'flight_data.js (demo)') {
  const timeSeconds = [], track = [];
  const spd = { id: 'gp2:gdspd', key: 'gdspd', group: 'gp2', abbr: 'GD SPD', desc: 'Ground Speed', unit: 'kt', data: [] };
  const alt = { id: 'gp2:radalt', key: 'radalt', group: 'gp2', abbr: 'RADALT', desc: 'Radio altitude', unit: 'm', data: [] };
  let base = null;
  for (const pt of trackArray) {
    const sec = relToSec(pt.time);
    if (sec === null) continue;
    if (base === null) base = sec;
    timeSeconds.push(sec - base);
    track.push({ lat: pt.lat, lon: pt.lon, alt: pt.alt, spd: pt.spd });
    alt.data.push(pt.alt);
    spd.data.push(pt.spd);
  }
  return {
    metadata: {
      filename, source: 'IA-3101 (demo)', date: '', records: timeSeconds.length,
      duration: formatHMS(timeSeconds[timeSeconds.length - 1] || 0), groups: ['gp2']
    },
    timeSeconds,
    timeLabels: timeSeconds.map(formatHMS),
    absStartMs: null,
    parameters: { 'gp2:gdspd': spd, 'gp2:radalt': alt },
    statusBits: [],
    track
  };
}
