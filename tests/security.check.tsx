// tests/security.check.tsx — حراسة الانحدار للأمان والتوحيد
// لماذا هذا الملف: كل خلل يتحقق منه هنا وقع فعلاً في المشروع، وكل تأكيد
// يفشل لو عاد. لا يحتاج خادماً — تحقق ثابت من الكود والملفات (سريع ومستقل).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { validateBaseUrl, checkResolvedAddress, isPrivateHost, isLoopbackHost, sanitizeErrorMessage, rateLimit, securityHeaders } from '../server/security';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? ' → ' + detail : ''}`);
}

function group(title: string): void {
  console.log('\n── ' + title);
}

// ============================================================
// 1) فلتر عناوين المزودات (مضاد SSRF)
// ============================================================
group('فلتر عناوين المزودات (SSRF)');

// D-19: الحارس صار غير متزامن (يعدو DNS) — كل نداء يجب أن يُنتظر،
// وإلا فالوعد الناتج صادق دائماً وتصير هذه التأكيدات تمرّ على لا شيء.
const awaited = await Promise.all([
  'https://api.groq.com/openai/v1',
  'https://api.together.ai/v1',
  'https://generativelanguage.googleapis.com/v1beta/openai',
  'http://localhost:11434/v1',      // Ollama محلي
  'http://127.0.0.1:1234/v1',       // LM Studio محلي
].map(async (u) => [u, await validateBaseUrl(u)] as const));
for (const [u, r] of awaited) {
  check(`يُقبل: ${u}`, r.ok, r.ok ? '' : r.error);
}

const denyCases: Array<[string, string]> = [
  ['http://169.254.169.254/latest/meta-data', 'بيانات وصفية سحابية'],
  ['http://192.168.1.50:8000/v1', 'شبكة داخلية'],
  ['http://10.0.0.5/v1', 'شبكة داخلية'],
  ['http://api.groq.com/openai/v1', 'http بلا محلي'],
  ['ftp://api.groq.com/v1', 'بروتوكول مرفوض'],
  ['https://user:secret@api.groq.com/v1', 'اعتماد داخل الرابط'],
  ['https://api.groq.com/v1#frag', 'fragment مرفوض'],
  ['https://metadata.google.internal/computeMetadata/v1', 'اسم داخلي'],
  ['not-a-url', 'نص ليس رابطاً'],
  ['', 'فراغ'],
];
for (const [u, why] of denyCases) {
  const r = await validateBaseUrl(u);
  check(`يُرفض (${why}): ${u || '∅'}`, !r.ok, r.ok ? 'قُبل خطأً' : '');
}

// 169.254 يبقى محجوباً حتى مع السماح بالشبكة المحلية — لا استثناء
check('169.254 محجوب رغم allowPrivate', !(await validateBaseUrl('http://169.254.169.254/', { allowPrivate: true })).ok);
check('RFC1918 يُقبل عند allowPrivate', (await validateBaseUrl('http://192.168.1.50:8000/v1', { allowPrivate: true })).ok);

