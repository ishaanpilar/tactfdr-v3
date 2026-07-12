/* The one playback clock. Chart, map, instruments, event log — and later
   CVR audio — all subscribe here. Position is a float index into the
   sample arrays so the map can interpolate between fixes. */

export function createPlayback(model) {
  let pos = 0;               // float index [0, n-1]
  let playing = false;
  let speed = 5;
  let rafId = null;
  let lastT = 0;
  const subs = new Set();
  const stateSubs = new Set(); // play/pause notifications

  const clamp = (p) => Math.max(0, Math.min(model.n - 1, p));

  function emit() { for (const fn of subs) fn(pos, playing); }
  function emitState() { for (const fn of stateSubs) fn(playing); }

  function frame(t) {
    if (!playing) return;
    const dt = (t - lastT) / 1000;
    lastT = t;
    pos = clamp(pos + dt * model.samplesPerSec * speed);
    if (pos >= model.n - 1) {
      pos = model.n - 1;
      playing = false;
      emit(); emitState();
      return;
    }
    emit();
    rafId = requestAnimationFrame(frame);
  }

  return {
    get pos() { return pos; },
    get index() { return Math.floor(pos); },
    get playing() { return playing; },
    get speed() { return speed; },
    onTick(fn) { subs.add(fn); return () => subs.delete(fn); },
    onState(fn) { stateSubs.add(fn); return () => stateSubs.delete(fn); },
    play() {
      if (playing || model.n < 2) return;
      if (pos >= model.n - 1) pos = 0;
      playing = true;
      lastT = performance.now();
      rafId = requestAnimationFrame(frame);
      emitState();
    },
    pause() {
      playing = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      emit(); emitState();
    },
    toggle() { playing ? this.pause() : this.play(); },
    seek(p) { pos = clamp(p); emit(); },
    nudge(dp) { this.seek(pos + dp); },
    setSpeed(s) { speed = s; },
    destroy() { this.pause(); subs.clear(); stateSubs.clear(); }
  };
}
