// tests/api.battery.mjs — بطارية API: كل مسار موثق + حالات سلبية + WebSocket حقيقي.
// التشغيل على الخادم المعزول:  BASE=http://127.0.0.1:3212 node tests/api.battery.mjs
// مفاتيح المزود الحقيقية تُقرأ من data/.testkeys.json (غير متتبع) — انظر tests/_fixtures.mjs.
import WebSocket from 'ws';
import { dahlTestKeys } from './_fixtures.mjs';

const DAHL_KEYS = dahlTestKeys();
const HAS_KEYS = DAHL_KEYS.length > 0;
const K1 = DAHL_KEYS[0] || 'dahl_PLACEHOLDER_NO_FIXTURE';

const BASE = process.env.BASE || 'http://127.0.0.1:3212';
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; failures.push(n + (d ? ' :: ' + d : '')); console.log('FAIL  ' + n + (d ? ' :: ' + d : '')); } };
const group = t => console.log('\n── ' + t);

const raw = async (p, init) => {
  const r = await fetch(BASE + p, init);
  let body = null;
  try { body = await r.clone().json(); } catch {}
  return { status: r.status, body, text: async () => r.text() };
};
const jget = p => raw(p);
const jpost = (p, b) => raw(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) });
const jpatch = (p, b) => raw(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) });
const jdel = p => raw(p, { method: 'DELETE' });

// ============ قراءة: كل مسارات GET الموثقة ============
group('مسارات القراءة (GET)');
const getRoutes = [
  ['/api/status', b => b.providers && b.stats],
  ['/api/providers', b => Array.isArray(b.providers)],
  ['/api/health', b => b.counts && Array.isArray(b.keys)],
  ['/api/logs?limit=5', b => Array.isArray(b.events)],
  ['/api/usage', b => Array.isArray(b.usage)],
  ['/api/catalog', b => Array.isArray(b.providers) && Array.isArray(b.keyPatterns)],
  ['/api/settings', b => b.settings && typeof b.settings.cacheEnabled === 'boolean'],
  ['/api/probe/results', b => Array.isArray(b.probes) && b.summary],
  ['/api/drift', b => b.current],
  ['/api/keys', b => Array.isArray(b.keys) && typeof b.baseUrl === 'string'],
  ['/api/agents/status', b => b.scheduler && b.rotation && b.sources],
  ['/api/agents/keys', b => Array.isArray(b.keys)],
  ['/api/agents/audit?limit=5', b => Array.isArray(b.rotations)],
  ['/api/providers/dahl/keys', b => Array.isArray(b.keys) && b.summary],
];
for (const [p, ok] of getRoutes) {
  const r = await jget(p);
  check(`GET ${p}`, r.status === 200 && ok(r.body), `status=${r.status}`);
}

