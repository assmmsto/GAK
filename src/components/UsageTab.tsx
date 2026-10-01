// src/components/UsageTab.tsx
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, TrendingUp, Zap, Scissors, Database, Loader2, Trash2 } from 'lucide-react';
import { api, type TokenSettings } from '../lib/api';
import { formatNumber, cn } from '../lib/utils';

// ===== لوحة تخفيف استهلاك الرموز =====
function TokenSavingPanel() {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings(),
    refetchInterval: 8000
  });
  const s: TokenSettings | undefined = data?.settings;

  const patch = async (body: any) => {
    setSaving(true);
    try {
      await api.updateSettings(body);
      qc.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally { setSaving(false); }
  };

  if (!s) return null;
  const totalCacheLookups = s.cacheHits + s.cacheMisses;
  const hitRate = totalCacheLookups > 0 ? Math.round((s.cacheHits / totalCacheLookups) * 100) : 0;

  return (
    <div className="card !p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Scissors className="w-4 h-4 text-primary-2" /> تخفيف استهلاك الرموز
          </h3>
          <p className="text-[11px] text-ink-dim mt-0.5">
            تُطبَّق على كل طلب قبل إرساله للمزوّد — تقليل مباشر للفاتورة والاستهلاك.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-[11px] text-ok">✓ حُفظ</span>}
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-dim" />}
          <button
            className="btn btn-sm"
            onClick={() => patch({ clearCache: true })}
            disabled={s.cacheSize === 0}
            title="إفراغ ذاكرة الردود المتطابقة"
          >
            <Trash2 className="w-3 h-3" /> إفراغ الذاكرة ({s.cacheSize})
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex items-center justify-between gap-2 bg-surface-2 border border-line rounded-lg px-3 py-2">
          <span className="text-xs">
            <b className="block">ذاكرة الردود المتطابقة</b>
            <span className="text-ink-dim text-[11px]">نفس الطلب → رد محفوظ بلا استهلاك</span>
          </span>
          <input
            type="checkbox"
            className="accent-primary w-4 h-4 shrink-0"
            checked={s.cacheEnabled}
            onChange={e => patch({ cacheEnabled: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between gap-2 bg-surface-2 border border-line rounded-lg px-3 py-2">
          <span className="text-xs">
            <b className="block">تقليم مخرجات الأدوات</b>
            <span className="text-ink-dim text-[11px]">أكبر مصدر للرموز في وكلاء البرمجة</span>
          </span>
          <input
            type="checkbox"
            className="accent-primary w-4 h-4 shrink-0"
            checked={s.trimToolOutputs}
            onChange={e => patch({ trimToolOutputs: e.target.checked })}
          />
        </label>

        <label className="bg-surface-2 border border-line rounded-lg px-3 py-2">
          <span className="text-xs block mb-1">حد مخرجات الأداة (حرف)</span>
          <input
            type="number" min={200} step={100}
            className="input !py-1 !text-xs"
            defaultValue={s.maxToolChars}
            onBlur={e => patch({ maxToolChars: Number(e.target.value) })}
          />
        </label>

        <label className="bg-surface-2 border border-line rounded-lg px-3 py-2">
          <span className="text-xs block mb-1">نافذة السياق (عدد الرسائل · 0 = بلا قص)</span>
          <input
            type="number" min={0} step={2}
            className="input !py-1 !text-xs"
            defaultValue={s.contextWindow}
            onBlur={e => patch({ contextWindow: Number(e.target.value) })}
          />
        </label>

        <label className="bg-surface-2 border border-line rounded-lg px-3 py-2">
          <span className="text-xs block mb-1">سقف max_tokens (0 = بلا سقف)</span>
          <input
            type="number" min={0} step={256}
            className="input !py-1 !text-xs"
            defaultValue={s.maxTokensCeiling}
            onBlur={e => patch({ maxTokensCeiling: Number(e.target.value) })}
          />
        </label>

        <label className="bg-surface-2 border border-line rounded-lg px-3 py-2">
          <span className="text-xs block mb-1">مدة صلاحية الذاكرة (ثانية)</span>
          <input
            type="number" min={0} step={30}
            className="input !py-1 !text-xs"
            defaultValue={s.cacheTtlSec}
            onBlur={e => patch({ cacheTtlSec: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-ink-dim flex-wrap border-t border-line/50 pt-2.5">
        <span className="flex items-center gap-1.5">
          <Database className="w-3 h-3" /> ذاكرة: {s.cacheSize} مدخل
        </span>
        <span>·</span>
        <span className={cn(hitRate > 0 && 'text-ok')}>
          إصابات: {s.cacheHits} / محاولات: {totalCacheLookups} ({hitRate}%)
        </span>
        <span>·</span>
        <span className="italic">التقليم لا يلمس آخر 3 مخرجات أدوات — السياق القريب يبقى كاملاً</span>
      </div>
    </div>
  );
}

export function UsageTab() {
  const { data, isLoading } = useQuery({ queryKey: ['usage'], queryFn: () => api.usage() });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: () => api.status() });

  if (isLoading) return (
    <div className="flex items-center justify-center py-12">
      <div className="spinner" />
    </div>
  );

  const usage = data?.usage || [];
  const stats = status?.stats;
  const totalTokens = usage.reduce((s, u) => s + (u.tokens || 0), 0);
  const totalReqs = usage.reduce((s, u) => s + (u.requests || 0), 0);
  const max = Math.max(...usage.map(u => u.tokens || 0), 1);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary-2" /> Usage
            <span className="badge">last 24h</span>
          </h2>
          <p className="text-xs text-ink-dim mt-0.5">Token consumption and request distribution</p>
        </div>
      </div>

      <TokenSavingPanel />

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="card">
          <div className="flex items-center gap-2 text-ink-muted text-xs mb-2">
            <Zap className="w-3.5 h-3.5" /> Total Tokens
          </div>
          <div className="text-2xl font-bold tabular-nums">{formatNumber(totalTokens)}</div>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 text-ink-muted text-xs mb-2">
            <TrendingUp className="w-3.5 h-3.5" /> Total Requests
          </div>
          <div className="text-2xl font-bold tabular-nums">{formatNumber(totalReqs)}</div>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 text-ink-muted text-xs mb-2">
            <Activity className="w-3.5 h-3.5" /> Avg / Request
          </div>
          <div className="text-2xl font-bold tabular-nums">
            {totalReqs > 0 ? formatNumber(Math.round(totalTokens / totalReqs)) : '—'}
          </div>
        </div>
      </div>

      {/* Per-provider breakdown */}
      <div className="card">
        <h3 className="text-sm font-semibold mb-3 text-ink-muted">By Provider</h3>
        {usage.length === 0 ? (
          <div className="text-center py-8 text-ink-muted text-sm">
            No usage data yet. Send a request to see stats.
          </div>
        ) : (
          <div className="space-y-2.5">
            {usage.map(u => (
              <div key={u.provider} className="space-y-1">
                <div className="grid grid-cols-[140px_1fr_120px] gap-3 items-center text-sm">
                  <code className="font-mono text-xs truncate" title={u.provider}>{u.provider}</code>
                  <div className="bg-surface-2 h-8 rounded-md overflow-hidden flex items-center relative">
                    <div
                      className="h-full bg-primary flex items-center px-3 text-white text-xs font-semibold transition-all duration-500"
                      style={{ width: `${Math.max((u.tokens / max) * 100, 4)}%` }}
                    >
                      {formatNumber(u.tokens)}
                    </div>
                  </div>
                  <span className="text-ink-muted text-xs tabular-nums text-right">
                    {u.requests} {u.requests === 1 ? 'req' : 'reqs'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {stats && stats.total > 0 && (
        <div className="card text-xs">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-ink-dim uppercase tracking-wider text-[10px] mb-1">Total</div>
              <div className="text-lg font-bold tabular-nums">{formatNumber(stats.total)}</div>
            </div>
            <div>
              <div className="text-ink-dim uppercase tracking-wider text-[10px] mb-1">Success</div>
              <div className="text-lg font-bold tabular-nums text-ok">{formatNumber(stats.success)}</div>
            </div>
            <div>
              <div className="text-ink-dim uppercase tracking-wider text-[10px] mb-1">Errors</div>
              <div className="text-lg font-bold tabular-nums text-bad">{formatNumber(stats.error)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}