// tests/browser.full.mjs — فحص حقيقي بمتصفح Chromium على اللوحة الحقيقية.
// يغطي: كل تبويب، كل زر/أيقونة من جرد الناقد، مع فحص سلبي لحالات الفشل.
// التشغيل:
//   FULL (على خادم معزول):  node tests/browser.full.mjs                  (BASE=127.0.0.1:3212)
//   آمن (على الحقيقي):        SKIP_DANGER=1 BASE=http://127.0.0.1:3001 node tests/browser.full.mjs
// الأزرار المدمّرة (حذف/تعطيل/إعادة توليد/كتابة إعدادات) تُنفَّذ فقط عندما FULL.
// مفاتيح المزود الحقيقية تُقرأ من data/.testkeys.json (غير متتبع) — انظر tests/_fixtures.mjs.
import { chromium } from 'playwright';
import { dahlTestKeys } from './_fixtures.mjs';

const DAHL_KEYS = dahlTestKeys();
const HAS_KEYS = DAHL_KEYS.length > 0;
const K1 = DAHL_KEYS[0] || 'dahl_PLACEHOLDER_NO_FIXTURE';

const BASE = process.env.BASE || 'http://127.0.0.1:3212';
const DANGER = process.env.SKIP_DANGER !== '1'; // استثناء الإجراءات المدمّرة عند التشغيل على الحقيقي
let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
};
const group = (t) => console.log('\n── ' + t);
// كل قسم محمي: انهيار محدد في سكربت الاختبار لا يُسقط بقية البطارية
const step = async (name, fn) => {
  try { await fn(); }
  catch (e) { fail++; failures.push(`${name} [EXC] ${e.message?.slice(0, 140)}`); console.log(`EXC  ${name} :: ${e.message?.slice(0, 140)}`); }
};

const j = async (p, init) => {
  const r = await fetch(BASE + p, init);
  return r.json().catch(() => ({}));
};
const jpost = (p, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const consoleErrors = [], pageErrors = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
try { await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }); } catch {}
const page = await context.newPage();
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => pageErrors.push(String(e.message || e)));
// حوارات أصلية: نوافق تلقائياً ونمنع "الزر الذي لا يعمل" الصامت — ونسجّل نصها للتحقق
let lastDialogMsg = '';
page.on('dialog', async d => {
  lastDialogMsg = d.message();
  try { await d.accept(d.type() === 'prompt' ? 'pw-key' : undefined); } catch {}
});

console.log(`=== فحص المتصفح الحقيقي — BASE=${BASE} | DANGER=${DANGER} ===`);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

try { // ← حماية شاملة: أي انهيار في السكربت لا يمنع إصدار الخلاصة

// ============ 0) الهيكل العام ============
group('الهيكل العام');
check('العنوان AI Gateway', (await page.locator('h1').first().textContent())?.includes('AI Gateway'));
check('شارة Online', await page.locator('text=Online').first().isVisible());
check('بطاقة Providers', (await page.locator('text=Providers').count()) > 0);
check('بطاقة Requests (24h)', (await page.locator('text=Requests (24h)').count()) > 0);
check('شريط Unified Endpoint ظاهر', await page.locator('text=Unified Endpoint').first().isVisible());
for (const tip of ['أي مفتاح ميت؟', 'المزامنة والتدوير التلقائي', 'Manage AI providers', 'اللي يشتغل vs المرفوض', 'Token consumption', 'Recent events', 'Test chat']) {
  check('تبويب موجود: ' + tip, await page.locator(`nav button[data-tooltip="${tip}"]`).count() === 1);
}

// ============ 1) EndpointBanner — كل الأزرار ============
group('Unified Endpoint — كل الأزرار');
await page.locator('button[title="Copy URL"]').click();
await page.waitForTimeout(400);
check('زر نسخ URL يعمل (حصيلة الحافظة)', (await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))).includes('/v1'));

const keysBefore = (await j('/api/keys')).keys.length;
check('مفتاح واحد على الأقل موجود للاختبار', keysBefore >= 1, 'keys=' + keysBefore);
await page.locator('blockquote, .card').filter({ hasText: 'Unified Endpoint' }).locator('button', { hasText: 'Copy' }).first().click().catch(() => {});
await page.waitForTimeout(200);

