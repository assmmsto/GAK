// src/components/SortTab.tsx — فرز النماذج: أي نموذج يعمل فعلاً؟
// غاية التبويب واحدة: نعرف أي نموذج يرد فعلاً، ونحجب الميت تلقائياً من التوجيه.
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ProbeRow, type ProbeStatus, type Provider } from '../lib/api';
import {
  CheckCircle2, XCircle, AlertTriangle, Clock, KeyRound, Play, Trash2,
  FlaskConical, RefreshCw, Info, Search, Loader2, Power
} from 'lucide-react';
import { cn } from '../lib/utils';

// ===== الحالات: لون + شرح + ترتيب أولوية =====
const STATUS_META: Record<ProbeStatus, { label: string; hint: string; badge: string; border: string; icon: any }> = {
  rejected:      { label: 'مرفوض',     hint: 'غير موجود أو لا يدعم المحادثة — محجوب من التوجيه', badge: 'badge-error',   border: 'border-l-bad',  icon: XCircle },
  provider_auth: { label: 'مفتاح خاطئ', hint: 'مشكلة في مفتاح المزود لا في النموذج — أصلح المفتاح', badge: 'badge-error', border: 'border-l-bad', icon: KeyRound },
  rate_limited:  { label: 'حصة فارغة', hint: 'انتهت الحصة أو خطأ شبكي مؤقت — قد تتجدد لاحقاً',      badge: 'badge-warning', border: 'border-l-warn', icon: AlertTriangle },
  slow:          { label: 'بطيء',      hint: 'لم يستجب في الوقت المحدد أو خطأ سيرفر مؤقت',      badge: 'badge-warning', border: 'border-l-warn', icon: Clock },
  ok:            { label: 'يعمل',      hint: 'رد فعلاً على طلب محادثة حقيقي',                    badge: 'badge-success', border: 'border-l-ok',   icon: CheckCircle2 },
  no_key:        { label: 'بلا مفتاح', hint: 'المزود بلا مفتاح — لن يُجرَّب حتى تضيف مفتاحاً',   badge: 'badge',         border: 'border-l-line', icon: KeyRound },
};

// الترتيب الافتراضي: ما يحتاج تدخّلاً أولاً
const SEVERITY: ProbeStatus[] = ['provider_auth', 'rejected', 'rate_limited', 'slow', 'ok', 'no_key'];
const rank = (s: ProbeStatus) => SEVERITY.indexOf(s);

const KPI_ACCENT: Record<string, string> = {
  ok: 'text-ok', provider_auth: 'text-bad', rejected: 'text-bad', warn: 'text-warn', no_key: 'text-ink-dim'
};

function fmtAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}ث`;
  if (s < 3600) return `${Math.round(s / 60)}د`;
  if (s < 86400) return `${Math.round(s / 3600)}س`;
  return `${Math.round(s / 86400)}ي`;
}

type SortBy = 'severity' | 'provider' | 'model' | 'latency';
type KpiKey = 'ok' | 'provider_auth' | 'rejected' | 'warn' | 'no_key';
// 'warn' حالة مركّبة (حصة فارغة + بطيء) — لذا نوع الفلتر أوسع من ProbeStatus
type StatusFilter = 'all' | ProbeStatus | 'warn';

export function SortTab({ onToast }: { onToast?: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  const qc = useQueryClient();

  // ===== حالة الواجهة =====
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortBy>('severity');
  const [cap, setCap] = useState(20);
  const [showMethod, setShowMethod] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);

  // ===== البيانات =====
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: () => api.status(), refetchInterval: 5000 });
  const { data: probesData, isLoading } = useQuery({
    queryKey: ['probes'], queryFn: () => api.probeResults(), refetchInterval: 5000
  });

  const providers: Provider[] = status?.providers || [];
  const probes: ProbeRow[] = probesData?.probes || [];
  const summary = probesData?.summary || {};
  const enabledProviders = providers.filter(p => p.enabled !== false);

  const n = (k: ProbeStatus) => Number(summary[k] || 0);
  const totalProbed = probesData?.total ?? probes.length;
  const rejectedCount = n('rejected');

  // تغطية كل مزود
  const coverage = useMemo(() => {
    const m = new Map<string, { total: number; ok: number; bad: number }>();
    for (const r of probes) {
      const c = m.get(r.provider) || { total: 0, ok: 0, bad: 0 };
      c.total++;
      if (r.status === 'ok') c.ok++;
      if (r.status === 'rejected' || r.status === 'no_key') c.bad++;
      m.set(r.provider, c);
    }
    return m;
  }, [probes]);

  // ===== الفلترة والترتيب =====
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = probes.filter(r => {
      if (statusFilter === 'warn') {
        if (r.status !== 'rate_limited' && r.status !== 'slow') return false;
      } else if (statusFilter !== 'all' && r.status !== statusFilter) {
        return false;
      }
      if (providerFilter !== 'all' && r.provider !== providerFilter) return false;
      if (needle && !`${r.model} ${r.provider}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    return [...out].sort((a, b) => {
      if (sortBy === 'severity') return rank(a.status) - rank(b.status) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
      if (sortBy === 'provider') return a.provider.localeCompare(b.provider) || rank(a.status) - rank(b.status);
      if (sortBy === 'model') return a.model.localeCompare(b.model);
      return (a.latency_ms || 0) - (b.latency_ms || 0);
    });
  }, [probes, q, statusFilter, providerFilter, sortBy]);

  const ROW_LIMIT = 300;
  const visibleRows = showAllRows ? rows : rows.slice(0, ROW_LIMIT);

  // ===== العمليات =====
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['probes'] });
    qc.invalidateQueries({ queryKey: ['status'] });
    qc.invalidateQueries({ queryKey: ['models'] });
  };

  const probeAllMut = useMutation({
    mutationFn: async (targets: Provider[]) => {
      const out: Array<{ pid: string; tested: number; ok: number; skipped?: string }> = [];
      for (const p of targets) {
        if (!p.hasKey && !p.keyless) { out.push({ pid: p.id, tested: 0, ok: 0, skipped: 'بلا مفتاح' }); continue; }
        try {
          const r = await api.probeAll(p.id, cap);
          out.push({ pid: p.id, tested: r.tested, ok: r.ok });
        } catch (e: any) {
          out.push({ pid: p.id, tested: 0, ok: 0, skipped: e.message });
        }
      }
      return out;
    },
    onSuccess: (out) => {
      invalidate();
      const tested = out.reduce((a, x) => a + x.tested, 0);
      const ok = out.reduce((a, x) => a + x.ok, 0);
      const skipped = out.filter(x => x.skipped).length;
      onToast?.(`انتهى الفحص: ${ok} يعمل من ${tested} نموذج${skipped ? ` · ${skipped} مزود متخطّى` : ''}`, 'success');
    },
    onError: (e: any) => onToast?.(`فشل الفحص: ${e.message}`, 'error')
  });

  const probeOneMut = useMutation({
    mutationFn: ({ pid, model }: { pid: string; model: string }) => api.probeOne(pid, model),
    onSuccess: (d) => {
      invalidate();
      onToast?.(`${d.model} → ${STATUS_META[d.status]?.label || d.status}`, d.status === 'ok' ? 'success' : 'error');
    },
    onError: (e: any) => onToast?.(`فشل: ${e.message}`, 'error')
  });

  const retryMut = useMutation({
    mutationFn: () => api.probeRetryRejected(),
    onSuccess: (d) => {
      invalidate();
      onToast?.(
        d.tested === 0 ? 'لا نماذج مرفوضة لإعادة الفحص' : `أُعيد فحص ${d.tested} — انتعش ${d.recovered}`,
        d.tested === 0 ? 'info' : 'success'
      );
    },
    onError: (e: any) => onToast?.(`فشل: ${e.message}`, 'error')
  });

  const clearMut = useMutation({
    mutationFn: () => api.probeClear(),
    onSuccess: () => { invalidate(); onToast?.('مُسحت نتائج الفحص — أُطلق كل المحجوب', 'info'); }
  });

  const busy = probeAllMut.isPending || retryMut.isPending || clearMut.isPending;

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><div className="spinner" /></div>;
  }

  const kpis: Array<{ key: KpiKey; value: number; label: string }> = [
    { key: 'ok', value: n('ok'), label: 'يعمل' },
    { key: 'provider_auth', value: n('provider_auth'), label: 'مفتاح خاطئ' },
    { key: 'rejected', value: rejectedCount, label: 'مرفوض (محجوب)' },
    { key: 'warn', value: n('rate_limited') + n('slow'), label: 'حصة فارغة / بطيء' },
    { key: 'no_key', value: n('no_key'), label: 'بلا مفتاح' }
  ];

  return (
    <div className="space-y-4">
      {/* ===== 1) الغاية ===== */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-primary-2" />
            فرز النماذج
            <span className="badge">{totalProbed} مفحوص</span>
          </h2>
          <p className="text-xs text-ink-dim mt-1 leading-relaxed max-w-2xl">
            يرسل <b className="text-ink-muted">طلب محادثة حقيقي</b> لكل نموذج ليعرف أيّها يرد فعلاً.
            المرفوض <b className="text-bad">يُحجب تلقائياً</b> من التوجيه، فلا يُجرَّب مرتين ولا يظهر في قائمة النماذج.
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => setShowMethod(v => !v)}>
          <Info className="w-3.5 h-3.5" /> {showMethod ? 'إخفاء' : 'كيف يعمل؟'}
        </button>
      </div>

      {showMethod && (
        <ol className="card !p-4 list-decimal pr-6 space-y-1 text-[13px] text-ink-muted leading-relaxed">
          <li>نتأكد أن المزود حي ومفتاحه سليم.</li>
          <li>نجلب قائمة نماذجه من المزود نفسه.</li>
          <li>نرسل لكل نموذج طلب محادثة قصيراً وننتظر ردّه فعلاً.</li>
          <li>الذي يرد نصاً → <b className="text-ok">يعمل</b> ويُدمج في القائمة الموحّدة.</li>
          <li>الذي يفشل (غير موجود / مفتاح خاطئ / لا يدعم المحادثة) → <b className="text-bad">مرفوض</b> ويُحجب من التوجيه.</li>
          <li>نفاد الحصة أو الخطأ المؤقت → <b className="text-warn">حصة فارغة/بطيء</b> ويُعاد فحصه تلقائياً كل ساعة.</li>
        </ol>
      )}

      {/* ===== 2) المؤشرات — اضغط للتصفية ===== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpis.map(c => (
          <button
            key={c.key}
            onClick={() => setStatusFilter(prev => prev === c.key ? 'all' : c.key)}
            className={cn('card !p-3 text-right transition-colors', statusFilter === c.key && 'border-primary')}
            title="اضغط للتصفية على هذه الحالة"
          >
            <div className={cn('text-2xl font-bold tabular-nums', KPI_ACCENT[c.key])}>{c.value}</div>
            <div className="text-[11px] text-ink-muted mt-0.5">{c.label}</div>
          </button>
        ))}
      </div>

      {/* ===== 3) الإجراءات ===== */}
      <div className="card !p-3 flex items-center gap-2 flex-wrap">
        <button
          className="btn btn-sm btn-primary"
          disabled={busy || enabledProviders.length === 0}
          onClick={() => probeAllMut.mutate(enabledProviders)}
          title="يفحص نماذج كل مزود مفعّل ويملك مفتاحاً"
        >
          {probeAllMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {probeAllMut.isPending ? 'جارٍ الفحص…' : `فحص المزودات المفعّلة (${enabledProviders.length})`}
        </button>

        <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
          نماذج لكل مزود
          <select className="input !py-1 !w-20" value={cap} onChange={e => setCap(Number(e.target.value))}>
            {[5, 10, 20, 50].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <span className="w-px h-5 bg-line" />

        <button
          className="btn btn-sm"
          disabled={busy || rejectedCount === 0}
          onClick={() => retryMut.mutate()}
          title="يعيد فحص المرفوضين فقط — قد تكون الحصة تجددت أو السيرفر رجع"
        >
          {retryMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          أعد فحص المرفوض {rejectedCount > 0 ? `(${rejectedCount})` : ''}
        </button>

        <button
          className="btn btn-sm btn-danger"
          disabled={busy || totalProbed === 0}
          onClick={() => { if (confirm('مسح كل نتائج الفحص وإطلاق كل النماذج المحجوبة؟')) clearMut.mutate(); }}
          title="يمسح النتائج ويُطلق المحجوب — سيُعاد كل شيء للفحص من جديد"
        >
          <Trash2 className="w-3.5 h-3.5" /> مسح النتائج
        </button>

        {busy && <span className="text-[11px] text-ink-dim">الفحص يستغرق وقتاً: طلب حقيقي لكل نموذج…</span>}
      </div>

      {/* ===== 4) تغطية المزودات ===== */}
      <div className="card !p-3">
        <div className="text-[11px] uppercase tracking-wider text-ink-muted font-semibold mb-2">تغطية المزودات</div>
        <div className="flex flex-wrap gap-1.5">
          {providers.map(p => {
            const c = coverage.get(p.id);
            const isOff = p.enabled === false;
            const active = providerFilter === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setProviderFilter(prev => prev === p.id ? 'all' : p.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors',
                  active ? 'border-primary bg-primary/10' : 'border-line bg-surface-2 hover:border-line-hover',
                  isOff && 'opacity-60'
                )}
                title={isOff ? `${p.id} — معطّل (لن يُفحص)` : `تصفية على ${p.id}`}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full',
                  isOff ? 'bg-ink-dim' : p.status === 'up' ? 'bg-ok' : p.status === 'auth_error' ? 'bg-bad' : 'bg-warn')} />
                <span className="font-mono">{p.id}</span>
                {!p.hasKey && !p.keyless && <span className="text-warn">بلا مفتاح</span>}
                {isOff && <span className="text-ink-dim">معطّل</span>}
                {c
                  ? <span className="text-ink-muted tabular-nums">{c.ok}✓ {c.bad}✗</span>
                  : <span className="text-ink-dim">لم يُفحص</span>}
              </button>
            );
          })}
        </div>
        {providers.some(p => p.enabled !== false && !coverage.get(p.id)) && (
          <p className="text-[11px] text-warn mt-2">مزودات مفعّلة لم تُفحص بعد — اضغط «فحص المزودات المفعّلة».</p>
        )}
      </div>

      {/* ===== 5) الفلاتر ===== */}
      <div className="card !p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-ink-dim absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            className="input !py-1.5 pr-8"
            placeholder="ابحث باسم النموذج…"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
        </div>
        <select className="input !py-1.5" value={providerFilter} onChange={e => setProviderFilter(e.target.value)}>
          <option value="all">كل المزودات</option>
          {providers.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
        <select className="input !py-1.5" value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)}>
          <option value="all">كل الحالات</option>
          <option value="warn">حصة فارغة / بطيء</option>
          {SEVERITY.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select>
        <select className="input !py-1.5" value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)}>
          <option value="severity">الترتيب: الأهم أولاً</option>
          <option value="provider">الترتيب: المزود</option>
          <option value="model">الترتيب: اسم النموذج</option>
          <option value="latency">الترتيب: الأسرع أولاً</option>
        </select>
      </div>

      {/* ===== 6) جدول النماذج ===== */}
      <div className="card !p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-line/60">
          <span className="text-sm font-semibold">
            النماذج
            <span className="text-ink-dim font-normal"> — المعروض {rows.length} من {totalProbed}</span>
          </span>
          {(q || statusFilter !== 'all' || providerFilter !== 'all') && (
            <button
              className="text-[11px] text-primary-2 hover:underline"
              onClick={() => { setQ(''); setStatusFilter('all'); setProviderFilter('all'); }}
            >
              إزالة الفلاتر
            </button>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="text-center py-12 text-sm text-ink-muted">
            {totalProbed === 0
              ? 'لم يُفحص أي نموذج بعد — ابدأ بـ «فحص المزودات المفعّلة»'
              : 'لا نتائج مطابقة للفلاتر'}
          </div>
        ) : (
          <div className="max-h-[560px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-surface-2">
                <tr className="text-ink-muted text-[11px]">
                  <th className="text-right font-semibold px-4 py-2">النموذج</th>
                  <th className="text-right font-semibold px-3 py-2 w-32">المزود</th>
                  <th className="text-right font-semibold px-3 py-2 w-28">الحالة</th>
                  <th className="text-right font-semibold px-3 py-2 w-20">الزمن</th>
                  <th className="text-right font-semibold px-3 py-2 w-16">آخر فحص</th>
                  <th className="text-right font-semibold px-3 py-2">السبب</th>
                  <th className="text-center font-semibold px-3 py-2 w-20">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(r => {
                  const meta = STATUS_META[r.status] || STATUS_META.rejected;
                  const Icon = meta.icon;
                  const isThisProbing = probeOneMut.isPending && probeOneMut.variables?.model === r.model;
                  return (
                    <tr key={r.id} className={cn('border-t border-line/40 border-l-4 hover:bg-surface-2/60', meta.border)}>
                      <td className="px-4 py-2 font-mono text-[11px] text-ink truncate max-w-[280px]" title={r.model}>{r.model}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-muted truncate" title={r.provider}>{r.provider}</td>
                      <td className="px-3 py-2">
                        <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold', meta.badge)}>
                          <Icon className="w-3 h-3" /> {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 tabular-nums text-ink-muted">{r.latency_ms ? `${r.latency_ms}ms` : '—'}</td>
                      <td className="px-3 py-2 text-ink-dim">{r.checked_at ? fmtAgo(r.checked_at) : '—'}</td>
                      <td className="px-3 py-2 text-ink-dim truncate max-w-[260px]" title={r.error || meta.hint}>
                        {r.error || <span className="italic">{meta.hint}</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={probeOneMut.isPending}
                          onClick={() => probeOneMut.mutate({ pid: r.provider, model: r.model })}
                          title="أعد فحص هذا النموذج"
                        >
                          {isThisProbing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!showAllRows && rows.length > ROW_LIMIT && (
              <div className="text-center py-3 border-t border-line/40">
                <button className="btn btn-sm" onClick={() => setShowAllRows(true)}>
                  عرض بقية النتائج ({rows.length - ROW_LIMIT})
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <p className="text-[11px] text-ink-dim flex items-center gap-1.5">
        <Power className="w-3 h-3" />
        لإضافة مفتاح أو تعديل رابط مزود أو تفعيله/تعطيله: تبويب <b className="text-ink-muted">Providers</b>.
      </p>
    </div>
  );
}
