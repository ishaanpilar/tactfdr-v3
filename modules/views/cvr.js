/* CVR module — cockpit voice audio locked to the master playback clock,
   with waveform, FDR-alignment offset, and a searchable transcript pane.

   Time mapping:  audioTime = flightTime(pos) − t0 − offset
   `offset` is how many seconds after the FDR recording starts that the CVR
   recording starts (negative = CVR started first). There is no guaranteed
   common time reference between the recorders, so the offset is an analyst
   control, nudgeable to ±0.1 s against known cues (rotor start, radio calls).

   Audio keeps sync by rate-matching up to 4× (browser playbackRate ceiling
   for intelligible audio); beyond that the audio mutes and the transcript
   alone carries the channel, resyncing the moment the rate drops back. */

import { parseTranscript } from '../data/transcript.js';

const fmtT = (s) => {
  const sign = s < 0 ? '-' : '';
  s = Math.abs(s);
  return `${sign}${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export function createCVR(root, model, playback) {
  const el = {
    body: root.querySelector('#cvr-body'),
    status: root.querySelector('#cvr-status'),
    wave: root.querySelector('#cvr-wave'),
    waveWrap: root.querySelector('#cvr-wave-wrap'),
    cursor: root.querySelector('#cvr-cursor'),
    offset: root.querySelector('#cvr-offset'),
    audioTime: root.querySelector('#cvr-time'),
    gate: root.querySelector('#cvr-gate'),
    list: root.querySelector('#cvr-transcript'),
    search: root.querySelector('#cvr-search'),
    mute: root.querySelector('#btn-cvr-mute')
  };

  const audio = new Audio();
  audio.preload = 'auto';
  let duration = 0;
  let offset = 0;
  let peaks = null;
  let segments = [];
  let muted = false;
  let activeSeg = -1;

  const t0 = model.timeSeconds[0] || 0;
  const flightSec = (pos) => {
    const i = Math.floor(pos), f = pos - i;
    const a = model.timeSeconds[Math.min(i, model.n - 1)];
    const b = model.timeSeconds[Math.min(i + 1, model.n - 1)];
    return a + (b - a) * f;
  };
  const audioTimeAt = (pos) => flightSec(pos) - t0 - offset;

  /* ---------- audio loading + waveform ----------
     Duration + peaks come from an OfflineAudioContext decode, which needs
     no audio output device (a plain AudioContext can stall on machines
     without one). The media element is used purely for sound output and
     is never awaited — if it can't play, the panel still works as a
     synced waveform + transcript. */
  const withTimeout = (p, ms, what) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))
  ]);

  async function loadAudio(arrayBuffer, filename, objectUrl) {
    // long recordings decode slowly (a 100-min CVR is ~200 MB of PCM) —
    // the generous timeout is only a safety net against no-device hangs
    let buf = null;
    try {
      const ctx = new OfflineAudioContext(1, 8, 8000);
      buf = await withTimeout(ctx.decodeAudioData(arrayBuffer), 45000, 'audio decode');
    } catch (e) {
      console.warn('CVR waveform decode unavailable (' + e.message + ') — trying metadata only');
    }

    if (buf) {
      duration = buf.duration;
      const ch = buf.getChannelData(0);
      const BINS = 600;
      const per = Math.max(1, Math.floor(ch.length / BINS));
      peaks = new Float32Array(BINS);
      for (let b = 0; b < BINS; b++) {
        let max = 0;
        for (let i = b * per; i < Math.min(ch.length, (b + 1) * per); i += 16) {
          const v = Math.abs(ch[i]);
          if (v > max) max = v;
        }
        peaks[b] = max;
      }
    }

    audio.onerror = () => console.warn('CVR: media element cannot play this format; waveform/transcript sync still active');
    audio.src = objectUrl;

    if (!buf) {
      // no decode (rare) — duration from the media element, no waveform
      peaks = null;
      duration = await withTimeout(new Promise((res, rej) => {
        audio.onloadedmetadata = () => res(audio.duration);
        audio.onerror = () => rej(new Error('unsupported audio format'));
      }), 6000, 'audio metadata');
    }

    el.status.textContent = `${filename} · ${fmtT(duration)}`;
    el.status.classList.add('g');
    el.body.style.display = '';
    audio.volume = 1;

    // audio is muted above 4× (unintelligible) — landing on a fresh file at
    // the transport's default 5× would play silence with no explanation, so
    // drop to 1× and let the analyst speed back up deliberately
    if (playback.speed > 4) {
      playback.setSpeed(1);
      const sel = document.getElementById('speed-select');
      if (sel) sel.value = '1';
    }

    drawWave();
    syncTick(playback.pos, playback.playing);
  }

  function drawWave() {
    const dpr = window.devicePixelRatio || 1;
    const w = el.waveWrap.clientWidth, h = el.waveWrap.clientHeight;
    el.wave.width = w * dpr; el.wave.height = h * dpr;
    const ctx = el.wave.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.02)';
    ctx.fillRect(0, 0, w, h);
    if (!peaks) return;
    ctx.fillStyle = 'rgba(56,214,255,.45)';
    const bw = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const bh = Math.max(1, peaks[i] * (h - 4));
      ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
    }
  }

  /* ---------- clock sync ---------- */
  function syncTick(pos, playing) {
    if (!duration) return;
    const at = audioTimeAt(pos);
    el.audioTime.textContent = fmtT(at) + ' / ' + fmtT(duration);
    el.cursor.style.left = Math.max(0, Math.min(100, (at / duration) * 100)) + '%';

    const inRange = at >= 0 && at < duration;
    const speed = playback.speed;
    const canPlay = playing && inRange && speed <= 4 && !muted;

    // say WHY there's no sound instead of leaving a silent mystery
    if (el.gate) {
      el.gate.textContent =
        muted ? 'MUTED' :
        speed > 4 ? `AUDIO OFF AT ${speed}× — SET RATE ≤ 4×` :
        !inRange ? 'OUTSIDE RECORDING' : '';
    }

    if (canPlay) {
      audio.playbackRate = speed;
      if (Math.abs(audio.currentTime - at) > 0.35) audio.currentTime = at;
      if (audio.paused) audio.play().catch(() => {});
    } else {
      if (!audio.paused) audio.pause();
      if (inRange && !playing) audio.currentTime = Math.max(0, at);
    }

    highlightSegment(at);
  }

  playback.onTick(syncTick);
  playback.onState((playing) => { if (!playing && !audio.paused) audio.pause(); });

  /* ---------- waveform seek ---------- */
  el.waveWrap.addEventListener('click', (e) => {
    if (!duration) return;
    const rect = el.waveWrap.getBoundingClientRect();
    const at = ((e.clientX - rect.left) / rect.width) * duration;
    seekToAudioTime(at);
  });

  function seekToAudioTime(at) {
    const target = t0 + offset + at;
    // invert flightSec ≈ uniform sampling — good enough for a seek
    const pos = (target - t0) * model.samplesPerSec;
    playback.seek(pos);
  }

  /* ---------- offset control ---------- */
  function setOffset(v) {
    offset = v;
    el.offset.value = offset.toFixed(1);
    syncTick(playback.pos, playback.playing);
  }
  el.offset.addEventListener('change', () => {
    const v = parseFloat(el.offset.value);
    if (!isNaN(v)) setOffset(v);
  });
  root.querySelectorAll('[data-nudge]').forEach(btn =>
    btn.addEventListener('click', () => setOffset(offset + parseFloat(btn.dataset.nudge))));

  el.mute.addEventListener('click', () => {
    muted = !muted;
    el.mute.classList.toggle('engaged', muted);
    if (muted && !audio.paused) audio.pause();
  });

  /* ---------- transcript ---------- */
  function loadTranscript(text, filename) {
    segments = parseTranscript(text, filename);
    el.body.style.display = ''; // transcript is useful even with no audio
    if (!duration) el.status.textContent = `transcript only · ${segments.length} segments`;
    renderTranscript();
  }

  function renderTranscript(filter = '') {
    const q = filter.trim().toLowerCase();
    const shown = q ? segments.filter(s => s.text.toLowerCase().includes(q)) : segments;
    el.list.innerHTML = shown.length
      ? shown.map(s => `
          <button class="cvr-seg" data-start="${s.start}">
            <span class="cs-time mono">${fmtT(s.start)}</span>
            <span class="cs-text">${s.text.replace(/</g, '&lt;')}</span>
          </button>`).join('')
      : `<div class="evt-empty">${segments.length ? 'No matches' : 'No transcript loaded'}</div>`;
    el.list.querySelectorAll('.cvr-seg').forEach(row =>
      row.addEventListener('click', () => seekToAudioTime(parseFloat(row.dataset.start))));
    activeSeg = -1;
  }

  el.search.addEventListener('input', () => renderTranscript(el.search.value));

  function highlightSegment(at) {
    if (!segments.length || el.search.value.trim()) return;
    const idx = segments.findIndex(s => at >= s.start && at < s.end);
    if (idx === activeSeg) return;
    activeSeg = idx;
    el.list.querySelectorAll('.cvr-seg').forEach((row, i) => {
      row.classList.toggle('active', i === idx);
      if (i === idx) row.scrollIntoView({ block: 'nearest' });
    });
  }

  new ResizeObserver(drawWave).observe(el.waveWrap);

  return {
    async loadAudioFile(file) {
      const buf = await file.arrayBuffer();
      await loadAudio(buf, file.name, URL.createObjectURL(file));
    },
    async loadTranscriptFile(file) {
      loadTranscript(await file.text(), file.name);
    },
    /* demo assets fetched relative to the app root; the real CVR recording
       is preferred, falling back to the synthetic sample + its transcript.
       Audio and transcript load independently so one failing doesn't hide
       the other. */
    async loadDemo() {
      let real = false;
      try {
        const aRes = await fetch('demo/cvr_real.ogg');
        if (aRes.ok) {
          const buf = await aRes.arrayBuffer();
          await loadAudio(buf.slice(0), 'CVR data (real)', URL.createObjectURL(new Blob([buf], { type: 'audio/ogg' })));
          real = true;
        }
      } catch (e) { console.warn('real CVR audio failed:', e); }
      if (real) {
        // real recording has no transcript yet — tools/transcribe.py generates one
        try {
          const tRes = await fetch('demo/cvr_real.srt');
          if (tRes.ok) loadTranscript(await tRes.text(), 'cvr_real.srt');
        } catch { /* optional */ }
        return;
      }
      try {
        const tRes = await fetch('demo/cvr_demo.srt');
        if (tRes.ok) loadTranscript(await tRes.text(), 'cvr_demo.srt');
      } catch (e) { console.warn('demo CVR transcript failed:', e); }
      try {
        const aRes = await fetch('demo/cvr_demo.wav');
        if (!aRes.ok) return;
        const buf = await aRes.arrayBuffer();
        await loadAudio(buf.slice(0), 'cvr_demo.wav (synthetic)', URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
      } catch (e) { console.warn('demo CVR audio failed:', e); }
    }
  };
}
