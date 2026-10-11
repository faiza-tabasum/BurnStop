// Generates SIMULATED Custom Hiring Centres. Real CHC locations/availability are not public in a usable form.
// Deterministic (seeded) so everyone gets the same file. Run: node scripts/gen-centres.mjs
import { writeFileSync, readFileSync } from 'node:fs';

const towns = JSON.parse(readFileSync(new URL('../src/data/towns.json', import.meta.url), 'utf8'));
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(2026);

const centres = [];
let n = 1;
for (const t of towns) {
  const count = rand() < 0.45 ? 2 : 1;
  for (let c = 0; c < count; c++) {
    const id = `CHC-${String(n).padStart(2, '0')}`;
    const machines = [];
    const m = 2 + Math.floor(rand() * 2); // 2-3 Happy Seeders per centre
    for (let k = 1; k <= m; k++) {
      const busy = rand() < 0.3;
      machines.push({
        id: `HS-${String(n).padStart(2, '0')}-${k}`, type: 'happy_seeder',
        status: busy ? 'busy' : 'available', freeInHours: busy ? Math.round(6 + rand() * 24) : 0,
      });
    }
    centres.push({
      id, name: `${id} (near ${t.name})`, simulated: true,
      lat: +(t.lat + (rand() - 0.5) * 0.3).toFixed(4), lon: +(t.lon + (rand() - 0.5) * 0.3).toFixed(4), machines,
    });
    n++;
  }
}
writeFileSync(new URL('../src/data/centres.json', import.meta.url), JSON.stringify(centres, null, 1));
console.log(`wrote ${centres.length} simulated centres, ${centres.reduce((s, c) => s + c.machines.length, 0)} machines`);
