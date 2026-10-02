// src/components/AgentsTab.tsx — لوحة الوكلاء: إشراف ذاتي التشغيل مرئياً.
//
// لماذا هذه اللوحة؟ الوكلاء يعملون تلقائياً بلا تدخّل، وهذا سلاح ذو حدّين:
// إن لم ترَ ماذا يفعلون، لا تستطيع أن تثق بهم ولا أن تلغيهم عند الخطأ.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, KeyRound, ShieldCheck, AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { api, type TaskState, type AgentKeyCircuit, type SourceStatus, type RotationAudit } from '../lib/api';
import { cn, timeAgo, formatNumber } from '../lib/utils';
import { StatCard, Spinner } from './ui';

const TASK_LABEL: Record<string, string> = {
  'key-sync': 'مزامنة المفاتيح',
  rotation: 'تدوير المفاتيح',
  health: 'فحص الصحة',
  drift: 'تتبّع التغيّر',
  'auto-probe': 'فحص النماذج',
  retention: 'تنظيف السجلات'
};

const ACTION_LABEL: Record<string, string> = {
  added: 'أُضيف', reactivated: 'أُعيد تفعيله', authority: 'تغيّرت سلطته',
  withdrawn: 'سُحب', backoff: 'عزل متصاعد', provider_isolated: 'عُزل المزوّد'
};

const ACTION_TONE: Record<string, string> = {
  added: 'text-ok', reactivated: 'text-ok', authority: 'text-primary-2',
  withdrawn: 'text-warn', backoff: 'text-warn', provider_isolated: 'text-bad'
};

function formatInterval(ms: number): string {
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}س`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}د`;
  return `${Math.round(ms / 1000)}ث`;
}

function CircuitPill({ state }: { state: AgentKeyCircuit['state'] }) {
  const map = {
    closed: { cls: 'text-ok', label: 'يعمل' },
    'half-open': { cls: 'text-warn', label: 'يُجرَّب' },
    open: { cls: 'text-bad', label: 'معطّل' }
  } as const;
  const c = map[state];
  return <span className={cn('text-[11px] font-semibold', c.cls)}>{c.label}</span>;
}

function TaskRow({ t }: { t: TaskState }) {
  const tone = t.lastOk === false ? 'text-bad' : t.lastOk === true ? 'text-ok' : 'text-ink-dim';
  return (
    <tr className="border-b border-line/40 last:border-0">
      <td className="py-2 font-medium">{TASK_LABEL[t.name] || t.name}</td>
      <td className="py-2 tabular-nums text-ink-dim">{formatInterval(t.intervalMs)}</td>
      <td className="py-2">
        <span className={cn('inline-flex items-center gap-1.5 text-[11px]', tone)}>
          {t.running
            ? <><Loader2 className="w-3 h-3 animate-spin" /> قيد التنفيذ</>
            : t.lastOk === false
              ? <><AlertTriangle className="w-3 h-3" /> فشل</>
              : t.lastOk === true
                ? <><CheckCircle2 className="w-3 h-3" /> سليم</>
                : 'لم يُنفَّذ بعد'}
        </span>
      </td>
      <td className="py-2 tabular-nums text-ink-dim">
        {t.lastRun ? `${t.lastMs}ms · ${timeAgo(t.lastRun)}` : '—'}
      </td>
      <td className="py-2 tabular-nums text-ink-dim">
        {formatNumber(t.runs)}
        {t.failures > 0 && <span className="text-bad"> ({t.failures} فشل)</span>}
      </td>
      <td className="py-2 text-[11px] text-bad max-w-[280px] truncate" title={t.lastError || ''}>
        {t.lastError || '—'}
      </td>
    </tr>
  );
}

