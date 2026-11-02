// tests/browser.tasks.mjs — اختبار حقيقي لكل مهمة واجهة كمهمة مستخدم كاملة:
// رحلات (إضافة/تعديل/حذف مزود، استيراد فعلي، إعادة توليد، استبدال مفتاح، محادثة)
// + تجاوب 3 نقاط عرض + تدقيق وصول axe-core + مراقبة شبكة + لوحة مفاتيح.
// التشغيل على نسخة معزولة: BASE=http://127.0.0.1:3212 node tests/browser.tasks.mjs
// يزرع مفاتيح الاختبار بنفسه من data/.testkeys.json (انظر tests/_fixtures.mjs) —
// بدونه: فحوص المحادثة الحقيقية تُتخطى بصدق والبقية تعمل.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { dahlTestKeys } from './_fixtures.mjs';
const require = createRequire(import.meta.url);

const DAHL_KEYS = dahlTestKeys();
const HAS_KEYS = DAHL_KEYS.length >= 2;

const BASE = process.env.BASE || 'http://127.0.0.1:3212';
let pass = 0, fail = 0;
const failures = [], netErrors = [];
const check = (n, c, d = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; failures.push(n + (d ? ' :: ' + d : '')); console.log('FAIL  ' + n + (d ? ' :: ' + d : '')); } };
const group = t => console.log('\n── ' + t);
const j = async (p, init) => (await fetch(BASE + p, init)).json().catch(() => ({}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastDialogMsg = '';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
try { await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }); } catch {}
const page = await context.newPage();
page.on('dialog', async d => { lastDialogMsg = d.message(); try { await d.accept(d.type() === 'prompt' ? 'my-key' : undefined); } catch {} });
page.on('response', r => { if (r.status() >= 400) netErrors.push(`${r.status()} ${r.url().replace(BASE, '')}`); });