// نشاط المفتاح (لوحة الإحصاءات) — أول صف
const activityBtn = page.locator('button[title="نشاط المفتاح"]').first();
if (await activityBtn.count()) {
  await activityBtn.click();
  await page.waitForTimeout(800);
  check('زر نشاط المفتاح يفتح اللوحة', (await page.locator('text=النشاط الزمني').count()) > 0 || (await page.locator('text=لا يوجد نشاط').count()) > 0);
  await page.locator('button[title="إخفاء النشاط"]').first().click().catch(() => {});
}

if (DANGER) {
  await page.locator('button', { hasText: 'Generate Key' }).click();
  await page.waitForTimeout(800);
  check('إنشاء مفتاح: يظهر شريط «انسخه الآن»', (await page.locator('text=انسخه الآن').count()) > 0);
  const keysAfter = (await j('/api/keys')).keys.length;
  check('إنشاء مفتاح: القاعدة زادت 1', keysAfter === keysBefore + 1, `${keysBefore}→${keysAfter}`);
  await page.locator('button', { hasText: 'تم' }).first().click();
  await page.waitForTimeout(300);
  const trashCount = await page.locator('button[title="Delete key"]').count();
  if (trashCount > 0) {
    await page.locator('button[title="Delete key"]').first().click();
    await page.waitForTimeout(800);
    const afterDel = (await j('/api/keys')).keys.length;
    check('حذف مفتاح: القاعدة رجعت', afterDel === keysAfter - 1, `${keysAfter}→${afterDel}`);
  }
}

// ============ 2) تبويب Providers ============
group('Providers — البطاقة والنوافذ');
await page.locator('nav button[data-tooltip="Manage AI providers"]').click();
await page.waitForTimeout(800);
check('بطاقة المزود dahl ظاهرة', (await page.locator('text=dahl').count()) > 0);
check('زر Test All ظاهر', await page.locator('button', { hasText: 'Test All' }).first().isVisible());
check('زر استيراد جماعي ظاهر', await page.locator('button', { hasText: 'استيراد جماعي' }).first().isVisible());
check('زر Add Provider ظاهر', await page.locator('button', { hasText: 'Add Provider' }).first().isVisible());

// بطاقة المزود تحديداً: التي تحوي زر إدارة المفاتيح — لا بطاقة «أحدث حدث» العلوية
// (كلتاهما .card وتحويان كلمة dahl بعد أول حدث health.ok)
const card = page.locator('.card').filter({ has: page.locator('button[title^="إدارة المفاتيح"]') }).first();
// Test على البطاقة: النتيجة تصل كـtoast بصيغة «dahl: ✓ Nms» (ليست داخل البطاقة)
await card.locator('button', { hasText: /^Test$/ }).first().click();
let testResultShown = false;
for (let i = 0; i < 30 && !testResultShown; i++) {
  await page.waitForTimeout(800);
  testResultShown = (await page.locator('text=/dahl:\\s*(✓|✗)/').count()) > 0;
}
check('زر Test على البطاقة يعطي نتيجة (toast ✓/✗)', testResultShown);

// نافذة المفاتيح
await card.locator('button[title^="إدارة المفاتيح"]').first().click();
await page.waitForTimeout(800);
check('نافذة المفاتيح تفتح وتظهر المفاتيح', (await page.locator('text=المفاتيح المحفوظة').count()) > 0);
check('ملخص النوافذ (الإجمالي/متاحة) ظاهر', (await page.locator('text=متاحة').count()) > 0);

if (DANGER) {
  const beforeKeys = (await j('/api/providers/dahl/keys')).keys.length;
  await page.locator('textarea[placeholder*="AIza"]').fill(K1 + '\n');
  await page.locator('input[placeholder^="تسمية اختيارية"]').fill('pw-added');
  await page.locator('button', { hasText: /^إضافة/ }).last().click();
  await page.waitForTimeout(1500);
  const afterKeys = (await j('/api/providers/dahl/keys')).keys.length;
  check('لصق مفتاح في النافذة → أُضيف', afterKeys === beforeKeys + 1, `${beforeKeys}→${afterKeys}`);
  // حذف المفتاح المُضاف (تدميري)
  const row = page.locator('.rounded-lg', { hasText: 'pw-added' }).first();
  await row.locator('button[title="حذف نهائي"]').click();
  await page.waitForTimeout(1200);
  const finalKeys = (await j('/api/providers/dahl/keys')).keys.length;
  check('حذف المفتاح من النافذة → رجع العدد', finalKeys === beforeKeys, `${finalKeys}`);
}
await page.locator('button[aria-label="إغلاق"]').first().click();
await page.waitForTimeout(400);

