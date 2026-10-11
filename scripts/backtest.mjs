// Honest held-out test of the ranking. For every day D in the test window:
//   - use only detections up to D (plus last season's archive) to rank cells,
//   - check which cells actually had a detection on D+1..D+2.
// Weights are NOT tuned on the test year. Compares against "rank by recent fires only" and a random cell.
//   node scripts/backtest.mjs [testYear=2025]      (needs fires-<testYear>.json and fires-<testYear-1>.json)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadYear, FIRES_DIR } from '../src/data.js';
import { buildRisk } from '../src/risk.js';
import { scopeCellCount } from '../src/geo.js';
import { addDays, dateRange } from '../src/util.js';

const year = +(process.argv[2] || 2025);
const test = loadYear(year), prev = loadYear(year - 1);
if (!Object.keys(test).length || !Object.keys(prev).length) {
  console.error(`Need fires-${year}.json and fires-${year - 1}.json in ${FIRES_DIR}`); process.exit(1);
}

const KS = [25, 50, 100], HEADLINE = 50;
const acc = Object.fromEntries(KS.map((k) => [k, { m: 0, p: 0, n: 0 }]));
let rand = 0, days = 0, outcomeTotal = 0;

for (const D of dateRange(`${year}-10-15`, `${year}-11-10`)) {
  const recentDays = {};
  for (const off of [0, 1, 2]) { const d = addDays(D, -off); if (test[d]) recentDays[d] = test[d]; }
  const ranked = buildRisk({ asOf: D, recentDays, lastYear: prev, machines: null }); // no machine-gap term: pure prediction
  const next = new Set();
  for (const d of [addDays(D, 1), addDays(D, 2)]) for (const c of Object.keys(test[d] || {})) next.add(c);
  if (!next.size || ranked.length < Math.max(...KS)) continue;

  const persistence = [...ranked].sort((a, b) => (b.r0 - a.r0) || (b.r1 - a.r1));
  days++; outcomeTotal += next.size;
  rand += next.size / scopeCellCount();
  for (const k of KS) {
    const hit = (list) => list.slice(0, k).filter((c) => next.has(c.cell)).length;
    acc[k].m += hit(ranked) / k; acc[k].p += hit(persistence) / k; acc[k].n++;
  }
}
if (!days) { console.error('No usable days. Is the archive empty?'); process.exit(1); }

const results = {};
for (const k of KS) results[k] = { model: { precision: acc[k].m / acc[k].n }, persistence: { precision: acc[k].p / acc[k].n } };
const out = {
  period: `${year}-10-15 to ${year}-11-10`, days, headlineK: HEADLINE, results,
  randomPrecision: rand / days, avgCellsBurningPer48h: Math.round(outcomeTotal / days),
  note: `Precision = share of the top-K ranked cells that had a satellite detection in the next 48 h, averaged over ${days} days. Weights were fixed in advance, not tuned on ${year}. Detection is not the same as a farmer burning a field.`,
  generatedAt: new Date().toISOString(),
};
writeFileSync(path.join(FIRES_DIR, 'backtest.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
