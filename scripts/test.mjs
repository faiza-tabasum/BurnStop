// End-to-end check of the whole loop on SYNTHETIC data, no AWS needed.
//   node scripts/make-synthetic.mjs /tmp/bs && FIRES_DIR=/tmp/bs node scripts/test.mjs
process.env.LOCAL = '1';
process.env.OFFICER_PIN = '1234';
process.env.LOCAL_DB = '/tmp/burnstop-test-db.json';
import { rmSync } from 'node:fs';
rmSync(process.env.LOCAL_DB, { force: true });
const { handler } = await import('../src/app.js');

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (method, path, body, pin = '1234') => {
  const r = await handler({ rawPath: path, headers: { 'x-pin': pin }, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method } } });
  return { status: r.statusCode, json: r.headers['content-type'].includes('json') ? JSON.parse(r.body) : r.body };
};

ok((await call('GET', '/')).status === 200, 'dashboard HTML served');
ok((await call('POST', '/api/plans/refresh', {}, 'bad')).status === 401, 'wrong PIN rejected');

ok((await call('POST', '/api/replay/start', { date: '2025-11-01' })).status === 200, 'replay started');
const risk = (await call('GET', '/api/risk')).json;
ok(risk.cells.length > 0 && risk.cells[0].score >= risk.cells.at(-1).score, `risk cells ranked (${risk.cells.length})`);
console.log('  top cell:', risk.cells[0].tier, risk.cells[0].town, risk.cells[0].score, risk.cells[0].reasons.join(' | '));

const proposed = (await call('POST', '/api/plans/refresh', {})).json.plans;
ok(proposed.length > 0, `proposals created (${proposed.length})`);
const machines = proposed.filter((p) => p.assignment).map((p) => p.assignment.machineId);
ok(new Set(machines).size === machines.length, 'no machine double-booked across proposals');

const a = proposed.find((p) => p.assignment);
const approved = (await call('POST', `/api/plans/${a.id}/approve`, {})).json.plan;
ok(approved.status === 'approved' && approved.texts.farmer.pa.includes('ਪਰਾਲੀ'), 'approve -> messages built (Punjabi/Hindi)');
console.log('  notifications:', approved.notifications.map((n) => `${n.what}:${n.ok ? 'ok' : 'skipped'}`).join(', '));
ok((await call('POST', `/api/plans/${a.id}/approve`, {})).status === 409, 'double approve blocked');

const b = proposed.filter((p) => p.assignment && p.id !== a.id)[0];
if (b) await call('POST', `/api/plans/${b.id}/approve`, {});
ok((await call('POST', `/api/plans/${a.id}/done`, {})).json.plan.status === 'done', 'operator marks done');

let adv;
for (let i = 0; i < 3; i++) adv = (await call('POST', '/api/replay/advance', {})).json;
ok(adv.asOf === '2025-11-04', 'replay advanced 3 days');
const plans = (await call('GET', '/api/plans')).json.plans;
const verified = plans.filter((p) => p.verification);
ok(verified.length > 0, `verification ran (${verified.map((p) => p.verification.outcome).join(', ')})`);
ok(verified.every((p) => ['SUCCESS', 'FAILED', 'UNCONFIRMED'].includes(p.verification.outcome)), 'outcomes valid');

const state = (await call('GET', '/api/state')).json;
ok(state.mode === 'replay' && state.historyYears.length >= 2, 'state endpoint ok');
ok((await call('POST', '/api/replay/stop', {})).status === 200, 'back to live');

// live ingest from a fixture CSV
process.env.FIRMS_FIXTURE = process.env.FIRES_DIR + '/fixture.csv';
const ing = await call('POST', '/api/ingest', {});
ok(ing.status === 200 && ing.json.detections > 0, `ingest from fixture (${ing.json.detections} detections)`);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
