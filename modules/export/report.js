/* Flight Data Report — the "click the tail number, get the story of the
   flight" deliverable. Builds a print-styled document (metadata header,
   exceedance summary, chronological sequence of events, chart snapshot)
   and hands it to the browser's print engine → PDF. No PDF library needed,
   which keeps the offline bundle lean. */

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SEV_ORDER = { critical: 0, warning: 1, caution: 2 };
const MAX_ROWS = 400;

export function createReport(previewEl, printRoot, model, getEvents, chartHost) {

  async function buildHTML() {
    const events = [...getEvents()].sort((a, b) => a.timeSec - b.timeSec);
    const m = model.metadata;
    const now = new Date();

    // chart snapshot (current chart state)
    let chartImg = '';
    try {
      const url = await Plotly.toImage(chartHost, { format: 'png', width: 1500, height: 520 });
      chartImg = `<img class="rp-chart" src="${url}" alt="Parameter traces">`;
    } catch (e) { /* chart not rendered yet — report ships without snapshot */ }

    const count = (sev) => events.filter(e => e.severity === sev).length;

    // exceedance summary: group limit episodes by label
    const limitEvents = events.filter(e => e.source === 'limit');
    const groups = {};
    for (const e of limitEvents) {
      const g = groups[e.label] || (groups[e.label] = { label: e.label, unit: e.unit, count: 0, peak: null, totalDur: 0, worstSev: 'warning' });
      g.count++;
      g.totalDur += e.durationSec || 0;
      const v = parseFloat(e.value);
      if (g.peak === null || Math.abs(v) > Math.abs(g.peak)) g.peak = v;
      if (e.severity === 'critical') g.worstSev = 'critical';
    }

    const rows = events.slice(0, MAX_ROWS);
    const truncated = events.length > MAX_ROWS;

    return `
      <div class="rp-head">
        <div>
          <div class="rp-title">TACT-FDR · FLIGHT DATA REPORT</div>
          <div class="rp-sub">Automated sequence-of-events analysis — for briefing use, verify against raw data</div>
        </div>
        <div class="rp-meta mono">
          Generated ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${now.toTimeString().slice(0, 5)}<br>
          Limits source: ${esc(limitsSourceLabel())}
        </div>
      </div>

      <table class="rp-kv">
        <tr><th>File</th><td class="mono">${esc(m.filename)}</td><th>Records</th><td class="mono">${m.records.toLocaleString()}</td></tr>
        <tr><th>Flight date</th><td class="mono">${esc(m.date || '—')}</td><th>Duration</th><td class="mono">${esc(m.duration)}</td></tr>
        <tr><th>Events</th><td class="mono">${events.length} total — ${count('critical')} critical / ${count('warning')} warning / ${count('caution')} info</td>
            <th>GPS track</th><td class="mono">${model.hasTrack ? 'present' : 'not present'}</td></tr>
      </table>

      ${chartImg}

      <h2>Limit Exceedance Summary</h2>
      ${Object.keys(groups).length === 0
        ? '<p class="rp-none">No limit exceedances against the loaded limits table.</p>'
        : `<table class="rp-table">
            <tr><th>Parameter / Side</th><th>Episodes</th><th>Peak</th><th>Total duration</th><th>Worst severity</th></tr>
            ${Object.values(groups).map(g => `
              <tr><td>${esc(g.label)}</td><td>${g.count}</td><td>${g.peak.toFixed(1)} ${esc(g.unit)}</td>
                  <td>${g.totalDur} s</td><td class="sev-${g.worstSev}">${g.worstSev.toUpperCase()}</td></tr>`).join('')}
          </table>`}

      <h2>Sequence of Events${truncated ? ` <span class="rp-none">(first ${MAX_ROWS} of ${events.length})</span>` : ''}</h2>
      ${rows.length === 0
        ? '<p class="rp-none">No events detected within current thresholds.</p>'
        : `<table class="rp-table">
            <tr><th>Time</th><th>Severity</th><th>Event</th><th>Value</th><th>Limit</th><th>Duration</th><th>Source</th></tr>
            ${rows.map(e => `
              <tr>
                <td class="mono">${e.time}</td>
                <td class="sev-${e.severity}">${e.severity.toUpperCase()}</td>
                <td>${esc(e.label)}</td>
                <td class="mono">${esc(e.value)} ${esc(e.unit)}</td>
                <td class="mono">${esc(String(e.threshold))}</td>
                <td class="mono">${e.durationSec ? e.durationSec + ' s' : '—'}</td>
                <td>${e.source}</td>
              </tr>`).join('')}
          </table>`}

      <div class="rp-foot">TACT-FDR v3 · thresholds and limits are analyst-configurable · page generated locally, no data left this machine</div>
    `;
  }

  let limitsSourceLabel = () => 'PLACEHOLDER';

  return {
    setLimitsSourceLabel(fn) { limitsSourceLabel = fn; },
    async generate() {
      const html = await buildHTML();
      previewEl.innerHTML = html;
      printRoot.innerHTML = html;
    },
    print() { window.print(); }
  };
}
