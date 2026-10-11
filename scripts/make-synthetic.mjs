// TEST DATA ONLY. Makes fake fires-2024/2025 files plus a fake FIRMS CSV in a temp folder so the code
// can be exercised without a MAP_KEY. Never copy these into src/data and never present them as real.
//   node scripts/make-synthetic.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { towns, cellId, inScope } from '../src/geo.js';
import { addDays } from '../src/util.js';

const out = process.argv[2] || '/tmp/burnstop-synth';
mkdirSync(out, { recursive: true });
let s = 7;
const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
const weight = Object.fromEntries(towns.map((t) => [t.name, 0.3 + rnd() * 1.7]));

for (const [year, peakShift] of [[2024, 3], [2025, -2]]) {
  const data = {}, csv = ['latitude,longitude,acq_date,confidence,type'];
  for (let d = `${year}-10-01`; d <= `${year}-11-30`; d = addDays(d, 1)) {
    const doy = (Date.parse(d) - Date.parse(`${year}-11-01`)) / 86400000 - peakShift;
    const season = Math.exp(-(doy * doy) / (2 * 10 * 10));
    for (const t of towns) {
      const n = Math.round(weight[t.name] * 14 * season * (0.5 + rnd()));
      for (let i = 0; i < n; i++) {
        const lat = t.lat + gauss() * 0.13, lon = t.lon + gauss() * 0.13;
        if (!inScope(lat, lon)) continue;
        const c = cellId(lat, lon);
        (data[d] ||= {})[c] = ((data[d] || {})[c] || 0) + 1;
        if (year === 2025 && d >= '2025-11-01' && d <= '2025-11-02') csv.push(`${lat.toFixed(4)},${lon.toFixed(4)},${d},n,0`);
      }
    }
  }
  writeFileSync(path.join(out, `fires-${year}.json`), JSON.stringify(data));
  if (year === 2025) writeFileSync(path.join(out, 'fixture.csv'), csv.join('\n'));
}
console.log('synthetic test data written to', out);