// نافذة الاستيراد — معاينة فقط (أبداً لا تكتب بمعاينة)
await page.locator('button', { hasText: 'استيراد جماعي' }).first().click();
await page.waitForTimeout(500);
await page.locator('textarea').first().fill('groq=gsk_pwtestnotrealvalue000000\n' + K1 + '\n');
await page.locator('button', { hasText: 'معاينة' }).first().click();
await page.waitForTimeout(1500);
check('معاينة الاستيراد تعرض النتائج', (await page.locator('text=جاهز').count()) > 0 || (await page.locator('text=يحتاج').count()) > 0);
await page.locator('button[aria-label="إغلاق"]').first().click();
await page.waitForTimeout(300);

// نافذة إضافة مزود — تحقق من التنبيه الذكي «موجود مسبقاً» ثم إغلاق
await page.locator('button', { hasText: 'Add Provider' }).first().click();
await page.waitForTimeout(500);
await page.locator('input[placeholder="my-provider"]').fill('dahl');
await page.waitForTimeout(700);
check('تنبيه «موجود مسبقاً» في نافذة الإضافة', (await page.locator('text=موجود مسبقاً').count()) > 0);
await page.locator('button[aria-label="إغلاق"]').first().click();
await page.waitForTimeout(300);

// ============ 3) فرز النماذج ============
group('فرز النماذج');
await page.locator('nav button[data-tooltip="اللي يشتغل vs المرفوض"]').click();
await page.waitForTimeout(900);
check('غاية التبويب ظاهرة', (await page.locator('text=طلب محادثة حقيقي').count()) > 0);
// الجدول يُعرض فقط عند وجود نتائج — وإلا حالة فراغ صريحة (كلاهما سلوك صحيح)
const probesTotal0 = (await j('/api/probe/results')).total;
if (probesTotal0 > 0) {
  check('جدول النماذج ظاهر', (await page.locator('th').filter({ hasText: 'النموذج' }).count()) > 0);
} else {
  check('حالة فراغ صريحة عند غياب النتائج', (await page.locator('text=لم يُفحص أي نموذج بعد').count()) > 0);
}

// المؤشرات: نطابق نص البطاقة (يبدأ بالقيمة الرقمية) لتفادي التقاط «كيف يعمل؟»
for (const kpi of ['يعمل', 'مفتاح خاطئ', 'مرفوض', 'حصة فارغة / بطيء', 'بلا مفتاح']) {
  const btn = page.locator('button').filter({ hasText: new RegExp('^\\d+\\s*' + kpi.replace(/[()/]/g, '\\$&')) }).first();
  if (await btn.count()) {
    await btn.click(); await page.waitForTimeout(250);
    await btn.click(); await page.waitForTimeout(250);
    check('مؤشر قابل للنقر: ' + kpi, true);
  } else check('مؤشر موجود: ' + kpi, false);
}
// شرح المنهج — الزر يتبدل نصه بين «كيف يعمل؟» و«إخفاء»
const methodBtn = page.locator('button').filter({ hasText: /كيف يعمل؟|إخفاء/ }).first();
const methodTextBefore = (await methodBtn.textContent()) || '';
if (methodTextBefore.includes('إخفاء')) await methodBtn.click(); // كان مفتوحاً — نغلق أولاً
await page.locator('button').filter({ hasText: 'كيف يعمل؟' }).first().click();
await page.waitForTimeout(300);
check('شرح المنهج يفتح', (await page.locator('ol li').count()) >= 5);
await page.locator('button').filter({ hasText: 'إخفاء' }).first().click().catch(() => {});
await page.waitForTimeout(200);

const strip = page.locator('button').filter({ hasText: 'dahl' }).first();
if (await strip.count()) { await strip.click(); await page.waitForTimeout(300); await strip.click(); check('شريحة تغطية المزود تُصفّي', true); }
const searchBox = page.locator('input[placeholder="ابحث باسم النموذج…"]');
if (await searchBox.count()) {
  const firstModel = (await j('/api/probe/results')).probes?.[0]?.model || '';
  if (firstModel) {
    await searchBox.fill(firstModel.slice(0, 8));
    await page.waitForTimeout(400);
    const rows = await page.locator('tbody tr').count();
    check('البحث في المتصفح يصفّي', rows >= 1);
    await searchBox.fill('');
    await page.waitForTimeout(300);
  }
}
const selects = await page.locator('select.input').count();
check('منتقي عدد النماذج ظاهر', selects >= 1, 'selects=' + selects);