// ============ v1: المصادقة والمخطط ============
group('v1 — المصادقة والحالات السلبية');
const keyRes = await jpost('/api/keys', { name: 'api-battery' });
const KEY = keyRes.body?.key;
check('إنشاء مفتاح بلوحة جديدة يعيد القيمة الكاملة مرة واحدة', !!KEY && KEY.startsWith('gw_'));
check('/v1/models بلا مفتاح → 401', (await jget('/v1/models')).status === 401);
check('/v1/models بمفتاح خاطئ → 401', (await raw('/v1/models', { headers: { Authorization: 'Bearer gw_wrongwrongwrong' } })).status === 401);
const modelsRes = await raw('/v1/models', { headers: { Authorization: `Bearer ${KEY}` } });
check('/v1/models بمفتاح صالح → 200 + auto', modelsRes.status === 200 && modelsRes.body.data.some(m => m.id === 'auto'));
check('/v1/chat/completions بلا messages → 400', (await raw('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: '{}' })).status === 400);
check('/v1/messages بلا messages → 400', (await raw('/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: '{}' })).status === 400);
check('/v1/embeddings بلا input → 400', (await raw('/v1/embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: '{"model":"x"}' })).status === 400);
check('JSON مشوّه → 400 منظم', (await raw('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: '{bad json' })).status === 400);
const big = await raw('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(2_200_000) }] }) });
check('جسم > 2MB → 413', big.status === 413, 'status=' + big.status);

// ============ إدارة المزودات: حالات سلبية ============
group('إدارة المزودات — حالات سلبية');
check('إضافة مزوّد بمعرّف غير صالح → 400', (await jpost('/api/providers/add', { id: 'BAD ID!', name: 'x', baseUrl: 'https://example.com/v1' })).status === 400);
check('إضافة مزوّد بعنوان 169.254 (سحابي) → 400 حجب SSRF', (await jpost('/api/providers/add', { id: 'ssrf-test', name: 'x', baseUrl: 'http://169.254.169.254/latest' })).status === 400);
check('إضافة مزوّد بعنوان داخلي 10.x → 400 حجب SSRF', (await jpost('/api/providers/add', { id: 'ssrf-test2', name: 'x', baseUrl: 'http://10.0.0.5:8080/v1' })).status === 400);
check('إضافة مزوّد بعنوان ملف:// → 400', (await jpost('/api/providers/add', { id: 'ssrf-test3', name: 'x', baseUrl: 'file:///etc/passwd' })).status === 400);
check('إضافة بلا حقول → 400', (await jpost('/api/providers/add', {})).status === 400);
check('PATCH مزوّد غير موجود → 404', (await jpatch('/api/providers/nope-xyz', { name: 'x' })).status === 404);
check('DELETE مزوّد غير موجود → 404', (await jdel('/api/providers/nope-xyz')).status === 404);
check('toggle بلا boolean → 400', (await jpost('/api/providers/dahl/toggle', { enabled: 'yes' })).status === 400);
check('مفاتيح لمزوّد غير موجود → 404', (await jpost('/api/providers/nope-xyz/keys', { keys: ['x'] })).status === 404);
// حارس انحدار P0: حدّ عددي غير رقمي كان يُسقط العملية كاملة (NaN → LIMIT)
check('GET /api/logs?limit=abc لا يُسقط الخادم ويرد 200 بحد افتراضي', (await jget('/api/logs?limit=abc')).status === 200);
check('GET /api/logs?limit=-5 و limit=1e99 آمنتان', (await jget('/api/logs?limit=-5')).status === 200 && (await jget('/api/logs?limit=1e99')).status === 200);
check('الخادم ما زال حياً بعد مدخلات الحدود (نبضة)', (await jget('/api/status')).status === 200);
check('PATCH مفتاح بمعرّف غير رقمي → 400', (await jpatch('/api/providers/dahl/keys/abc', { label: 'x' })).status === 400);
check('PATCH مفتاح غير موجود → 404', (await jpatch('/api/providers/dahl/keys/999999', { label: 'x' })).status === 404);
check('فحص ping بعنوان داخلي → 400', (await jpost('/api/probe/ping', { baseUrl: 'http://192.168.1.1' })).status === 400);
check('فحص connect بلا نموذج → 400', (await jpost('/api/probe/connect', { baseUrl: 'https://example.com' })).status === 400);
check('فحص connect بنموذج طويل جداً → 400 (حارس S9)', (await jpost('/api/probe/connect', { baseUrl: 'https://example.com', model: 'x'.repeat(200) })).status === 400);
check('استيراد فارغ → 400', (await jpost('/api/providers/import', { text: '' })).status === 400);
check('مسح نتائج فحص لمزوّد غير موجود → 200 آمن', [200].includes((await jdel('/api/probe/results?provider=nope')).status));
check('مسار /api غير موجود → 404 منظم', (await jget('/api/definitely-not-a-route')).status === 404);
check('إحصاءات مفتاح بمعرّف غير رقمي → 400', (await jget('/api/keys/abc/stats')).status === 400);

// ============ عمليات حقيقية ============
group('عمليات حقيقية (POST/PATCH/DELETE)');
const imp = await jpost('/api/providers/import', { text: 'unknown_xyz=key123456789\n' + K1, dryRun: true });
check('استيراد dry-run يعيد سطراً بانتظار انتباه واحداً على الأقل', imp.status === 200 && imp.body.dryRun === true && imp.body.total === 2);
const ping = await jpost('/api/probe/ping', { baseUrl: 'https://inference.dahl.global/v1' });
check('ping لعنوان عام صالح → ok true', ping.status === 200 && ping.body.ok === true, JSON.stringify(ping.body).slice(0, 80));
const tconn = await jpost('/api/providers/test-connection', { baseUrl: 'https://inference.dahl.global/v1' });
check('test-connection يعمل', tconn.status === 200 && typeof tconn.body.ok === 'boolean');
const fetchM = await jpost('/api/providers/fetch-models', { baseUrl: 'https://inference.dahl.global/v1' });
check('fetch-models يعيد نماذج', fetchM.status === 200 && fetchM.body.count >= 3, 'count=' + fetchM.body?.count);
const probM = await jpost('/api/probe/models', { baseUrl: 'https://inference.dahl.global/v1' });
check('probe/models يعيد نماذج', probM.status === 200 && probM.body.count >= 3);
const testP = await jpost('/api/test', { providerId: 'dahl' });
check('اختبار مزود dahl → ok', testP.status === 200 && testP.body.ok === true, JSON.stringify(testP.body).slice(0, 80));
const sync = await jpost('/api/agents/sync');
check('مزامنة الوكلاء تنفّذ بلا أخطاء', sync.status === 200 && sync.body.ok === true);
const rot = await jpost('/api/agents/rotate');
check('دورة التدوير تنفّذ', rot.status === 200 && rot.body.ok === true);
const set1 = await jpatch('/api/settings', { cacheTtlSec: 301 });
const setBack = await jpatch('/api/settings', { cacheTtlSec: 300 });
check('تعديل الإعدادات يُحفظ ويُعاد', set1.status === 200 && set1.body.settings.cacheTtlSec === 301 && setBack.body.settings.cacheTtlSec === 300);
const st = await jget('/api/keys');
const keyId = st.body.keys.find(k => k.name === 'api-battery')?.id;
check('القائمة تعرض بصمة لا قيمة كاملة', keyId && !String(st.body.keys.find(k => k.id === keyId).key).startsWith('gw_' + KEY?.slice(3, 12)), 'hint=' + st.body.keys.find(k => k.id === keyId)?.key);
const del = await jdel('/api/keys/' + keyId);
const after = await jget('/api/keys');
check('حذف مفتاح الاختبار نجح', del.status === 200 && !after.body.keys.find(k => k.id === keyId));

// ============ WebSocket حقيقي ============
group('WebSocket /ws');
await new Promise((resolve) => {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  let got = null;
  const t = setTimeout(() => { check('WebSocket: استقبال بث حقيقي', false, 'timeout'); try { ws.close(); } catch {} resolve(); }, 15000);
  ws.on('open', async () => { await jpost('/api/test', { providerId: 'dahl' }); });
  ws.on('message', (m) => { try { got = JSON.parse(String(m)); } catch { got = { raw: true }; } });
  ws.on('message', () => { if (got) { clearTimeout(t); check('WebSocket: استقبال بث حقيقي (health)', got.type === 'health' || got.type === 'health-all', JSON.stringify(got).slice(0, 60)); ws.close(); resolve(); } });
  ws.on('error', (e) => { clearTimeout(t); check('WebSocket: استقبال بث حقيقي', false, String(e.message)); resolve(); });
});

// ============ حراس انحدار من جولة الفحص بثلاثة وكلاء (أدلة مُثبتة) ============
group('حراس انحدار — الخلل المكتشفة والمصلَحة');
// P0: حدّ غير رقمي كان يُسقط العملية
check('GET /api/logs?limit=abc آمن (كان يقتل العملية)', (await jget('/api/logs?limit=abc')).status === 200);
check('GET /api/logs?limit=-5 / 1e99 آمنان', (await jget('/api/logs?limit=-5')).status === 200 && (await jget('/api/logs?limit=1e99')).status === 200);
// P1-1: اسم مفتاح بنوع كائن كان يعلّق الطلب (وقبل الشبكة: يقتل العملية)
const badName = await jpost('/api/keys', { name: { a: 1 } });
check('POST /api/keys باسم كائن → 400 فوراً (كان يعلّق)', badName.status === 400);
check('POST /api/keys باسم رقم → 400', (await jpost('/api/keys', { name: 123 })).status === 400);
// P1-2: حذف مفتاح عبر مسار مزود آخر كان ينفَّذ فعلاً
await jpost('/api/providers/add', { id: 'zz-cross', name: 'ZZ Cross', baseUrl: 'https://example.com/v1' });
await jpost('/api/providers/zz-cross/keys', { keys: ['zz_cross_key_1'] });
const crossKey = (await jget('/api/providers/zz-cross/keys')).body?.keys?.[0]?.id;
const crossDel = await jdel(`/api/providers/dahl/keys/${crossKey}`);
check('DELETE مفتاح مزود عبر مسار مزود آخر → 404 (كان 200 ويحذف)', crossDel.status === 404, 'status=' + crossDel.status);
check('المفتاح ما زال موجوداً بعد المحاولة المتقاطعة', (await jget('/api/providers/zz-cross/keys')).body?.keys?.length === 1);
check('DELETE مفتاح غير موجود → 404 (كان 200 كاذبة)', (await jdel('/api/providers/zz-cross/keys/999999')).status === 404);
// الخلل المتوسط: مفتاح وهمي عند الإضافة بلا مفتاح
const phantom = await jpost('/api/providers/add', { id: 'zz-phantom', name: 'ZZ Phantom', baseUrl: 'https://example.com/v1' });
check('إضافة مزود بلا مفتاح → hasKey false (كان true)', phantom.body?.hasKey === false, 'hasKey=' + phantom.body?.hasKey);
check('لا صف «بلا مفتاح» وهمي (keys.total=0)', phantom.body?.keys?.total === 0, 'total=' + phantom.body?.keys?.total);
await jdel('/api/providers/zz-cross?purgeKeys=1');
await jdel('/api/providers/zz-phantom?purgeKeys=1');
// P2-2: نوع enabled خاطئ كان يُتجاهل بصمت
check('PATCH مفتاح enabled:"yes" → 400 (كان 200 صامتاً)', (await jpatch('/api/providers/dahl/keys/1', { enabled: 'yes' })).status === 400);
// P2-1 + خلل#1: خطأ عميل يعود 400، ونموذج غير موجود يعود 404
// مهم: KEY الأصلي حُذف في قسم سابق — ننشئ مفتاحاً جديداً للحراس
const guardKey = (await jpost('/api/keys', { name: 'guard-key' })).body?.key;
check('/v1/chat/completions برسائل فارغة → 400 (كان 504)', (await raw('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guardKey}` }, body: JSON.stringify({ model: 'auto', messages: [] }) })).status === 400);
check('/v1/chat/completions max_tokens نصي → 400', (await raw('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guardKey}` }, body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'x' }], max_tokens: 'كبير' }) })).status === 400);
check('/v1/chat/completions بنموذج غير موجود → 404 (كان 504)', (await raw('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guardKey}` }, body: JSON.stringify({ model: 'no-such-zzz-999', messages: [{ role: 'user', content: 'x' }] }) })).status === 404);
check('/v1/messages بنموذج غير موجود → 404 (كان 502)', (await raw('/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guardKey}` }, body: JSON.stringify({ model: 'no-such-zzz-999', messages: [{ role: 'user', content: 'x' }] }) })).status === 404);
const guardId = (await jget('/api/keys')).body.keys.find(k => k.name === 'guard-key')?.id;
if (guardId) await jdel('/api/keys/' + guardId);

console.log('\n' + '='.repeat(52));
console.log(`بطارية API: ${pass} ناجح / ${fail} فشل  (${BASE})`);
if (failures.length) { console.log('\nالإخفاقات:'); failures.forEach(f => console.log(' ✗ ' + f)); }
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
