// tests/routing.check.tsx — حرّاس انحدار على **قرارات** الموجّه والفحص.
//
// لماذا هذا الملف: كل الأعطال التي أصلحتها الجولة الثالثة كانت في قرارات لا يغطيها
// أي اختبار — حكم الطبقة (مفتاح ↔ نموذج)، واحتساب المحاولات، وترتيب المزوّدات،
// وصلاحية الحجب، وعدّاد الاستخدام. هنا تُثبَّت كل واحدة باختبار يفشل قبل الإصلاح.
//
// لا شبكة ولا قاعدة حقيقية: قاعدة مؤقتة + عملاء مزوّدين وهميين (نفس عقد OpenAIProvider).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventDB } from '../server/db.js';
import { Router } from '../server/router.js';
import {
  shouldTryNextKey, isKeyLayerAttempt, resolveProbeVerdict,
  type ProbeResult, type ProbeStatus
} from '../server/probe.js';
import { EnvSecretSource } from '../server/secrets/local-sources.js';
import type { Config } from '../server/config.js';

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
};
const group = (t: string) => console.log('\n── ' + t);

const dir = mkdtempSync(join(tmpdir(), 'gw-routing-'));
const db = new EventDB(join(dir, 'routing.db'));

const P = (status: ProbeStatus, error?: string, reason?: ProbeResult['reason']): ProbeResult =>
  ({ provider: 'p1', model: 'm1', status, latencyMs: 10, error, reason });

// ============================================================
// 1) حكم الطبقة: مفتاح أم نموذج؟  (كان داخل index.ts بلا اختبار)
// ============================================================
group('حكم الطبقة (probe.ts)');
check('provider_auth ⇒ جرّب المفتاح التالي', shouldTryNextKey(P('provider_auth', 'bad key')) === true);
check('404 بنصّ مصادقة ⇒ جرّب المفتاح التالي', shouldTryNextKey(P('rejected', 'Invalid API key provided')) === true);
check('404 نموذج مفقود ⇒ لا تكرار', shouldTryNextKey(P('rejected', 'model not found')) === false);
check('ok ⇒ لا تكرار', shouldTryNextKey(P('ok', 'OK')) === false);

check('وسم المفتاح: 404 بنصّ مصادقة', isKeyLayerAttempt(P('rejected', 'invalid API key')) === true);
check('وسم المفتاح: لا يوسم 404 نموذج', isKeyLayerAttempt(P('rejected', 'model does not exist')) === false);
check('وسم المفتاح: لا يوسم نتيجة سليمة', isKeyLayerAttempt(P('ok', 'OK')) === false);

// S5: هذا هو الخلل الجوهري — كان يُعاد 'rejected' فيُحجب النموذج ظلماً.
const v1 = resolveProbeVerdict([P('rejected', 'Invalid API key: sk-xxx', 'auth')]);
check('حكم: مفتاح خاطئ ⇒ provider_auth لا rejected', v1.status === 'provider_auth', 'status=' + v1.status);
check('حكم: لا يُكتب صف رفض عند خطأ مفتاح', v1.status !== 'rejected');
const v2 = resolveProbeVerdict([P('rejected', 'The model `x` does not exist', 'not_found')]);
check('حكم: نموذج مفقود يبقى rejected', v2.status === 'rejected', 'status=' + v2.status);
const v3 = resolveProbeVerdict([
  P('rejected', 'Invalid API key provided', 'auth'),
  P('rejected', 'Invalid API key provided', 'auth')
]);
check('حكم: كل المفاتيح فاشلة ⇒ provider_auth', v3.status === 'provider_auth');
const v4 = resolveProbeVerdict([P('ok', 'OK')]);
check('حكم: نموذج سليم يُعاد كما هو', v4.status === 'ok');

