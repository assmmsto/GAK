// src/components/PlaygroundTab.tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Sparkles, Send, Loader2, MessageSquare, User, Bot, Cpu, Hash, Copy, Check, Plug } from 'lucide-react';
import { api, ensureUiKey, storedUiKey } from '../lib/api';
import { cn } from '../lib/utils';

const QUICK_PROMPTS = [
  'اشرح الحوسبة الكمية في جملتين',
  'اكتب هايكو عن البرمجة',
  'كم يساوي 2+2؟',
  'أعطني 3 ألوان بصيغة JSON'
];

export function PlaygroundTab({ onToast }: { onToast?: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  // قائمة النماذج تحتاج مفتاح عميل في الترويسة. المتصفح الجديد (أو الذي مُسح
  // تخزينه) لا يملك مفتاحاً، فكانت /v1/models ترد 401 والقائمة تُعرض فارغة
  // بلا تفسير — نُنشئ مفتاح الواجهة هنا مرة واحدة عند فتح التبويب.
  // ensureUiKey تتحقق من صلاحية المفتاح المخزَّن وتستبدله إن رُفض، فنُعيد
  // المحاولة عند فشل الشبكة بدل تسميم الذاكرة المؤقتة بنتيجة فارغة.
  const { data: modelsData, error: modelsError, isLoading: modelsLoading } = useQuery({
    queryKey: ['models'],
    queryFn: async () => {
      await ensureUiKey();
      return api.models();
    },
    refetchInterval: 10000,
    retry: 3,
    retryDelay: 800,
  });
  const models = modelsData?.data || [];
  const [model, setModel] = useState('auto');
  const [system, setSystem] = useState('أنت مساعد مفيد ومختصر.');
  const [user, setUser] = useState('مرحباً! من أنت؟');
  const [apiKey, setApiKey] = useState('');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState('');

  // --- بيانات الاتصال ---
  const { data: keyData } = useQuery({ queryKey: ['keys'], queryFn: () => api.keys(), refetchInterval: 8000 });
  // المفتاح الكامل لا يخرج من القاعدة (تُخزَّن hash) — نعرض النسخة المحلية
  // للواجهة إن وُجدت، وإلا بصمة القائمة (القيمة الكاملة عند الإنشاء فقط).
  const quickKey = storedUiKey() || keyData?.keys?.[0]?.key || '';
  const [copied, setCopied] = useState<'url' | 'key' | 'model' | null>(null);
  const doCopy = (what: 'url' | 'key' | 'model', text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
    }).catch(() => {
      // صلاحية الحافظة قد تُرفض — لا نُسقط الوعد بلا معالجة (كان unhandled rejection)
    });
  };
  const BASE = (import.meta as any).env?.VITE_GATEWAY_URL || `${window.location.origin}`;
  const endpoint = `${BASE}/v1`;
  const modelId = model === 'auto' ? 'auto' : model;

  const send = async () => {
    if (!user.trim() || loading) return;
    const userMsg = user.trim();
    setMessages(m => [...m, { role: 'user', content: userMsg }]);
    setUser('');
    setLoading(true);
    setStreaming(true);
    setMeta('');
    const reqMessages: any[] = [];
    if (system.trim()) reqMessages.push({ role: 'system', content: system });
    reqMessages.push({ role: 'user', content: userMsg });
    const t0 = Date.now();
    try {
      let acc = '';
      let thought = ''; // نماذج التفكير تُرسل thinking في delta.reasoning
      let sseBuffer = ''; // مخزن مؤقت للأسطر المقطوعة بين الـ chunks
      setMessages(m => [...m, { role: 'assistant', content: '' }]);
      const sub: { requested?: string; actual?: string; providerId?: string } = {};
      await api.chat({ model, messages: reqMessages }, (chunk) => {
        // نجمّع كل شي بمكان واحد، وبعدين نقسم سطر سطر
        // عشان الـ chunk ما يقص نص JSON نصّين (هيك كان يكسر العربي)
        sseBuffer += chunk;
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || ''; // آخر سطر غالبًا ناقص → ننتظر اللي بعده
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            // إشعار الاستبدال (يرجع مرة وحدة عند بداية الـ stream)
            if (parsed._substituted && !sub.actual) Object.assign(sub, parsed._substituted);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              acc += delta;
              setMessages(m => {
                const next = [...m];
                next[next.length - 1] = { role: 'assistant', content: acc };
                return next;
              });
            } else if (parsed.choices?.[0]?.delta?.reasoning) {
              // النموذج يفكّر بلا نص ظاهر — نعرض التفكير بدل فقاعة فارغة
              thought += parsed.choices[0].delta.reasoning;
              setMessages(m => {
                const next = [...m];
                const last = next[next.length - 1];
                if (!last.content) next[next.length - 1] = { role: 'assistant', content: '…يفكّر: ' + thought.slice(-280) };
                return next;
              });
            }
          } catch {}
        }
      }, apiKey.trim() || undefined);
      const provider = model === 'auto' ? 'توجيه تلقائي' : model;
      // إشعار الاستبدال (في الـ meta أسفل الـ reply)
      if (sub.actual && sub.requested) {
        setMeta(`↪ استُبدل ${sub.requested} بـ ${sub.actual} (${sub.providerId}) · ${Date.now() - t0} م.ث`);
      } else {
        setMeta(`✓ ${Date.now() - t0} م.ث · ${provider}`);
      }
    } catch (e: any) {
      // الخطأ في فقاعة منفصلة، لا داخل ردّ المساعد (كان يوهم أنه إجابة النموذج)
      setMessages(m => [...m, { role: 'assistant', content: '' }]);
      setMessages(m => m.slice(0, -1));
      onToast?.(`فشل الطلب: ${e.message}`, 'error');
      setMeta('خطأ');
    } finally {
      setLoading(false);
      setStreaming(false);
    }
  };

  const useQuick = (p: string) => setUser(p);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" /> اختبار محادثة
            <span className="badge-primary badge">بثّ مباشر</span>
          </h2>
          <p className="text-xs text-ink-dim mt-0.5">اختبر أي مزوّد أو نموذج بردود متدفّقة مباشرة</p>
        </div>
      </div>

      {/* Config bar */}
      <div className="card !p-3 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Cpu className="w-4 h-4 text-ink-muted shrink-0" />
          <select
            className="input flex-1 !py-1.5"
            aria-label="اختيار النموذج"
            value={model}
            onChange={e => setModel(e.target.value)}
          >
            <option value="auto">✨ تلقائي (الموجّه يختار الأفضل)</option>
            <optgroup label="النماذج المتاحة">
              {models.filter(m => m.id !== 'auto').map(m => (
                <option key={m.id} value={m.id}>
                  {m.id} {m._tier === 4 ? '· مجاني' : m._tier === 1 ? '· مدفوع' : ''}
                </option>
              ))}
            </optgroup>
          </select>
          {(modelsError || (!modelsLoading && models.length === 0)) && (
            <span className="text-[11px] text-warn shrink-0" title={modelsError ? String((modelsError as Error).message) : 'لا نماذج'}>
              {modelsError
                ? (/401|invalid_api_key|Invalid API key/i.test(String((modelsError as Error).message))
                    ? 'مفتاح الواجهة مرفوض — أعد المحاولة'
                    : 'تعذّر جلب النماذج')
                : 'لا نماذج مسجّلة'}
            </span>
          )}
        </div>
        <input
          className="input !py-1.5 font-mono text-xs w-52"
          dir="ltr"
          type="password"
          aria-label="مفتاح API"
          placeholder="مفتاح API (اختياري)"
          title="مفتاح عميل — يُنشأ تلقائياً مرة واحدة عند أول إرسال إن تُرك فارغاً"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
        />
        <button onClick={send} disabled={loading || !user.trim()} className="btn btn-primary">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          {loading ? 'جارٍ الإرسال…' : 'أرسل'}
        </button>
      </div>

      {/* Quick Connect — توليد تلقائي لبيانات أي نموذج */}
      <div className="card !p-3">
        <div className="flex items-center gap-2 mb-2.5">
          <Plug className="w-3.5 h-3.5 text-primary" />
          <span className="text-[11px] uppercase font-semibold tracking-wider text-ink-muted">اتصال سريع</span>
          <span className="text-[11px] text-ink-dim">— يتبع النموذج المختار تلقائياً</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {[
            { label: 'عنوان الأساس', val: endpoint, id: 'url' as const },
            { label: 'مفتاح API', val: quickKey || '—', id: 'key' as const },
            { label: 'معرّف النموذج', val: modelId, id: 'model' as const },
          ].map(f => (
            <div key={f.id} className="rounded-lg bg-surface-2 border border-line p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] tracking-wide text-ink-dim font-semibold">{f.label}</span>
                {f.val !== '—' && (
                  <button
                    onClick={() => doCopy(f.id, f.val)}
                    className="text-ink-muted hover:text-primary transition-colors"
                    title="نسخ"
                  >
                    {copied === f.id ? <Check className="w-3.5 h-3.5 text-ok" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
              <div dir="ltr" className="font-mono text-[11px] text-ink truncate text-left" title={f.val}>
                {f.val === '—' ? <span className="text-ink-dim italic">لا مفتاح محفوظ — يُنشأ عند أول إرسال</span> : f.val}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Input panel */}
        <div className="card space-y-3">
          <div>
            <label className="flex items-center gap-1.5 text-[11px] text-ink-muted font-semibold tracking-wide mb-1.5">
              <Bot className="w-3 h-3" /> رسالة النظام
            </label>
            <textarea
              className="input font-sans" rows={2}
              aria-label="رسالة النظام"
              value={system} onChange={e => setSystem(e.target.value)}
            />
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[11px] text-ink-muted font-semibold tracking-wide mb-1.5">
              <User className="w-3 h-3" /> رسالتك
            </label>
            <textarea
              className="input font-sans" rows={6}
              aria-label="رسالتك"
              value={user} onChange={e => setUser(e.target.value)}
              placeholder="اكتب رسالتك… (Enter للإرسال، Shift+Enter لسطر جديد)"
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          </div>

          <div>
            <label className="block text-[11px] text-ink-dim tracking-wide mb-1.5">أسئلة سريعة</label>
            <div className="flex flex-wrap gap-1">
              {QUICK_PROMPTS.map(p => (
                <button
                  key={p} onClick={() => useQuick(p)}
                  className="px-2 py-1 text-[11px] rounded-md bg-surface-2 border border-line text-ink-muted hover:text-ink hover:border-primary transition-colors"
                >
                  {p.length > 28 ? p.slice(0, 28) + '…' : p}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Response panel */}
        <div className="card flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <label className="flex items-center gap-1.5 text-[11px] text-ink-muted font-semibold tracking-wide">
              <MessageSquare className="w-3 h-3" /> المحادثة
            </label>
            {meta && <span dir="ltr" className="text-[11px] font-mono text-ink-dim">{meta}</span>}
          </div>
          <div className="flex-1 min-h-[300px] max-h-[500px] overflow-y-auto space-y-2.5 pe-1">
            {messages.length === 0 ? (
              <div className="text-center py-12 text-ink-muted text-sm">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 text-ink-dim" />
                لا رسائل بعد — أرسل واحدة للبدء.
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex gap-2 ',
                    m.role === 'user' ? 'justify-end' : 'justify-start'
                  )}
                >
                  {m.role === 'assistant' && (
                    <div className="shrink-0 w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
                      <Bot className="w-3.5 h-3.5 text-white" />
                    </div>
                  )}
                  <div className={cn(
                    'max-w-[85%] rounded-xl px-3 py-2 text-sm',
                    m.role === 'user'
                      ? 'bg-primary/15 border border-primary/30 text-ink'
                      : 'bg-surface-2 border border-line text-ink'
                  )}>
                    <div className="whitespace-pre-wrap break-words">
                      {m.content || (streaming && i === messages.length - 1 ? (
                        <span className="text-ink-dim">▍</span>
                      ) : '')}
                    </div>
                  </div>
                  {m.role === 'user' && (
                    <div className="shrink-0 w-7 h-7 rounded-lg bg-surface-2 border border-line flex items-center justify-center">
                      <User className="w-3.5 h-3.5 text-ink-muted" />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          {meta && (
            <div dir="ltr" className="mt-2 pt-2 border-t border-line/50 text-[11px] font-mono text-ink-dim flex items-center gap-1.5">
              <Hash className="w-3 h-3" /> {meta}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}