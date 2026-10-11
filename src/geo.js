import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = path.join(here, 'data');
export const towns = JSON.parse(readFileSync(path.join(SEED_DIR, 'towns.json'), 'utf8'));

// ---- Grid: square cells of 0.05 degrees (about 5.5 km). Simple, dependency-free. ----
export const CELL = 0.05;
export const BOX = { w: 73.8, s: 27.6, e: 77.7, n: 32.6 }; // Punjab + Haryana search box

export const cellId = (lat, lon) => `${Math.floor(lat / CELL)}_${Math.floor(lon / CELL)}`;

export function cellCenter(id) {
  const [a, b] = id.split('_').map(Number);
  return { lat: (a + 0.5) * CELL, lon: (b + 0.5) * CELL };
}

export function cellBounds(id) {
  const [a, b] = id.split('_').map(Number);
  return { s: a * CELL, w: b * CELL, n: (a + 1) * CELL, e: (b + 1) * CELL };
}

export function neighbours(id) {
  const [a, b] = id.split('_').map(Number);
  const out = [];
  for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) if (da || db) out.push(`${a + da}_${b + db}`);
  return out;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearestTown(lat, lon) {
  let best = null;
  for (const t of towns) {
    const km = haversine(lat, lon, t.lat, t.lon);
    if (!best || km < best.km) best = { name: t.name, km };
  }
  return best;
}

// ---- Scope filter -------------------------------------------------------------------
// APPROXIMATE western edge (India-Pakistan border) as [lat, lon]. Used only to drop detections
// that are obviously on the Pakistani side. Swap for a real state-boundary polygon if you have one.
const BORDER = [
  [32.6, 75.3], [32.5, 75.15], [32.03, 74.98], [31.6, 74.52], [31.0, 74.5],
  [30.6, 74.25], [30.4, 73.95], [29.9, 73.85], [27.6, 73.8],
];

function borderLon(lat) {
  for (let i = 0; i < BORDER.length - 1; i++) {
    const [la1, lo1] = BORDER[i], [la2, lo2] = BORDER[i + 1];
    if (lat <= la1 && lat >= la2) return lo1 + ((lat - la1) / (la2 - la1)) * (lo2 - lo1);
  }
  return 73.8;
}

// Keep a point only if it is inside the box, east of the approximate border,
// and within 30 km of one of our reference towns (which keeps us in Punjab/Haryana farmland).
export function inScope(lat, lon) {
  if (lat < BOX.s || lat > BOX.n || lon > BOX.e || lon < BOX.w) return false;
  if (lon < borderLon(lat)) return false;
  return nearestTown(lat, lon).km <= 30;
}

let _scopeCount = null;
export function scopeCellCount() {
  if (_scopeCount != null) return _scopeCount;
  let n = 0;
  for (let lat = BOX.s + CELL / 2; lat < BOX.n; lat += CELL)
    for (let lon = BOX.w + CELL / 2; lon < BOX.e; lon += CELL) if (inScope(lat, lon)) n++;
  return (_scopeCount = n);
}
