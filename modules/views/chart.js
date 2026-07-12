/* Plotly chart view — ported from FDR-Visualization and re-tokenized to ACCS.
   Adds the client-requested X-axis interval presets (1/3/5/10/30 min / full)
   in place of the fixed 120 s playback window. */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const REDRAW_MS = 150; // throttle Plotly redraws during playback (matches v1)

export function createChartView(host, model, playback, getEvents, getLimits) {
  let windowSec = 0;          // 0 = full flight
  let yMode = 'auto';         // auto | normalized | manual
  let yManual = [0, 100];
  let chartMode = 'lines';
  let lastRedraw = 0;
  let built = false;

  const theme = {
    paper: css('--panel') || '#0b1118',
    plot: css('--bg-1') || '#080c12',
    grid: 'rgba(140,170,200,.08)',
    zero: 'rgba(140,170,200,.14)',
    txt: css('--txt-2') || '#9fb3c6',
    dim: css('--txt-3') || '#5f7488',
    cursor: css('--intel') || '#38d6ff',
    mono: 'JetBrains Mono, monospace',
    cond: 'Saira Condensed, sans-serif'
  };

  function activeParams() {
    return Object.values(model.parameters).filter(p => p.visible);
  }

  function buildTraces(clipTo) {
    const end = clipTo != null ? Math.floor(clipTo) + 1 : model.n;
    return activeParams().map(p => {
      let y = p.data.slice(0, end);
      if (yMode === 'normalized') {
        const valid = p.data.filter(v => v !== null);
        const min = Math.min(...valid), max = Math.max(...valid);
        const range = max - min || 1;
        y = y.map(v => v !== null ? (v - min) / range : null);
      }
      return {
        x: model.timeSeconds.slice(0, end),
        y,
        name: `${p.name} (${p.unit})`,
        type: 'scatter',
        mode: chartMode,
        line: { color: p.color, width: 1.5 },
        marker: { size: 3, color: p.color },
        text: model.timeLabels.slice(0, end),
        hovertemplate: `<b>${p.name}</b><br>%{text}<br>%{y:.2f} ${p.unit}<extra></extra>`,
        connectgaps: true
      };
    });
  }

  function buildLayout(pos, follow) {
    const totalSec = model.timeSeconds[model.n - 1] || 0;
    const t0 = model.timeSeconds[0] || 0;
    const curSec = model.timeSeconds[Math.floor(pos)] || t0;

    // X window: preset interval follows the cursor (pinned ~80% left while
    // playing, centered while paused); 0 = full flight
    let xRange;
    if (windowSec > 0) {
      let start = follow ? curSec - windowSec * 0.8 : curSec - windowSec / 2;
      start = Math.max(t0, Math.min(start, totalSec - windowSec));
      xRange = [start, Math.max(start, t0) + windowSec];
    } else {
      xRange = [t0, totalSec + 5];
    }

    const yaxis = {
      gridcolor: theme.grid, zerolinecolor: theme.zero,
      tickfont: { family: theme.mono, size: 10, color: theme.dim }
    };
    if (yMode === 'normalized') { yaxis.range = [0, 1]; yaxis.title = { text: 'NORMALIZED', font: { family: theme.cond, size: 11, color: theme.dim } }; }
    else if (yMode === 'manual') yaxis.range = yManual;
    else yaxis.autorange = true;

    // playback cursor
    const shapes = [{
      type: 'line', x0: curSec, x1: curSec, y0: 0, y1: 1, yref: 'paper',
      line: { color: theme.cursor, width: 2 }
    }];

    // limit lines for visible parameters (skipped in normalized mode where
    // absolute bounds are meaningless): caution bounds amber, hard red
    if (yMode !== 'normalized' && getLimits) {
      const table = getLimits() || [];
      for (const p of activeParams()) {
        const lim = table.find(l => p.name.toLowerCase().includes(l.param.toLowerCase()));
        if (!lim) continue;
        const line = (y, color, dash) => shapes.push({
          type: 'line', x0: xRange[0], x1: xRange[1], y0: y, y1: y,
          line: { color, width: 1, dash }, opacity: 0.65
        });
        if (lim.cautionMax !== null) line(lim.cautionMax, '#ffc24b', 'dash');
        if (lim.cautionMin !== null) line(lim.cautionMin, '#ffc24b', 'dash');
        if (lim.max !== null) line(lim.max, '#ff4d63', 'dash');
        if (lim.min !== null) line(lim.min, '#ff4d63', 'dash');
      }
    }

    // event markers. Full-height dotted lines read well for a handful of
    // events but become solid "curtains" past a few dozen — so above the
    // line budget, degrade to short severity-colored ticks along the top
    // edge. Plotly also slows badly past a few hundred shapes: hard cap,
    // most-severe first.
    const annotations = [];
    const MARKER_CAP = 250, FULL_LINE_BUDGET = 40;
    let events = getEvents() || [];
    if (events.length > MARKER_CAP) {
      const rank = { critical: 0, warning: 1, caution: 2 };
      events = [...events].sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, MARKER_CAP);
    }
    const fullLines = events.length <= FULL_LINE_BUDGET;
    for (const evt of events) {
      shapes.push({
        type: 'line', x0: evt.timeSec, x1: evt.timeSec, yref: 'paper',
        y0: fullLines ? 0 : 0.965, y1: 1,
        line: { color: evt.color, width: fullLines ? 1 : 2, dash: fullLines ? 'dot' : 'solid' },
        opacity: fullLines ? 0.55 : 0.8
      });
      if (fullLines) {
        annotations.push({
          x: evt.timeSec, y: 1, yref: 'paper', text: '▾', showarrow: false,
          font: { size: 11, color: evt.color }, yshift: 8,
          hovertext: `${evt.label} — ${evt.value} ${evt.unit} @ ${evt.time}`
        });
      }
    }

    return {
      paper_bgcolor: theme.paper, plot_bgcolor: theme.plot,
      font: { family: 'Saira, sans-serif', color: theme.txt },
      margin: { l: 52, r: 14, t: 18, b: 42 },
      xaxis: {
        gridcolor: theme.grid, zerolinecolor: theme.zero,
        tickfont: { family: theme.mono, size: 10, color: theme.dim },
        range: xRange, tickangle: -35,
        tickmode: 'array', ...tickArray(xRange)
      },
      yaxis: yaxis,
      legend: {
        bgcolor: 'rgba(13,20,29,.9)', bordercolor: 'rgba(140,170,200,.10)', borderwidth: 1,
        font: { size: 10, color: theme.txt }, orientation: 'h', y: -0.18
      },
      hovermode: 'x unified',
      hoverlabel: { bgcolor: css('--panel-hi') || '#101925', bordercolor: 'rgba(150,185,220,.18)', font: { family: theme.mono, size: 11, color: css('--txt') || '#e9f1f8' } },
      shapes, annotations
    };
  }

  function tickArray([a, b]) {
    const span = b - a;
    const step = Math.max(10, Math.round(span / 12 / 10) * 10);
    const tickvals = [], ticktext = [];
    for (let s = Math.ceil(a / step) * step; s <= b; s += step) {
      tickvals.push(s);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
      ticktext.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`);
    }
    return { tickvals, ticktext };
  }

  function render(pos, playing) {
    const traces = buildTraces(playing ? pos : null);
    const layout = buildLayout(pos, playing);
    if (!built) {
      Plotly.newPlot(host, traces, layout, {
        responsive: true, displaylogo: false, scrollZoom: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
      });
      built = true;
    } else {
      Plotly.react(host, traces, layout);
    }
  }

  playback.onTick((pos, playing) => {
    if (!isVisible()) return;
    const now = performance.now();
    if (playing && now - lastRedraw < REDRAW_MS) return;
    lastRedraw = now;
    render(pos, playing);
  });

  function isVisible() { return host.offsetParent !== null; }

  return {
    refresh() { if (isVisible()) render(playback.pos, playback.playing); },
    setWindow(sec) { windowSec = sec; this.refresh(); },
    setYMode(mode, min, max) { yMode = mode; if (mode === 'manual') yManual = [min, max]; this.refresh(); },
    setChartMode(mode) { chartMode = mode; this.refresh(); },
    exportPNG() {
      Plotly.downloadImage(host, {
        format: 'png', width: 1920, height: 1080,
        filename: 'TACTFDR_' + (model.metadata.filename || 'chart').replace(/\.[^.]+$/, '')
      });
    },
    resize() { if (built && isVisible()) Plotly.Plots.resize(host); }
  };
}
