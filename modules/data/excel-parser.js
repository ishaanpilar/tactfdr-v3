/* Unified FDR Excel parser — merges the parameter-column parser from
   FDR-Visualization with the DMS lat/lon track parser from TactFDR.
   One workbook read produces both the chart parameters and the map track.

   Expected sheet layout (per both source repos):
     row 1  metadata (filename, timestamp)
     row 2  parameter abbreviations
     row 3  parameter full names
     row 4  units
     row 5+ data — col A time, cols K+ parameters, col S/T lat/lon (DMS), col U alt
*/

const PARAM_DEFS = {
  10: { name: 'Ground Speed',   unit: 'kt',  abbr: 'GD SPD'  },
  11: { name: 'Wind Speed',     unit: 'kt',  abbr: 'WDSPD'   },
  12: { name: 'Wind Direction', unit: 'deg', abbr: 'WDDIR'   },
  13: { name: 'Drift Angle',    unit: 'deg', abbr: 'DRIFT'   },
  14: { name: 'Impact Temp',    unit: '°C',  abbr: 'IMP TMP' },
  15: { name: 'Static Temp',    unit: '°C',  abbr: 'STA TMP' },
  16: { name: 'Sel Course',     unit: 'deg', abbr: 'SEL CRS' },
  17: { name: 'Desired Track',  unit: 'deg', abbr: 'DES TRK' },
  20: { name: 'Radar Altitude', unit: 'm',   abbr: 'RADALT'  }
};

const COL_TIME = 0, COL_SPD = 10, COL_LAT = 18, COL_LON = 19, COL_ALT = 20;
const DATA_START_ROW = 4; // 0-indexed