// ---- D-19: تثبيت العنوان عبر DNS (سدّ DNS rebinding) ----
// الإصلاح نفسه: عنوان مُحَلّ إلى داخل يُرفض، واسم لا يُحَلّ يُرفض (fail-closed).
check('عنوان محلول 169.254 مرفوض دائماً', checkResolvedAddress('169.254.169.254', true) !== null);
check('عنوان محلول داخلي مرفوض بلا allowPrivate', checkResolvedAddress('192.168.1.7', false) !== null);
check('عنوان محلول داخلي مقبول مع allowPrivate', checkResolvedAddress('192.168.1.7', true) === null);
check('عنوان محلول عام مقبول', checkResolvedAddress('8.8.8.8', false) === null);
// اسم لا يُحلّ ⇒ رفض صريح، لا تمرير
const nx = await validateBaseUrl('http://this-host-does-not-exist-d19.invalid/v1');
check('اسم لا يُحَلّ يُرفض (fail-closed)', !nx.ok, nx.ok ? 'قُبل خطأً' : '');
// اسم عام حقيقي يُحَلّ ويُفحص كل عنواناته ثم يُقبل
const okNamed = await validateBaseUrl('https://api.groq.com/openai/v1');
check('اسم عام قابل للحل يُقبل بعد فحص عناوينه', okNamed.ok, okNamed.ok ? '' : okNamed.error);
check('validateBaseUrl صار غير متزامن (حارس D-19 قائم)', /export async function validateBaseUrl/.test(read('server/security.ts')));
check('isLoopbackHost صحيح', isLoopbackHost('localhost') && isLoopbackHost('127.0.0.1') && !isLoopbackHost('api.groq.com'));
check('isPrivateHost(172.16/12) صحيح', isPrivateHost('172.16.0.1') && isPrivateHost('172.31.255.255') && !isPrivateHost('172.32.0.1'));
check('العنوان العام ليس داخلياً', !isPrivateHost('8.8.8.8') && !isPrivateHost('api.groq.com'));

// ============================================================
// 2) تعقيم رسائل الخطأ (منع تسريب المفاتيح)
// ============================================================
group('تعقيم رسائل الخطأ');
const cleaned = sanitizeErrorMessage('upstream rejected: invalid key sk-abcdefghijklmnopqrst for model x');
check('لا يبقى مفتاح sk- في الرسالة', !cleaned.includes('sk-abcdefghijklmnopqrst'), cleaned);
check('يحتفظ بمعنى الرسالة', /invalid key/i.test(cleaned));
check('يحذف Bearer', !sanitizeErrorMessage('Authorization: Bearer gsk_1234567890abcdef').includes('gsk_1234567890abcdef'));
check('لا يعيد فراغاً', sanitizeErrorMessage(null).length > 0);

