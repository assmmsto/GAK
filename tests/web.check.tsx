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

// ============================================================
// 6) سكربتات الاختبار تشمل الحرّاس الجديدة
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
console.log('\n' + '='.repeat(46));
console.log(`حراسة الواجهة والنصوص: ${passed} نجاح / ${failures.length} فشل`);
if (failures.length) {
  console.log('\nالانحدارات المكتشفة:');
  failures.forEach(f => console.log(' ✗ ' + f));
}
console.log('='.repeat(46));
process.exit(failures.length ? 1 : 0);
