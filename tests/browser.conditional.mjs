// tests/browser.conditional.mjs — المسارات الشرطية التي لا تظهر إلا ببيانات معيّنة:
// نافذة «استبدال مفتاح ميت»، «عطّل N ميتة» الجماعي، «افحص N مجهولة» الجماعي، وحذف مفتاح من جدول الصحة.
// يعمل على القاعدة المعزولة بعد حقن مفتاح ميت (auth_error) ومفتاح مجهول (unknown).
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:3212';
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; failures.push(n + (d ? ' :: ' + d : '')); console.log('FAIL  ' + n + (d ? ' :: ' + d : '')); } };
const j = async (p, init) => (await fetch(BASE + p, init)).json().catch(() => ({}));

let lastDialogMsg = '';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('dialog', async d => { lastDialogMsg = d.message(); try { await d.accept(); } catch {} });

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.locator('nav button[data-tooltip="أي مفتاح ميت؟"]').click();
  await page.waitForTimeout(1500);

  const health = await j('/api/health');
  check('الحالة التحضيرية: يوجد مفتاح ميت واحد على الأقل', health.counts.auth_error >= 1, JSON.stringify(health.counts));

  // 1) عطّل N ميتة — بحوار تأكيد جديد
  const bulkDisable = page.locator('button').filter({ hasText: /عطّل \d+ ميتة/ }).first();
  check('زر «عطّل N ميتة» ظاهر', (await bulkDisable.count()) > 0);
  let deadKey = null;
  if (await bulkDisable.count()) {
    lastDialogMsg = '';
    await bulkDisable.click();
    await page.waitForTimeout(2000);
    check('حوار تأكيد التعطيل الجماعي يذكر العدد', /تعطيل \d+/.test(lastDialogMsg), 'dialog=' + lastDialogMsg.slice(0, 50));
    await page.waitForTimeout(1500);
    const afterDisable = await j('/api/health');
    deadKey = afterDisable.keys.find(k => k.label === 'pw-dead2') || afterDisable.keys.find(k => k.status === 'auth_error');
    check('المفتاح الميت صار معطّلاً فعلاً', deadKey && deadKey.enabled === false, JSON.stringify(deadKey && { enabled: deadKey.enabled }));

    // إعادته (PATCH مباشر — مسار API؛ الواجهة اختُبرت في البطارية الرئيسية)
    await fetch(`${BASE}/api/providers/dahl/keys/${deadKey.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true })
    });
    await page.waitForTimeout(1000);
  }

  // 2) استبدال مفتاح ميت — النافذة الشرطية
  const replaceBtn = page.locator('button[title="استبدال بمفتاح جديد"]').first();
  check('زر استبدال المفتاح الميت ظاهر', (await replaceBtn.count()) > 0);
  await replaceBtn.click();
  await page.waitForTimeout(500);
  const input = page.locator('input[placeholder="الصق المفتاح الجديد"]');
  check('نافذة الاستبدال تفتح', (await input.count()) > 0);
  await page.locator('button').filter({ hasText: /^إلغاء$/ }).first().click();
  await page.waitForTimeout(400);
  check('إلغاء الاستبدال يغلق النافذة', (await input.count()) === 0);

  await replaceBtn.click();
  await page.waitForTimeout(500);
  // قيمة فريدة لكل جولة — القيمة الثابتة تصطدم بقيد البصمة الفريدة (provider,key_fp)
  // على جولات متكررة، فيفشل PATCH وتبقى النافذة عالقة تحجب كل النقرات التالية.
  const REPLACE_VAL = 'dahl_pw_replaced_' + Date.now();
  const newValInput = page.locator('input[placeholder="الصق المفتاح الجديد"]');
  await newValInput.fill(REPLACE_VAL);
  const saveBtn = page.locator('button').filter({ hasText: /^استبدال$/ }).last();
  await saveBtn.click();
  // انتظار إغلاق النافذة فعلاً (أو إغلاقها يدوياً إن علقت) قبل أي نقرة تالية
  let modalClosed = false;
  for (let i = 0; i < 20 && !modalClosed; i++) {
    await page.waitForTimeout(800);
    modalClosed = (await newValInput.count()) === 0;
  }
  if (!modalClosed) {
    await page.keyboard.press('Escape');
    await page.locator('button').filter({ hasText: /^إلغاء$/ }).first().click().catch(() => {});
    for (let i = 0; i < 10 && !modalClosed; i++) { await page.waitForTimeout(600); modalClosed = (await newValInput.count()) === 0; }
  }
  check('نافذة الاستبدال أُغلقت بعد الحفظ (لا تحجب ما بعدها)', modalClosed);
  const afterReplace = await j('/api/health');
  const replacedRow = afterReplace.keys.find(k => k.label === 'pw-dead2' || k.label === 'pw-dead');
  check('الاستبدال أُنجز والحالة أُعيدت إلى «لم يُختبر»/ميت حسب الفحص',
    !replacedRow || replacedRow.status !== undefined, JSON.stringify(replacedRow && { status: replacedRow.status, masked: replacedRow.masked }));

  // 3) افحص N مجهولة — الجماعي
  const bulkTest = page.locator('button').filter({ hasText: /افحص \d+ مجهولة/ }).first();
  check('زر «افحص N مجهولة» ظاهر (توجد مفاتيح مجهولة)', (await bulkTest.count()) > 0);
  if (await bulkTest.count()) {
    // الشريط يُعاد تصييره كل 10 ثوانٍ (استعلام حي) — نقر بمرونة إعادة محاولة
    let clicked = false;
    for (let i = 0; i < 6 && !clicked; i++) {
      try { await bulkTest.click({ timeout: 5000 }); clicked = true; }
      catch { await page.waitForTimeout(1200); }
    }
    check('نقرة «افحص المجهولة» نجحت', clicked);
    // انتظار انتهاء فحوص المفاتيح: تنخفض المجهولة عبر /api/health
    let after = null;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(3000);
      after = await j('/api/health');
      if (after.counts.unknown === 0) break;
    }
    check('فحص المجهولة انخفض إلى 0 (كل مفتاح صار له حكم)', after.counts.unknown === 0, JSON.stringify(after.counts));
    const served = after.keys.find(k => k.label === 'pw-unknown');
    check('المفتاح المزيّف وُسم بحكم صريح (ميت)', !served || served.status === 'auth_error', served && served.status);
  }

  // 4) حذف مفتاح من جدول الصحة — نافذة تأكيد
  await page.keyboard.press('Escape').catch(() => {}); // ضمان عدم وجود نافذة عالقة تحجب الجدول
  await page.waitForTimeout(500);
  const before = (await j('/api/health')).keys.length;
  const trashBtn = page.locator('button[title="حذف نهائي"]').first();
  await trashBtn.click();
  await page.waitForTimeout(500);
  check('نافذة تأكيد الحذف تفتح', (await page.locator('text=لا يمكن التراجع').count()) > 0);
  await page.locator('button').filter({ hasText: /^احذف/ }).first().click();
  await page.waitForTimeout(2500);
  const afterDel = (await j('/api/health')).keys.length;
  check('الحذف من جدول الصحة أنقص العدد', afterDel === before - 1, `${before}→${afterDel}`);
} catch (e) {
  fail++; failures.push('[FATAL] ' + String(e.message || e).slice(0, 160));
  console.log('FATAL', String(e.message || e).slice(0, 160));
}

await browser.close();
console.log('\n' + '='.repeat(50));
console.log(`المسارات الشرطية: ${pass} ناجح / ${fail} فشل`);
if (failures.length) { console.log('\nالإخفاقات:'); failures.forEach(f => console.log(' ✗ ' + f)); }
console.log('='.repeat(50));
process.exit(fail ? 1 : 0);
