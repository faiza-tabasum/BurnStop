// Transparent burn-risk score. No trained model: a weighted sum of four explainable signals.
// Weights/cut-offs are judgement calls (stated in the UI); the backtest script measures how well they rank cells.
import { cellCenter, neighbours, nearestTown, haversine, inScope, cellBounds } from './geo.js';
import { addDays, daysBetween } from './util.js';

export const W = { recent: 0.40, hist: 0.30, urgency: 0.15, gap: 0.15 };
export const CUTS = { High: 0.5, Medium: 0.3, Low: 0.12 };
export const SOWING_DEADLINE = '11-15'; // ASSUMPTION: wheat sowing window treated as closing 15 Nov

export function tierOf(score) {
  return score >= CUTS.High ? 'High' : score >= CUTS.Medium ? 'Medium' : score >= CUTS.Low ? 'Low' : 'None';
}

export function scoreParts({ r0, r1, ly, urgency, gap }) {
  const recent = Math.min(1, (2 * r0 + r1) / 6); // saturates at ~3 detections in the cell
  const hist = Math.min(1, ly / 5);              // saturates at 5 detections in the same week last year
  const score = W.recent * recent + W.hist * hist + W.urgency * urgency + W.gap * gap;
  return { recent, hist, urgency, gap, score: +score.toFixed(3) };
}

export function buildRisk({ asOf, recentDays, lastYear, machines, radiusKm = 15 }) {
  const year = +asOf.slice(0, 4);

  // r0: detections in the cell over the last 3 UTC days
  const recent = new Map();
  for (const off of [0, 1, 2]) {
    const cells = recentDays[addDays(asOf, -off)];
    if (!cells) continue;
    for (const [c, n] of Object.entries(cells)) recent.set(c, (recent.get(c) || 0) + n);
  }
  // r1: detections in the 8 surrounding cells
  const around = new Map();
  for (const [c, n] of recent) for (const nb of neighbours(c)) around.set(nb, (around.get(nb) || 0) + n);

  // ly: detections in the same cell in the same calendar week (+/-3 days) last year
  const ly = new Map();
  for (let off = -3; off <= 3; off++) {
    const cells = lastYear?.[addDays(`${year - 1}${asOf.slice(4)}`, off)];
    if (!cells) continue;
    for (const [c, n] of Object.entries(cells)) ly.set(c, (ly.get(c) || 0) + n);
  }

  const daysLeft = Math.max(0, daysBetween(asOf, `${year}-${SOWING_DEADLINE}`));
  const urgency = Math.min(1, Math.max(0, 1 - daysLeft / 45));
  const avail = machines ? machines.filter((m) => m.type === 'happy_seeder' && m.status === 'available') : null;

  const ids = new Set([...recent.keys(), ...around.keys(), ...ly.keys()]);
  const out = [];
  for (const id of ids) {
    const r0 = recent.get(id) || 0, r1 = around.get(id) || 0, h = ly.get(id) || 0;
    if (!r0 && !r1 && !h) continue;
    const { lat, lon } = cellCenter(id);
    if (!inScope(lat, lon)) continue;

    let gap = 0, nearby = null;
    if (avail) {
      nearby = avail.filter((m) => haversine(lat, lon, m.lat, m.lon) <= radiusKm).length;
      gap = nearby === 0 ? 1 : nearby === 1 ? 0.5 : 0;
    }
    const parts = scoreParts({ r0, r1, ly: h, urgency, gap });
    const t = nearestTown(lat, lon);

    const reasons = [];
    if (r0) reasons.push(`${r0} satellite fire detection${r0 > 1 ? 's' : ''} in this cell in the last 3 days`);
    if (r1) reasons.push(`${r1} more in the 8 surrounding cells`);
    if (h) reasons.push(`${h} detection${h > 1 ? 's' : ''} here in the same week last year`);
    reasons.push(`${daysLeft} days to the assumed wheat-sowing cut-off (${SOWING_DEADLINE.replace('-', '/')})`);
    if (nearby === 0) reasons.push(`no available Happy Seeder within ${radiusKm} km`);
    else if (nearby === 1) reasons.push(`only 1 available Happy Seeder within ${radiusKm} km`);

    out.push({
      cell: id, lat, lon, bounds: cellBounds(id), town: t.name, townKm: +t.km.toFixed(1),
      r0, r1, ly: h, daysLeft, parts, score: parts.score, tier: tierOf(parts.score), reasons,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}
