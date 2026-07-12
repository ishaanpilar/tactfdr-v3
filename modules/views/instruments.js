/* Instruments rail — TactFDR's canvas dial replaced with the ACCS radial
   gauge primitive (components.css §RADIAL GAUGE) + readout cells + VSI bar.
   All values update from the shared playback clock. */

import { trackAt } from '../engine/interpolate.js';

const CIRC = 2 * Math.PI * 54; // r=54 gauge circle

export function createInstruments(root, model, playback) {
  const el = {
    gaugeArc: root.querySelector('#alt-arc'),
    gaugeNum: root.querySelector('#alt-num'),
    alt: root.querySelector('#ro-alt'),
    spd: root.querySelector('#ro-spd'),
    hdg: root.querySelector('#ro-hdg'),
    time: root.querySelector('#ro-time'),
    pos: root.querySelector('#ro-pos'),
    vsiVal: root.querySelector('#vsi-val'),
    vsiNeedle: root.querySelector('#vsi-needle')
  };

  const maxAlt = model.altData ? Math.max(1, ...model.altData.filter(v => v !== null)) : 1;

  function update(pos) {
    const i = Math.floor(pos);
    const pt = model.hasTrack ? trackAt(model.track, pos) : null;

    const alt = pt ? pt.alt : (model.altData ? model.altData[i] : null);
    const spd = pt ? pt.spd : (model.spdData ? model.spdData[i] : null);
    const hdg = model.heading ? model.heading[i] : null;
    const vsi = model.altRate ? model.altRate[i] : null;

    if (alt !== null && alt !== undefined) {
      const frac = Math.max(0, Math.min(1, alt / maxAlt));
      el.gaugeArc.style.strokeDashoffset = CIRC * (1 - frac);
      el.gaugeNum.textContent = Math.round(alt);
      el.alt.textContent = Math.round(alt);
    }
    if (spd !== null && spd !== undefined) el.spd.textContent = Math.round(spd);
    el.hdg.textContent = hdg !== null && hdg !== undefined ? String(Math.round(hdg)).padStart(3, '0') + '°' : '---';
    el.time.textContent = model.labelAt(i);
    if (el.pos) el.pos.textContent = pt ? `${pt.lat.toFixed(5)} / ${pt.lon.toFixed(5)}` : '—';

    if (vsi !== null && vsi !== undefined) {
      el.vsiVal.textContent = (vsi >= 0 ? '+' : '') + vsi.toFixed(1);
      const clamped = Math.max(-10, Math.min(10, vsi));
      el.vsiNeedle.style.left = (50 + clamped * 5) + '%';
    } else {
      el.vsiVal.textContent = '0.0';
      el.vsiNeedle.style.left = '50%';
    }
  }

  playback.onTick(update);
  update(0);
  return { update };
}
