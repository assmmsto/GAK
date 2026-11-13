// tests/live-security.check.tsx — فحص حي للأمان على خادم يعمل
// التشغيل: GATEWAY_URL=http://127.0.0.1:3001 node --import tsx tests/live-security.check.tsx
// كل الحالات هنا **قراءة فقط** (لا تضيف مزوداً ولا تعدّله) — آمنة على بيئة حقيقية.
const BASE = process.env.GATEWAY_URL || 'http://127.0.0.1:3001';
let pass = 0;
const fails: string[] = [];

function expect(name: string, cond: boolean, detail: string): void {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(`${name} → ${detail}`); console.log('  ✗ ' + name + ' → ' + detail); }
}

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: r.status, text: (await r.text()).slice(0, 200) };
}

console.log(`فحص حي على ${BASE}`);

console.log('\n[1] SSRF: بيانات وصفية سحابية');
let r = await post('/api/providers/test-connection', { baseUrl: 'http://169.254.169.254/latest/meta-data' });
expect('مرفوض 400', r.status === 400, `status=${r.status} ${r.text}`);
expect('رسالة واضحة', /169\.254|محجوب/.test(r.text), r.text);

console.log('\n[2] SSRF: http لموقع عام');
r = await post('/api/providers/test-connection', { baseUrl: 'http://api.groq.com/openai/v1' });
expect('مرفوض 400', r.status === 400, `status=${r.status} ${r.text}`);

console.log('\n[3] SSRF: شبكة داخلية 192.168');
r = await post('/api/probe/models', { baseUrl: 'http://192.168.1.1/v1' });
expect('مرفوض 400', r.status === 400, `status=${r.status} ${r.text}`);

console.log('\n[4] SSRF: probe/connect بعنوان داخلي');
r = await post('/api/probe/connect', { baseUrl: 'http://10.0.0.1/v1', model: 'x' });
expect('مرفوض 400', r.status === 400, `status=${r.status} ${r.text}`);

console.log('\n[5] مسار محلي مسموح: Ollama (لا رفض من الفلتر)');
r = await post('/api/providers/test-connection', { baseUrl: 'http://localhost:11434/v1' });
expect('ليس 400 من الفلتر', r.status !== 400, `status=${r.status} ${r.text}`);

console.log('\n[6] JSON تالف: لا تسريب مسارات ملفات');
const badRes = await fetch(BASE + '/api/providers/test-connection', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops'
});
const badBody = await badRes.text();
expect('يرجع 400', badRes.status === 400, `status=${badRes.status}`);
expect('JSON لا HTML', badBody.trim().startsWith('{'), badBody.slice(0, 80));
expect('لا يذكر node_modules', !/node_modules/i.test(badBody), badBody.slice(0, 80));

console.log('\n[7] ترويسات أمنية وحد معدل على /v1');
const vr = await fetch(BASE + '/v1/models');
expect('X-Content-Type-Options', vr.headers.get('x-content-type-options') === 'nosniff', String(vr.headers.get('x-content-type-options')));
expect('X-Frame-Options', vr.headers.get('x-frame-options') === 'DENY', String(vr.headers.get('x-frame-options')));
expect('حد المعدل معلن', Number(vr.headers.get('x-ratelimit-limit')) > 0, String(vr.headers.get('x-ratelimit-limit')));

console.log('\n[8] حد معدل /api/probe (60/دقيقة)');
let sawLimit = false;
let firstLimit = 0;
for (let i = 0; i < 80; i++) {
  const res = await post('/api/probe/models', { baseUrl: 'http://169.254.169.254/v1' });
  if (res.status === 429) { sawLimit = true; firstLimit = i + 1; break; }
}
expect('يظهر 429 عند التجاوز', sawLimit, 'لم يظهر خلال 80 طلباً');
if (sawLimit) console.log(`  (الحاجز عند الطلب رقم ${firstLimit})`);

console.log('\n' + '='.repeat(46));
console.log(`الفحص الحي: ${pass} نجاح / ${fails.length} فشل`);
fails.forEach(f => console.log('  ✗ ' + f));
console.log('='.repeat(46));
process.exit(fails.length ? 1 : 0);
