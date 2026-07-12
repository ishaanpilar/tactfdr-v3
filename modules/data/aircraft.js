/* Aircraft profile registry — one dictionary (parameters, limits, warning
   triggers) per airframe type. Today there is exactly one profile (HAL
   ALH, the aircraft this deployment is built for); the manifest and loader
   exist so adding a second aircraft is a new JSON file + one line in
   config/aircraft/index.json, not a code change.

   To add a profile: run tools/extract_dictionaries.py against that
   aircraft's reference workbooks, output to config/aircraft/<id>.json with
   a `meta` block (id/name/fullName/tailPattern), then list it here. */

let manifest = null;
let cache = new Map();

export async function loadManifest() {
  if (manifest) return manifest;
  const res = await fetch('config/aircraft/index.json');
  manifest = res.ok ? await res.json() : { profiles: [] };
  return manifest;
}

export async function loadProfile(id) {
  if (cache.has(id)) return cache.get(id);
  const m = await loadManifest();
  const entry = m.profiles.find(p => p.id === id) || m.profiles[0];
  if (!entry) return null;
  const res = await fetch('config/aircraft/' + entry.file);
  const dict = res.ok ? await res.json() : null;
  cache.set(id, dict);
  return dict;
}

/** Best-effort tail number extraction from the recorder's row-1 source
 *  string (e.g. "IA-3101_02022023_1419_1.dat" → "IA-3101"), tested against
 *  the active profile's tailPattern first, falling back to a generic
 *  registration-looking token, then the raw source string. */
export function extractTailNumber(source, profile) {
  if (!source) return null;
  const pattern = profile && profile.meta && profile.meta.tailPattern;
  if (pattern) {
    const m = source.match(new RegExp(pattern));
    if (m) return m[0].toUpperCase();
  }
  const generic = source.match(/\b[A-Z]{1,3}-?\d{3,5}\b/);
  if (generic) return generic[0].toUpperCase();
  return source.split(/[_.]/)[0] || null;
}