export function dmsToDecimal(dmsStr) {
  if (!dmsStr || typeof dmsStr !== 'string') return null;
  const m = dmsStr.trim().match(/([NSEW])(\d+)\s+(\d+)'(\d+)"/);
  if (!m) return null;
  let d = parseInt(m[2]) + parseInt(m[3]) / 60 + parseInt(m[4]) / 3600;
  if (m[1] === 'S' || m[1] === 'W') d = -d;
  return Math.round(d * 1e6) / 1e6;
}

function parseTimeCell(timeVal) {
  if (timeVal instanceof Date) {
    const h = timeVal.getUTCHours(), m = timeVal.getUTCMinutes(), s = timeVal.getUTCSeconds();
    return h * 3600 + m * 60 + s;
  }
  if (typeof timeVal === 'number') {
    return Math.round(timeVal * 86400); // Excel fractional days
  }
  if (typeof timeVal === 'string') {
    const parts = timeVal.trim().match(/(\d+):(\d+):(\d+)/);
    if (parts) return (+parts[1]) * 3600 + (+parts[2]) * 60 + (+parts[3]);
    const d = new Date(timeVal);
    if (!isNaN(d.getTime())) return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  }
  return null;
}

export function formatHMS(totalSec) {
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = Math.floor(totalSec % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/** Parse an ArrayBuffer of an .xlsx/.xls FDR export.
 *  Returns { metadata, timeSeconds, timeLabels, parameters, track } where
 *  parameters = { colIndex: { name, unit, abbr, data[] } } aligned to timeSeconds,
 *  track = [{lat,lon,alt,spd}] aligned to timeSeconds (null entries where no fix). */
export function parseWorkbook(arrayBuffer, filename) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
  if (rows.length < DATA_START_ROW + 1) throw new Error('Insufficient data rows in the Excel file.');

  const metadata = { filename, date: (rows[0] && rows[0][1]) || '', records: 0, duration: '' };
  const headerRow = rows[1] || [];
  const unitRow = rows[3] || [];

  // parameter definitions: known map + auto-detect extra columns past col 9
  const parameters = {};
  for (let col = 0; col < headerRow.length; col++) {
    if (col < 10 || col === COL_LAT || col === COL_LON) continue;
    const headerVal = String(headerRow[col] || '').trim();
    if (!headerVal && !PARAM_DEFS[col]) continue;
    const def = PARAM_DEFS[col] || {
      name: headerVal, unit: String(unitRow[col] || '').trim(), abbr: headerVal.substring(0, 7).toUpperCase()
    };
    parameters[col] = { ...def, colIndex: col, data: [] };
  }
  // Guarantee the core columns exist even with a sparse header row
  for (const col of [COL_SPD, COL_ALT]) {
    if (!parameters[col]) parameters[col] = { ...PARAM_DEFS[col], colIndex: col, data: [] };
  }

  const timeSeconds = [], timeLabels = [], track = [];

  for (let i = DATA_START_ROW; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const sec = parseTimeCell(row[COL_TIME]);
    if (sec === null) continue;

    timeSeconds.push(sec);
    timeLabels.push(formatHMS(sec));

    for (const colStr of Object.keys(parameters)) {
      const col = +colStr;
      let val = row[col];
      if (val === null || val === undefined || (typeof val === 'string' && val.trim() === '')) {
        val = null;
      } else {
        val = parseFloat(val);
        if (isNaN(val)) val = null;
      }
      parameters[col].data.push(val);
    }

    const lat = dmsToDecimal(row[COL_LAT] != null ? String(row[COL_LAT]) : '');
    const lon = dmsToDecimal(row[COL_LON] != null ? String(row[COL_LON]) : '');
    if (lat !== null && lon !== null) {
      const alt = parseFloat(row[COL_ALT]); const spd = parseFloat(row[COL_SPD]);
      track.push({ lat, lon, alt: isNaN(alt) ? 0 : alt, spd: isNaN(spd) ? 0 : spd });
    } else {
      track.push(null);
    }
  }

  // forward-fill parameter nulls for gap-free traces (matches source behaviour)
  for (const colStr of Object.keys(parameters)) {
    const data = parameters[colStr].data;
    let last = null;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== null) last = data[i];
      else if (last !== null) data[i] = last;
    }
  }
  // drop parameter columns that never produced a value
  for (const colStr of Object.keys(parameters)) {
    if (!parameters[colStr].data.some(v => v !== null)) delete parameters[colStr];
  }

  // classify discrete status/warning bits: a column whose values are only
  // ever 0/1 is a status flag (HRS invalid, AFCS disengage, …), not a
  // plottable parameter — route it to the event pipeline instead
  const statusBits = [];
  for (const colStr of Object.keys(parameters)) {
    const p = parameters[colStr];
    if (p.colIndex === COL_ALT || p.colIndex === COL_SPD) continue; // never demote core params
    const vals = p.data.filter(v => v !== null);
    if (vals.length && vals.every(v => v === 0 || v === 1)) {
      statusBits.push({ name: p.name, abbr: p.abbr, colIndex: p.colIndex, data: p.data });
      delete parameters[colStr];
    }
  }

  metadata.records = timeSeconds.length;
  metadata.duration = timeLabels.length ? timeLabels[timeLabels.length - 1] : '';
  return { metadata, timeSeconds, timeLabels, parameters, track, statusBits };
}

/** Adapt TactFDR's pre-processed FLIGHT_DATA array ({lat,lon,alt,spd,time})
 *  into the same shape parseWorkbook returns — used by the demo loader. */
export function fromTrackArray(trackArray, filename = 'flight_data.js (demo)') {
  const timeSeconds = [], timeLabels = [], track = [];
  const alt = { ...PARAM_DEFS[COL_ALT], colIndex: COL_ALT, data: [] };
  const spd = { ...PARAM_DEFS[COL_SPD], colIndex: COL_SPD, data: [] };

  for (const pt of trackArray) {
    const sec = parseTimeCell(pt.time);
    if (sec === null) continue;
    timeSeconds.push(sec);
    timeLabels.push(formatHMS(sec));
    track.push({ lat: pt.lat, lon: pt.lon, alt: pt.alt, spd: pt.spd });
    alt.data.push(pt.alt);
    spd.data.push(pt.spd);
  }
  return {
    metadata: { filename, date: '', records: timeSeconds.length, duration: timeLabels[timeLabels.length - 1] || '' },
    timeSeconds, timeLabels,
    parameters: { [COL_SPD]: spd, [COL_ALT]: alt },
    track,
    statusBits: []
  };
}
