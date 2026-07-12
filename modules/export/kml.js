/* KML export — the FDR→Google Earth "transformer". Produces a single .kml
   containing:
   - a <gx:Track>: time-stamped positions Google Earth animates with its
     time slider (the 3D replay the client asked for, using software HAL
     already runs)
   - the full flight path as a LineString
   - origin / terminus placemarks
   - event placemarks (critical + warning) pinned at their track position
     with value/limit/time details

   Times: FDR exports carry relative HH:MM:SS only. KML needs absolute
   ISO timestamps, so the track is anchored to an arbitrary epoch date —
   relative timing between points (what the replay shows) is exact. */

const EPOCH = Date.UTC(2023, 0, 1); // anchor date, arbitrary but stable

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const iso = (sec) => new Date(EPOCH + sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/* KML colors are aabbggrr */
const KML_STYLES = `
  <Style id="path"><LineStyle><color>ffffd638</color><width>2.5</width></LineStyle></Style>
  <Style id="track">
    <LineStyle><color>b0ffd638</color><width>1.5</width></LineStyle>
    <IconStyle><scale>1.1</scale><Icon><href>http://earth.google.com/images/kml-icons/track-directional/track-0.png</href></Icon></IconStyle>
  </Style>
  <Style id="origin"><IconStyle><color>ff8ae046</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>
  <Style id="terminus"><IconStyle><color>ff634dff</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>
  <Style id="evtCritical"><IconStyle><color>ff634dff</color><scale>0.9</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/caution.png</href></Icon></IconStyle></Style>
  <Style id="evtWarning"><IconStyle><color>ff4bc2ff</color><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/caution.png</href></Icon></IconStyle></Style>`;

const MAX_EVENT_PINS = 100;

export function buildKML(model, events = []) {
  if (!model.hasTrack) throw new Error('No GPS track in this flight — nothing to export.');
  const t0 = model.timeSeconds[0] || 0;

  // decimate very dense tracks: GE handles ~10k track points comfortably
  const step = Math.max(1, Math.ceil(model.n / 10000));

  const whens = [], coords = [], lineCoords = [];
  for (let i = 0; i < model.n; i += step) {
    const t = model.track[i];
    if (!t) continue;
    whens.push(`      <when>${iso(model.timeSeconds[i] - t0)}</when>`);
    coords.push(`      <gx:coord>${t.lon} ${t.lat} ${t.alt.toFixed(1)}</gx:coord>`);
    lineCoords.push(`${t.lon},${t.lat},${t.alt.toFixed(1)}`);
  }
  if (!lineCoords.length) throw new Error('No GPS fixes in this flight.');

  const fixes = model.track.filter(t => t);
  const first = fixes[0], last = fixes[fixes.length - 1];

  // event pins: severity-ranked, capped, only where a fix exists
  const ranked = [...events]
    .filter(e => e.severity === 'critical' || e.severity === 'warning')
    .sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1))
    .slice(0, MAX_EVENT_PINS);

  const eventPins = ranked.map(e => {
    const t = model.track[e.index] || nearestFix(model.track, e.index);
    if (!t) return '';
    return `
    <Placemark>
      <name>${esc(e.label)}</name>
      <styleUrl>#evt${e.severity === 'critical' ? 'Critical' : 'Warning'}</styleUrl>
      <description><![CDATA[${e.severity.toUpperCase()} — ${e.value} ${e.unit} (limit ${e.threshold})<br>Flight time ${e.time}${e.durationSec ? `<br>Duration ${e.durationSec} s` : ''}]]></description>
      <TimeStamp><when>${iso(e.timeSec - t0)}</when></TimeStamp>
      <Point><altitudeMode>absolute</altitudeMode><coordinates>${t.lon},${t.lat},${t.alt.toFixed(1)}</coordinates></Point>
    </Placemark>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>TACT-FDR — ${esc(model.metadata.filename)}</name>
  <description><![CDATA[Flight replay exported by TACT-FDR v3.<br>
Duration ${esc(model.metadata.duration)} · ${model.metadata.records.toLocaleString()} records · ${events.length} detected events.<br>
Timestamps are relative to an arbitrary epoch (FDR exports carry no absolute date) — use the time slider for replay.]]></description>
${KML_STYLES}
  <Placemark>
    <name>Flight Replay (time slider)</name>
    <styleUrl>#track</styleUrl>
    <gx:Track>
      <altitudeMode>absolute</altitudeMode>
${whens.join('\n')}
${coords.join('\n')}
    </gx:Track>
  </Placemark>
  <Placemark>
    <name>Flight Path</name>
    <styleUrl>#path</styleUrl>
    <LineString><altitudeMode>absolute</altitudeMode><coordinates>
      ${lineCoords.join(' ')}
    </coordinates></LineString>
  </Placemark>
  <Placemark><name>Origin</name><styleUrl>#origin</styleUrl>
    <Point><altitudeMode>absolute</altitudeMode><coordinates>${first.lon},${first.lat},${first.alt.toFixed(1)}</coordinates></Point>
  </Placemark>
  <Placemark><name>Terminus</name><styleUrl>#terminus</styleUrl>
    <Point><altitudeMode>absolute</altitudeMode><coordinates>${last.lon},${last.lat},${last.alt.toFixed(1)}</coordinates></Point>
  </Placemark>
  <Folder>
    <name>Events (${ranked.length}${events.length > ranked.length ? ` of ${events.length}` : ''})</name>${eventPins}
  </Folder>
</Document>
</kml>`;
}

function nearestFix(track, idx) {
  for (let d = 1; d < track.length; d++) {
    if (track[idx - d]) return track[idx - d];
    if (track[idx + d]) return track[idx + d];
  }
  return null;
}

export function downloadKML(model, events) {
  const kml = buildKML(model, events);
  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'TACTFDR_' + (model.metadata.filename || 'flight').replace(/\.[^.]+$/, '') + '.kml';
  a.click();
  URL.revokeObjectURL(a.href);
}