export function AgentsTab({ showToast }: { showToast: (m: string, t?: 'info' | 'success' | 'error') => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [showAllKeys, setShowAllKeys] = useState(false);

  const { data: status } = useQuery({
    queryKey: ['agents-status'],
    queryFn: () => api.agentsStatus({}),
    refetchInterval: 8000
  });
  const { data: keys } = useQuery({
    queryKey: ['agents-keys'],
    queryFn: () => api.agentsKeys({}),
    refetchInterval: 15000
  });
  const { data: audit } = useQuery({
    queryKey: ['agents-audit'],
    queryFn: () => api.agentsAudit({ limit: 25 }),
    refetchInterval: 20000
  });

  const run = async (kind: 'sync' | 'rotate') => {
    setBusy(kind);
    try {
      if (kind === 'sync') {
        const r = await api.agentsSync({ method: 'POST', body: '{}' });
        const c = r.counts;
        const changed = c.added + c.reactivated + c.authority + c.withdrawn;
        showToast(
          changed > 0
            ? `مزامنة: ${c.added} جديد · ${c.withdrawn} مسحوب · ${c.authority} تغيّرسلطة (${r.durationMs}ms)`
            : `لا تغيير — ${r.desiredKeys} مفتاحاً متسقاً مع المصادر (${r.durationMs}ms)`,
          c.error > 0 ? 'error' : 'success'
        );
      } else {
        const r = await api.agentsRotate({ method: 'POST', body: '{}' });
        const iso = r.isolatedProviders.length;
        showToast(
          iso > 0
            ? `تدوير: عزل ${iso} مزوّداً بلا مفاتيح صالحة`
            : `تدوير: ${r.counts.closed} سليم · ${r.counts.open} معطّل`,
          iso > 0 ? 'error' : 'success'
        );
      }
      await qc.invalidateQueries();
    } catch (e: any) {
      showToast(`فشل: ${e?.message || 'خطأ غير معروف'}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const rot = status?.rotation;
  const circuits: AgentKeyCircuit[] = keys?.keys || [];
  const visibleKeys = showAllKeys ? circuits : circuits.filter((k: AgentKeyCircuit) => k.state !== 'closed').slice(0, 12);
  const problems = circuits.filter((k: AgentKeyCircuit) => k.state === 'open' || k.needsResync).length;
  const configured = (status?.sources || []).filter((s: SourceStatus) => s.configured);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="المشرف" value={status?.scheduler.running ? 'يعمل' : 'متوقف'}
          meta={status?.scheduler.running ? `كل ${formatInterval(status.scheduler.tickMs)}` : 'AGENTS_ENABLED=0'}
          icon={ShieldCheck} accent={status?.scheduler.running ? 'success' : 'warning'}
        />
        <StatCard label="مفاتيح سليمة" value={rot?.closed ?? '—'} meta={`من ${rot?.total ?? 0}`} icon={KeyRound} accent="success" />
        <StatCard label="معطّلة" value={rot?.open ?? '—'} meta={`${rot?.halfOpen ?? 0} قيد المحاولة`} icon={AlertTriangle} accent={rot?.open ? 'warning' : 'accent'} />
        <StatCard label="مصادر مُهيَّأة" value={`${configured.length}/${status?.sources.length ?? 0}`} meta="مُهيَّأة" icon={RefreshCw} accent="accent-2" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => run('sync')} disabled={busy !== null} className="btn btn-ghost btn-size-sm">
          {busy === 'sync' ? <Spinner size="sm" /> : <RefreshCw className="w-3.5 h-3.5" />} مزامنة الآن
        </button>
        <button onClick={() => run('rotate')} disabled={busy !== null} className="btn btn-ghost btn-size-sm">
          {busy === 'rotate' ? <Spinner size="sm" /> : <ShieldCheck className="w-3.5 h-3.5" />} دورة تدوير
        </button>
        <span className="text-[11px] text-ink-dim">
          الوكلاء يعملون تلقائياً كل دورة. الأزرار تُشغّل الدورة نفسها الآن.
        </span>
      </div>

      <div className="glass rounded-xl p-4">
        <h3 className="text-sm font-semibold mb-3">المهمّات الدورية</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-ink-muted text-[10px] uppercase tracking-wider">
                <th className="text-right font-semibold py-1">المهمّة</th>
                <th className="text-right font-semibold py-1">الفترة</th>
                <th className="text-right font-semibold py-1">الحالة</th>
                <th className="text-right font-semibold py-1">آخر تشغيل</th>
                <th className="text-right font-semibold py-1">عدد</th>
                <th className="text-right font-semibold py-1">آخر خطأ</th>
              </tr>
            </thead>
            <tbody>
              {(status?.scheduler.tasks || []).map((t: TaskState) => <TaskRow key={t.name} t={t} />)}
              {!status && <tr><td colSpan={6} className="py-4 text-center text-ink-muted">جارٍ التحميل…</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="glass rounded-xl p-4">
        <h3 className="text-sm font-semibold mb-1">مصادر الأسرار</h3>
        <p className="text-[11px] text-ink-dim mb-3">
          الهرمية: الأصغر يفوز عند التعارض. لا تُعرض أي قيمة مفتاح — الأرقام فقط.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-ink-muted text-[10px] uppercase tracking-wider">
                <th className="text-right font-semibold py-1">المصدر</th>
                <th className="text-right font-semibold py-1">الأولوية</th>
                <th className="text-right font-semibold py-1">الحالة</th>
                <th className="text-right font-semibold py-1">مفاتيح</th>
                <th className="text-right font-semibold py-1">زمن الجلب</th>
                <th className="text-right font-semibold py-1">آخر مزامنة</th>
              </tr>
            </thead>
            <tbody>
              {(status?.sources || []).map((s: SourceStatus) => (
                <tr key={s.id} className="border-b border-line/40 last:border-0">
                  <td className="py-2 font-medium">{s.label}</td>
                  <td className="py-2 tabular-nums text-ink-dim">{s.priority}</td>
                  <td className="py-2">
                    {!s.configured ? <span className="text-ink-dim text-[11px]">غير مُهيَّأ</span>
                      : s.ok === false ? <span className="text-bad text-[11px]">فشل</span>
                        : s.ok ? <span className="text-ok text-[11px]">يعمل</span>
                          : <span className="text-ink-dim text-[11px]">لم يُجرَّب</span>}
                  </td>
                  <td className="py-2 tabular-nums">{s.configured ? s.entries : '—'}</td>
                  <td className="py-2 tabular-nums text-ink-dim">{s.latencyMs != null ? `${s.latencyMs}ms` : '—'}</td>
                  <td className="py-2 text-ink-dim text-[11px]">{s.lastSync ? timeAgo(s.lastSync) : '—'}</td>
                </tr>
              ))}
              {status && configured.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-3 text-[11px] text-warn">
                    لا يوجد مصدر مُهيَّأ. أضف متغيّرات مدير الأسرار إلى .env أو ملف data/secrets.json —
                    المفاتيح اليدوية تبقى تعمل.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {(status?.sources || []).filter((s: SourceStatus) => s.error).map((s: SourceStatus) => (
          <p key={s.id} className="text-[11px] text-bad mt-2">{s.label}: {s.error}</p>
        ))}
      </div>

      <div className="glass rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">دوائر المفاتيح</h3>
          <button onClick={() => setShowAllKeys(v => !v)} className="btn btn-ghost btn-size-sm">
            {showAllKeys ? 'إظهار غير السليمة فقط' : `إظهار الكل (${circuits.length})`}
          </button>
        </div>
        {problems > 0 && (
          <p className="text-[11px] text-warn mb-2">{problems} مفتاحاً معطّلاً أو يستحق إعادة جلب.</p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-ink-muted text-[10px] uppercase tracking-wider">
                <th className="text-right font-semibold py-1">المزوّد</th>
                <th className="text-right font-semibold py-1">المصدر</th>
                <th className="text-right font-semibold py-1">الحالة</th>
                <th className="text-right font-semibold py-1">الدرجة</th>
                <th className="text-right font-semibold py-1">طلبات</th>
                <th className="text-right font-semibold py-1">إعادة المحاولة</th>
              </tr>
            </thead>
            <tbody>
              {visibleKeys.map((k: AgentKeyCircuit) => (
                <tr key={k.id} className="border-b border-line/40 last:border-0">
                  <td className="py-2 font-medium">{k.provider}</td>
                  <td className="py-2 text-ink-dim">{k.source}</td>
                  <td className="py-2">
                    <CircuitPill state={k.state} />
                    {k.needsResync && <span className="text-[10px] text-primary-2 mr-1.5">يستحق جلب</span>}
                  </td>
                  <td className="py-2 tabular-nums">{k.score}</td>
                  <td className="py-2 tabular-nums text-ink-dim">{formatNumber(k.requests)}</td>
                  <td className="py-2 text-ink-dim text-[11px]">
                    {k.retryInMs != null ? `بعد ${Math.ceil(k.retryInMs / 1000)}ث` : '—'}
                  </td>
                </tr>
              ))}
              {circuits.length === 0 && (
                <tr><td colSpan={6} className="py-4 text-center text-ink-muted">لا مفاتيح بعد</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="glass rounded-xl p-4">
        <h3 className="text-sm font-semibold mb-3">سجل التدقيق</h3>
        <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
          {(audit?.rotations || []).map((r: RotationAudit) => (
            <div key={r.id} className="flex items-center gap-2 text-[11px] border-b border-line/30 last:border-0 py-1.5">
              <Clock className="w-3 h-3 text-ink-dim shrink-0" />
              <span className="tabular-nums text-ink-dim shrink-0">{timeAgo(r.ts)}</span>
              <span className="font-medium shrink-0">{r.provider}</span>
              <span className={cn('font-semibold shrink-0', ACTION_TONE[r.action] || 'text-ink-dim')}>
                {ACTION_LABEL[r.action] || r.action}
              </span>
              <span className="text-ink-dim truncate">{r.reason || ''}</span>
            </div>
          ))}
          {!audit?.rotations?.length && (
            <p className="text-[11px] text-ink-muted py-2">لا تغييرات بعد — وهذا جيد.</p>
          )}
        </div>
      </div>
    </div>
  );
}