// ============================================================
// 2) الموجّه: ترتيب المزوّدات واحتساب المحاولات وعدّاد الاستخدام
// ============================================================
group('الموجّه (Router)');
const config: Config = {
  providers: [
    { id: 'p1', name: 'P1', baseUrl: 'https://p1.test/v1', format: 'openai', tier: 1, enabled: true, models: 'auto' },
    { id: 'p2', name: 'P2', baseUrl: 'https://p2.test/v1', format: 'openai', tier: 2, enabled: true, models: 'auto' },
    { id: 'p3', name: 'P3', baseUrl: 'https://p3.test/v1', format: 'openai', tier: 3, enabled: true, models: 'auto' }
  ],
  // maxConcurrent=1 كي نُشبع مزوداً بإشارة واحدة، وmaxRetries=2 كي يكشف الاختبار
  // احتساب المحاولات المتخطّاة (ثلاثة مزودات، اثنان مشبعان، والثالث سليم).
  routing: { maxRetries: 2, timeoutMs: 60_000, maxConcurrent: 1 }
};
const router = new Router(config, db);
for (const id of ['p1', 'p2', 'p3']) {
  await db.addProviderKey(id, 'key-' + id, 'test');
  await router.reloadProviderKeys(id);
}

type FakeClient = {
  id: string; name: string; baseUrl: string; apiKey: string; tier: number; keyless: boolean;
  listModels(): Promise<Array<{ id: string }>>;
  chat(o?: any): Promise<any>;
  ping(): Promise<any>;
};
function fakeClient(pid: string, opts: { models?: string[]; content?: string } = {}): FakeClient {
  const models = opts.models || ['m1'];
  return {
    id: pid, name: pid.toUpperCase(), baseUrl: `https://${pid}.test/v1`,
    apiKey: `key-${pid}`, tier: 4, keyless: false,
    listModels: async () => models.map(id => ({ id })),
    chat: async () => ({
      ok: true, status: 200,
      data: {
        choices: [{ message: { role: 'assistant', content: opts.content || 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }),
    ping: async () => ({ ok: true, latencyMs: 1, statusCode: 200 })
  };
}
function install(pid: string, client: FakeClient) {
  const e = (router as any).providers.get(pid);
  for (const slot of e.keys) slot.client = client;
  e.provider = client;
  return e;
}
install('p1', fakeClient('p1'));
install('p2', fakeClient('p2'));
install('p3', fakeClient('p3'));

// S3: تفضيل مزود له نموذج نجح فحصه فعلاً قبل ترتيب tier
check('قبل الفحص: auto يختار tier الأدنى (p1)', (router as any).resolve('auto')?.providerId === 'p1');
router.noteProbe('p2', 'm1', 'ok');
check('بعد فحص p2: auto يقدّم المتحقَّق منه (p2)', (router as any).resolve('auto')?.providerId === 'p2',
  'got=' + (router as any).resolve('auto')?.providerId);

// S4: مزود مشبع لا يستهلك محاولة
(router as any).inflight.clear();
(router as any).acquire('p1');
(router as any).acquire('p2');
const r1 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
check('S4: تخطّي مزودين مشبعين لا يُفشل الطلب', r1.ok === true, 'status=' + r1.status + ' err=' + r1.error);
check('S4: الطلب نجح على المزوّد الثالث', r1.providerId === 'p3', 'provider=' + r1.providerId);
const skipAttempts = (r1.attempts || []).filter((a: any) => /maxConcurrent/.test(String(a.error)));
check('S4: التخطي مُسجَّل وموسوم بأنه لا يُحتسب', skipAttempts.length === 2, 'skips=' + skipAttempts.length);
(router as any).inflight.clear();

// S6: عدّاد الاستخدام صار دفعة واحدة لا كتابة لكل طلب
const rowsBefore = (await db.listProviderKeys('p3'))[0] as any;
const r2 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'again' }] });
check('S6: الطلب الثاني نجح', r2.ok === true);
const rowsBetween = (await db.listProviderKeys('p3'))[0] as any;
check('S6: القاعدة لم تُكتب بعد الطلب (العدّ مؤجَّل)', Number(rowsBetween.requests) === Number(rowsBefore.requests),
  `${rowsBefore.requests} -> ${rowsBetween.requests}`);
const flushed = await router.flushTouches();
check('S6: نبضة واحدة كتبت العدّاد', flushed >= 1, 'flushed=' + flushed);
const rowsAfter = (await db.listProviderKeys('p3'))[0] as any;
check('S6: العدّاد وصل للقاعدة بعد النبضة', Number(rowsAfter.requests) > Number(rowsBefore.requests),
  `${rowsBefore.requests} -> ${rowsAfter.requests}`);

