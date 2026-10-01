// src/components/EndpointBanner.tsx — unified API key + URL generator
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Copy, Check, Plus, Trash2, Loader2, Link2, Eye, EyeOff, Activity, RefreshCw, BarChart3 } from 'lucide-react';
import { api, KeyStats } from '../lib/api';
import { timeAgo, cn } from '../lib/utils';

const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

// شريط أفقي صغير يمثل الرموز لكل نموذج
function TokenBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.max(3, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-ink-muted font-mono w-28 truncate shrink-0" title={label}>{label}</span>
      <div className="flex-1 h-3.5 bg-surface-2 rounded overflow-hidden border border-line">
        <div className="h-full bg-primary/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-ink w-16 text-right shrink-0">{fmt(value)}</span>
    </div>
  );
}

// خط بياني لزمني (نقاط الاستخدام)
function Sparkline({ series }: { series: Array<{ ts: number; n: number }> }) {
  if (!series.length) {
    return <div className="text-[10px] text-ink-dim italic py-4 text-center">لا يوجد نشاط بعد — استخدم المفتاح في أداة وارجع هنا</div>;
  }
  const max = Math.max(1, ...series.map(s => s.n));
  const W = 100, H = 30;
  const step = series.length > 1 ? W / (series.length - 1) : W;
  const pts = series.map((s, i) => {
    const x = i * step;
    const y = H - (s.n / max) * (H - 4) - 2;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div className="bg-surface-2 border border-line rounded-lg p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16" preserveAspectRatio="none">
        <polyline
          points={pts}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex items-center justify-between mt-1 text-[9px] font-mono text-ink-dim">
        <span>{timeAgo(series[0].ts)}</span>
        <span>الآن</span>
      </div>
    </div>
  );
}

export function EndpointBanner({ onToast }: { onToast: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['keys'], queryFn: () => api.keys(), refetchInterval: 5000 });
  const [creating, setCreating] = useState(false);
  const [regenId, setRegenId] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);

  const baseUrl = data?.baseUrl || '';
  const keys = data?.keys || [];

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      onToast(`${label} copied`, 'success');
      setTimeout(() => setCopied(null), 1500);
    } catch {
      onToast('Copy failed', 'error');
    }
  };

  const create = async () => {
    const name = prompt('Name this key (e.g. cursor, codex, my-app):', 'my-key');
    if (!name) return;
    setCreating(true);
    try {
      await api.createKey(name);
      onToast('Unified API key created', 'success');
      qc.invalidateQueries({ queryKey: ['keys'] });
    } catch (e: any) {
      onToast(e.message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const regenerate = async (id: number, name: string) => {
    if (!confirm(`Regenerate key "${name}"?\n\nالقيمة القديمة رح تبطل مباشرة — كل أداة تستخدمها لازم تحدّثها.`)) return;
    setRegenId(id);
    try {
      await api.regenerateKey(id);
      onToast('Key regenerated — update your tools', 'success');
      qc.invalidateQueries({ queryKey: ['keys'] });
      if (activeId === id) qc.invalidateQueries({ queryKey: ['key-stats', id] });
    } catch (e: any) {
      onToast(e.message, 'error');
    } finally {
      setRegenId(null);
    }
  };

  const remove = async (id: number, name: string) => {
    if (!confirm(`Delete key "${name}"?\n\nTools using it will stop working.`)) return;
    try {
      await api.deleteKey(id);
      if (activeId === id) setActiveId(null);
      onToast('Key deleted', 'success');
      qc.invalidateQueries({ queryKey: ['keys'] });
    } catch (e: any) {
      onToast(e.message, 'error');
    }
  };

  const mask = (k: string) => k.slice(0, 8) + '••••••••••••••••••••';

  return (
    <div className="card mb-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold">Unified Endpoint</h2>
          <span className="badge badge-primary">one key · all providers</span>
        </div>
        <button className="btn btn-sm btn-primary" onClick={create} disabled={creating}>
          {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Generate Key
        </button>
      </div>

      {/* URL الجامع */}
      <div className="space-y-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-ink-dim font-semibold">Base URL</label>
          <div className="flex items-center gap-2 mt-1">
            <code className="flex-1 bg-surface-2 border border-line rounded-lg px-3 py-2 text-xs text-ink font-mono truncate">
              {baseUrl || 'http://localhost:3001'}/v1
            </code>
            <button
              className="btn btn-sm"
              onClick={() => copy(`${baseUrl}/v1`, 'URL')}
              title="Copy URL"
            >
              {copied === 'URL' ? <Check className="w-3 h-3 text-ok" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {/* المفاتيح */}
        {isLoading ? (
          <div className="text-xs text-ink-dim py-2">loading keys…</div>
        ) : keys.length === 0 ? (
          <div className="text-xs text-ink-dim py-2">
            No keys yet — localhost is open. Generate one to protect this endpoint when exposed.
          </div>
        ) : (
          <div className="space-y-1.5">
            {keys.map(k => (
              <div key={k.id}>
                <div className="flex items-center gap-2 bg-surface-2 border border-line rounded-lg px-3 py-2">
                  <span className="text-[10px] text-ink-muted font-medium w-20 truncate" title={k.name}>{k.name}</span>
                  <code className="flex-1 text-xs text-ink font-mono truncate">
                    {revealed[k.id] ? k.key : mask(k.key as string)}
                  </code>
                  <span className="text-[10px] text-ink-dim whitespace-nowrap">
                    {k.requests || 0} reqs
                    {k.last_used ? ` · ${timeAgo(k.last_used as number)}` : ''}
                  </span>
                  <button
                    className={cn('btn btn-sm btn-ghost', activeId === k.id && 'text-primary')}
                    onClick={() => setActiveId(activeId === k.id ? null : (k.id as number))}
                    title={activeId === k.id ? 'إخفاء النشاط' : 'نشاط المفتاح'}
                  >
                    <Activity className="w-3 h-3" />
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => setRevealed(r => ({ ...r, [k.id]: !r[k.id] }))}
                    title={revealed[k.id] ? 'Hide' : 'Reveal'}
                  >
                    {revealed[k.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => copy(k.key as string, 'Key')}
                    title="Copy key"
                  >
                    {copied === 'Key' ? <Check className="w-3 h-3 text-ok" /> : <Copy className="w-3 h-3" />}
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => regenerate(k.id as number, k.name as string)}
                    disabled={regenId === k.id}
                    title="إعادة توليد المفتاح (يلغي القديم)"
                  >
                    {regenId === k.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => remove(k.id as number, k.name as string)}
                    title="Delete key"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                {/* لوحة النشاط */}
                {activeId === k.id && <KeyStatsPanel keyId={k.id as number} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* اختصار الاستخدام */}
      <div className="mt-3 pt-3 border-t border-line/50 flex items-center gap-1.5 text-[11px] text-ink-dim">
        <Link2 className="w-3 h-3" />
        Point any OpenAI-compatible tool here:
        <code className="text-primary-2 font-mono">base URL</code> +
        <code className="text-primary-2 font-mono">key</code>
      </div>
    </div>
  );
}

function KeyStatsPanel({ keyId }: { keyId: number }) {
  const { data, isLoading, isError } = useQuery<KeyStats>({
    queryKey: ['key-stats', keyId],
    queryFn: () => api.keyStats(keyId),
    refetchInterval: 4000
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 bg-surface border border-line border-t-0 rounded-b-lg text-[11px] text-ink-dim">
        <Loader2 className="w-3 h-3 animate-spin" /> تحميل النشاط…
      </div>
    );
  }
  if (isError || !data) {
    return <div className="px-3 py-2.5 bg-surface border border-line border-t-0 rounded-b-lg text-[11px] text-bad">فشل تحميل النشاط</div>;
  }

  const totalTokens = data.models.reduce((a, m) => a + m.tokens, 0);
  const totalReqs = data.models.reduce((a, m) => a + m.requests, 0);
  const maxTokens = Math.max(1, ...data.models.map(m => m.tokens));
  const avgMs = data.models.length
    ? Math.round(data.models.reduce((a, m) => a + m.avgMs, 0) / data.models.length)
    : 0;

  if (!data.models.length && !data.series.length) {
    return (
      <div className="px-3 py-3 bg-surface border border-line border-t-0 rounded-b-lg text-[11px] text-ink-dim">
        <BarChart3 className="w-3 h-3 inline-block mr-1.5" />
        لا يوجد نشاط على هذا المفتاح بعد. استخدمه بأي أداة (Cursor, Cline…) وستظهر الإحصائيات هنا تلقائياً.
      </div>
    );
  }

  return (
    <div className="px-3 py-3 bg-surface border border-line border-t-0 rounded-b-lg space-y-3">
      {/* الملخص */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'الرموز', value: fmt(totalTokens) },
          { label: 'الطلبات', value: fmt(totalReqs) },
          { label: 'النماذج', value: String(data.models.length) },
          { label: 'زمن الاستجابة', value: avgMs ? `${fmt(avgMs)}ms` : '—' }
        ].map(s => (
          <div key={s.label} className="text-center bg-surface-2 rounded-lg py-1.5 border border-line">
            <div className="text-sm font-mono font-semibold text-ink">{s.value}</div>
            <div className="text-[9px] text-ink-dim">{s.label}</div>
          </div>
        ))}
      </div>

      {/* الرسم الزمني */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-ink-muted font-semibold mb-1">النشاط الزمني</div>
        <Sparkline series={data.series} />
      </div>

      {/* الرموز لكل نموذج */}
      {data.models.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-muted font-semibold mb-1.5">الرموز حسب النموذج</div>
          <div className="space-y-1.5">
            {data.models.map(m => (
              <div key={m.model} className="group">
                <TokenBar label={m.model} value={m.tokens} max={maxTokens} />
                <div className="flex items-center gap-3 text-[9px] text-ink-dim pl-[5.25rem] opacity-70">
                  <span>{m.requests} طلب</span>
                  <span>·</span>
                  <span>دخل {fmt(m.prompt)} / خرج {fmt(m.completion)}</span>
                  {m.avgMs > 0 && (<><span>·</span><span>{m.avgMs}ms</span></>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
