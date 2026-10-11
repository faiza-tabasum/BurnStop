// The BurnStop loop: ingest -> score -> propose -> (officer approves) -> notify -> done -> verify -> escalate.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as aws from './aws.js';
import { SEED_DIR, neighbours } from './geo.js';
import { SOURCES_NRT, fetchArea, aggregate } from './firms.js';
import { getFireDays, loadYear, haveYear } from './data.js';
import { buildRisk } from './risk.js';
import { matchCell, TARGET_HOURS } from './match.js';
import { sendApproval, sendOperator, sendOfficer, buildTexts } from './messages.js';
import { today, addDays, daysBetween } from './util.js';

// ---------- context: live or replay ----------
export async function getCtx() {
  const r = await store.get('CONFIG', 'replay');
  if (r?.active) return { mode: 'replay', ns: 'replay', asOf: r.asOf };
  return { mode: 'live', ns: 'live', asOf: today() };
}

// ---------- centres / machines (SIMULATED) ----------
export async function ensureCentres(ns) {
  let list = await store.query(`${ns}#CENTRE`);
  if (!list.length) {
    list = JSON.parse(readFileSync(path.join(SEED_DIR, 'centres.json'), 'utf8'));
    for (const c of list) await store.put(`${ns}#CENTRE`, c.id, c);
  }
  return list;
}
export const flatten = (centres) =>
  centres.flatMap((c) => c.machines.map((m) => ({ ...m, centreId: c.id, centreName: c.name, lat: c.lat, lon: c.lon })));

async function setMachine(ns, centreId, machineId, patch) {
  const c = await store.get(`${ns}#CENTRE`, centreId);
  const m = c?.machines.find((x) => x.id === machineId);
  if (!m) return null;
  Object.assign(m, patch);
  await store.put(`${ns}#CENTRE`, centreId, c);
  return m;
}

// ---------- ingest (live only) ----------
export async function ingest() {
  const key = process.env.FIRMS_KEY;
  if (!key && !process.env.FIRMS_FIXTURE) throw new Error('FIRMS_KEY is not set');
  const sources = process.env.FIRMS_FIXTURE ? SOURCES_NRT.slice(0, 1) : SOURCES_NRT;
  const merged = {}, errors = [];
  let ok = 0;
  for (const source of sources) {
    try {
      const rows = await fetchArea({ key, source, days: 2 });
      aggregate(rows, merged); // sums across satellites
      ok++;
    } catch (e) { errors.push(`${source}: ${e.message}`); }
  }
  if (!ok) throw new Error('All FIRMS requests failed: ' + errors.join(' | '));
  let detections = 0;
  for (const [date, cells] of Object.entries(merged)) {
    await store.put('live#FIRES', date, { cells, updatedAt: new Date().toISOString() });
    detections += Object.values(cells).reduce((a, b) => a + b, 0);
  }
  const info = { at: new Date().toISOString(), dates: Object.keys(merged), detections, errors };
  await store.put('CONFIG', 'lastIngest', info);
  return info;
}

// ---------- risk + proposals ----------
export async function computeRisk(ctx) {
  const machines = flatten(await ensureCentres(ctx.ns));
  const recentDays = await getFireDays(ctx, addDays(ctx.asOf, -2), ctx.asOf);
  const lastYear = loadYear(+ctx.asOf.slice(0, 4) - 1);
  return { machines, risk: buildRisk({ asOf: ctx.asOf, recentDays, lastYear, machines }) };
}

const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export async function refreshPlans(ctx) {
  const { machines, risk } = await computeRisk(ctx);
  const existing = await store.query(`${ctx.ns}#PLAN`);
  for (const p of existing) if (p.status === 'proposed') await store.del(`${ctx.ns}#PLAN`, p.id);

  // don't re-propose a cell that already has an approved / in-flight plan from the last 3 days
  const busyCells = new Set(existing.filter((p) => p.status !== 'proposed' && daysBetween(p.asOf, ctx.asOf) <= 3).map((p) => p.cell));
  const top = risk.filter((c) => (c.tier === 'High' || c.tier === 'Medium') && !busyCells.has(c.cell)).slice(0, 8);

  const used = new Set();
  const made = [];
  for (const c of top) {
    const m = matchCell(c, machines, used);
    if (m) used.add(m.best.machineId);
    const plan = {
      id: newId(), asOf: ctx.asOf, mode: ctx.mode, status: 'proposed', createdAt: new Date().toISOString(),
      cell: c.cell, lat: c.lat, lon: c.lon, bounds: c.bounds, town: c.town, tier: c.tier, score: c.score,
      reasons: c.reasons, parts: c.parts,
      assignment: m ? m.best : null, alternatives: m ? m.alternatives : [], meetsTarget: m ? m.meetsTarget : false,
    };
    plan.reason = m
      ? `${c.tier} burn risk near ${c.town}. Nearest-ETA machine is ${m.best.machineId} at ${m.best.centreName}: ~${m.best.roadKm} km by road, ETA ~${m.best.etaHours} h` +
        (m.meetsTarget ? ` (within the ${TARGET_HOURS} h target).` : ` (misses the ${TARGET_HOURS} h target).`)
      : `${c.tier} burn risk near ${c.town}, but no Happy Seeder is free. Escalate for more capacity.`;
    try {
      const b = await aws.bedrockBrief(`Write a 2-sentence plain-English briefing for a district agriculture officer. Facts: ${plan.reasons.join('; ')}. Proposed action: ${plan.reason} Do not invent facts.`);
      if (b) plan.brief = b;
    } catch (e) { console.warn('bedrock brief failed:', e.message); }
    await store.put(`${ctx.ns}#PLAN`, plan.id, plan);
    made.push(plan);
  }
  return made;
}

