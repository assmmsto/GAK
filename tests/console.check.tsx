// فحص تفصيلي: تحذيرات/أخطاء React والكونسول عند تصيير كل مكوّنات الواجهة فعلياً.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5173/', pretendToBeVisual: true });
const w: any = dom.window;
const define = (k: string, v: any) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
define('window', w); define('document', w.document); define('navigator', w.navigator); define('localStorage', w.localStorage);
(globalThis as any).HTMLElement = w.HTMLElement;
(globalThis as any).HTMLInputElement = w.HTMLInputElement;
(globalThis as any).HTMLTextAreaElement = w.HTMLTextAreaElement;
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

// التقاط رسائل الكونسول
const issues: string[] = [];
const origErr = console.error, origWarn = console.warn;
console.error = (...a: any[]) => { issues.push('ERROR: ' + a.map(x => String(x)).join(' ')); origErr(...a); };
console.warn = (...a: any[]) => { issues.push('WARN: ' + a.map(x => String(x)).join(' ')); origWarn(...a); };

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const App = (await import('../src/App')).default;
const { ProvidersTab } = await import('../src/components/ProvidersTab');
const { SortTab } = await import('../src/components/SortTab');
const { UsageTab } = await import('../src/components/UsageTab');
const { LogsTab } = await import('../src/components/LogsTab');
const { PlaygroundTab } = await import('../src/components/PlaygroundTab');
const { EndpointBanner } = await import('../src/components/EndpointBanner');
const { AddProviderModal } = await import('../src/components/AddProviderModal');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let rendered = 0;

async function render(name: string, el: any, props: any = {}, wait = 2500) {
  const container = w.document.createElement('div');
  w.document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  const before = issues.length;
  await act(async () => { root.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(el, props))); });
  await act(async () => { await sleep(wait); });
  const produced = issues.slice(before);
  rendered++;
  const nodes = container.querySelectorAll('*').length;
  console.log(`${produced.length ? 'ISSUES' : 'CLEAN '} ${name.padEnd(16)} | عناصر DOM: ${nodes} | رسائل: ${produced.length}`);
  produced.slice(0, 6).forEach(m => console.log('        → ' + m.slice(0, 160)));
  await act(async () => { root.unmount(); });
}

console.log('=== فحص تحذيرات React وأخطاء الكونسول لكل مكوّن ===\n');
await render('App (الهيكل)', App, {}, 4000);
await render('ProvidersTab', ProvidersTab, { onToast: () => {} });
await render('SortTab', SortTab, { onToast: () => {} });
await render('UsageTab', UsageTab, {});
await render('LogsTab', LogsTab, {});
await render('PlaygroundTab', PlaygroundTab, {});
await render('EndpointBanner', EndpointBanner, { onToast: () => {} });
await render('AddProviderModal', AddProviderModal, { open: true, onClose: () => {}, onAdded: () => {}, editTarget: null }, 1500);

const real = issues.filter(i => !/Download the React DevTools/i.test(i));
console.log('\n================ النتيجة ================');
console.log('مكوّنات صُيّرت: ' + rendered + ' | إجمالي الرسائل: ' + real.length);
if (real.length) { console.log('\nالرسائل:'); real.slice(0, 20).forEach(m => console.log(' ✗ ' + m.slice(0, 220))); }
else console.log('لا تحذيرات ولا أخطاء React — نظيف تماماً');
process.exit(real.length ? 1 : 0);
