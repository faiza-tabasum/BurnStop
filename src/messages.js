// Messages to farmer / operator / officer. Hindi and Punjabi come from hand-written templates
// (Amazon Translate is not on the AWS free plan). Have a native Punjabi speaker review before real use.
// Audio: Amazon Polly Hindi voice. Delivery: Telegram bot (SMS to India needs DLT registration, so it is out of scope).
import * as aws from './aws.js';

const MACHINE = { en: 'Happy Seeder', hi: 'हैप्पी सीडर', pa: 'ਹੈਪੀ ਸੀਡਰ' };

const T = {
  farmer: {
    en: 'A residue-management machine ({machine}) is being sent to your area near {town}. Expected in about {eta} hours. Please do not burn the stubble, and keep the field accessible.',
    hi: 'आपके क्षेत्र ({town} के पास) में पराली प्रबंधन मशीन ({machine}) भेजी जा रही है। लगभग {eta} घंटे में पहुँचेगी। कृपया पराली न जलाएँ और खेत तक रास्ता खुला रखें।',
    pa: 'ਤੁਹਾਡੇ ਇਲਾਕੇ ({town} ਨੇੜੇ) ਵਿੱਚ ਪਰਾਲੀ ਪ੍ਰਬੰਧਨ ਮਸ਼ੀਨ ({machine}) ਭੇਜੀ ਜਾ ਰਹੀ ਹੈ। ਲਗਭਗ {eta} ਘੰਟਿਆਂ ਵਿੱਚ ਪਹੁੰਚੇਗੀ। ਕਿਰਪਾ ਕਰਕੇ ਪਰਾਲੀ ਨਾ ਸਾੜੋ ਅਤੇ ਖੇਤ ਤੱਕ ਰਸਤਾ ਖੁੱਲ੍ਹਾ ਰੱਖੋ।',
  },
  operator: {
    en: 'New assignment: {machine} {machineId} from {centre} to the area near {town} ({km} km by road). ETA about {eta} h. Tap Done when the service is finished.',
    hi: 'नया कार्य: {centre} से {machine} {machineId} को {town} के पास भेजें ({km} किमी)। लगभग {eta} घंटे। काम पूरा होने पर Done दबाएँ।',
  },
};

const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

export function buildTexts(plan) {
  const a = plan.assignment;
  const base = { town: plan.town, eta: Math.max(1, Math.round(a.etaHours)), km: a.roadKm, machineId: a.machineId, centre: a.centreName };
  return {
    farmer: {
      pa: fill(T.farmer.pa, { ...base, machine: MACHINE.pa }),
      hi: fill(T.farmer.hi, { ...base, machine: MACHINE.hi }),
      en: fill(T.farmer.en, { ...base, machine: MACHINE.en }),
    },
    operator: {
      hi: fill(T.operator.hi, { ...base, machine: MACHINE.hi }),
      en: fill(T.operator.en, { ...base, machine: MACHINE.en }),
    },
  };
}

// ---- Telegram ----
export const tgConfigured = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
const tgUrl = (m) => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${m}`;

async function tg(method, body) {
  const r = await fetch(tgUrl(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'telegram error');
  return j;
}

async function tgAudio(buf, caption) {
  const fd = new FormData();
  fd.append('chat_id', process.env.TELEGRAM_CHAT_ID);
  fd.append('caption', caption.slice(0, 1000));
  fd.append('title', 'BurnStop (Hindi)');
  fd.append('audio', new Blob([buf], { type: 'audio/mpeg' }), 'burnstop-hindi.mp3');
  const r = await fetch(tgUrl('sendAudio'), { method: 'POST', body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'telegram audio error');
}

export const tgText = (text, extra = {}) => tg('sendMessage', { chat_id: process.env.TELEGRAM_CHAT_ID, text, ...extra });
export const tgAnswer = (id, text) => tg('answerCallbackQuery', { callback_query_id: id, text });

const tag = () => '';

// Sends farmer message (Punjabi + Hindi text, Hindi voice) and operator message (with a Done button).
// Every send is logged so the app can show exactly what happened.
export async function sendApproval(plan, ctx) {
  const t = buildTexts(plan);
  const log = [];
  const attempt = async (to, what, fn) => {
    if (!tgConfigured()) { log.push({ to, what, ok: false, note: 'Telegram not configured (messages shown in the app only)' }); return; }
    try { await fn(); log.push({ to, what, ok: true }); } catch (e) { log.push({ to, what, ok: false, note: e.message }); }
  };

  await attempt('farmer', 'text (Punjabi + Hindi)', () =>
    tgText(`${tag(ctx)}Message to farmer\n\n${t.farmer.pa}\n\n${t.farmer.hi}`));

  let audio = null;
  try { audio = await aws.speakHindi(t.farmer.hi); log.push({ to: 'farmer', what: 'Polly Hindi voice generated', ok: true }); }
  catch (e) { log.push({ to: 'farmer', what: 'Polly Hindi voice', ok: false, note: e.message }); }
  if (audio) await attempt('farmer', 'Hindi voice message', () => tgAudio(audio, `${tag(ctx)}Farmer voice message (Hindi, Amazon Polly)`));

  log.push(...(await sendOperator(plan, ctx)));
  return log;
}

// Operator gets the job with Accept / Can't do it buttons.
export async function sendOperator(plan, ctx) {
  const t = buildTexts(plan);
  if (!tgConfigured()) return [{ to: 'operator', what: 'job offer', ok: false, note: 'Telegram not configured' }];
  try {
    await tgText(`Message to operator\n\n${t.operator.hi}\n\n${t.operator.en}`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Accept', callback_data: `acc:${ctx.ns}:${plan.id}` },
        { text: "❌ Can't do it", callback_data: `dec:${ctx.ns}:${plan.id}` },
      ]] },
    });
    return [{ to: 'operator', what: 'job offer', ok: true }];
  } catch (e) { return [{ to: 'operator', what: 'job offer', ok: false, note: e.message }]; }
}

export const sendDoneButton = (ns, id) => tgText('Tap Done when the service is finished.', {
  reply_markup: { inline_keyboard: [[{ text: '✅ Done', callback_data: `done:${ns}:${id}` }]] },
});

export async function sendOfficer(text, ctx) {
  if (!tgConfigured()) return { ok: false, note: 'Telegram not configured' };
  try { await tgText(`${tag(ctx)}${text}`); return { ok: true }; } catch (e) { return { ok: false, note: e.message }; }
}