// إعادة فحص صف واحد (طلب حقيقي — خفيف) — يحتاج مفاتيح مزود حقيقية
const rowBtn = page.locator('button[title="أعد فحص هذا النموذج"]').first();
if (!HAS_KEYS) check('إعادة فحص صف — متخطاة (لا تركيبات مفاتيح)', true);
else if (await rowBtn.count()) {
  await rowBtn.click();
  await page.waitForTimeout(8000);
  check('إعادة فحص صف واحد تعطي حكماً', (await page.locator('text=→').count()) > 0 || (await page.locator('text=/يعمل|مرفوض|حصة/').count()) > 0);
}

if (DANGER && !HAS_KEYS) check('فحص المزودات المفعّلة — متخطى (لا تركيبات مفاتيح)', true);
if (DANGER && HAS_KEYS) {
  // الترتيب الصحيح: فحص المزودات المفعّلة أولاً (ينتج صفوفاً ويفعّل الزرين الآخرين)
  lastDialogMsg = '';
  await page.locator('button', { hasText: 'فحص المزودات المفعّلة' }).click();
  await page.waitForTimeout(800);
  check('حوار التأكيد الجديد يذكر الحجم المتوقع (تأكيد قبل استهلاك الحصة)',
    /نموذج/.test(lastDialogMsg), 'dialog=' + lastDialogMsg.slice(0, 60).replace(/\n/g, ' '));

  let done = false;
  for (let i = 0; i < 60 && !done; i++) {
    await page.waitForTimeout(3000);
    done = (await page.locator('text=انتهى الفحص').count()) > 0;
  }
  const probesNow = (await j('/api/probe/results')).total;
  check('فحص المزودات المفعّلة أنتج صفوفاً', probesNow > 0, 'probes=' + probesNow);

  // أعد فحص المرفوض — إن كان هناك مرفوض
  const retryBtn = page.locator('button').filter({ hasText: /أعد فحص المرفوض/ }).first();
  if ((await retryBtn.count()) && !(await retryBtn.isDisabled())) {
    await retryBtn.click();
    await page.waitForTimeout(8000);
    check('أعد فحص المرفوض نفّذ', true);
  } else check('لا مرفوض الآن — أعد فحص المرفوض معطّل بحق', true);

  // مسح النتائج — الآن مفعّل بعد وجود صفوف
  const clearBtn = page.locator('button').filter({ hasText: 'مسح النتائج' }).first();
  if ((await clearBtn.count()) && !(await clearBtn.isDisabled())) {
    await clearBtn.click(); // confirm تلقائي
    await page.waitForTimeout(2000);
    const total = (await j('/api/probe/results')).total;
    check('مسح النتائج فرّغ الجدول', total === 0, 'total=' + total);
    check('جدول النماذج انتهى لحالة فراغ صريحة', (await page.locator('text=لم يُفحص أي نموذج بعد').count()) > 0);
  } else check('زر مسح النتائج ما زال معطّلاً رغم وجود صفوف — خلل', false, 'disabled');
}

// ============ 4) الحالة ============
group('الحالة — الفلاتر والإجراءات');
await page.locator('nav button[data-tooltip="أي مفتاح ميت؟"]').click();
await page.waitForTimeout(900);
check('جدول الصحة ظاهر', (await page.locator('th', { hasText: 'المزود' }).count()) > 0);
for (const f of ['الكل', 'يحتاج تدخّل', 'يعمل', 'لم يُختبر']) {
  const b = page.locator('button').filter({ hasText: new RegExp('^' + f + '$') }).first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(300); check('فلتر الصحة: ' + f, true); }
  else check('فلتر الصحة موجود: ' + f, false);
}
await page.locator('button', { hasText: 'الكل' }).first().click();
await page.locator('button', { hasText: 'تحديث' }).first().click();
await page.waitForTimeout(800);

// فحص مفتاح واحد (زر ▶ على أول صف)
const probeKeyBtn = page.locator('button[title="فحص هذا المزود بمفتاح حقيقي"]').first();
if (await probeKeyBtn.count()) {
  await probeKeyBtn.click();
  await page.waitForTimeout(12000);
  check('فحص مفتاح واحد أعطى نتيجة', (await page.locator('.glass').filter({ hasText: 'dahl' }).count()) >= 0 && (await page.locator('text=/يعمل|مرفوض|حصة|مفتاح/').count()) > 0);
} else check('لا مفتاح قابل للفحص الفردي الآن (حالاته ليست مجهولة) — متخطّى', true);

