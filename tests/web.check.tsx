// tests/web.check.tsx — حرّاس ثابتة على **عقد الواجهة والنصوص والتكرار**.
//
// لماذا هذا الملف: أعطال الجولة الثالثة لم تكن كلها منطقية — بعضها كان:
//   1) ألوان Tailwind مُستخدَمة وغير مُعرَّفة (bg-panel، border-l-success) ⇒
//      عناصر بلا خلفية/حدود تُرسم صامتةً، ولا يكتشفها أي اختبار سلوكي.
//   2) نصوص تكذب على المستخدم («يُخزَّن في .env» بينما هو في القاعدة).
//   3) حارس SSRF مكرّر ميت في provider-manager.ts بلا مستهلك.
//   4) قالب نصّي مكسور بعلامة اقتباس مفردة يطبع ${...} حرفياً.
// هذا الفحص يمسك هذه الفئات قبل أن تصل للمستخدم.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
// إزالة التعليقات قبل فحص «غياب الرمز»: التعليق قد يذكر الاسم المحذوف شرحاً
// (وهذا مقصود) — فلا يجوز أن يُحسب كتكرار حقيقي.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const walk = (rel: string): string[] => {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const child = join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(child));
    else out.push(child.replace(/\\/g, '/'));
  }
  return out;
};

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; } else {
    failures.push(`${name}${detail ? ' → ' + detail : ''}`);
    console.log('FAIL  ' + name + (detail ? ' :: ' + detail : ''));
  }
};
const group = (t: string) => console.log('\n── ' + t);

// ============================================================
// 1) رموز ألوان Tailwind: كل لون مُستخدَم في src يجب أن يكون مُعرَّفاً
// ============================================================
group('رموز ألوان Tailwind');

const twConfig = read('tailwind.config.js');
const configColors = new Set(
  [...twConfig.matchAll(/"?([a-z0-9-]+)"?\s*:\s*"#/g)].map(m => m[1])
);
for (const token of ['panel', 'ok', 'warn', 'bad', 'ink', 'ink-muted', 'ink-dim',
  'primary', 'primary-2', 'canvas', 'surface', 'surface-2', 'line', 'line-hover']) {
  check(`لون "${token}" مُعرَّف في tailwind.config.js`, configColors.has(token));
}

// رموز ليست ألواناً (أحجام، محاذاة، أشكال) أو ألوان Tailwind الافتراضية.
// تُستثنى كي يبقى الفحص مركّزاً على الألوان المخصّصة غير المُعرَّفة.
const NON_COLOR = new Set([
  'base', 'center', 'left', 'right', 'justify', 'start', 'end',
  'none', 'dashed', 'solid', 'dotted', 'double', 'hidden',
  'xs', 'sm', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
  'black', 'white', 'transparent', 'current', 'inherit',
  // `border-b`/`border-t`/`border-l`/`border-s`… بلا لون = عرض أو جهة فقط
  // (l/r/t/b فيزيائية، s/e منطقية — الصحيحة في RTL)
  'b', 't', 'l', 'r', 's', 'e',
]);
// `border-s-4` = عرض، و`border-s-primary` = لون الجهة المنطقية
const isWidthOrShade = (t: string) => /^[lrtbse]-\d+$/.test(t) || /^[a-z]+-\d{2,3}$/.test(t);

const colorUtil =
  /\b(?:border-l|border-r|border-t|border-b|border-s|border-e|ring-offset|placeholder|decoration|outline|divide|border|bg|text|ring|from|via|to|accent|caret|fill|stroke|shadow)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![a-z0-9-])/g;
const offenders = new Map<string, Set<string>>();
for (const f of walk('src').filter(p => /\.tsx$/.test(p))) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  let m: RegExpExecArray | null;
  colorUtil.lastIndex = 0;
  while ((m = colorUtil.exec(src))) {
    const t = m[1];
    if (configColors.has(t) || NON_COLOR.has(t) || isWidthOrShade(t)) continue;
    if (!offenders.has(t)) offenders.set(t, new Set());
    offenders.get(t)!.add(f);
  }
}
check('لا رمز لون غير مُعرَّف في src',
  offenders.size === 0,
  [...offenders.entries()].map(([t, fs]) => `${t} (${[...fs].join(',')})`).join(' · '));

// ============================================================
// 2) النصوص لا تكذب: المفاتيح في القاعدة لا في .env
// ============================================================
group('صدق النصوص');

