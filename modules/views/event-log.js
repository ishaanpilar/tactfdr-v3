/* Event log panel — one chronological ledger merging three sources:
   rate-derived events, limit exceedance episodes (aircraft dictionary
   limits when available, placeholder otherwise), and discrete status-bit
   transitions labelled with their dictionary descriptions + trigger text.
   WOW ground gating suppresses on-ground noise (toggleable). */

import { detectEvents, detectStatusEvents, combineEvents, DEFAULT_THRESHOLDS, THRESHOLD_LABELS } from '../engine/events.js';
import { detectLimitEvents, limitsFromDictionary, PLACEHOLDER_LIMITS } from '../data/limits.js';

export function createEventLog(root, model, playback, dict, onEventsChanged) {
  const listEl = root.querySelector('#events-list');
  const badgesEl = root.querySelector('#events-badges');
  const thGrid = root.querySelector('#th-grid');
  const gateBox = root.querySelector('#gate-ground');
  const thresholds = { ...DEFAULT_THRESHOLDS };

  const dictLimits = limitsFromDictionary(dict);
  let limitsTable = dictLimits || PLACEHOLDER_LIMITS;
  let limitsLabel = dictLimits ? 'AIRCRAFT DICT' : 'PLACEHOLDER';
  let gateGround = true;
  let events = [];

  function run() {
    const mask = gateGround ? model.groundMask : null;
    events = combineEvents(
      detectEvents(model, thresholds, mask),
      detectLimitEvents(limitsTable, model, mask),
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
    const cap = 500; // DOM safety for pathological logs
    listEl.innerHTML = events.slice(0, cap).map(evt => `
      <button class="evt-row" data-idx="${evt.index}" title="${(evt.note || evt.detail || '').replace(/"/g, '&quot;')}">
        <span class="sev ${evt.severity}"></span>
        <span class="einfo">
          <span class="elabel">${evt.label}</span>
          <span class="edetail">${detailLine(evt)}</span>
        </span>
        <span class="etime">${evt.time}</span>
      </button>
    `).join('') + (events.length > cap ? `<div class="evt-empty">+${events.length - cap} more — see report</div>` : '');
    listEl.querySelectorAll('.evt-row').forEach(row => {
      row.addEventListener('click', () => {
        playback.pause();
        playback.seek(parseInt(row.dataset.idx));
      });
    });
  }

  function detailLine(evt) {
    if (evt.source === 'status') return evt.detail || 'recorder status bit';
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

  if (gateBox) {
    gateBox.checked = true;
    gateBox.disabled = !model.groundMask;
    gateBox.title = model.groundMask
      ? 'Suppress events while weight-on-wheels (GP9 WOW bits)'
      : 'No WOW bits in this flight — gate unavailable';
    gateBox.addEventListener('change', () => { gateGround = gateBox.checked; run(); });
  }

  run();
  return {
    get events() { return events; },
    get limitsTable() { return limitsTable; },
    get limitsLabel() { return limitsLabel; },
    setLimits(table, label) { limitsTable = table; limitsLabel = label; run(); },
    rerun: run
  };
}
