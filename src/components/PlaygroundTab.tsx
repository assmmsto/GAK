// src/components/PlaygroundTab.tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Sparkles, Send, Loader2, MessageSquare, User, Bot, Cpu, Hash, Copy, Check, Plug } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';

const QUICK_PROMPTS = [
  'Explain quantum computing in 2 sentences',
  'Write a haiku about programming',
  'What is 2+2?',
  'List 3 colors in JSON'
];

export function PlaygroundTab() {
  const { data: modelsData } = useQuery({ queryKey: ['models'], queryFn: () => api.models(), refetchInterval: 10000 });
  const models = modelsData?.data || [];
  const [model, setModel] = useState('auto');
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [user, setUser] = useState('Hello! Who are you?');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState('');

  // --- التوليد التلقائي لبيانات الاتصال ---
  const { data: keyData } = useQuery({ queryKey: ['keys'], queryFn: () => api.keys(), refetchInterval: 8000 });
  const quickKey = keyData?.keys?.[0]?.key || '';
  const [copied, setCopied] = useState<'url' | 'key' | 'model' | null>(null);
  const doCopy = (what: 'url' | 'key' | 'model', text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
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
            }
          } catch {}
        }
      });
      const provider = model === 'auto' ? 'auto-routed' : model;
      // إشعار الاستبدال (في الـ meta أسفل الـ reply)
      if (sub.actual && sub.requested) {
        setMeta(`↪ استُبدل ${sub.requested} بـ ${sub.actual} (${sub.providerId}) · ${Date.now() - t0}ms`);
      } else {
        setMeta(`✓ ${Date.now() - t0}ms · ${provider}`);
      }
    } catch (e: any) {
      setMessages(m => [...m, { role: 'assistant', content: 'Error: ' + e.message }]);
      setMeta('error');
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
            <Sparkles className="w-5 h-5 text-primary" /> Playground
            <span className="badge-primary badge">streaming</span>
          </h2>
          <p className="text-xs text-ink-dim mt-0.5">Test any provider or model with live streaming responses</p>
        </div>
      </div>

      {/* Config bar */}
      <div className="card !p-3 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Cpu className="w-4 h-4 text-ink-muted shrink-0" />
          <select
            className="input flex-1 !py-1.5"
            value={model}
            onChange={e => setModel(e.target.value)}
          >
            <option value="auto">✨ auto (router picks best)</option>
            <optgroup label="Available models">
              {models.filter(m => m.id !== 'auto').map(m => (
                <option key={m.id} value={m.id}>
                  {m.id} {m._tier === 4 ? '·free' : m._tier === 1 ? '·paid' : ''}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <button onClick={send} disabled={loading || !user.trim()} className="btn btn-primary">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          {loading ? 'Sending…' : 'Send'}
        </button>
      </div>

      {/* Quick Connect — توليد تلقائي لبيانات أي نموذج */}
      <div className="card !p-3">
        <div className="flex items-center gap-2 mb-2.5">
          <Plug className="w-3.5 h-3.5 text-primary" />
          <span className="text-[11px] uppercase font-semibold tracking-wider text-ink-muted">Quick connect</span>
          <span className="text-[10px] text-ink-dim">— يتبع النموذج المختار تلقائياً</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {[
            { label: 'Base URL', val: endpoint, id: 'url' as const },
            { label: 'API Key', val: quickKey || '—', id: 'key' as const },
            { label: 'Model ID', val: modelId, id: 'model' as const },
          ].map(f => (
            <div key={f.id} className="rounded-lg bg-surface-2 border border-line p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] uppercase tracking-wider text-ink-dim font-semibold">{f.label}</span>
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
              <div className="font-mono text-[11px] text-ink truncate" title={f.val}>
                {f.val === '—' ? <span className="text-ink-dim italic">يولّد تلقائياً…</span> : f.val}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Input panel */}
        <div className="card space-y-3">
          <div>
            <label className="flex items-center gap-1.5 text-[11px] uppercase text-ink-muted font-semibold tracking-wider mb-1.5">
              <Bot className="w-3 h-3" /> System
            </label>
            <textarea
              className="input font-sans" rows={2}
              value={system} onChange={e => setSystem(e.target.value)}
            />
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[11px] uppercase text-ink-muted font-semibold tracking-wider mb-1.5">
              <User className="w-3 h-3" /> User prompt
            </label>
            <textarea
              className="input font-sans" rows={6}
              value={user} onChange={e => setUser(e.target.value)}
              placeholder="Type your message… (Enter to send, Shift+Enter for newline)"
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          </div>

          <div>
            <label className="block text-[10px] uppercase text-ink-dim tracking-wider mb-1.5">Quick prompts</label>
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
            <label className="flex items-center gap-1.5 text-[11px] uppercase text-ink-muted font-semibold tracking-wider">
              <MessageSquare className="w-3 h-3" /> Conversation
            </label>
            {meta && <span className="text-[10px] font-mono text-ink-dim">{meta}</span>}
          </div>
          <div className="flex-1 min-h-[300px] max-h-[500px] overflow-y-auto space-y-2.5 pr-1">
            {messages.length === 0 ? (
              <div className="text-center py-12 text-ink-muted text-sm">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 text-ink-dim" />
                No messages yet. Send one to start.
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
            <div className="mt-2 pt-2 border-t border-line/50 text-[10px] font-mono text-ink-dim flex items-center gap-1.5">
              <Hash className="w-3 h-3" /> {meta}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}