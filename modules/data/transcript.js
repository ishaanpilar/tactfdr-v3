/* CVR transcript parsing — SRT, WebVTT, or JSON segment arrays.
   All formats normalize to [{ start, end, text }] with times in seconds
   relative to the START OF THE AUDIO FILE (the CVR offset control maps
   audio time onto the FDR time base at runtime).

   JSON shape accepted: [{ "start": 12.4, "end": 15.1, "text": "…" }]
   (this is what tools/transcribe.py emits). */

function tsToSec(ts) {
  // "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" / "MM:SS.mmm" (VTT)
  const m = ts.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d{1,3})/);
  if (!m) return null;
  const h = m[1] ? +m[1] : 0;
  return h * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

function parseSRT(text) {
  const segments = [];
  // blocks separated by blank lines: index line (optional), time line, text lines
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) continue;
    const timeIdx = lines.findIndex(l => l.includes('-->'));
    if (timeIdx === -1) continue;
    const [a, b] = lines[timeIdx].split('-->');
    const start = tsToSec(a), end = tsToSec(b);
    if (start === null || end === null) continue;
    const body = lines.slice(timeIdx + 1).join(' ').trim();
    if (body) segments.push({ start, end, text: body });
  }
  return segments;
}

function parseVTT(text) {
  // WebVTT is SRT-shaped after the header; cue settings after the end
  // timestamp are ignored by splitting on whitespace
  return parseSRT(text.replace(/^WEBVTT[^\n]*\n/, '').replace(/(-->\s*[\d:.,]+)[^\n]*/g, '$1'));
}

function parseJSONSegments(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('JSON transcript must be an array of segments');
  return arr
    .filter(s => s && typeof s.start === 'number' && typeof s.end === 'number' && s.text)
    .map(s => ({ start: s.start, end: s.end, text: String(s.text).trim() }));
}

/** Parse transcript file content by extension (or sniffing). */
export function parseTranscript(text, filename = '') {
  const ext = (filename.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  let segments;
  if (ext === 'json') segments = parseJSONSegments(text);
  else if (ext === 'vtt' || /^WEBVTT/.test(text)) segments = parseVTT(text);
  else segments = parseSRT(text); // srt and srt-like default
  segments.sort((a, b) => a.start - b.start);
  if (!segments.length) throw new Error('No transcript segments found in ' + (filename || 'file'));
  return segments;
}