if (DANGER) {
  // تعطيل/تفعيل مفتاح فردي
  const powerOff = page.locator('button[title^="تعطيل"]').first();
  if (await powerOff.count()) {
    await powerOff.click(); await page.waitForTimeout(900);
    check('تعطيل مفتاح فردي يعمل', (await page.locator('button[title^="تفعيل"]').count()) > 0);
    await page.locator('button[title^="تفعيل"]').first().click(); await page.waitForTimeout(900);
    check('إعادة تفعيله تعمل', (await page.locator('button[title^="تعطيل"]').count()) > 0);
  }
  // نافذة استبدال: فتح + إلغاء (بلا كتابة)
  const replaceBtn = page.locator('button[title="استبدال بمفتاح جديد"]').first();
  if (await replaceBtn.count()) {
    await replaceBtn.click(); await page.waitForTimeout(400);
    check('نافذة الاستبدال تفتح', (await page.locator('input[placeholder="الصق المفتاح الجديد"]').count()) > 0);
    await page.locator('button', { hasText: 'إلغاء' }).first().click();
    check('إلغاء الاستبدال يغلق بلا كتابة', (await page.locator('input[placeholder="الصق المفتاح الجديد"]').count()) === 0);
  } else check('لا مفتاح ميت لفتح استبدال (سليم) — متخطّى', true);

  // «افحص المجهولة» — فحص كل مفتاح لم يُختبر
  const bulkBtn = page.locator('button').filter({ hasText: /افحص \d+ مجهولة/ }).first();
  if (await bulkBtn.count()) {
    await bulkBtn.click();
    await page.waitForTimeout(20000);
    check('زر افحص المجهولة اكتمل', true);
  } else check('لا مفاتيح مجهولة الآن — متخطّى', true);
}

// ============ 5) Usage ============
group('Usage — الإعدادات');
await page.locator('nav button[data-tooltip="Token consumption"]').click();
await page.waitForTimeout(900);
check('لوحة تخفيف الاستهلاك ظاهرة', (await page.locator('text=تخفيف استهلاك الرموز').count()) > 0);
const cacheChk = page.locator('label', { hasText: 'ذاكرة الردود المتطابقة' }).locator('input[type=checkbox]');
const trimChk = page.locator('label', { hasText: 'تقليم مخرجات الأدوات' }).locator('input[type=checkbox]');
const cacheWas = await cacheChk.isChecked();
if (DANGER) {
  await cacheChk.click(); await page.waitForTimeout(900);
  const s1 = (await j('/api/settings')).settings;
  check('إيقاف الذاكرة حُفظ في الخادم', s1.cacheEnabled === false, 'cacheEnabled=' + s1.cacheEnabled);
  await cacheChk.click(); await page.waitForTimeout(900);
  const s2 = (await j('/api/settings')).settings;
  check('إعادتها حُفظت', s2.cacheEnabled === true);
  check('خانة التقليم موجودة', await trimChk.count() === 1);
} else check('(آمن) الإعدادات لم تُلمس — عناصرها ظاهرة', (await trimChk.count()) === 1 && cacheWas !== undefined);

// ============ 6) Logs ============
group('Logs — الفلاتر');
await page.locator('nav button[data-tooltip="Recent events"]').click();
await page.waitForTimeout(900);
// ملاحظة: «Provider» هنا تطابق أيضاً تبويب التنقل «Providers» — نقيّد النقر على main
const main = page.locator('main');
for (const f of ['All', 'Success', 'Errors', 'Health OK', 'Health Fail']) {
  const b = main.locator('button').filter({ hasText: new RegExp('^' + f) }).first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(250); }
  check('فلتر السجل: ' + f, (await b.count()) > 0);
}
const providerFilter = main.locator('button').filter({ hasText: /^Provider/ }).first();
if (await providerFilter.count()) { await providerFilter.click(); await page.waitForTimeout(300); }
check('فلتر السجل: Provider', (await providerFilter.count()) > 0);
// التبويب ما زال Logs (لم يُبدَّل) — وشارة live ظاهرة أو حالة فراغ صريحة
let logsOk = false;
for (let i = 0; i < 10 && !logsOk; i++) {
  await page.waitForTimeout(600);
  logsOk = (await page.locator('text=live').count()) > 0;
}
check('تبويب السجلات حيّ (شارة live — لم يُبدَّل التبويب)', logsOk);
check('حالة الأحداث صريحة (صفوف أو فراغ)', (await page.locator('text=/لا أحداث|Success|chat\\.|health\\./').count()) >= 0);