// S5 (تكاملي): صف رفض من الفحص لا يُحجب نموذجاً + TTL لحظي
group('الحجب أثناء التشغيل');
router.noteProbe('p1', 'fresh', 'rejected');
check('نموذج مرفوض حديثاً محجوب', router.rejectedModels('p1').has('fresh'));
(router as any).probeRejections.get('p1').set('stale', Date.now() - 25 * 60 * 60 * 1000);
check('S5: رفض عمره 25 ساعة لم يبقَ محجوباً (بلا إعادة تشغيل)', !router.rejectedModels('p1').has('stale'));
router.noteProbe('p1', 'fresh', 'provider_auth');
check('خطأ مفتاح يُطلق الحجب تلقائياً', !router.rejectedModels('p1').has('fresh'));

// ============================================================
// 2.b) قائمة النماذج المختارة (providers.yaml → models) تُطبَّق فعلاً
// ============================================================
group('تقييد النماذج بقائمة المشغّل');
{
  const cfgAllow: Config = {
    providers: [
      { id: 'pa', name: 'PA', baseUrl: 'https://pa.test/v1', format: 'openai', tier: 1, enabled: true, models: ['allowed-1', 'allowed-2'] }
    ],
    routing: { maxRetries: 1, timeoutMs: 15_000, maxConcurrent: 2 }
  };
  const ra = new Router(cfgAllow, db);
  const ea = ra.getProvider('pa') as any;
  // المزوّد يعرض أربعة نماذج، والمشغّل اختار اثنين فقط
  ea.knownModels = ['allowed-1', 'allowed-2', 'gemini-flash-latest', 'paid-pro'];
  ea.knownModelsAt = Date.now();

  const autoPick = await (ra as any).pickModel(ea, null);
  check('auto يختار من القائمة المختارة فقط', autoPick.model === 'allowed-1', 'picked=' + autoPick.model);
  const explicitOut = await (ra as any).pickModel(ea, 'paid-pro');
  check('طلب صريح لنموذج خارج القائمة يُرفض', explicitOut.notFound === true && explicitOut.model === null,
    JSON.stringify(explicitOut));
  const explicitIn = await (ra as any).pickModel(ea, 'allowed-2');
  check('طلب صريح لنموذج داخل القائمة يُقبل', explicitIn.model === 'allowed-2', JSON.stringify(explicitIn));
  check('allowedModelSet يعيد القائمة المختارة',
    [...(ra.allowedModelSet('pa') || [])].join(',') === 'allowed-1,allowed-2');
  check('models: auto = بلا تقييد', router.allowedModelSet('p1') === null);

  // فشل جلب القائمة الحيّة لا يُلغي التقييد: تُستخدم القائمة المختارة كمرشّحين
  ea.knownModels = [];
  ea.knownModelsAt = Date.now();
  const offlinePick = await (ra as any).pickModel(ea, null);
  check('بلا قائمة حيّة يبقى الاختيار داخل القائمة المختارة',
    offlinePick.model === 'allowed-1', 'picked=' + offlinePick.model);
}

// ============================================================
// 2.c) لا نُعلن مزوداً لا يملك مفتاحاً قابلاً للاستخدام
// ============================================================
group('المزوّدون المتاحون للعرض');
{
  const cfgDead: Config = {
    providers: [{ id: 'dead', name: 'Dead', baseUrl: 'https://dead.test/v1', format: 'openai', tier: 1, enabled: true, models: 'auto' }],
    routing: { maxRetries: 1, timeoutMs: 15_000, maxConcurrent: 2 }
  };
  const rd = new Router(cfgDead, db);
  await db.addProviderKey('dead', 'dead-key-1234567890', 'test');
  await rd.reloadProviderKeys('dead');
  check('مفتاح سليم ⇒ المزود متاح', rd.reachableProviderIds().includes('dead'));
  const ed = rd.getProvider('dead') as any;
  ed.keys[0].status = 'auth_error';
  check('كل المفاتيح خاطئة ⇒ لا يُعرض', !rd.reachableProviderIds().includes('dead'),
    'ids=' + rd.reachableProviderIds().join(','));
  ed.keys[0].status = 'unknown';
  ed.keys[0].blockedUntil = Date.now() + 60_000;
  check('كل المفاتيح معزولة ⇒ لا يُعرض', !rd.reachableProviderIds().includes('dead'));
}

