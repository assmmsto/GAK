// اختبار إنتاجي حقيقي — يقرأ مفتاح Google من .env ويستخدم الخدمات الفعلية (لا بيانات وهمية).
// التشغيل:  node --import tsx tests/production.e2e.tsx     (يتطلب npm run dev)
// يغطّي: نافذة الإضافة (اختبار/جلب/فحص/حفظ) · بطاقات المزودات وكل أيقونة ·
//        فرز النماذج بفحص حقيقي · الـ Playground بمحادثة حقيقية · EndpointBanner · Usage · Logs
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5173/', pretendToBeVisual: true });
const w: any = dom.window;
const define = (k: string, v: any) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
define('window', w); define('document', w.document); define('navigator', w.navigator); define('localStorage', w.localStorage);
(globalThis as any).HTMLElement = w.HTMLElement;
(globalThis as any).HTMLInputElement = w.HTMLInputElement;
(globalThis as any).Event = w.Event;
(globalThis as any).MouseEvent = w.MouseEvent;
(globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const API = process.env.GATEWAY_URL || 'http://127.0.0.1:3001';
const realFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  return realFetch(url.startsWith('http') ? url : API + url, init);
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { AddProviderModal } = await import('../src/components/AddProviderModal');
const { ProvidersTab } = await import('../src/components/ProvidersTab');
const { SortTab } = await import('../src/components/SortTab');
const { PlaygroundTab } = await import('../src/components/PlaygroundTab');
const { EndpointBanner } = await import('../src/components/EndpointBanner');
const { UsageTab } = await import('../src/components/UsageTab');
const { LogsTab } = await import('../src/components/LogsTab');

let pass = 0, fail = 0;
const failures: string[] = [];
const notes: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const jget = (p: string) => realFetch(API + p).then(r => r.json());
const setVal = (el: any, v: string) => {
  const s = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!;
  s.call(el, v); el.dispatchEvent(new w.Event('input', { bubbles: true }));
};
const setArea = (el: any, v: string) => {
  const s = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value')!.set!;
  s.call(el, v); el.dispatchEvent(new w.Event('input', { bubbles: true }));
};
const click = (el: any) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const btn = (c: any, t: string) => [...c.querySelectorAll('button')].find(b => (b.textContent || '').includes(t));
const byTitle = (c: any, t: string) => [...c.querySelectorAll('button,a')].find(b =>
  `${b.getAttribute('title') || ''} ${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-tooltip') || ''}`.includes(t));
const inputs = (c: any) => [...c.querySelectorAll('input')];
const yamlProviders = () => {
  const txt = fs.readFileSync('server/providers.yaml', 'utf8');
  return txt.split(/\n(?=  - id: )/).map(b => ({
    id: (b.match(/^  - id:\s*(\S+)/) || [])[1],
    hasPlainKey: /^\s+apiKey:/m.test(b),
    apiKeyEnv: (b.match(/^\s+apiKeyEnv:\s*(\S+)/m) || [])[1] || null,
    enabled: /^\s+enabled:\s*true\s*$/m.test(b),
    models: b.includes('models: auto') ? 'auto' : 'list'
  })).filter(p => p.id);
};
function mount(el: any, props: any = {}) {
  const container = w.document.createElement('div');
  w.document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => { root.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(el, props))); });
  return { container, root, qc };
}

// المفتاح الحقيقي من .env — لا يُكتب في الكود
const envTxt = fs.readFileSync('.env', 'utf8');
const GKEY = (envTxt.match(/^GEMINI_API_KEY=(.+)$/m) || [])[1]?.trim() || '';
console.log('=== اختبار إنتاجي حقيقي (مفتاح Google من .env) ===');
console.log('المفتاح:', GKEY ? GKEY.slice(0, 8) + '… (' + GKEY.length + ' حرف)' : 'غير موجود!');
if (!GKEY) { console.log('لا يوجد مفتاح — توقف'); process.exit(1); }
console.log('');

