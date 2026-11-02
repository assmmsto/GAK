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
// 3) معدل النجاح: رد الكاش ردٌّ ناجح (كان يسقط من البسط)
// ============================================================
group('إحصاءات الطلبات');
const since = Date.now() - 3_600_000;
// نقيس الفرق لا القيمة المطلقة: الموجّه نفسه يكتب chat.success للطلبات السابقة،
// فالمطلقات هشّة. الفرق يعزل أثر الأحداث الأربعة المُضافة هنا وحدها.
const base: any = await db.getStats(since);
await db.logEvent('chat.success', { model: 'm1', status: 'success' });
await db.logEvent('chat.cache_hit', { model: 'm1', status: 'success' });
await db.logEvent('chat.error', { model: 'm1', status: 'error' });
await db.logEvent('health.ok', { provider: 'p1', status: 'ok' });
const stats: any = await db.getStats(since);
const dTotal = Number(stats.total) - Number(base.total);
const dSuccess = Number(stats.success) - Number(base.success);
const dError = Number(stats.error) - Number(base.error);
check('الإجمالي يحسب أحداث chat فقط (لا الصحة)', dTotal === 3, 'delta=' + dTotal);
check('النجاح يشمل رد الكاش', dSuccess === 2, 'delta=' + dSuccess);
check('الفشل محسوب مرة واحدة', dError === 1, 'delta=' + dError);

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
await db.close();
console.log('\n' + '='.repeat(46));
console.log(`حراسة التوجيه: ${passed} نجاح / ${failures.length} فشل`);
if (failures.length) {
  console.log('\nالإخفاقات:');
  failures.forEach(f => console.log(' ✗ ' + f));
}
console.log('='.repeat(46));
process.exit(failures.length ? 1 : 0);
