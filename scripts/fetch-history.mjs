// Downloads the last two harvest seasons of REAL NASA FIRMS VIIRS detections (Oct 1 - Nov 30)
// and saves them as per-cell daily counts: src/data/fires-YYYY.json. Run once before `sam build`.
//   node scripts/fetch-history.mjs <FIRMS_MAP_KEY> [2024,2025]
import { writeFileSync } from 'node:fs';
import { fetchArea, aggregate, SOURCES_SP } from '../src/firms.js';
import { addDays, sleep } from '../src/util.js';

const key = process.argv[2] || process.env.FIRMS_KEY;
const years = (process.argv[3] || '2024,2025').split(',').map(Number);
if (!key) { console.error('Usage: node scripts/fetch-history.mjs <FIRMS_MAP_KEY> [2024,2025]'); process.exit(1); }

for (const year of years) {
  const out = {};
  let total = 0;
  for (let start = `${year}-10-01`; start <= `${year}-11-30`; start = addDays(start, 5)) {
    for (const source of SOURCES_SP) {
      process.stdout.write(`${year} ${start} ${source} ... `);
      const rows = await fetchArea({ key, source, days: 5, date: start });
      aggregate(rows, out);
      console.log(`${rows.length} rows`);
      await sleep(1200);
    }
  }
  for (const d of Object.keys(out)) if (d < `${year}-10-01` || d > `${year}-11-30`) delete out[d];
  for (const cells of Object.values(out)) for (const n of Object.values(cells)) total += n;
  const file = new URL(`../src/data/fires-${year}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(out));
  console.log(`=> ${year}: ${Object.keys(out).length} days, ${total} in-scope detections saved\n`);
}
