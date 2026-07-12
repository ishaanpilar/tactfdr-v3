# TACT-FDR v3 — Flight Data Analysis Suite

Unified FDR analysis & briefing tool. Merges the FDR-Visualization (Plotly graphs)
and TactFDR (Leaflet map replay) prototypes into one offline-first app, restyled
in the ACCS design language (`../design-handover/`). See `../BUILD_PLAN.md` for
the full roadmap — this is the **Phase 1** build.

## Run

Everything is vendored locally (Plotly, Leaflet, SheetJS, fonts) — no internet
needed except for map tiles (offline tiles arrive in Phase 4).

```sh
cd tactfdr-v3
python3 -m http.server 8471
# open http://localhost:8471
```

A plain HTTP server is required because the app uses ES modules (blocked on
`file://`). Any static server works. Phase 5 wraps this in a Tauri executable.

**Dev shortcuts:** `?demo` auto-loads the bundled demo flight; `?demo&view=map`
opens straight to map replay.

## What's in Phase 1

- **Excel import** — drag-drop `.xlsx`/`.xls`, parsed client-side (SheetJS).
  One workbook read extracts parameter columns, DMS lat/lon track, and time base.
- **Analysis view** — Plotly traces, parameter toggles, auto/normalized/manual
  Y-scale, line/marker modes, PNG export, **X-interval presets** (1/3/5/10/30 min
  windows that follow the playhead — the client's interval-control request).
- **Map replay** — altitude-banded flight path, heading-rotated helicopter marker,
  trail, camera follow, SAT/MAP/TOPO layers.
- **Instruments** — radial altimeter gauge, GS/HDG/elapsed/position readouts, VSI.
- **Event log** — rate-based detection (overspeed, low alt, rapid climb/descent,
  excessive turn, hard landing) with configurable thresholds, severity badges,
  click-to-seek, and chart/timeline markers. Heading is unwrapped and rate inputs
  lightly smoothed so 1 Hz GPS jitter doesn't flood the log.
- **One playback clock** — chart, map, instruments, and timeline all subscribe to
  a single rAF clock (float index, Catmull-Rom interpolated) so CVR audio can
  slot in during Phase 3 without re-plumbing.
- **Transport** — play/pause/jump, 1–100× rate, scrubbable altitude profile,
  keyboard: `Space` play/pause · `←/→` seek (Shift = larger) · `Home/End` · `F` follow.

## What's in Phase 2

- **Limits engine** ([modules/data/limits.js](modules/data/limits.js)) — per-parameter
  min/max + caution bands checked against every sample. Continuous exceedances
  collapse into single episodes (onset, peak, duration). A clearly-labelled
  placeholder table ships until the client provides the aircraft limits Excel;
  the real one imports at runtime via the **Limits…** button (schema:
  `Parameter | Min | Max | Caution Min | Caution Max`).
- **Status-bit detection** — parsed columns whose values are only 0/1 are
  classified as recorder status flags; every rising edge becomes a timestamped
  `ACTIVE` event, every falling edge a `CLEARED` event.
- **Unified ledger** — rate events + limit episodes + status bits merged
  chronologically in the event log, chart markers, and timeline ticks.
- **Chart limit lines** — amber (caution) / red (hard) dashed bounds drawn for
  any visible parameter with limits.
- **Flight Data Report** — REPORT nav tab renders a print-styled document:
  metadata header, chart snapshot, limit exceedance summary, full sequence of
  events. "Print / Save PDF" uses the browser print engine — no PDF library.

## What's in Phase 3

- **CVR panel** ([modules/views/cvr.js](modules/views/cvr.js)) — cockpit audio
  locked to the master playback clock: rate-matched up to 4×, muted beyond
  (transcript carries the channel), drift-corrected on every tick. Waveform +
  duration decode via `OfflineAudioContext`, so the panel works even with no
  audio output device.
- **FDR alignment offset** — the recorders share no time reference; the offset
  control (±0.1 s / ±1 s nudges) lets the analyst align the CVR against known
  cues (rotor start, radio calls).
- **Transcript layer** — import SRT / WebVTT / JSON; searchable, click-to-seek,
  live segment highlight during replay.
- **Offline transcription** ([tools/transcribe.py](tools/transcribe.py)) —
  faster-whisper on the analyst's machine (no cloud), `large-v3` for
  Hindi + English code-switched CVR audio, VAD-filtered for noisy recordings.
  Emits SRT + JSON that import straight into the CVR panel.
- **Demo assets** — a clearly-labelled *synthetic* CVR wav + transcript
  auto-load with `?demo` so the sync pipeline is demonstrable end-to-end.

## What's in Phase 4

- **KML export** ([modules/export/kml.js](modules/export/kml.js)) — one click in
  the Map view produces a Google Earth file with a time-animated `gx:Track`
  replay (drag GE's time slider to fly the flight), the full path, origin/
  terminus marks, and up to 100 severity-ranked event pins carrying value/
  limit/duration details. This is the FDR→Google Earth "transformer" — HAL
  already uses GE, so the 3D replay works in software they trust today.
- **Offline basemaps** — the Map view's **Offline Map…** button loads a local
  `.pmtiles` file: vector protomaps extracts render via protomaps-leaflet
  (dark theme), raster archives via the pmtiles Leaflet layer. This removes
  the last online dependency. Get real extracts from
  [protomaps.com/downloads](https://protomaps.com/downloads) (whole-planet or
  clipped) or `pmtiles extract` for the operating region.
- **Bundled fallback grid** (`demo/offline_base.pmtiles`, 3.6 KB) — a dark
  graticule basemap so the replay is usable with zero internet and no extract
  loaded. Dev/demo shortcut: `?demo&view=map&pmtiles=demo/offline_base.pmtiles`.
- **Deferred:** CesiumJS in-app 3D (needs a ~30 MB asset decision); KML covers
  the 3D replay requirement for the HAL demo via Google Earth.

## Structure

```text
index.html            app shell (ACCS topbar/navbar/panels)
styles/               tokens.css + components.css (ACCS, verbatim) + app.css + fonts.css
modules/data/         excel-parser.js · flight-model.js · limits.js
modules/engine/       playback.js · events.js · interpolate.js
modules/views/        chart.js · map.js · instruments.js · event-log.js
modules/export/       report.js
modules/main.js       wiring
vendor/               Plotly 2.35.2 · Leaflet 1.9.4 · SheetJS 0.20.3 · woff2 fonts
demo/flight_data.js   sample flight (4,138 pts, 01:09:10)
```