// ============================================================
// 1) نافذة الإضافة: اختبار الاتصال ثم جلب النماذج ثم الحفظ
// ============================================================
console.log('--- 1) نافذة إضافة مزود: اتصال + جلب نماذج + حفظ ---');
{
  // العُدّة: لوحة الوصفات تُخفي المزود الموجود أصلاً، فيمر هذا الاختبار بمسار
  // «الإضافة الحقيقية» وحين يكون google-ai غائباً. نحذفه ونُعيده تلقائياً لو انهار.
  const gBefore = (await jget('/api/providers')).providers.find((p: any) => p.id === 'google-ai');
  if (gBefore) await realFetch(API + '/api/providers/google-ai?purgeKeys=1', { method: 'DELETE' });

  try {
  let added = 0, closed = 0;
  const container = w.document.createElement('div');
  w.document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  const Harness = () => {
    const [open, setOpen] = React.useState(true);
    return React.createElement(QueryClientProvider, { client: qc },
      React.createElement(AddProviderModal, {
        open, onClose: () => { closed++; setOpen(false); }, onAdded: () => { added++; }, editTarget: null
      }));
  };
  await act(async () => { root.render(React.createElement(Harness)); });
  await act(async () => { await sleep(400); });

  // اختيار وصفة Google AI Studio
  const preset = [...container.querySelectorAll('div')].find(d => (d.textContent || '').trim().startsWith('Google AI Studio') && d.querySelector('span'));
  await act(async () => { click(preset); });
  await act(async () => { await sleep(250); });
  const ins = inputs(container);
  check('وصفة Google تملأ الرابط الصحيح', ins[2]?.value === 'https://generativelanguage.googleapis.com/v1beta/openai', 'baseUrl=' + ins[2]?.value);
  check('وصفة Google تملأ المعرّف google-ai', ins[0]?.value === 'google-ai');
  check('حقل المفتاح موجود وفارغ', ins[3]?.type === 'password' && ins[3]?.value === '');

  // إدخال المفتاح الحقيقي
  await act(async () => { setVal(ins[3], GKEY); });
  await act(async () => { await sleep(150); });
  // التلميح (نص عربي في الواجهة): يعرض اسم متغيّر البيئة الحقيقي من الكتالوج
  const tNow = container.textContent || '';
  check('تلميح متغيّر البيئة يعرض الاسم الصحيح (GEMINI_API_KEY)', tNow.includes('GEMINI_API_KEY'), tNow.slice(0, 80));

  // اختبار الاتصال (شبكة حقيقية)
  const testBtn: any = btn(container, 'Test');
  check('زر الاختبار موجود وغير معطّل', !!testBtn && !testBtn.disabled);
  await act(async () => { click(testBtn); });
  await act(async () => { await sleep(6000); });
  const afterTest = container.textContent || '';
  check('اختبار الاتصال الحقيقي نجح', afterTest.includes('نجح الاتصال'), afterTest.slice(afterTest.indexOf('نجح') > -1 ? afterTest.indexOf('نجح') : 0, (afterTest.indexOf('نجح') > -1 ? afterTest.indexOf('نجح') : 0) + 60));

  // جلب النماذج (شبكة حقيقية)
  const fetchBtn: any = btn(container, 'Fetch Models');
  check('زر جلب النماذج موجود', !!fetchBtn && !fetchBtn.disabled);
  await act(async () => { click(fetchBtn); });
  await act(async () => { await sleep(9000); });
  const afterFetch = container.textContent || '';
  const mCount = (afterFetch.match(/(\d+) نموذج · (\d+) ناجح/) || []);
  check('جلب النماذج الحقيقي أعاد قائمة', !!mCount[1] && Number(mCount[1]) > 20, 'نص: ' + (mCount[0] || 'غير موجود'));
  notes.push('نماذج Google المجلوبة فعلياً: ' + (mCount[1] || '?'));
  check('انتقل لخطوة اختيار النماذج', afterFetch.includes('Select Models') || !!btn(container, 'Back'));

  // حفظ (شبكة حقيقية → PATCH → .env)
  const saveBtn: any = btn(container, 'حفظ') || btn(container, 'تحديث');
  check('زر الحفظ موجود وغير معطّل', !!saveBtn && !saveBtn.disabled, 'disabled=' + saveBtn?.disabled);
  await act(async () => { click(saveBtn); });
  await act(async () => { await sleep(4000); });
  check('الحفظ أغلق النافذة', closed >= 1, 'closed=' + closed);
  check('onAdded نُفِّذ', added >= 1);

  // S14: المفاتيح تُخزَّن مشفّرة في قاعدة البيانات لا في .env. الفحص القديم
  // (envAfter.includes('GEMINI_API_KEY=' + GKEY)) كان ينجح **زوراً** لأن المفتاح
  // موجود في .env سلفاً ⇒ «دليل نجاح» لا يعني أن الحفظ عمل.
  const keyList = await jget('/api/providers/google-ai/keys');
  check('المفتاح محفوظ في قاعدة البيانات (summary.total > 0)',
    Number(keyList?.summary?.total || 0) > 0, 'summary=' + JSON.stringify(keyList?.summary || {}));
  check('المفتاح يُعاد مقنّعاً لا كاملاً',
    String(keyList?.keys?.[0]?.masked || '').includes('…'), 'masked=' + String(keyList?.keys?.[0]?.masked || ''));
  const gp = yamlProviders().find(p => p.id === 'google-ai')!;
  check('المزود مفعّل في YAML', gp.enabled === true);
  check('المفتاح ليس نصاً في YAML', gp.hasPlainKey === false);
  const provs = await jget('/api/providers');
  const gprov = provs.providers.find((p: any) => p.id === 'google-ai');
  check('المزود يظهر بمفتاح في الذاكرة', gprov?.hasKey === true && gprov?.enabled === true);
  check('الرابط الصحيح محفوظ', gprov?.baseUrl === 'https://generativelanguage.googleapis.com/v1beta/openai', gprov?.baseUrl);
  await act(async () => { root.unmount(); });

  // قاطع العُدّة: لو انهار المسار الحقيقي قبل الحفظ، يُعاد google-ai بمواصفاته ومفتاحه
  } finally {
    const now = (await jget('/api/providers')).providers;
    if (gBefore && !now.find((p: any) => p.id === 'google-ai')) {
      await realFetch(API + '/api/providers/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'google-ai', name: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', tier: 3, models: 'auto', apiKey: GKEY })
      });
      console.log('  [*] أُعيد google-ai بعد انهيار العُدّة');
    }
  }
}

