// scripts/screenshot.mjs — يلتقط صور الواجهة لملف README.
// يحتاج خادماً حياً (BASE، افتراضياً 127.0.0.1:3001). لا يلمس أي بيانات:
// يقرأ فقط، ولا ينشئ مفاتيح ولا يحذفها.
//
//   node scripts/screenshot.mjs                 # الصور الافتراضية
//   BASE=http://127.0.0.1:3001 node scripts/screenshot.mjs
//
// المخرجات في docs/screenshots/ — وهي متتبعة عمداً (الصور تُنشر مع المستودع).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const BASE = process.env.BASE || 'http://127.0.0.1:3001';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
// viewport ثابت: صورة متغيّرة الأبعاد في README تبدو مهزوزة.
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2, // شبكية — النص العربي يصير واضحاً في README
  locale: 'ar',
});
const page = await context.newPage();

const res = await fetch(BASE + '/api/health').catch(() => null);
if (!res || !res.ok) {
  console.error(`✖ لا خادم حيّ على ${BASE} — شغّل: npm start`);
  process.exit(1);
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500); // الرسوم والعدادات تُملأ عبر WebSocket

const shot = async (name, opts = {}) => {
  await page.screenshot({ path: join(OUT, name), ...opts });
  console.log('✓ ' + name);
};

// 1) الواجهة كاملة — الصورة البطلة في README
await shot('dashboard.png');

// 2) التبويبات: كل واحد بتخطيطه الحقيقي.
// نطابق على data-tooltip (وصف ثابت) لا على label: نص عربي فيه شدّة قد
// يختلف بصرياً عن مكافئه، والخطأ هنا صامت (يُلتقط نفس المشهد مرتين).
const TABS = [
  ['أي مفتاح ميت؟', 'tab-health.png'],
  ['إدارة مزوّدي الذكاء الاصطناعي', 'tab-providers.png'],
  ['استهلاك التوكنات', 'tab-usage.png'],
  ['اختبار المحادثة', 'tab-playground.png'],
];
const shots = new Set();
for (const [tip, file] of TABS) {
  const btn = page.locator(`nav button[data-tooltip="${tip}"]`).first();
  if (!(await btn.count())) throw new Error('تبويب مفقود (data-tooltip): ' + tip);
  await btn.click();
  await page.waitForTimeout(1600);
  // الهدف: مشهد مختلف فعلاً — الاسم وحده لا يكفي.
  const key = (await page.locator('main').innerHTML()).length + ':' + (await page.locator('main h2').first().textContent().catch(() => ''));
  if (shots.has(key)) throw new Error('التبويب لم يغيّر المحتوى: ' + tip);
  shots.add(key);
  await shot(file);
}

// 3) الشريط العلوي: اسم النظام + زر التوليد — أوضح دليل على التسمية
await page.locator(`nav button[data-tooltip="أي مفتاح ميت؟"]`).first().click();
await page.waitForTimeout(1200);
const banner = page.locator('.card').filter({ has: page.locator('button[title="Generate API Key"]') }).first();
if (await banner.count()) {
  await banner.screenshot({ path: join(OUT, 'gak-keys-banner.png') });
  console.log('✓ gak-keys-banner.png');
}

// 4) نسخة الجوال — تُثبت أن الواجهة متجاوبة فعلاً لا على الورق
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  locale: 'ar',
  isMobile: true,
  hasTouch: true,
});
const mp = await mobile.newPage();
await mp.goto(BASE, { waitUntil: 'networkidle' });
await mp.waitForTimeout(2500);
await mp.screenshot({ path: join(OUT, 'mobile.png') });
console.log('✓ mobile.png');
await mobile.close();

await browser.close();
console.log('\nالمخرجات في docs/screenshots/');