// ============================================================
// 3) أدوات الأمان موصولة فعلاً (لا كود ميت)
// ============================================================
group('أدوات الأمان موصولة بـ index.ts');
const indexSrc = read('server/index.ts');
check('يستورد من security.js', /from '\.\/security\.js'/.test(indexSrc));
check('طبّق securityHeaders', /app\.use\(securityHeaders\)/.test(indexSrc));
check('طبّق rateLimit على /v1', /app\.use\('\/v1',\s*rateLimit\(/.test(indexSrc));
check('طبّق rateLimit على /api/probe', /app\.use\('\/api\/probe',\s*rateLimit\(/.test(indexSrc));
check('يستخدم sanitizeErrorMessage', (indexSrc.match(/sanitizeErrorMessage\(/g) || []).length >= 3);
check('معالج أخطاء JSON موجود', /entity\.parse\.failed/.test(indexSrc));

// ---- D-20: ترويسة CSP تُضبط فعلياً (لا رمز ميت) ----
{
  const headers: Record<string, string> = {};
  const fakeRes = {
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    removeHeader: (k: string) => { delete headers[k.toLowerCase()]; },
  };
  securityHeaders({} as any, fakeRes as any, () => { });
  const csp = headers['content-security-policy'] ?? '';
  check('CSP مضبوط في securityHeaders', csp.length > 0, 'غائب');
  check("CSP يبدأ بـ default-src 'self'", /^default-src 'self'/.test(csp), csp);
  check("CSP بلا 'unsafe-inline'", !/unsafe-inline/.test(csp), csp);
  check("CSP بلا 'unsafe-eval'", !/unsafe-eval/.test(csp), csp);
  check('CSP يمنع التأطير (frame-ancestors none)', /frame-ancestors 'none'/.test(csp), csp);
  check('الترويسات القديمة باقية', headers['x-frame-options'] === 'DENY' && headers['x-content-type-options'] === 'nosniff');
}


// كل مسار يقرأ baseUrl من جسم الطلب يجب أن يحرسه قبل أي استخدام
const lines = indexSrc.split(/\r?\n/);
const unguarded: string[] = [];
for (let i = 0; i < lines.length; i++) {
  // نمط القراءة من المستخدم: "… baseUrl … } = req.body"
  if (!/baseUrl[^}]*\}\s*=\s*req\.body/.test(lines[i])) continue;
  const window = lines.slice(i, i + 12).join('\n');
  if (!window.includes('guardBaseUrl(')) unguarded.push(`سطر ${i + 1}`);
}
check('كل مدخل baseUrl محروس', unguarded.length === 0, unguarded.join(','));


// ============================================================
// 4) مصدر حقيقة واحد: catalog.yaml ↔ providers.yaml ↔ الواجهة
// ============================================================
group('توافق الكتالوج والملفات والواجهة');
const catalog = (yamlParse(read('server/catalog.yaml')) as any).providers as any[];
const providers = (yamlParse(read('server/providers.yaml')) as any).providers as any[];

check('الكتالوج غير فارغ', catalog.length > 20, `عدد=${catalog.length}`);

// لا مزود باسم يساوي رابطاً (خلل inceptionlabs)
const urlNamed = providers.filter(p => /^https?:\/\//.test(String(p.name || '')));
check('لا مزود اسمه رابط', urlNamed.length === 0, urlNamed.map(p => p.id).join(','));

// لا رابط مكرر بين معرّفين مختلفين (خلل google-ai11 الشبح)
const byUrl = new Map<string, string[]>();
for (const p of providers) {
  const u = String(p.baseUrl || '').replace(/\/+$/, '');
  byUrl.set(u, [...(byUrl.get(u) || []), String(p.id)]);
}
const dupUrls = [...byUrl.entries()].filter(([, ids]) => ids.length > 1);
check('لا رابط مكرر بين مزودين', dupUrls.length === 0, dupUrls.map(([u, ids]) => `${u}=[${ids}]`).join(' '));

// معرّفات صالحة
const badIds = providers.filter(p => !/^[a-z0-9-]{2,32}$/.test(String(p.id || '')));
check('كل المعرّفات صالحة', badIds.length === 0, badIds.map(p => p.id).join(','));

// تثبيت انحدار: الروابط التي أُصلحت لا تعود للخطأ — شرطي على وجود المزود:
// providers.yaml قابل للتهيئة (يمكن حذف مزودات)، فالتحقق من غيابها ليس فشلاً.
// القاعدة: إن وُجد المزود وجب أن يكون على نطاقه الرسمي؛ وإن غاب فلا شيء لنُثبّته.
const pinTogether = (list: any[]) => {
  const p = list.find(x => x.id === 'together');
  return !p || p.baseUrl === 'https://api.together.ai/v1';
};
const pinChutes = (list: any[]) => {
  const p = list.find(x => x.id === 'chutes');
  return !p || p.baseUrl === 'https://llm.chutes.ai/v1';
};
check('together (إن وُجد) يستخدم api.together.ai', pinTogether(providers as any[]));
check('catalog.together (إن وُجد) يستخدم api.together.ai', pinTogether(catalog as any[]));
check('chutes (إن وُجد) يستخدم llm.chutes.ai', pinChutes(providers as any[]));

// Quick Presets في الواجهة لا تتفرّع عن الكتالوج
const modalSrc = read('src/components/AddProviderModal.tsx');
check('الواجهة تقرأ /api/catalog', /api\.catalog\(\)/.test(modalSrc));
const presetRe = /\{ id: '([^']+)', name: '[^']*', baseUrl: '([^']+)'/g;
const byCatalogId = new Map(catalog.map(p => [p.id, String(p.baseUrl).replace(/\/+$/, '')]));
const diverged: string[] = [];
const unknownPreset: string[] = [];
let mm: RegExpExecArray | null;
while ((mm = presetRe.exec(modalSrc))) {
  const id = mm[1];
  const modalUrl = mm[2].replace(/\/+$/, '');
  const catUrl = byCatalogId.get(id);
  if (!catUrl) { unknownPreset.push(id); continue; }
  if (catUrl !== modalUrl) diverged.push(`${id}: modal=${modalUrl} catalog=${catUrl}`);
}
check('الاحتياطي في الواجهة مطابق للكتالوج', diverged.length === 0, diverged.join(' | '));
check('لا اختيار سريع بمعرّف خارج الكتالوج', unknownPreset.length === 0, unknownPreset.join(','));

// ============================================================
// 5) .gitignore يحمي الأسرار فعلاً
// ============================================================
group('حماية الأسرار في .gitignore');
const ignoreLines = read('.gitignore').split(/\r?\n/).map(l => l.trim());
check('.env مستثنى بسطر مستقل', ignoreLines.includes('.env'));
check('قواعد البيانات مستثناة', ignoreLines.includes('*.db'));
check(
  'لا سطر يجمع عدة أنماط',
  !ignoreLines.some(l => l && !l.startsWith('#') && l.includes(' ')),
  'سطر واحد يجمع أنماطاً = لا يُستثني شيء'
);
const envExample = read('.env.example');
check('.env.example يوثّق ADMIN_TOKEN', /ADMIN_TOKEN=/.test(envExample));
check('.env.example يوثّق HOST', /^HOST=/m.test(envExample));

// ============================================================
// ============================================================
// 6) المعالج العام خارج كتلة dist (D-08)
// ============================================================
// الخلل: كان `app.use((err,…))` داخل `if (existsSync(DIST_DIR)) {` بقوس زائد،
// فيتوقّف عن العمل عند غياب dist/ فيعود Express لصفحة HTML فيها مسارات الملفات.
group('معالج الأخطاء خارج كتلة dist');
const distIdx = indexSrc.indexOf('if (existsSync(DIST_DIR)) {');
const handlerIdx = indexSrc.indexOf('app.use((err:');
check('كتلة dist موجودة', distIdx >= 0);
check('المعالج العام موجود', handlerIdx > distIdx);
// مسح الأقواس لتحديد نهاية كتلة dist بدقة
let depth = 0;
let blockEnd = -1;
const openLen = 'if (existsSync(DIST_DIR)) {'.length;
for (let i = distIdx + openLen; i < indexSrc.length; i++) {
  const ch = indexSrc[i];
  if (ch === '{') depth++;
  else if (ch === '}') {
    if (depth === 0) { blockEnd = i; break; }
    depth--;
  }
}
check('نهاية كتلة dist محسوبة', blockEnd > 0, `blockEnd=${blockEnd}`);
check(
  'المعالج مسجَّل خارج كتلة dist',
  blockEnd > 0 && handlerIdx > blockEnd,
  `handler=${handlerIdx} blockEnd=${blockEnd}`
);

// ============================================================
// ============================================================
// 7) حدّ المعدل غير قابل للتحايل + /v1 مغلق عند غياب المفاتيح (S2)
// ============================================================
group('حدّ المعدل: دلو واحد لكل IP');
{
  const mw = rateLimit({ windowMs: 60_000, max: 3 });
  const mkRes = () => {
    const res: any = { headers: {} as Record<string, string> };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
    res.status = (code: number) => { if (code === 429) res.blocked = true; return res; };
    res.json = () => res;
    return res;
  };
  let blocked = 0;
  // **ستة ترويسات مختلفة من العنوان نفسه**: قبل الإصلاح كان لكل واحد دلو ⇒ صفر تحجيم
  for (let i = 0; i < 6; i++) {
    const res = mkRes();
    mw({ ip: '1.2.3.4', headers: { authorization: `Bearer key-${i}` } } as any, res, () => { });
    if (res.blocked) blocked++;
  }
  check('تغيير الترويسة لا يفتح دلواً جديداً', blocked === 3, `blocked=${blocked}`);
  let blocked2 = 0;
  for (let i = 0; i < 6; i++) {
    const res = mkRes();
    mw({ ip: '5.6.7.8', headers: {} } as any, res, () => { });
    if (res.blocked) blocked2++;
  }
  check('الحدّ يعمل بلا ترويسة', blocked2 === 3, `blocked=${blocked2}`);
}

group('/v1 مغلق عند غياب المفاتيح (fail-closed)');
check('لا فرع "افتح" باقى', !/keysExistCache\s*===\s*false\)\s*return\s+next\(\)/.test(indexSrc));
check('الغياب يرفض بـ503 صريح', /gateway_misconfigured/.test(indexSrc));

// ============================================================
// 9) لا مفتاح كامل يغادر الخادم — لا للمزوّد ولا للعميل
// ============================================================
// السؤال الذي بُني عليه هذا الحارس: «هل يرى مستخدمٌ مفتاحَ آخر؟» الجواب لا،
// لأن القيمة الكاملة لا تُغادر الخادم أصلاً: الواجهة تستقبل قناعاً، وقائمة
// مفاتيح العملاء تستقبل بصمة، والملفات المتعقَّبة لا تحمل مفتاحاً.
group('لا مفتاح كامل يغادر الخادم');

const routerSrc = read('server/router.ts');
const dbSrc = read('server/db.ts');
const cfgSrc = read('server/config.ts');

check('keyDetails يعرض masked لا القيمة', /masked:\s*maskKey\(s\.key\)/.test(routerSrc));
check('keyDetails لا يُرجع s.key خاماً', !/\bkey:\s*s\.key\b/.test(routerSrc));
check('snapshot يعيد ملخّص أعداد لا مفاتيح', /keys:\s*this\.keySummary\(e\)/.test(routerSrc));
check('/api/providers مبني على snapshot', /app\.get\('\/api\/providers'[^\n]*router\.snapshot\(\)/.test(indexSrc));

// القناع نفسه: يقصّ ولا يعيد النص، حتى للمفاتيح القصيرة
for (const [name, src] of [['router', routerSrc], ['config', cfgSrc]] as const) {
  const at = src.indexOf('function maskKey');
  const fn = at === -1 ? '' : src.slice(at, at + 320);
  check(`maskKey في ${name} يقصّ ولا يعيد النص الكامل`, fn.length > 0 && /slice\(/.test(fn) && !/return\s+k\s*;/.test(fn));
}

// مفاتيح العملاء: تُخزَّن hash، والقائمة تعيد بصمة
check('قائمة مفاتيح العملاء تعيد key_hint فقط', /COALESCE\(key_hint/.test(dbSrc));
check('إنشاء مفتاح عميل يخزّن sha256 لا النص', /INSERT INTO api_keys[\s\S]{0,160}sha256Hex\(key\)/.test(dbSrc));

// لا مفتاح في YAML: لا إضافة، لا استيراد، لا تعديل
const entryBlock = indexSrc.slice(indexSrc.indexOf('const entry: any = {'), indexSrc.indexOf('yaml.providers.push(entry)'));
check('كائن المزوّد المُضاف لا يحمل apiKey', entryBlock.length > 0 && !/apiKey\s*:/.test(entryBlock));
const newEntryBlock = indexSrc.slice(indexSrc.indexOf('const newEntry: any = {'), indexSrc.indexOf('yaml.providers.push(newEntry)'));
check('الاستيراد الجماعي لا يحمل apiKey', newEntryBlock.length > 0 && !/apiKey\s*:/.test(newEntryBlock));
check('تعديل مزوّد يحذف apiKey قبل الكتابة', /delete updated\.apiKey/.test(indexSrc));

// ============================================================
console.log('\n' + '='.repeat(46));
console.log(`نتيجة الحراسة: ${passed} نجاح / ${failures.length} فشل`);
if (failures.length) {
  console.log('\nالانحدارات المكتشفة:');
  failures.forEach(f => console.log(' ✗ ' + f));
}
console.log('='.repeat(46));
process.exit(failures.length ? 1 : 0);

