/* Event log panel — one chronological ledger merging three sources:
   rate-derived events (engine/events.js), limit exceedance episodes
   (data/limits.js), and discrete status-bit transitions. Severity-badged,
   click-to-seek, with a threshold editor and runtime limits import. */

import { detectEvents, detectStatusEvents, combineEvents, DEFAULT_THRESHOLDS, THRESHOLD_LABELS } from '../engine/events.js';
import { detectLimitEvents, PLACEHOLDER_LIMITS } from '../data/limits.js';

export function createEventLog(root, model, playback, onEventsChanged) {
  const listEl = root.querySelector('#events-list');
  const badgesEl = root.querySelector('#events-badges');
  const thGrid = root.querySelector('#th-grid');
  const thresholds = { ...DEFAULT_THRESHOLDS };
  let limitsTable = PLACEHOLDER_LIMITS;
  let limitsLabel = 'PLACEHOLDER';
  let events = [];

  function run() {
    events = combineEvents(
      detectEvents(model, thresholds),
      detectLimitEvents(limitsTable, model),
      detectStatusEvents(model)
    );
    renderBadges();
    renderList();
    onEventsChanged(events);
  }

  function renderBadges() {
    const count = (sev) => events.filter(e => e.severity === sev).length;
    const c = count('critical'), w = count('warning'), i = count('caution');
    badgesEl.innerHTML =
      (c ? `<span class="evt-badge critical">${c} CRIT</span>` : '') +
      (w ? `<span class="evt-badge warning">${w} WARN</span>` : '') +
      (i ? `<span class="evt-badge caution">${i} INFO</span>` : '') +
      (events.length === 0 ? '<span class="evt-badge ok">CLEAR</span>' : '');
  }

  function renderList() {
    if (events.length === 0) {
      listEl.innerHTML = '<div class="evt-empty">No anomalies within thresholds</div>';
      return;
    }
    listEl.innerHTML = events.map(evt => `
      <button class="evt-row" data-idx="${evt.index}">
        <span class="sev ${evt.severity}"></span>
        <span class="einfo">
          <span class="elabel">${evt.label}</span>
          <span class="edetail">${detailLine(evt)}</span>
        </span>
        <span class="etime">${evt.time}</span>
      </button>
    `).join('');
    listEl.querySelectorAll('.evt-row').forEach(row => {
      row.addEventListener('click', () => {
        playback.pause();
        playback.seek(parseInt(row.dataset.idx));
      });
    });
  }

  function detailLine(evt) {
    if (evt.source === 'status') return 'recorder status bit';
    let s = `${evt.value} ${evt.unit} · limit ${evt.threshold}`;
    if (evt.durationSec) s += ` · ${evt.durationSec}s`;
    return s;
  }

  // threshold editor
  thGrid.innerHTML = Object.keys(thresholds).map(key => `
    <label for="th-${key}">${THRESHOLD_LABELS[key]}</label>
    <input class="ctl-num" id="th-${key}" data-key="${key}" type="number" step="0.5" value="${thresholds[key]}">
  `).join('');
  thGrid.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!isNaN(v)) thresholds[input.dataset.key] = v;
      run();
    });
  });

  run();
  return {
    get events() { return events; },
    get limitsTable() { return limitsTable; },
    get limitsLabel() { return limitsLabel; },
    setLimits(table, label) { limitsTable = table; limitsLabel = label; run(); },
    rerun: run
  };
}