export async function listPlans(ctx) {
  const plans = await store.query(`${ctx.ns}#PLAN`);
  return plans.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ---------- approve / done ----------
export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export async function approvePlan(ctx, id) {
  const plan = await store.get(`${ctx.ns}#PLAN`, id);
  if (!plan) throw new HttpError(404, 'Plan not found');
  if (plan.status !== 'proposed') throw new HttpError(409, `Plan is already ${plan.status}`);
  if (!plan.assignment) throw new HttpError(409, 'No machine available for this plan');
  const centre = await store.get(`${ctx.ns}#CENTRE`, plan.assignment.centreId);
  const machine = centre?.machines.find((m) => m.id === plan.assignment.machineId);
  if (!machine || machine.status === 'assigned') throw new HttpError(409, 'That machine was just taken. Refresh proposals.');

  machine.status = 'assigned'; machine.planId = id;
  await store.put(`${ctx.ns}#CENTRE`, centre.id, centre);

  plan.status = 'approved';
  plan.approvedAt = new Date().toISOString();
  plan.approvedDate = ctx.asOf;
  plan.texts = buildTexts(plan);
  plan.notifications = await sendApproval(plan, ctx);
  await store.put(`${ctx.ns}#PLAN`, id, plan);
  return plan;
}

export async function markDone(nsOrCtx, id) {
  const ns = typeof nsOrCtx === 'string' ? nsOrCtx : nsOrCtx.ns;
  const plan = await store.get(`${ns}#PLAN`, id);
  if (!plan) throw new HttpError(404, 'Plan not found');
  if (plan.status !== 'approved' && plan.status !== 'accepted') throw new HttpError(409, `Plan is ${plan.status}, not in progress`);
  plan.status = 'done';
  plan.doneAt = new Date().toISOString();
  await store.put(`${ns}#PLAN`, id, plan);
  await setMachine(ns, plan.assignment.centreId, plan.assignment.machineId, { status: 'available', freeInHours: 0, planId: null });
  return plan;
}

export async function acceptPlan(nsOrCtx, id) {
  const ns = typeof nsOrCtx === 'string' ? nsOrCtx : nsOrCtx.ns;
  const plan = await store.get(`${ns}#PLAN`, id);
  if (!plan) throw new HttpError(404, 'Plan not found');
  if (plan.status !== 'approved') throw new HttpError(409, `Plan is ${plan.status}, not waiting for the operator`);
  plan.status = 'accepted';
  plan.acceptedAt = new Date().toISOString();
  await store.put(`${ns}#PLAN`, id, plan);
  return plan;
}

// Operator can't do it: free that machine and move to the next-best one that is still available.
export async function declinePlan(nsOrCtx, id) {
  const ctx = typeof nsOrCtx === 'string' ? { ns: nsOrCtx, mode: nsOrCtx === 'replay' ? 'replay' : 'live' } : nsOrCtx;
  const plan = await store.get(`${ctx.ns}#PLAN`, id);
  if (!plan) throw new HttpError(404, 'Plan not found');
  if (plan.status !== 'approved') throw new HttpError(409, `Plan is ${plan.status}, not waiting for the operator`);
  const old = plan.assignment;
  plan.declined = [...(plan.declined || []), old.machineId];
  await setMachine(ctx.ns, old.centreId, old.machineId, { status: 'available', freeInHours: 0, planId: null });

  let next = null;
  for (const alt of plan.alternatives || []) {
    if (plan.declined.includes(alt.machineId)) continue;
    const c = await store.get(`${ctx.ns}#CENTRE`, alt.centreId);
    const m = c?.machines.find((x) => x.id === alt.machineId);
    if (m && m.status === 'available') { next = alt; m.status = 'assigned'; m.planId = id; await store.put(`${ctx.ns}#CENTRE`, c.id, c); break; }
  }
  if (!next) {
    plan.status = 'proposed'; plan.assignment = null; plan.reason = 'Operator could not take the job and no other machine is free.';
    await store.put(`${ctx.ns}#PLAN`, id, plan);
    return plan;
  }
  plan.assignment = next;
  plan.alternatives = plan.alternatives.filter((a) => a.machineId !== next.machineId);
  plan.texts = buildTexts(plan);
  plan.notifications = [...(plan.notifications || []), ...(await sendOperator(plan, ctx))];
  await store.put(`${ctx.ns}#PLAN`, id, plan);
  return plan;
}

// ---------- verify + escalate ----------
// Window: from the UTC day AFTER approval up to asOf. A fire in the plan's cell in that window = FAILED.
// "No detection" is reported as SUCCESS only if the operator confirmed service; otherwise UNCONFIRMED.
export async function verifyAll(ctx) {
  const plans = (await store.query(`${ctx.ns}#PLAN`)).filter((p) => (p.status === 'approved' || p.status === 'accepted' || p.status === 'done') && !p.verification);
  const results = [];
  for (const p of plans) {
    const from = addDays(p.approvedDate, 1);
    if (from > ctx.asOf) continue; // need at least one full UTC day after approval
    const days = await getFireDays(ctx, from, ctx.asOf);
    const nb = neighbours(p.cell);
    let inCell = 0, near = 0;
    for (const cells of Object.values(days)) {
      inCell += cells[p.cell] || 0;
      for (const n of nb) near += cells[n] || 0;
    }
    const serviced = p.status === 'done';
    const outcome = inCell > 0 ? 'FAILED' : serviced ? 'SUCCESS' : 'UNCONFIRMED';
    p.verification = {
      at: new Date().toISOString(), window: [from, ctx.asOf], detectionsInCell: inCell, detectionsNearby: near, serviceConfirmed: serviced, outcome,
      note: outcome === 'FAILED'
        ? `Fire detected in this area after the machine visit (${inCell} detection${inCell > 1 ? 's' : ''})${serviced ? '.' : ', and the service was never confirmed.'}`
        : outcome === 'SUCCESS'
          ? 'Service confirmed and no fire detected in this area since. Absence of a detection is not proof: satellites pass a few times a day.'
          : 'No fire detected since, but the operator never confirmed the service.',
    };
    p.status = outcome === 'FAILED' ? 'failed' : outcome === 'SUCCESS' ? 'verified' : 'unconfirmed';
    if (outcome === 'FAILED') {
      const msg = `INTERVENTION FAILED near ${p.town}: ${p.verification.note}\nMachine ${p.assignment.machineId} (${p.assignment.centreName}). Needs officer follow-up.`;
      p.verification.escalation = { sns: await aws.notifyOfficer(`BurnStop: intervention failed near ${p.town}`, msg).catch((e) => ({ error: e.message })), telegram: await sendOfficer('🔴 ' + msg, ctx) };
      if (p.assignment) await setMachine(ctx.ns, p.assignment.centreId, p.assignment.machineId, { status: 'available', freeInHours: 0, planId: null });
    }
    await store.put(`${ctx.ns}#PLAN`, p.id, p);
    results.push(p);
  }
  return results;
}

// ---------- replay ----------
export async function startReplay(date) {
  const year = +date.slice(0, 4);
  if (!haveYear(year)) throw new HttpError(400, `No archived data for ${year}. Run scripts/fetch-history.mjs before deploying.`);
  for (const ns of ['replay']) {
    for (const p of await store.query(`${ns}#PLAN`)) await store.del(`${ns}#PLAN`, p.id);
    for (const c of await store.query(`${ns}#CENTRE`)) await store.del(`${ns}#CENTRE`, c.id);
  }
  await store.put('CONFIG', 'replay', { active: true, asOf: date, startedAt: new Date().toISOString() });
}

export async function advanceReplay(ctx) {
  if (ctx.mode !== 'replay') throw new HttpError(400, 'Not in replay mode');
  const next = addDays(ctx.asOf, 1);
  const dates = Object.keys(loadYear(+next.slice(0, 4))).sort();
  if (next > dates[dates.length - 1]) throw new HttpError(400, 'No archived data beyond this date');
  await store.put('CONFIG', 'replay', { active: true, asOf: next });
  return { ...ctx, asOf: next };
}

export const stopReplay = () => store.put('CONFIG', 'replay', { active: false });