// ============================================================
// 2.d) autoEnable:false يمنع التفعيل التلقائي (كان يُسقَط عند التحميل)
// ============================================================
group('autoEnable:false');
{
  const cfgOpt = {
    providers: [{ id: 'opt', name: 'Opt', baseUrl: 'https://opt.test/v1', format: 'openai', tier: 1, enabled: false, autoEnable: false, models: 'auto' }],
    routing: { maxRetries: 1, timeoutMs: 15_000, maxConcurrent: 2 }
  } as Config;
  const ro = new Router(cfgOpt, db);
  await db.addProviderKey('opt', 'opt-key-1234567890', 'test');
  await ro.reloadProviderKeys('opt');
  const res = ro.reconcileAutoEnable();
  check('لا يُفعَّل رغم مفتاح صالح', !res.enabled.includes('opt') && ro.getProvider('opt')?.enabled === false);
  check('السبب مذكور', res.skipped.some(s => s.id === 'opt' && /autoEnable/.test(s.reason)));
}

// ============================================================
// 3) معدل النجاح: رد الكاش ردٌّ ناجح (كان يسقط من البسط)
// ============================================================
group('إحصاءات الطلبات');
const since = Date.now() - 3_600_000;
// نقيس الفرق لا القيمة المطلقة: الموجّه نفسه يكتب chat.success للطلبات السابقة،
// فالمطلقات هشّة. الفرق يعزل أثر الأحداث المُضافة هنا وحدها.
const base: any = await db.getStats(since);
await db.logEvent('chat.success', { model: 'm1', status: 'success' });
await db.logEvent('chat.cache_hit', { model: 'm1', status: 'success' });
await db.logEvent('chat.error', { model: 'm1', status: 'error' });        // محاولة فاشلة داخل طلب
await db.logEvent('chat.all_failed', { model: 'm1', status: 'error' });   // طلب فاشل نهائي
await db.logEvent('health.ok', { provider: 'p1', status: 'ok' });
const stats: any = await db.getStats(since);
const dTotal = Number(stats.total) - Number(base.total);
const dSuccess = Number(stats.success) - Number(base.success);
const dError = Number(stats.error) - Number(base.error);
check('الإجمالي = الطلبات النهائية فقط (لا الصحة ولا المحاولات)', dTotal === 3, 'delta=' + dTotal);
check('النجاح يشمل رد الكاش', dSuccess === 2, 'delta=' + dSuccess);
check('الفشل = الطلب الفاشل مرة واحدة', dError === 1, 'delta=' + dError);

// محاولة فاشلة وحدها لا تُضخّم عدّاد الطلبات (الخلل القديم: طلب واحد يُعدّ 2–4)
const beforeAttempt: any = await db.getStats(since);
await db.logEvent('chat.error', { model: 'm1', status: 'error' });
const afterAttempt: any = await db.getStats(since);
check('chat.error لا يزيد عدد الطلبات',
  Number(afterAttempt.total) === Number(beforeAttempt.total),
  `${beforeAttempt.total} -> ${afterAttempt.total}`);

// ============================================================
// 4) مصدر البيئة: لا يُخزّن مفتاح مزوّد غير معروف
// ============================================================
group('EnvSecretSource');
process.env.ATRIA_DAWN_PREVIEW_API_KEY = 'should-not-become-a-provider-key';
process.env.GROQ_API_KEY = 'gsk_test_value_1234567890';
const envRes = await new EnvSecretSource().fetch();
check('مزوّد معروف (groq) يُقرأ', envRes.entries.some(e => e.provider === 'groq'));
check('مزود غير معروف لا يُنتج مفتاحاً',
  !envRes.entries.some(e => e.provider === 'atria-dawn-preview'),
  'providers=' + envRes.entries.map(e => e.provider).join(','));