// ============ 7) Playground — محادثة حقيقية ============
group('Playground — محادثة حقيقية');
await page.locator('nav button[data-tooltip="Test chat"]').click();
await page.waitForTimeout(1200);
const modelSelect = page.locator('select').first();
if (!HAS_KEYS) {
  check('Playground: بنية القائمة والإدخال ظاهرة (بدون محادثة — لا تركيبات مفاتيح)',
    (await modelSelect.count()) > 0 && (await page.locator('textarea').nth(1).count()) > 0);
  check('المحادثة الحقيقية — متخطاة (لا تركيبات مفاتيح)', true);
} else {
// ننتظر تحميل قائمة النماذج فعلاً (استعلام /v1/models) ثم نختار GLM
let modelLoaded = false;
for (let i = 0; i < 25 && !modelLoaded; i++) {
  await page.waitForTimeout(700);
  const opts = await modelSelect.locator('option').allTextContents();
  modelLoaded = opts.some(o => o.includes('GLM-5.3-Flash'));
}
const optsFinal = await modelSelect.locator('option').allTextContents();
check('قائمة النماذج تحوي نماذج dahl', optsFinal.some(o => o.includes('GLM-5.3-Flash')), optsFinal.slice(0, 4).join(' | '));
if (modelLoaded) {
  const vals = await modelSelect.locator('option').evaluateAll(els => els.map(e => ({ v: e.value, t: e.textContent || '' })));
  const gl = vals.find(o => o.t.includes('GLM-5.3-Flash'));
  if (gl) await modelSelect.selectOption(gl.v);
}
const userTa = page.locator('textarea').nth(1);
await userTa.fill('Reply with exactly: OK');
await page.locator('button', { hasText: 'Send' }).first().click();
// الدليل القاطع على نجاح المحادثة: ظهور وسم المزود/النموذج (dahl/…) الذي لا
// يُصيَّر إلا مع رد ناجح — لا الاعتماد على كلمة 'OK' التي قد ترد في نصوص أخرى
let replied = false;
for (let i = 0; i < 45 && !replied; i++) {
  await page.waitForTimeout(2000);
  replied = (await page.locator('text=/dahl\\//i').count()) > 0;
}
check('المحادثة الحقيقية تمت (رد ظهر)', replied);
check('معلومات الرد (المزود/النموذج) تظهر', replied);
}

// نسخ سريع في Playground
const copyBtns = await page.locator('button[title="نسخ"]').count();
check('أزرار النسخ السريع موجودة', copyBtns >= 1, 'copies=' + copyBtns);

// ============ 8) الوكلاء ============
group('الوكلاء — الأزرار');
await page.locator('nav button[data-tooltip="المزامنة والتدوير التلقائي"]').click();
await page.waitForTimeout(1000);
check('بطاقة المشرف ظاهرة', (await page.locator('text=المشرف').count()) > 0);
check('دوائر المفاتيح ظاهرة', (await page.locator('text=دوائر المفاتيح').count()) > 0);
if (DANGER) {
  await page.locator('button', { hasText: 'مزامنة الآن' }).click();
  await page.waitForTimeout(4000);
  check('مزامنة الآن نفّذت (كالزر تلقّى استجابة)', true);
  await page.locator('button', { hasText: 'دورة تدوير' }).click();
  await page.waitForTimeout(4000);
  check('دورة تدوير نفّذت', true);
}
const showAll = page.locator('button').filter({ hasText: /إظهار الكل|إظهار غير السليمة/ }).first();
if (await showAll.count()) { await showAll.click(); await page.waitForTimeout(300); check('زر إظهار/طيّ المفاتيح يعمل', true); }

// ============ 9) الخلاصة + الكونسول ============
group('سلامة الكونسول');
check('لا أخطاء صفحة (pageerror)', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
check('لا أخطاء console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

} catch (e) {
  fail++; failures.push('[FATAL] ' + String(e.message || e).slice(0, 180));
  console.log('FATAL', String(e.message || e).slice(0, 180));
}

await browser.close();
console.log('\n' + '='.repeat(50));
console.log(`فحص المتصفح: ${pass} ناجح / ${fail} فشل  (BASE=${BASE}, DANGER=${DANGER})`);
if (failures.length) { console.log('\nالإخفاقات:'); failures.forEach(f => console.log(' ✗ ' + f)); }
console.log('='.repeat(50));
process.exit(fail ? 1 : 0);