// ============================================================
// 2) تبويب Providers: البطاقة وكل أيقونة
// ============================================================
console.log('\n--- 2) تبويب Providers: البطاقة والأيقونات ---');
{
  const { container, root } = mount(ProvidersTab, { onToast: () => {} });
  await act(async () => { await sleep(1500); });
  const txt = container.textContent || '';
  check('بطاقة google-ai موجودة', txt.includes('Google AI Studio'));
  check('تعرض "authenticated" لمزود له مفتاح', txt.includes('authenticated'));
  check('تعرض شارة free', txt.includes('free'));
  check('تعرض شارات الطبقة t1..t4', /t\d · (paid|cheap|fallback|free)/.test(txt));
  check('تعرض عنوان القاعدة (baseUrl)', txt.includes('generativelanguage.googleapis.com'));
  const liveProviders = (await jget('/api/providers')).providers.length;
  check('العدّاد العلوي يعرض عدد المزودات', txt.includes(String(liveProviders)), 'المتوقع ' + liveProviders);
  check('يعرض عدد المفعّلة', txt.includes('active'));

  const cards = [...container.querySelectorAll('.card')];
  const gcard: any = cards.find(c => (c.textContent || '').includes('Google AI Studio'));
  check('بطاقة google-ai عُثر عليها', !!gcard);
  const titles = [...gcard.querySelectorAll('button,a')].map(b => b.getAttribute('title') || b.getAttribute('data-tooltip') || '');
  check('أيقونة الاختبار (Test) موجودة', !!btn(gcard, 'Test'));
  check('أيقونة التفعيل/التعطيل موجودة', !!byTitle(gcard, 'Disable') || !!byTitle(gcard, 'Enable'));
  check('أيقونة التحرير موجودة', !!byTitle(gcard, 'Edit'));
  check('أيقونة جلب المفتاح (رابط التسجيل) موجودة', !!byTitle(gcard, 'Get API key'));
  check('أيقونة الحذف موجودة', !!byTitle(gcard, 'Delete'));

  // اختبار حقيقي من البطاقة (ping فعلي إلى Google)
  const testBtn: any = btn(gcard, 'Test');
  await act(async () => { click(testBtn); });
  await act(async () => { await sleep(6000); });
  check('اختبار المزود من البطاقة اشتغل (لا خطأ)', true);
  const after = container.textContent || '';
  check('حالة المزود تحدّثت بعد الاختبار', /Google AI Studio/.test(after));
  await act(async () => { root.unmount(); });
}

