import { readFileSync } from 'node:fs';
import { cellId, inScope } from './geo.js';
import { sleep } from './util.js';

// Same two satellites for live (NRT) and history (SP) so counts are comparable.
export const SOURCES_NRT = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT'];
export const SOURCES_SP = ['VIIRS_SNPP_SP', 'VIIRS_NOAA20_SP'];
export const AREA = '73.8,27.6,77.7,32.6'; // west,south,east,north

const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

export function parseCsv(text) {
  text = (text || '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const head = lines[0].split(',');
  if (!head.includes('latitude')) throw new Error('FIRMS said: ' + text.slice(0, 200));
  const ix = (n) => head.indexOf(n);
  const [iLat, iLon, iDate, iConf, iType] = ['latitude', 'longitude', 'acq_date', 'confidence', 'type'].map(ix);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < head.length) continue;
    rows.push({
      lat: +c[iLat], lon: +c[iLon], date: c[iDate],
      conf: iConf >= 0 ? c[iConf] : undefined,
      type: iType >= 0 ? c[iType] : undefined,
    });
  }
  return rows;
}

// MAP_KEY limit is 5000 transactions / 10 min, and day range is 1..5.
export async function fetchArea({ key, source, days, date }) {
  if (process.env.FIRMS_FIXTURE) return parseCsv(readFileSync(process.env.FIRMS_FIXTURE, 'utf8'));
  const url = `${BASE}/${key}/${source}/${AREA}/${days}` + (date ? `/${date}` : '');
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (res.ok) return parseCsv(text);
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
    } catch (e) { lastErr = e; }
    await sleep(2000 * attempt);
  }
  throw lastErr;
}

// Drop low-confidence detections and non-vegetation sources (type 2 = static land source, 3 = offshore).
export const keep = (r) => r.conf !== 'l' && r.conf !== 'low' && (r.type === undefined || r.type === '' || r.type === '0');

// rows -> { "YYYY-MM-DD": { cellId: count } }, in-scope only
export function aggregate(rows, into = {}) {
  for (const r of rows) {
    if (!keep(r) || !inScope(r.lat, r.lon)) continue;
    const day = (into[r.date] ||= {});
    const c = cellId(r.lat, r.lon);
    day[c] = (day[c] || 0) + 1;
  }
  return into;
}