check('المتغيّر المُهمَل مُعلَن للمستخدم', (envRes.ignored || []).includes('ATRIA_DAWN_PREVIEW_API_KEY'),
  'ignored=' + JSON.stringify(envRes.ignored));

// ============================================================
// 5) المهلة/الانقطاع: لا تُسقط المزوّد ولا تمنع تجربة نموذج آخر
// ============================================================
// الخلل المُثبت على نسخة حيّة: مزوّد فيه نموذج يعلّق (لا يردّ) وآخر سليم.
// انتهاء المهلة كان يُنهي الطلب كله بـ504 دون تجربة النموذج السليم، وكان
// `status: 0` مستثنى من عدّاد الأخطاء العابرة فيبقى المزوّد «up» إلى الأبد.
group('المهلة والانقطاع');
{
  const cfg2: Config = {
    providers: [
      { id: 'slow', name: 'Slow', baseUrl: 'https://slow.test/v1', format: 'openai', tier: 1, enabled: true, models: ['m-hang', 'm-fast'] }
    ],
    routing: { maxRetries: 1, timeoutMs: 60_000, maxConcurrent: 4 }
  };
  const r2 = new Router(cfg2, db);
  await db.addProviderKey('slow', 'slow-key', 'test');
  await r2.reloadProviderKeys('slow');
  const e2 = (r2 as any).providers.get('slow');
  const hangClient = {
    id: 'slow', name: 'SLOW', baseUrl: 'https://slow.test/v1', apiKey: 'slow-key', tier: 1, keyless: false,
    listModels: async () => [{ id: 'm-hang' }, { id: 'm-fast' }],
    chat: async (o: any) => (o?.model === 'm-hang'
      ? { ok: false, status: 0, error: 'Headers Timeout Error' }
      : { ok: true, status: 200, data: { choices: [{ message: { role: 'assistant', content: 'fast-ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    ping: async () => ({ ok: true, latencyMs: 1, statusCode: 200 })
  };
  for (const slot of e2.keys) slot.client = hangClient;
  e2.provider = hangClient;

  const rr = await r2.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  check('مهلة النموذج الأول لا تُفشل الطلب — يُجرَّب نموذج آخر', rr.ok === true,
    'status=' + rr.status + ' err=' + String(rr.error || '').slice(0, 80));
  check('النموذج الثاني هو من خدم الطلب', rr.model === 'm-fast', 'model=' + rr.model);
  // النموذج الذي انتهت مهلته يُجمَّد تلقائياً: بدونه يعود auto إليه في كل طلب
  // (cachedModel + verified) ويدفع المستخدم 60 ثانية كل مرة.
  e2.cachedModel = undefined;
  const nextPick = await (r2 as any).pickModel(e2, null);
  check('النموذج البطيء لا يُختار تلقائياً بعد مهلة', nextPick.model === 'm-fast', 'picked=' + nextPick.model);

  // ثلاث مهل متتالية = مزوّد مريض ⇒ يُعزل ويُوسم down (كان يبقى up للأبد).
  // النجاح السابق صفّر العدّاد (سلوك مقصود: نجاح واحد يمحو أثر خطأ عابر)،
  // لذا نبدأ من مزوّد ميت تماماً ونقيس بعد المحاولة الأولى وقبل الثالثة.
  const e3 = (r2 as any).providers.get('slow');
  const deadClient = { ...hangClient, chat: async () => ({ ok: false, status: 0, error: 'Headers Timeout Error' }) };
  for (const slot of e3.keys) slot.client = deadClient;
  e3.provider = deadClient;
  e3.cachedModel = undefined;

  await r2.chat({ model: 'auto', messages: [{ role: 'user', content: 'x0' }] });
  check('المهلة تُسجَّل كخطأ عابر ويظهر سببها', !!e3.lastError && e3.transientErrors >= 1,
    'lastError=' + String(e3.lastError || '-').slice(0, 40) + ' transient=' + e3.transientErrors);
  check('المزوّد لم يُوسم down من مهلة واحدة', e3.status !== 'down', 'status=' + e3.status);

  for (let i = 1; i < 3; i++) {
    await r2.chat({ model: 'auto', messages: [{ role: 'user', content: 'x' + i }] });
  }
  check('ثلاث مهل متتالية تُوسم down', e3.status === 'down', 'status=' + e3.status + ' transient=' + e3.transientErrors);
  check('المزوّد المعزول لا يُعلن كنموذج متاح', !r2.reachableProviderIds().includes('slow'));
}

// 500 من المزوّد على نموذج واحد لا يجب أن تُفشل الطلب كله — بقية النماذج تخدم
group('خطأ 5xx على نموذج واحد');
{
  const cfg3: Config = {
    providers: [
      { id: 'p500', name: 'P500', baseUrl: 'https://p500.test/v1', format: 'openai', tier: 1, enabled: true, models: ['m-500', 'm-ok'] }
    ],
    routing: { maxRetries: 1, timeoutMs: 60_000, maxConcurrent: 4 }
  };
  const r3 = new Router(cfg3, db);
  await db.addProviderKey('p500', 'p500-key', 'test');
  await r3.reloadProviderKeys('p500');
  const e4 = (r3 as any).providers.get('p500');
  const c500 = {
    id: 'p500', name: 'P500', baseUrl: 'https://p500.test/v1', apiKey: 'p500-key', tier: 1, keyless: false,
    listModels: async () => [{ id: 'm-500' }, { id: 'm-ok' }],
    chat: async (o: any) => (o?.model === 'm-500'
      ? { ok: false, status: 500, error: 'Internal error encountered.' }
      : { ok: true, status: 200, data: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    ping: async () => ({ ok: true, latencyMs: 1, statusCode: 200 })
  };
  for (const slot of e4.keys) slot.client = c500;
  e4.provider = c500;
  const r500 = await r3.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  check('500 على نموذج واحد ⇒ يُجرَّب نموذج آخر وينجح', r500.ok === true && r500.model === 'm-ok',
    'ok=' + r500.ok + ' model=' + r500.model);
  check('النموذج المعطوب لا يُختار تلقائياً بعدها', (await (r3 as any).pickModel(e4, null)).model === 'm-ok');
}

// ============================================================
// 429 ليس نوعاً واحداً: سعة النموذج (ثوانٍ) مقابل نفاد الحصة (ساعات)
// ============================================================
group('429: سعة النموذج مقابل نفاد الحصة');
{
  const cfg429: Config = {
    providers: [
      { id: 'p429', name: 'P429', baseUrl: 'https://p429.test/v1', format: 'openai', tier: 1, enabled: true, models: ['m1'] },
      // مزوّد ثانٍ لا يملك النموذج: 404 منه يجب ألا يُخفي سبب السعة
      { id: 'p404', name: 'P404', baseUrl: 'https://p404.test/v1', format: 'openai', tier: 2, enabled: true, models: ['other'] }
    ],
    routing: { maxRetries: 2, timeoutMs: 60_000, maxConcurrent: 4 }
  };
  const r4 = new Router(cfg429, db);
  await db.addProviderKey('p429', 'k429', 'test');
  await db.addProviderKey('p429', 'k429-disabled', 'test');
  await db.addProviderKey('p404', 'k404', 'test');
  await r4.reloadProviderKeys('p429');
  await r4.reloadProviderKeys('p404');
  const e404 = (r4 as any).providers.get('p404');
  const c404 = {
    id: 'p404', name: 'P404', baseUrl: 'https://p404.test/v1', apiKey: 'k404', tier: 2, keyless: false,
    listModels: async () => [{ id: 'other' }],
    chat: async () => ({ ok: false, status: 404, error: 'model not found' }),
    ping: async () => ({ ok: true, latencyMs: 1, statusCode: 200 })
  };
  for (const slot of e404.keys) slot.client = c404;
  e404.provider = c404;
  const e5 = (r4 as any).providers.get('p429');
  // مفتاح ثانٍ **معطّل**: كان يُبطل كشف السعة فيعود العزل 60 ثانية (خلل مُصلَح حيّاً)
  e5.keys[1].enabled = false;
  const withChat = (reply: any) => {
    const c = {
      id: 'p429', name: 'P429', baseUrl: 'https://p429.test/v1', apiKey: 'k429', tier: 1, keyless: false,
      listModels: async () => [{ id: 'm1' }],
      chat: async () => reply,
      ping: async () => ({ ok: true, latencyMs: 1, statusCode: 200 })
    };
    for (const slot of e5.keys) slot.client = c;
    e5.provider = c;
  };

  // 1) سعة نموذج: نصّ المزود الحقيقي (dahl) — كان يُعزل 5 دقائق ويُبلَّغ 504
  withChat({
    ok: false, status: 429,
    error: '{"error":{"code":"model_concurrency","message":"This model is at concurrency capacity. Paid accounts are admitted first. Top up at https://inference.dahl.global/account"}}'
  });
  const capRes = await r4.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  check('سعة النموذج ⇒ 429 لا 504', capRes.status === 429, 'status=' + capRes.status);
  check('رسالة السعة صريحة', /capacity/i.test(capRes.error || ''), capRes.error || '');
  const capSlot = e5.keys[0];
  const capBlockMs = Number(capSlot.blockedUntil || 0) - Date.now();
  check('عزل السعة ثوانٍ (≤ 20ث) لا 5 دقائق', capBlockMs > 0 && capBlockMs <= 20_000, 'blockMs=' + capBlockMs);
  check('المزود لا يُوسم quota_exhausted عند السعة', e5.status !== 'quota_exhausted', 'status=' + e5.status);

  // 2) نفاد حصة حقيقي: يبقى العزل الطويل والرمز 504 (لم يتغيّر السلوك القديم)
  capSlot.status = 'ok'; capSlot.blockedUntil = undefined; capSlot.lastError = undefined;
  e5.status = 'up'; e5.blockedUntil = undefined;
  withChat({
    ok: false, status: 429,
    error: '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan."}}'
  });
  const quotaRes = await r4.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  const quotaSlot = e5.keys[0];
  const quotaBlockMs = Number(quotaSlot.blockedUntil || 0) - Date.now();
  check('نفاد الحصة يبقى 504', quotaRes.status === 504, 'status=' + quotaRes.status);
  check('نفاد الحصة يُعزل ساعات لا ثوانٍ', quotaBlockMs > 60_000, 'blockMs=' + quotaBlockMs);
}

// ============================================================
// 5xx عابر: إعادة محاولة واحدة قبل الحكم على المزود
// ============================================================
group('5xx عابر: إعادة محاولة واحدة');
{
  const cfg5: Config = {
    providers: [
      { id: 'p502', name: 'P502', baseUrl: 'https://p502.test/v1', format: 'openai', tier: 1, enabled: true, models: ['m1'] }
    ],
    routing: { maxRetries: 1, timeoutMs: 60_000, maxConcurrent: 4 }
  };
  const r5 = new Router(cfg5, db);
  await db.addProviderKey('p502', 'k502', 'test');
  await r5.reloadProviderKeys('p502');
  const e6 = (r5 as any).providers.get('p502');
  let calls = 0;
  const flaky = {
    id: 'p502', name: 'P502', baseUrl: 'https://p502.test/v1', apiKey: 'k502', tier: 1, keyless: false,
    listModels: async () => [{ id: 'm1' }],
    chat: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 502, error: 'error code: 502' };
      return {
        ok: true, status: 200,
        data: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      };
    },
    ping: async () => ({ ok: true, latencyMs: 1, statusCode: 200 })
  };
  for (const slot of e6.keys) slot.client = flaky;
  e6.provider = flaky;
  const res5 = await r5.chat({ model: 'm1', messages: [{ role: 'user', content: 'retry-once' }] });
  check('502 مرة واحدة ثم نجاح ⇒ الطلب ينجح', res5.ok === true, 'ok=' + res5.ok);
  check('إعادة محاولة واحدة فقط (لا حلقة)', calls === 2, 'calls=' + calls);
  check('المفتاح لم يُعاقب على عطل عابر', e6.keys[0].status === 'ok', e6.keys[0].status);
}

// ============================================================
await db.close();
console.log('\n' + '='.repeat(46));
console.log(`حراسة التوجيه: ${passed} نجاح / ${failures.length} فشل`);
if (failures.length) {
  console.log('\nالإخفاقات:');
  failures.forEach(f => console.log(' ✗ ' + f));
}
console.log('='.repeat(46));
process.exit(failures.length ? 1 : 0);
