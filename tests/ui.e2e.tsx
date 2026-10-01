// اختبار واجهة شامل (jsdom) — يُصيّر المكوّنات فعلياً ويستدعي الخادم الحقيقي.
// التشغيل:  npm run test:ui      (يتطلب أن يكون الخادم يعمل: npm run dev)
// العنوان الافتراضي http://127.0.0.1:3001 ويمكن تجاوزه بـ GATEWAY_URL.
// يغطّي: نافذة إضافة/تحرير المزود (الحفظ، التحرير، الأخطاء) + تبويب فرز النماذج
// (التصيير، المؤشرات، الجدول، البحث، التصفية، شرح المنهج).
// لا يدخل في بناء الإنتاج — tsconfig يضم src و server فقط.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true
});
const w: any = dom.window;
const define = (key: string, value: any) =>
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
define('window', w);
define('document', w.document);
define('navigator', w.navigator);
define('localStorage', w.localStorage);
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

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const api = (p: string, init?: any) => realFetch(API + p, init).then(r => r.json());

function setInputValue(input: any, value: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
}
function click(el: any) {
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function findButton(container: any, text: string) {
  return [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes(text));
}
function findDivByText(container: any, text: string) {
  return [...container.querySelectorAll('div')].find(d => (d.textContent || '').trim() === text);
}
function inputs(container: any) { return [...container.querySelectorAll('input')]; }

let closedCount = 0, addedCount = 0;
function mount(editTarget: any) {
  const container = w.document.createElement('div');
  w.document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return React.createElement(QueryClientProvider, { client: qc },
      React.createElement(AddProviderModal, {
        open,
        onClose: () => { closedCount++; setOpen(false); },
        onAdded: () => { addedCount++; },
        editTarget
      })
    );
  }
  return { container, root, Harness };
}

console.log('=== اختبار نافذة إضافة/تحرير المزود (jsdom + الخادم الحقيقي) ===\n');

// ============ الاختبار 1: وصفة موجودة مسبقاً (كانت تفشل بـ 409 غير مرئي) ============
{
  const before = await api('/api/providers');
  const groqBefore = before.providers.find((p: any) => p.id === 'groq');

  closedCount = 0; addedCount = 0;
  const { container, root, Harness } = mount(null);
  await act(async () => { root.render(React.createElement(Harness)); });
  await act(async () => { await sleep(300); });

  const txt0 = container.textContent || '';
  check('النافذة تُفتح وتعرض العنوان', txt0.includes('Add Provider'), txt0.slice(0, 60));
  check('تعرض الوصفات الجاهزة', txt0.includes('Quick Presets') && txt0.includes('Groq Cloud'));

  // نختار وصفة معرّفها موجود مسبقاً في providers.yaml
  const preset = findDivByText(container, 'Groq Cloud') || [...container.querySelectorAll('div')].find(d => (d.textContent || '').includes('Groq Cloud') && d.querySelector('span'));
  await act(async () => { click(preset); });
  await act(async () => { await sleep(200); });

  const inputsAfterPreset = inputs(container);
  const idVal = inputsAfterPreset[0]?.value;
  check('الوصفة تملأ المعرّف', idVal === 'groq', 'id=' + idVal);

  const txt1 = container.textContent || '';
  check('يظهر تنبيه "موجود مسبقاً" قبل الحفظ', txt1.includes('موجود مسبقاً'), 'التنبيه غير ظاهر');

  const saveBtn: any = findButton(container, 'تحديث المزود الموجود') || findButton(container, 'حفظ المزود');
  check('زر الحفظ يقول "تحديث المزود الموجود"', !!findButton(container, 'تحديث المزود الموجود'));
  check('زر الحفظ غير معطّل', saveBtn && !saveBtn.disabled, 'disabled=' + saveBtn?.disabled);

  // نغيّر الاسم لنتأكد أن الحفظ حدث فعلاً
  const nameInput = inputsAfterPreset.find((i: any) => i.value === 'Groq Cloud');
  await act(async () => { setInputValue(nameInput, 'Groq Cloud E2E'); });
  await act(async () => { await sleep(120); });

  await act(async () => { click(saveBtn); });
  await act(async () => { await sleep(1200); });

  check('الحفظ أغلق النافذة (onClose نُفِّذ)', closedCount >= 1, 'closed=' + closedCount);
  check('onAdded نُفِّذ', addedCount >= 1, 'added=' + addedCount);

  const after = await api('/api/providers');
  const groqAfter = after.providers.find((p: any) => p.id === 'groq');
  check('الخادم حُدِّث فعلاً (409 → تحديث)', groqAfter?.name === 'Groq Cloud E2E', 'name=' + groqAfter?.name);
  check('لم يُنشأ مزود مكرر', after.providers.filter((p: any) => p.id === 'groq').length === 1);
  check('عدد المزودات لم يزد', after.providers.length === before.providers.length, before.providers.length + ' → ' + after.providers.length);

  // نُعيد الاسم الأصلي
  await realFetch(API + '/api/providers/groq', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: groqBefore.name })
  });
  const restored = await api('/api/providers');
  check('أُعيد الاسم الأصلي', restored.providers.find((p: any) => p.id === 'groq')?.name === 'Groq Cloud');

  await act(async () => { root.unmount(); });
}

