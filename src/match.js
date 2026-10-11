// Deterministic machine matching (plain code, not an LLM): earliest ETA wins.
import { haversine } from './geo.js';

export const ROAD_FACTOR = 1.3;   // ASSUMPTION: road distance = 1.3 x straight line
export const SPEED_KMH = 15;      // ASSUMPTION: tractor + implement travel speed
export const PREP_HOURS = 0.5;    // ASSUMPTION: loading / set-up time
export const TARGET_HOURS = 48;   // service target for a High/Medium cell

export function matchCell(cell, machines, used = new Set()) {
  const cands = machines
    .filter((m) => m.type === 'happy_seeder' && m.status !== 'assigned' && !used.has(m.id))
    .map((m) => {
      const roadKm = haversine(cell.lat, cell.lon, m.lat, m.lon) * ROAD_FACTOR;
      const wait = m.status === 'busy' ? m.freeInHours || 0 : 0;
      const eta = wait + roadKm / SPEED_KMH + PREP_HOURS;
      return {
        machineId: m.id, centreId: m.centreId, centreName: m.centreName, type: m.type,
        status: m.status, roadKm: +roadKm.toFixed(1), etaHours: +eta.toFixed(1),
      };
    })
    .sort((a, b) => a.etaHours - b.etaHours);
  if (!cands.length) return null;
  return { best: cands[0], alternatives: cands.slice(1, 4), meetsTarget: cands[0].etaHours <= TARGET_HOURS };
}