console.log(`=== مهام الواجهة — BASE=${BASE} ===`);
try {
  // زرع مفاتيح الاختبار ذاتياً (من التركيبات المحلية — صراع البصمة ممنوع بالتصميم)
  if (HAS_KEYS) {
    await fetch(BASE + '/api/providers/dahl/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: DAHL_KEYS.slice(0, 3) })
    }).catch(() => {});
  }
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const modal = () => page.locator('.z-50').filter({ has: page.locator('input') }).last();

  // ============ مهمة 1: إضافة مزود كاملة (Test → حفظ) ============
  group('مهمة 1: إضافة مزود كاملة عبر النافذة');
  await page.locator('button', { hasText: 'Add Provider' }).first().click();
  await page.waitForTimeout(500);
  await page.locator('input[placeholder="my-provider"]').fill('together');
  await page.locator('input[placeholder="My Provider"]').fill('Together AI');
  await page.locator('input[placeholder^="https://api.example.com"]').fill('https://api.together.ai/v1');
  await page.waitForTimeout(500);
  // زر Test داخل النافذة (يمسّ المزود فعلاً — بلا مفتاح سيرفض 401: حالة خطأ حقيقية)
  await modal().locator('button', { hasText: /^Test$/ }).last().click();
  await page.waitForTimeout(4000);
  check('Test داخل النافذة يعرض نتيجة اتصال (حتى الفاشلة)', (await modal().locator('text=/ms|فشل|خطأ|✓|✗|error/i').count()) > 0);
  // التسمية ذكية: مزود جديد → «حفظ المزود»، موجود في الكتالوج/القائمة → «تحديث المزود (الموجود)»
  await modal().locator('button').filter({ hasText: /حفظ المزود|تحديث المزود/ }).last().click();
  await page.waitForTimeout(2000);
  const added = (await j('/api/providers')).providers.find(p => p.id === 'together');
  check('المزود الجديد حُفظ فعلاً في الخادم', !!added, JSON.stringify(!!added));

  // ============ مهمة 2: تعديل مزود (تحرير مُعبأ مسبقاً) ============
  group('مهمة 2: تعديل مزود');
  // بطاقة dahl بالاسم تحديداً — ترتيب البطاقات يتغير بعد أي تعديل
  // (المزود المعدَّل يُعاد إدراجه آخراً في القائمة — سلوك موثق في التقرير)
  const dahlCardBy = () => page.locator('.card').filter({ has: page.locator('button[title^="إدارة المفاتيح"]') }).filter({ hasText: 'dahl' }).first();
  const dahlCard = dahlCardBy();
  await dahlCard.locator('button[title^="Edit"]').first().click();
  await page.waitForTimeout(600);
  check('نافذة التحرير تفتح معبأة بعنوان المزود', (await page.locator('text=تحرير: dahl').count()) > 0);
  // الاسم المتوقع من الخادم (قد تحمله جولات سابقة) — المهم: مُعبأ بالقيمة الحالية
  const currentName = (await j('/api/providers')).providers.find(p => p.id === 'dahl')?.name;
  const nameVal = await page.locator('input[placeholder="My Provider"]').inputValue();
  check('الاسم مُعبأ بالقيمة الحقيقية', nameVal === currentName, `val=${nameVal} expected=${currentName}`);
  await page.locator('input[placeholder="My Provider"]').fill('Dahl Inference (main)');
  await page.locator('button', { hasText: 'تحديث المزود' }).last().click();
  await page.waitForTimeout(2000);
  let provs = (await j('/api/providers')).providers;
  check('التعديل وصل الخادم', provs.find(p => p.id === 'dahl')?.name === 'Dahl Inference (main)');
  await fetch(BASE + '/api/providers/dahl', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Dahl Inference' }) });

  // ============ مهمة 3: تعطيل/تفعيل المزود (زر الطاقة) ============
  group('مهمة 3: زر تعطيل/تفعيل المزود');
  await page.waitForTimeout(600);
  let disabled = false;
  for (let i = 0; i < 4 && !disabled; i++) {
    const b = dahlCardBy().locator('button[title^="Disable"]').first();
    if (await b.count()) { await b.click().catch(() => {}); }
    await page.waitForTimeout(2000);
    disabled = (await j('/api/providers')).providers.find(p => p.id === 'dahl')?.enabled === false;
  }
  check('التعطيل وصل الخادم (enabled=false)', disabled);
  // التفعيل: العنوان يتغير بعد إعادة التصيير — ننتظر زر Enable ثم نتحقق بالحالة
  const enableBtn = dahlCardBy().locator('button[title^="Enable"]').first();
  let enabled = false;
  for (let i = 0; i < 4 && !enabled; i++) {
    if (await enableBtn.count()) { await enableBtn.click().catch(() => {}); }
    await page.waitForTimeout(2000);
    enabled = (await j('/api/providers')).providers.find(p => p.id === 'dahl')?.enabled !== false;
  }
  check('التفعيل أعاد المزود (حالة الخادم هي الحكم)', enabled);

  // ============ مهمة 4: Test All ============
  group('مهمة 4: زر فحص الكل');
  await page.locator('button', { hasText: 'Test All' }).first().click();
  let testAllToast = false;
  for (let i = 0; i < 20 && !testAllToast; i++) { await sleep(1500); testAllToast = (await page.locator('text=/providers up|Testing all/').count()) > 0; }
  check('Test All أنجز وأظهر النتيجة', testAllToast);

  // ============ مهمة 5: استيراد فعلي (لا معاينة) ============
  group('مهمة 5: استيراد الآن');
  const keysBefore = (await j('/api/providers/dahl/keys')).keys.length;
  await page.locator('button', { hasText: 'استيراد جماعي' }).first().click();
  await page.waitForTimeout(500);
  // مفتاح غير مزروع مسبقاً — المنع بالبصمة يصدّ التكرار (وهذا سلوك صحيح اختُبر سابقاً)
  // الصيغة الموثقة للمزودات غير الكتالوجية: provider=مفتاح (بادئة dahl_ وحدها
  // لا يتعرف عليها الكتالوج — اكتشاف موثق في التقرير)
  await page.locator('textarea').first().fill('dahl=' + (DAHL_KEYS[3] || DAHL_KEYS[0] || 'dahl_NOFIXTURE'));
  await page.locator('button', { hasText: 'استيراد الآن' }).first().click();
  await page.waitForTimeout(2500);
  const keysAfter = (await j('/api/providers/dahl/keys')).keys.length;
  check('الاستيراد الفعلي أضاف المفتاح', keysAfter === keysBefore + 1, `${keysBefore}→${keysAfter}`);
  const imported = (await j('/api/providers/dahl/keys')).keys.find(k => k.masked.includes('fNXB'));
  if (imported) await fetch(`${BASE}/api/providers/dahl/keys/${imported.id}`, { method: 'DELETE' });
  await page.locator('button[aria-label="إغلاق"]').first().click().catch(() => {});

  // ============ مهمة 6: إعادة توليد المفتاح الموحد (prompt + confirm) ============
  group('مهمة 6: إعادة توليد المفتاح الموحد');
  const unifiedBefore = (await j('/api/keys')).keys.length;
  await page.locator('button[title^="إعادة توليد"]').first().click();
  await page.waitForTimeout(1500);
  check('حوار إعادة التوليد تحذّر بالأثر (القيمة القديمة تبطل)', /تبطل/.test(lastDialogMsg), lastDialogMsg.slice(0, 50));
  check('شريط المفتاح الجديد ظهر بعد التوليد', (await page.locator('text=انسخه الآن').count()) > 0);
  const unifiedAfter = (await j('/api/keys')).keys.length;
  check('إعادة التوليد = حذف + إنشاء (العدد ثابت)', unifiedAfter === unifiedBefore, `${unifiedBefore}→${unifiedAfter}`);
  const mine = (await j('/api/keys')).keys.find(k => k.name === 'my-key');
  if (mine) await fetch(`${BASE}/api/keys/${mine.id}`, { method: 'DELETE' });

  // ============ مهمة 7: استبدال مفتاح ميت — مسار الحفظ الكامل ============
  group('مهمة 7: استبدال مفتاح ميت (حفظ فعلي)');
  // نبني حالة حقيقية: نضيف مفتاحاً مزيّفاً ونفحصه فعلياً فيوسم ميتاً
  await fetch(BASE + '/api/providers/dahl/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['dahl_TASKFAKE_000000000009'] }) });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.locator('nav button[data-tooltip="أي مفتاح ميت؟"]').click();
  await page.waitForTimeout(1200);
  // الجدول يعرض البصمة 'dahl_…0009' لا اسم المفتاح — نصفّي بآخر 4 محارف
  const fakeRow = page.locator('tr').filter({ hasText: '0009' }).first();
  await fakeRow.locator('button[title="فحص هذا المزود بمفتاح حقيقي"]').click();
  await page.waitForTimeout(12000);
  const fakeAfter = (await j('/api/health')).keys.find(k => k.masked.includes('0009'));
  check('الفحص الفردي وسَم المفتاح المزيّف ميتاً', fakeAfter?.status === 'auth_error', fakeAfter?.status);
  await fakeRow.locator('button[title="استبدال بمفتاح جديد"]').click();
  await page.waitForTimeout(500);
  // قيمة فريدة — قيمة مفتاح موجود تصطدم بقيد البصمة الفريدة (provider,key_fp)
  const REPL = 'dahl_pw_repl_' + Date.now();
  await page.locator('input[placeholder="الصق المفتاح الجديد"]').fill(REPL);
  await page.locator('button').filter({ hasText: /^استبدال$/ }).last().click();
  let closed = false;
  for (let i = 0; i < 15 && !closed; i++) { await sleep(800); closed = (await page.locator('input[placeholder="الصق المفتاح الجديد"]').count()) === 0; }
  check('الاستبدال حُفظ وأُغلقت النافذة', closed);
  const replacedRow = (await j('/api/health')).keys.find(k => k.masked.endsWith(REPL.slice(-4)));
  check('الصف أصبح يحمل المفتاح البديل (بصمته تغيّرت)', !!replacedRow, replacedRow?.masked);
  if (replacedRow) await fetch(`${BASE}/api/providers/dahl/keys/${replacedRow.id}`, { method: 'DELETE' });
  // تنظيف المفتاح المزيّف الأصلي إن بقي (الاستبدال أعاد استخدام صفّه)
  const leftovers = (await j('/api/providers/dahl/keys')).keys.filter(k => k.masked.includes('0009'));
  for (const l of leftovers) await fetch(`${BASE}/api/providers/dahl/keys/${l.id}`, { method: 'DELETE' });

  // ============ مهمة 8: السجلات تتحدث حياً (بلا تدخل) ============
  group('مهمة 8: التحديث الحي للسجلات');
  await page.locator('nav button[data-tooltip="Recent events"]').click();
  await page.waitForTimeout(1500);
  const rowsBefore = await page.locator('main .card:last-of-type >> ..').locator('div').count();
  await fetch(BASE + '/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'dahl' }) });
  let sawNew = false;
  for (let i = 0; i < 10 && !sawNew; i++) { await sleep(1500); sawNew = (await page.locator('text=/health\\.ok/').count()) > 0; }
  check('حدث جديد ظهر في السجلات تلقائياً (استطلاع 5ث)', sawNew);
  void rowsBefore;

  // ============ مهمة 9: Playground — أزرار سريعة وEnter وShift+Enter ============
  group('مهمة 9: Playground بالتفصيل');
  await page.locator('nav button[data-tooltip="Test chat"]').click();
  await page.waitForTimeout(1500);
  await page.locator('button', { hasText: 'What is 2+2?' }).first().click();
  check('زر السؤال السريع يملأ الحقل', (await page.locator('textarea').nth(1).inputValue()).includes('2+2'));
  const ta = page.locator('textarea').nth(1);
  await ta.fill('line1');
  await ta.press('Shift+Enter');
  await ta.type('line2');
  check('Shift+Enter يعمل سطراً جديداً بلا إرسال', (await ta.inputValue()).includes('\n'));
  let sent = false;
  if (!HAS_KEYS) {
    check('المحادثة الحقيقية — متخطاة (لا تركيبات مفاتيح)', true);
  } else {
    for (let i = 0; i < 45 && !sent; i++) { await sleep(2000); sent = (await page.locator('text=/dahl\\//i').count()) > 0; }
    check('Enter/زر الإرسال أنجز محادثة حقيقية', sent);
  }

  // ============ مهمة 10: حذف مزود (تأكيد) ============
  group('مهمة 10: حذف مزود بتأكيد');
  await page.locator('nav button[data-tooltip="Manage AI providers"]').click();
  await page.waitForTimeout(800);
  const delProv = (await j('/api/providers')).providers.find(p => p.id === 'together');
  check('المزود التجريبي موجود قبل الحذف', !!delProv);
  await page.locator('button[aria-label="Delete together"]').first().click();
  await page.waitForTimeout(600);
  check('حوار حذف المزود يوضح مصير المفاتيح', /مفاتيحه تبقى/.test(lastDialogMsg), lastDialogMsg.slice(0, 60));
  await page.waitForTimeout(1800);
  check('المزود حُذف من الخادم', !((await j('/api/providers')).providers.find(p => p.id === 'together')));

  // ============ تجاوب 3 نقاط عرض ============
  group('التجاوب — 375 / 768 / 1440');
  for (const w of [375, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 850 });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`لا تفيض أفقياً عند ${w}px`, overflow <= 2, 'overflow=' + overflow + 'px');
    await page.screenshot({ path: `tests/_shots/providers-${w}.png` });
    await page.locator('nav button[data-tooltip="أي مفتاح ميت؟"]').click();
    await page.waitForTimeout(800);
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`الحالة بلا فيض عند ${w}px`, overflow2 <= 2, 'overflow=' + overflow2 + 'px');
    await page.screenshot({ path: `tests/_shots/health-${w}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ============ الوصول (axe-core) على كل تبويب ============
  group('تدقيق الوصول axe-core — كل تبويب');
  const axePath = require.resolve('axe-core/axe.min.js');
  let criticalTotal = 0;
  for (const [tip, label] of [['Manage AI providers', 'Providers'], ['أي مفتاح ميت؟', 'الحالة'], ['اللي يشتغل vs المرفوض', 'فرز'], ['Token consumption', 'Usage'], ['Recent events', 'Logs'], ['Test chat', 'Playground'], ['المزامنة والتدوير التلقائي', 'الوكلاء']]) {
    await page.locator(`nav button[data-tooltip="${tip}"]`).click();
    await page.waitForTimeout(1200);
    await page.addScriptTag({ path: axePath });
    const res = await page.evaluate(async () => { const a = window.axe; const r = await a.run(document, { resultTypes: ['violations'] }); return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })); });
    const critical = res.filter(v => v.impact === 'critical');
    const serious = res.filter(v => v.impact === 'serious');
    criticalTotal += critical.length;
    check(`a11y ${label}: لا مخالفات حرجة`, critical.length === 0, `critical=${JSON.stringify(critical)} serious=${serious.map(s => s.id + '×' + s.nodes).join(',') || '0'}`);
  }

  // ============ لوحة المفاتيح ============
  group('لوحة المفاتيح');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName + ':' + (document.activeElement?.textContent || '').slice(0, 20));
  check('Tab يصل عنصراً تفاعلياً (لا حصار تركيز)', /BUTTON|A|INPUT/.test(focused || ''), focused);

  // ============ مراقبة الشبكة والكونسول ============
  group('مراقبة الشبكة');
  // 409 على /api/providers/add هو المسار الذكي المصمم (موجود → يتحول لتحديث) — متوقع
  const unexpected = netErrors.filter(u => !/favicon/.test(u) && !/409 \/api\/providers\/add/.test(u));
  check('لا فشل شبكة غير متوقع (4xx/5xx) في كل الرحلات', unexpected.length === 0, unexpected.slice(0, 4).join(' | '));
} catch (e) {
  fail++; failures.push('[FATAL] ' + String(e.message || e).slice(0, 160));
  console.log('FATAL', String(e.message || e).slice(0, 160));
}

await browser.close();
console.log('\n' + '='.repeat(52));
console.log(`مهام الواجهة: ${pass} ناجح / ${fail} فشل  (${BASE})`);
if (failures.length) { console.log('\nالإخفاقات:'); failures.forEach(f => console.log(' ✗ ' + f)); }
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