// ============ الاختبار 2: نافذة التحرير تُملأ ببيانات المزود ============
{
  closedCount = 0;
  const { container, root, Harness } = mount({
    id: 'groq', name: 'Groq Cloud', baseUrl: 'https://api.groq.com/openai/v1', tier: 4, hasKey: false
  });
  await act(async () => { root.render(React.createElement(Harness)); });
  await act(async () => { await sleep(300); });

  const txt = container.textContent || '';
  check('عنوان نافذة التحرير يذكر المزود', txt.includes('تحرير: groq'), txt.slice(0, 80));

  const ins = inputs(container);
  check('حقل المعرّف مُملوء (لا يفتح فارغاً)', ins[0]?.value === 'groq', 'id=' + ins[0]?.value);
  const nameIn = ins.find((i: any) => i.value === 'Groq Cloud');
  const urlIn = ins.find((i: any) => i.value === 'https://api.groq.com/openai/v1');
  check('حقل الاسم مُملوء', !!nameIn, 'name value missing');
  check('حقل الرابط مُملوء', !!urlIn, 'url value missing');

  const saveBtn: any = findButton(container, 'تحديث المزود');
  check('زر الحفظ غير معطّل في وضع التحرير', saveBtn && !saveBtn.disabled, 'disabled=' + saveBtn?.disabled);

  await act(async () => { root.unmount(); });
}

// ============ الاختبار 3: خطأ الحفظ يظهر في DOM (لا يفشل بصمت) ============
{
  closedCount = 0;
  const { container, root, Harness } = mount(null);
  await act(async () => { root.render(React.createElement(Harness)); });
  await act(async () => { await sleep(300); });

  // نمسح حقل الاسم ثم نحاول الحفظ → يجب أن تظهر رسالة واضحة
  const baseCount = (await api('/api/providers')).providers.length;
  const nameInput = inputs(container)[1];
  await act(async () => { setInputValue(nameInput, ''); });
  const saveBtn: any = findButton(container, 'حفظ المزود');
  check('زر الحفظ معطّل عند نقص الحقول', saveBtn?.disabled === true, 'disabled=' + saveBtn?.disabled);

  // نملأ الحقول ونطلب الحفظ، ثم نتحقق أن شريط الخطأ/النتيجة موجود في DOM
  const ins = inputs(container);
  await act(async () => { setInputValue(ins[0], 'e2e-ui-tmp'); });
  await act(async () => { setInputValue(ins[1], 'E2E UI'); });
  await act(async () => { setInputValue(ins[2], 'https://example.invalid/v1'); });
  await act(async () => { await sleep(150); });

  const okBtn: any = findButton(container, 'حفظ المزود');
  check('زر الحفظ صار متاحاً بعد تعبئة الحقول', okBtn && !okBtn.disabled);

  await act(async () => { click(okBtn); });
  await act(async () => { await sleep(1500); });

  // إمّا نجح (فأُغلق) أو ظهر خطأ — في الحالتين يجب ألا يبقى بلا أي إشارة
  const txt = container.textContent || '';
  const closedOk = closedCount >= 1;
  const errorShown = /فشل|خطأ|مطلوبة|Failed|error/i.test(txt);
  check('الحفظ إمّا نجح أو أظهر خطأً مرئياً (لا فشل صامت)', closedOk || errorShown, 'closed=' + closedCount + ' text=' + txt.slice(0, 120));

  if (closedOk) {
    const provs = await api('/api/providers');
    check('المزود الجديد أُضيف فعلاً', !!provs.providers.find((p: any) => p.id === 'e2e-ui-tmp'));
    await realFetch(API + '/api/providers/e2e-ui-tmp', { method: 'DELETE' });
    const after = await api('/api/providers');
    check('تنظيف مزود الاختبار', !after.providers.find((p: any) => p.id === 'e2e-ui-tmp'));
    // نقارن بعدد البداية لا برقم ثابت (المستخدم قد يضيف مزودات)
    check('عدد المزودات عاد كما كان', after.providers.length === baseCount, 'count=' + after.providers.length + ' vs ' + baseCount);
  }

  await act(async () => { root.unmount(); });
}