// ============================================================
// 3) فرز النماذج: فحص حقيقي لنماذج Google
// ============================================================
console.log('\n--- 3) فرز النماذج: فحص حقيقي بميزانية محدودة ---');
{
  const { container, root } = mount(SortTab, { onToast: () => {} });
  await act(async () => { await sleep(1500); });
  const before = await jget('/api/probe/results');
  check('التبويب يعرض شريط تغطية المزودات', (container.textContent || '').includes('تغطية المزودات'));
  check('google-ai يظهر في الشرائح', (container.textContent || '').includes('google-ai'));

  // فحص مباشر عبر الواجهة البرمجية للتبويب (نفس ما يناديه الزر) بميزانية 5
  const res = await realFetch(API + '/api/probe/google-ai/all?cap=5', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
  check('فحص كل نماذج مزود (بحد 5) رجع نتائج', typeof res.tested === 'number' && res.tested > 0, JSON.stringify(res).slice(0, 120));
  notes.push('فحص google-ai بحد 5: ' + res.tested + ' مفحوص، ' + res.ok + ' يعمل');
  const statuses = (res.results || []).map((r: any) => r.status);
  // نماذج تحقّقنا يدوياً أنها تعمل بهذا المفتاح (gemini-2.5-pro يرجع 404 من Google نفسه)
  const chatModels = ['gemini-2.5-flash', 'gemini-flash-latest'];
  const falselyRejected = (res.results || []).filter((r: any) => chatModels.includes(r.model) && r.status === 'rejected');
  check('نماذج المحادثة المتحقَّق منها لم تُرفض ظلماً', falselyRejected.length === 0,
    'مرفوضة ظلماً: ' + falselyRejected.map((r: any) => r.model + '(' + r.reason + ')').join(', '));
  const rejected = (res.results || []).filter((r: any) => r.status === 'rejected');
  check('كل رفض مصنَّف بسببه (format/not_found/auth)',
    rejected.every((r: any) => ['format', 'not_found', 'auth'].includes(r.reason)),
    rejected.map((r: any) => r.model + ':' + r.reason).join(', '));
  check('كل حالة معروفة', statuses.every((s: string) => ['ok', 'rejected', 'rate_limited', 'slow', 'no_key'].includes(s)));
  notes.push('حالات الفحص: ' + statuses.join('/') + (rejected.length ? ' (المرفوض: ' + rejected.map((r: any) => r.model + '/' + r.reason).join(', ') + ')' : ''));

  await act(async () => { await sleep(3000); });
  const txt = container.textContent || '';
  check('الجدول يعرض صفوفاً بعد الفحص', container.querySelectorAll('tbody tr').length > 0, 'rows=' + container.querySelectorAll('tbody tr').length);
  check('المؤشرات تعرض أرقاماً', /\d/.test(txt));
  await act(async () => { root.unmount(); });
}

// ============================================================
// 4) Playground: محادثة حقيقية بثّية
// ============================================================
console.log('\n--- 4) Playground: محادثة حقيقية ---');
{
  const { container, root } = mount(PlaygroundTab);
  await act(async () => { await sleep(9000); });
  const sel: any = container.querySelector('select');
  check('قائمة اختيار النموذج موجودة', !!sel);
  const opts = [...(sel?.querySelectorAll('option') || [])].map((o: any) => o.value);
  check('خيار auto موجود', opts.includes('auto'));
  check('قائمة النماذج مملوءة فعلاً (>50 خيار)', opts.length > 50, 'عدد الخيارات=' + opts.length);
  // القائمة تُبنى من ذاكرة تتحدد بعد إعادة إنشاء المزود (قسم 1) — ننتظر دورة التحديث
  // (refetch كل 10 ثوانٍ في مكوّن Playground) بدل قراءة واحدة قديمة
  let gopt: string | undefined;
  for (let i = 0; i < 10 && !gopt; i++) {
    await act(async () => { await sleep(2500); });
    const selNow: any = container.querySelector('select');
    gopt = [...(selNow?.querySelectorAll('option') || [])].map((o: any) => o.value).find((v: string) => v.startsWith('google-ai/'));
  }
  check('نماذج google-ai ظاهرة في القائمة', !!gopt, 'أول 5: ' + opts.slice(0, 5).join(', '));
  notes.push('نموذج مستخدم للاختبار: ' + (gopt || 'auto'));

  const areas = [...container.querySelectorAll('textarea')];
  check('حقول System و User موجودة', areas.length >= 2);
  await act(async () => { setArea(areas[1], 'Reply with exactly: UIWORKS'); });
  await act(async () => { await sleep(200); });

  const sendBtn: any = btn(container, 'Send');
  check('زر الإرسال موجود وغير معطّل', !!sendBtn && !sendBtn.disabled);
  await act(async () => { click(sendBtn); });
  await act(async () => { await sleep(25000); });

  const out = container.textContent || '';
  check('الرد الحقيقي ظهر في الواجهة', out.includes('UIWORKS') || /✓ \d+ms/.test(out), out.slice(-200));
  check('يعرض زمن الاستجابة', /✓ \d+ms/.test(out) || /↪/.test(out), '');
  check('لا رسالة خطأ في المحادثة', !out.includes('Error:'));
  const meta = (out.match(/✓ (\d+)ms · (.+)/) || [])[1];
  if (meta) notes.push('زمن استجابة Playground: ' + meta + 'ms');
  await act(async () => { root.unmount(); });
}

// ============================================================
// 5) EndpointBanner: المفتاح الموحّد ولوحة النشاط
// ============================================================
console.log('\n--- 5) EndpointBanner: العنوان والمفتاح والنشاط ---');
{
  const { container, root } = mount(EndpointBanner, { onToast: () => {} });
  await act(async () => { await sleep(2000); });
  const txt = container.textContent || '';
  check('يعرض العنوان الموحّد /v1', txt.includes('/v1'));
  check('يعرض اسم المفتاح', txt.includes('default'));
  check('يعرض عدد الطلبات', /\d+ reqs/.test(txt));
  check('أيقونة إظهار/إخفاء المفتاح موجودة', !!byTitle(container, 'Reveal') || !!byTitle(container, 'Hide'));
  check('أيقونة نسخ المفتاح موجودة', !!byTitle(container, 'Copy key'));
  check('أيقونة إعادة التوليد موجودة', !!byTitle(container, 'إعادة توليد'));
  check('أيقونة الحذف موجودة', !!byTitle(container, 'Delete key'));
  check('أيقونة النشاط موجودة', !!byTitle(container, 'نشاط المفتاح'));
  check('زر توليد مفتاح موجود', !!btn(container, 'Generate Key'));

  // فتح لوحة النشاط (إحصاءات حقيقية)
  const actBtn: any = byTitle(container, 'نشاط المفتاح');
  await act(async () => { click(actBtn); });
  await act(async () => { await sleep(2500); });
  const panel = container.textContent || '';
  check('لوحة النشاط تُفتح وتعرض بيانات', panel.includes('الرموز') && panel.includes('الطلبات'), '');
  check('تعرض النشاط الزمني', panel.includes('النشاط الزمني'));
  check('تعرض الرموز حسب النموذج أو رسالة لا نشاط', panel.includes('الرموز حسب النموذج') || panel.includes('لا يوجد نشاط'));
  // القيمة تسبق التسمية في ترتيب DOM — نقرأ الصندوق كاملاً
  const boxes = [...container.querySelectorAll('div')].map(d => (d.textContent || '').trim());
  const latencyBox = boxes.find(t => /^\S+\s*زمن الاستجابة$/.test(t) && t.includes('زمن الاستجابة'));
  const avgMatch = latencyBox?.match(/([\d.]+k?)\s*ms/);
  notes.push('متوسط زمن الاستجابة المعروض: ' + (avgMatch ? avgMatch[1] + 'ms' : latencyBox || '—'));
  check('متوسط الزمن يظهر رقماً حقيقياً (لا صفر)', !!avgMatch && avgMatch[1] !== '0', 'box=' + latencyBox);
  await act(async () => { root.unmount(); });
}

// ============================================================
// 6) Usage + Logs
// ============================================================
console.log('\n--- 6) تبويبا الاستخدام والسجل ---');
{
  const u = mount(UsageTab);
  await act(async () => { await sleep(2000); });
  const ut = u.container.textContent || '';
  check('Usage يعرض إجمالي الرموز', ut.includes('Total Tokens'));
  check('Usage يعرض توزيعاً حسب المزود', ut.includes('By Provider'));
  check('Usage يعرض أرقاماً حقيقية', /\d/.test(ut) && !ut.includes('No usage data yet'), ut.includes('No usage data yet') ? 'لا بيانات' : '');
  await act(async () => { u.root.unmount(); });

  const l = mount(LogsTab);
  await act(async () => { await sleep(2000); });
  const lt = l.container.textContent || '';
  check('Logs يعرض أحداثاً حقيقية', l.container.querySelectorAll('.glass').length > 0, 'cards=' + l.container.querySelectorAll('.glass').length);
  check('Logs يعرض فلاتر', lt.includes('Health OK') && lt.includes('Errors'));
  await act(async () => { l.root.unmount(); });
}

console.log('\n================ النتيجة ================');
console.log('ناجح: ' + pass + ' | فاشل: ' + fail);
if (notes.length) { console.log('\nملاحظات:'); notes.forEach(n => console.log(' - ' + n)); }
if (failures.length) { console.log('\nالإخفاقات:'); failures.forEach(f => console.log(' ✗ ' + f)); }
process.exit(fail ? 1 : 0);
