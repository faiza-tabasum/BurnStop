// Lambda entry point. Serves the app page (GET /), a small JSON API, the Telegram webhook,
// and two scheduled jobs (EventBridge): ingest every 3 h, verify daily.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as store from './store.js';
import * as aws from './aws.js';
import * as flow from './flow.js';
import { buildTexts, tgConfigured, tgAnswer, tgText, sendDoneButton } from './messages.js';
import { loadBacktest, loadedYears } from './data.js';
import { SOWING_DEADLINE, W, CUTS } from './risk.js';
import { daysBetween } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let html;
const page = () => (html ||= readFileSync(path.join(here, 'ui.html'), 'utf8'));

const json = (status, obj) => ({ statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(obj) });

function pinOk(event) {
  const want = process.env.OFFICER_PIN;
  return !!want && event.headers?.['x-pin'] === want;
}

export async function handler(event) {
  try {
    // ---- scheduled jobs ----
    if (event.task === 'ingest') {
      const info = await flow.ingest();
      const ctx = await flow.getCtx();
      if (ctx.mode === 'live') await flow.refreshPlans(ctx);
      return info;
    }
    if (event.task === 'verify') {
      const ctx = await flow.getCtx();
      return { verified: (await flow.verifyAll(ctx)).length };
    }

    // ---- HTTP ----
    const method = event.requestContext?.http?.method || 'GET';
    const p = event.rawPath || '/';
    const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : {};

    if (method === 'GET' && p === '/') return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: page() };

    // Telegram webhook (own secret, not the officer PIN)
    if (method === 'POST' && p === '/api/telegram') {
      if (event.headers?.['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) return json(401, { error: 'bad secret' });
      const cb = body.callback_query;
      if (cb?.data?.startsWith('acc:')) {
        const [, ns, id] = cb.data.split(':');
        try { await flow.acceptPlan(ns, id); await tgAnswer(cb.id, 'Accepted.'); await sendDoneButton(ns, id); }
        catch (e) { await tgAnswer(cb.id, e.message).catch(() => {}); }
      } else if (cb?.data?.startsWith('dec:')) {
        const [, ns, id] = cb.data.split(':');
        try { await flow.declinePlan(ns, id); await tgAnswer(cb.id, 'Noted. Another machine is being assigned.'); }
        catch (e) { await tgAnswer(cb.id, e.message).catch(() => {}); }
      } else if (cb?.data?.startsWith('done:')) {
        const [, ns, id] = cb.data.split(':');
        try { await flow.markDone(ns, id); await tgAnswer(cb.id, 'Marked done. Thank you.'); }
        catch (e) { await tgAnswer(cb.id, e.message).catch(() => {}); }
      } else if (body.message?.text === '/start') {
        await tgText(`BurnStop bot is connected. Your chat id is ${body.message.chat.id}.`).catch(() => {});
      }
      return json(200, { ok: true });
    }

    if (!p.startsWith('/api/')) return json(404, { error: 'not found' });

    const ctx = await flow.getCtx();

    // ---- read-only ----
    if (method === 'GET' && p === '/api/state') {
      const plans = await flow.listPlans(ctx);
      const counts = {};
      for (const x of plans) counts[x.status] = (counts[x.status] || 0) + 1;
      const year = +ctx.asOf.slice(0, 4);
      return json(200, {
        mode: ctx.mode, asOf: ctx.asOf, counts,
        daysLeft: Math.max(0, daysBetween(ctx.asOf, `${year}-${SOWING_DEADLINE}`)), deadline: SOWING_DEADLINE,
        weights: W, cuts: CUTS, historyYears: loadedYears(), telegram: tgConfigured(),
        lastIngest: await store.get('CONFIG', 'lastIngest'), backtest: loadBacktest(),
      });
    }
    if (method === 'GET' && p === '/api/risk') {
      const { risk, machines } = await flow.computeRisk(ctx);
      return json(200, {
        asOf: ctx.asOf, mode: ctx.mode, cells: risk.filter((c) => c.tier !== 'None').slice(0, 150),
        centres: (await flow.ensureCentres(ctx.ns)).map((c) => ({ id: c.id, name: c.name, lat: c.lat, lon: c.lon,
          available: c.machines.filter((m) => m.status === 'available').length, total: c.machines.length })),
        machinesAvailable: machines.filter((m) => m.status === 'available').length,
      });
    }
    if (method === 'GET' && p === '/api/plans') return json(200, { plans: await flow.listPlans(ctx) });

    let m;
    if (method === 'GET' && (m = p.match(/^\/api\/plans\/([\w-]+)\/audio$/))) {
      const plan = await store.get(`${ctx.ns}#PLAN`, m[1]);
      if (!plan?.assignment) return json(404, { error: 'plan not found' });
      const t = buildTexts(plan);
      try {
        const buf = await aws.speakHindi(t.farmer.hi);
        return json(200, { text: t.farmer.hi, audio: buf.toString('base64') });
      } catch (e) { return json(200, { text: t.farmer.hi, audio: null, error: e.message }); }
    }

    // ---- officer actions (PIN) ----
    if (method === 'POST') {
      if (!pinOk(event)) return json(401, { error: 'Wrong or missing PIN' });

      if (p === '/api/ingest') {
        if (ctx.mode === 'replay') return json(400, { error: 'Replay mode uses archived data. Switch back to live to ingest.' });
        return json(200, await flow.ingest());
      }
      if (p === '/api/plans/refresh') return json(200, { plans: await flow.refreshPlans(ctx) });
      if (p === '/api/verify') return json(200, { verified: await flow.verifyAll(ctx) });
      if (p === '/api/replay/start') { await flow.startReplay(body.date); return json(200, { ok: true }); }
      if (p === '/api/replay/advance') {
        const next = await flow.advanceReplay(ctx);
        const verified = await flow.verifyAll(next);
        return json(200, { asOf: next.asOf, verified });
      }
      if (p === '/api/replay/stop') { await flow.stopReplay(); return json(200, { ok: true }); }
      if ((m = p.match(/^\/api\/plans\/([\w-]+)\/approve$/))) return json(200, { plan: await flow.approvePlan(ctx, m[1]) });
      if ((m = p.match(/^\/api\/plans\/([\w-]+)\/accept$/))) return json(200, { plan: await flow.acceptPlan(ctx, m[1]) });
      if ((m = p.match(/^\/api\/plans\/([\w-]+)\/decline$/))) return json(200, { plan: await flow.declinePlan(ctx, m[1]) });
      if ((m = p.match(/^\/api\/plans\/([\w-]+)\/done$/))) return json(200, { plan: await flow.markDone(ctx, m[1]) });
    }
    return json(404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(e.status || 500, { error: e.message });
  }
}
