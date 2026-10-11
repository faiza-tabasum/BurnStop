// Fire-detection access. Live mode reads what the scheduled ingest saved in DynamoDB.
// Replay mode reads the bundled archive (fires-YYYY.json) and never looks past "today" (no leakage).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { SEED_DIR } from './geo.js';
import { dateRange } from './util.js';

export const FIRES_DIR = process.env.FIRES_DIR || SEED_DIR;
const cache = new Map();

export function loadYear(year) {
  if (cache.has(year)) return cache.get(year);
  const file = path.join(FIRES_DIR, `fires-${year}.json`);
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  cache.set(year, data);
  return data;
}

export const haveYear = (year) => Object.keys(loadYear(year)).length > 0;
export const loadedYears = () => [2023, 2024, 2025, 2026].filter(haveYear);

export function loadBacktest() {
  const file = path.join(FIRES_DIR, 'backtest.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

// -> { "YYYY-MM-DD": { cell: count } } for from..to (inclusive), only dates <= asOf
export async function getFireDays(ctx, from, to) {
  const out = {};
  for (const d of dateRange(from, to)) {
    if (d > ctx.asOf) continue;
    if (ctx.mode === 'replay') {
      const cells = loadYear(+d.slice(0, 4))[d];
      if (cells) out[d] = cells;
    } else {
      const item = await store.get('live#FIRES', d);
      if (item) out[d] = item.cells;
    }
  }
  return out;
}