const modal = read('src/components/AddProviderModal.tsx');
check('نافذة الإضافة تُصرّح بالخزْن في gateway.db', /data\/gateway\.db/.test(modal));
check('نافذة الإضافة لا تدّعي الخزْن في .env',
  !/(stored in|يُخزَّن في|مخزّن في)\s*`?\.env/i.test(modal),
  'ادّعاء .env ما زال موجوداً');

const readme = read('README.md');
const deleteRow = readme.split('\n').find(l => l.includes('/api/providers/:id') && l.includes('DELETE')) || '';
check('README يوضّح أن حذف المزود يُبقي مفاتيحه (أو purgeKeys)',
  /kept|purgeKeys/i.test(deleteRow), 'السلوك الحقيقي: المفاتيح تبقى في القاعدة');

// ============================================================
// 3) عدّاد المزودات في الدليل = العدد الحقيقي في providers.yaml
// ============================================================
group('توافق الوثائق مع الواقع');
const yamlCount = (read('server/providers.yaml').match(/^\s*-\s*id:/gm) || []).length;
const guide = read('RUN-GUIDE.md');
// الدليل لا يثبّت عدّاً (يُبنى «N providers loaded» عند الإقلاع)، فالحارس يتحقق
// من وجود الصف ويقارن العدّاد فقط إن كان الدليل يذكر عدداً صريحاً.
const explicit = (guide.match(/(\d+)\s*مزوداً في `providers\.yaml`/) || [])[1];
const guideCount = explicit === undefined ? yamlCount : Number(explicit);
check('عدد المزودات في RUN-GUIDE يطابق providers.yaml',
  guideCount === yamlCount, `الدليل=${explicit ?? 'غير مثبّت'} · الفعلي=${yamlCount}`);

// ============================================================
// 4) لا حارس SSRF مكرّر ميت: المصدر الحي واحد
// ============================================================
group('حارس العنوان الواحد');
const pmgr = stripComments(read('server/provider-manager.ts'));
check('provider-manager.ts لا يحمل حارس SSRF ميتاً',
  !/PRIVATE_CIDRS|normalizeBaseUrl|validateAndNormalizeBaseUrl|function validateBaseUrl|BaseUrlCheck/.test(pmgr));
const indexSrc = read('server/index.ts');
check('index.ts يستورد guardBaseUrl من url-guard',
  indexSrc.includes("from './services/url-guard.js'") && indexSrc.includes('guardBaseUrl'));
check('index.ts لا يعرّف validateBaseUrl محلياً',
  !/function validateBaseUrl/.test(indexSrc));
check('url-guard.ts يُصدّر guardBaseUrl',
  /export function guardBaseUrl/.test(read('server/services/url-guard.ts')));

// ============================================================
// 5) حكم الطبقة والقالب: مصدر واحد، ولا ${...} داخل اقتباس مفرد
// ============================================================
group('مصدر الحكم الواحد والقالب');
check('index.ts يستورد حكم الطبقة من probe.ts',
  /resolveProbeVerdict/.test(indexSrc) && /shouldTryNextKey/.test(indexSrc) &&
  indexSrc.includes("from './probe.js'"));
check('index.ts لا يُعيد تعريف shouldTryNextKey محلياً',
  !/function shouldTryNextKey/.test(indexSrc));
check('index.ts لا يُعيد تعريف looksKeyRelated محلياً',
  !/function looksKeyRelated/.test(indexSrc));

const routerSrc = read('server/router.ts');
check('router.ts يحمل القالب الصحيح لخطأ «النموذج غير معروض»',
  routerSrc.includes('`model "${wantModel}" not offered by ${attempt.providerId}`'));
check('router.ts لم يعد يحمل القالب المكسور بعلامة اقتباس مفردة',
  !routerSrc.includes("'model \"${wantModel}\" not offered by"));
check('reachableProviderIds يستخدم نفس شرط التوجيه (usable)',
  /reachableProviderIds\(\)[\s\S]{0,400}this\.usable\(e\)/.test(routerSrc));

// ============================================================
// 6) سلسلة «فحص → حفظ → عرض»: لا فحص ضعيف ولا إدراج للفاشل
// ============================================================
group('سلامة سلسلة الفحص والحفظ');
const testRoute = indexSrc.slice(
  indexSrc.indexOf('async function verifyProvider'),
  indexSrc.indexOf("app.get('/api/logs'")
);
check('اختبار المزوّد محادثة حقيقية لا ping', /probeWithKeys\(/.test(testRoute));
check('اختبار المزوّد لا يكتفي بـping', !/\.ping\(\)/.test(testRoute));
check('مسار /api/test يستخدم الفحص الحقيقي', /verifyProvider\(/.test(testRoute));

const connectRoute = indexSrc.slice(
  indexSrc.indexOf("app.post('/api/probe/connect'"),
  indexSrc.indexOf('// ----- Periodic health check -----')
);
check('فحص الاتصال يستخدم محرّك الفحص الحقيقي', /probeModel\(/.test(connectRoute));
check('فحص الاتصال لا يعتمد على رمز الحالة وحده',
  !/statusCode\s*>=\s*200\s*&&\s*statusCode\s*<\s*400/.test(connectRoute));
check('فحص الدفعات موجود (لا حدّ 60 طلباً/دقيقة)',
  indexSrc.includes("'/api/probe/connect-batch'"));

const modalSrc = read('src/components/AddProviderModal.tsx');
check('الحفظ لا يسقط إلى auto عند وجود نماذج مفحوصة',
  !/successfulModels\.length > 0 \? successfulModels : 'auto'/.test(modalSrc));
check('الحفظ يمنع مزوّداً بلا نموذج مقبول', modalSrc.includes('لا نموذج مقبول'));
check('واجهة الإضافة تستخدم فحص الدفعات', /probeConnectBatch\(/.test(modalSrc));

// ===== المفاتيح اليتيمة: مزود محذوف تبقى مفاتيحه قابلة للإدارة والفحص =====
const patchKeys = indexSrc.slice(
  indexSrc.indexOf("app.patch('/api/providers/:id/keys/:keyId'"),
  indexSrc.indexOf("app.delete('/api/providers/:id/keys/:keyId'")
);
check('PATCH مفتاح لا يشترط وجود المزوّد', !/if \(!router\.getProvider\(id\)\)/.test(patchKeys));
const delKeys = indexSrc.slice(
  indexSrc.indexOf("app.delete('/api/providers/:id/keys/:keyId'"),
  indexSrc.indexOf('// ===== الاستيراد الجماعي =====')
);
check('DELETE مفتاح لا يشترط وجود المزوّد', !/if \(!router\.getProvider\(id\)\)/.test(delKeys));
check('فحص المفتاح يحكم طبقة المفتاح من probe.ts', /isKeyLayerAttempt\(out\)/.test(indexSrc));
check('فحص المفتاح يستعين بنموذج سابق النجاح', /probeRows\.find/.test(indexSrc));
check('config.ts يحمل autoEnable', /autoEnable: p\.autoEnable === false/.test(read('server/config.ts')));
check('الحالة تعرف rate_limited', read('src/components/HealthTab.tsx').includes('rate_limited: {'));
check('الفحص الجماعي يشمل المحدود مؤقتاً',
  /k\.status === 'unknown' \|\| k\.status === 'rate_limited'/.test(read('src/components/HealthTab.tsx')));

// ============================================================
// 7) سكربتات الاختبار تشمل الحرّاس الجديدة
// ============================================================
group('سكربتات الاختبار');
const pkg = JSON.parse(read('package.json'));
const testScript = pkg.scripts?.test || '';
check('سكربت test يشمل routing.check', testScript.includes('routing.check.tsx'));
check('سكربت test يشمل web.check', testScript.includes('web.check.tsx'));
for (const s of ['test:ui', 'test:live', 'test:prod', 'test:console', 'test:decrypt']) {
  check(`سكربت "${s}" معرّف`, typeof pkg.scripts?.[s] === 'string');
}

// ============================================================
// 8) نوافذ الإضافة/المفاتيح/الاستيراد تُغلق كغيرها (ESC + خارجها)
// ============================================================
// كانت الثلاث مبنية يدوياً بلا ESC ولا إغلاق بالنقر خارجها ولا إرجاع تركيز،
// بينما Modal المشترك يفعلها — فاختلف سلوك «إغلاق» بين نافذة وأخرى (مُثبت
// باختبار متصفح: Escape لم يُغلق نافذة الإضافة).
group('اتساق النوافذ');
for (const f of ['AddProviderModal', 'KeysModal', 'ImportModal']) {
  const src = read(`src/components/${f}.tsx`);
  check(`${f}: يستخدم useModalDismiss (ESC + تركيز)`, /useModalDismiss\(/.test(src));
  check(`${f}: يُغلق بالنقر خارج النافذة`, /onMouseDown=\{e => \{ if \(e\.target === e\.currentTarget\) onClose\(\); \}\}/.test(src));
  check(`${f}: role="dialog"`, src.includes('role="dialog"'));
}

// ============================================================
// 9) رقم الإصدار من مصدر واحد (package.json)
// ============================================================
group('الإصدار');
const appSrc = read('src/App.tsx');
check('الواجهة تقرأ __APP_VERSION__', appSrc.includes('__APP_VERSION__'));
check('لا يوجد إصدار مكتوب يدوياً في App.tsx', !/v1\.0\.0|badge-primary">v1\.0</.test(appSrc));
check('vite يحقن الإصدار من package.json', read('vite.config.ts').includes('__APP_VERSION__'));

// ============================================================
// 10) قائمة النماذج للوحة لا تُنشئ مفتاح عميل
// ============================================================
// كان تبويب «اختبار محادثة» يقرأ /v1/models عبر ensureUiKey ⇒ مفتاح عميل جديد
// بمجرد فتح التبويب، وواحد لكل متصفح، وكلها باسم playground.
group('قائمة النماذج');
const apiSrc = read('src/lib/api.ts');
const modelsLine = apiSrc.split(/\r?\n/).find(l => /^\s*models:\s*\(\)/.test(l)) || '';
check('دالة models تقرأ /api/models (لا /v1 بمفتاح عميل)', modelsLine.includes("'/api/models'"), modelsLine.slice(0, 90));
check('الخادم يوفّر /api/models', read('server/index.ts').includes("app.get('/api/models'"));
check('اسم مفتاح الواجهة مميّز لا متطابق', !/createKey\('playground'\)/.test(apiSrc));
// حذف مزوّد كان يُبقي صفوف فحصه في «فرز النماذج» بلا مزوّد ⇒ زر فحص يعيد 404
check('حذف المزوّد يمسح نتائج فحصه', /router\.removeProvider\(id\);[\s\S]{0,400}clearProbes\(id\)/.test(indexSrc));
// مزوّد بلا مفتاح كان يُوسم down برسالة «تعذّر جلب قائمة المزوّد» — تشخيص كاذب
check('فحص مزوّد بلا مفتاح يعيد no_key لا no_model', indexSrc.includes("status: 'no_key'"));
check('لا فحص لمزوّد بلا مفتاح متاح (لا صفوف no_key)', indexSrc.includes('router.availableKeySlots(entry).length === 0) continue;'));
// «جلب النماذج» كان يبتلع سبب الفشل ويعيد قائمة فارغة (يبدو عشوائياً)
check('جلب النماذج يشرح سبب الفشل', indexSrc.includes('fetchModelsDetailed') && read('server/provider-manager.ts').includes('fetchModelsDetailed'));
// الفحص الدفعي: مهلة أقصر وتوازٍ أعلى (كان 25 ث × 5)
check('الفحص الدفعي يستخدم مهلة 12 ث', /probeModel\('temp', check\.url, apiKey \|\| undefined, m, !apiKey, 12_000\)/.test(indexSrc));
// حلّ DNS مخزَّن + تمييز «نطاق غير موجود» عن «مُحلّل متعثّر»
const secSrc = read('server/security.ts');
check('حل DNS مخزَّن مؤقتاً', secSrc.includes('dnsCache') && secSrc.includes('DNS_CACHE_TTL_MS'));
check('تمييز ENOTFOUND عن المهلة', secSrc.includes("ENOTFOUND") && secSrc.includes('transient('));
// الفحص لا يتوقف عند دفعة فاشلة
check('واجهة الإضافة تُكمل الفحص بعد دفعة فاشلة', read('src/components/AddProviderModal.tsx').includes('failures.push'));
// «احصل على مفتاح»: أيقونة رابط خارجي في البطاقة + زر في نافذة المفاتيح
const provSrc = read('src/components/ProvidersTab.tsx');
check('بطاقة المزوّد تفتح موقع المزوّد برابط خارجي',
  provSrc.includes('ExternalLink') && /href=\{p\.signupUrl\}/.test(provSrc) && provSrc.includes('rel="noopener noreferrer"'));
check('نافذة المفاتيح فيها زر «احصل على مفتاح»',
  read('src/components/KeysModal.tsx').includes('signupUrl') && provSrc.includes('signupUrl={keysFor.signupUrl}'));

// ============================================================
console.log('\n' + '='.repeat(46));
console.log(`حراسة الواجهة والنصوص: ${passed} نجاح / ${failures.length} فشل`);
if (failures.length) {
  console.log('\nالانحدارات المكتشفة:');
  failures.forEach(f => console.log(' ✗ ' + f));
}
console.log('='.repeat(46));
process.exit(failures.length ? 1 : 0);