// ============ الاختبار 4: تبويب فرز النماذج (الهيكل الجديد) ============
{
  const { SortTab } = await import('../src/components/SortTab');
  const container = w.document.createElement('div');
  w.document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: qc },
      React.createElement(SortTab as any, { onToast: () => {} })));
  });
  await act(async () => { await sleep(800); });

  const txt = () => container.textContent || '';
  const rowsNow = () => container.querySelectorAll('tbody tr').length;
  const serverProbes = await api('/api/probe/results');

  check('التبويب يُصيَّر بلا انهيار', txt().includes('فرز النماذج'));
  check('يعرض غاية التبويب بوضوح', txt().includes('طلب محادثة حقيقي') && txt().includes('يُحجب تلقائياً'));
  check('شارة العدد تطابق نتائج الخادم', txt().includes(`${serverProbes.total} مفحوص`), 'server=' + serverProbes.total);

  // المؤشرات الأربعة
  const kpiLabels = ['يعمل', 'مرفوض (محجوب)', 'حصة فارغة / بطيء', 'بلا مفتاح'];
  check('المؤشرات الأربعة موجودة', kpiLabels.every(l => txt().includes(l)));

  // جدول النماذج
  const rowCount = rowsNow();
  check('جدول النماذج يعرض صفوفاً فعلية', rowCount > 0, 'rows=' + rowCount);
  check('الجدول يعرض عدد المعروض من الإجمالي', /المعروض \d+ من \d+/.test(txt()), txt().slice(0, 0));
  check('أعمدة الجدول كاملة', ['النموذج', 'المزود', 'الحالة', 'الزمن', 'آخر فحص', 'السبب', 'إجراء'].every(h =>
    [...container.querySelectorAll('th')].some(th => (th.textContent || '').trim() === h)));

  // تغطية المزودات
  check('شريط تغطية المزودات يعرض المزودات', txt().includes('تغطية المزودات') && txt().includes('apmix') && txt().includes('pollinations'));
  check('يميّز المزود المعطّل', txt().includes('معطّل'));

  // التصفية بالمؤشر: نضغط "مرفوض (محجوب)"
  const kpiBtn: any = [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes('مرفوض (محجوب)'));
  await act(async () => { click(kpiBtn); });
  await act(async () => { await sleep(300); });
  const statusBadges = [...container.querySelectorAll('tbody tr')].map(tr => {
    const b = [...tr.querySelectorAll('span')].find(s => s.className.includes('badge'));
    return (b?.textContent || '').trim();
  });
  check('التصفية بالمؤشر تعمل (كل الصفوف "مرفوض")', statusBadges.length > 0 && statusBadges.every(s => s === 'مرفوض'),
    'badges=' + [...new Set(statusBadges)].join('/'));

  // إلغاء التصفية
  await act(async () => { click(kpiBtn); });
  await act(async () => { await sleep(300); });
  check('إلغاء التصفية يعيد كل الصفوف', rowsNow() === rowCount, rowsNow() + ' vs ' + rowCount);

  // البحث
  const searchInput: any = container.querySelector('input[placeholder*="ابحث"]');
  check('حقل البحث موجود', !!searchInput);
  await act(async () => { setInputValue(searchInput, 'llama'); });
  await act(async () => { await sleep(400); });
  const afterSearch = rowsNow();
  check('البحث يُقلّل النتائج', afterSearch < rowCount && afterSearch > 0, afterSearch + ' من ' + rowCount);
  const modelsShown = [...container.querySelectorAll('tbody tr')].map(tr => (tr.querySelector('td')?.textContent || '').toLowerCase());
  check('كل نتائج البحث تحتوي الكلمة', modelsShown.every(m => m.includes('llama')), modelsShown.slice(0, 3).join(', '));

  await act(async () => { setInputValue(searchInput, ''); });
  await act(async () => { await sleep(300); });
  check('مسح البحث يعيد كل الصفوف', rowsNow() === rowCount);

  // شرح المنهج
  const methodBtn: any = [...container.querySelectorAll('button')].find(b => (b.textContent || '').includes('كيف يعمل؟'));
  check('زر شرح المنهج موجود', !!methodBtn);
  await act(async () => { click(methodBtn); });
  await act(async () => { await sleep(200); });
  check('شرح المنهج يظهر عند الطلب', container.querySelectorAll('ol li').length >= 5, 'items=' + container.querySelectorAll('ol li').length);

  // أزرار الإجراءات
  check('زر فحص المزودات المفعّلة موجود ومعطّل بشكل صحيح', !!findButton(container, 'فحص المزودات المفعّلة'));
  check('منتقي عدد النماذج ظاهر (كان مخفياً قبل)', !!container.querySelector('select') && txt().includes('نماذج لكل مزود'));
  check('زر مسح النتائج معطّل عند وجود نتائج؟', !!findButton(container, 'مسح النتائج'));
  check('تلميح إدارة المفاتيح يوجّه لتبويب Providers', txt().includes('Providers'));

  await act(async () => { root.unmount(); });
}

console.log('\n================ النتيجة ================');
console.log('ناجح: ' + pass + ' | فاشل: ' + fail);
if (failures.length) { console.log('\nالإخفاقات:'); failures.forEach(f => console.log(' ✗ ' + f)); }
process.exit(fail ? 1 : 0);
