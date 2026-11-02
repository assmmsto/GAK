// src/components/HealthTab.tsx — حالة كل مفتاح في جدول واحد
// لماذا: KeysModal يفتح مزوداً بمزود، فسؤال "أي مفتاح ميت؟" كان يتطلب فتح كل
// مزود على حدة. هنا كل مفتاح في صف واحد، مرتّب بالأخطر أولاً.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ShieldAlert, AlertTriangle, Clock, CheckCircle2, KeyRound, RefreshCw, Info,
  Power, Trash2, PlayCircle, X
} from 'lucide-react';
import { api, type HealthKey, type HealthStatus } from '../lib/api';
import { cn, formatNumber, timeAgo } from '../lib/utils';
import { ConfirmDialog, Modal, StatCard } from './ui';

const STATUS_META: Record<HealthStatus, { label: string; cls: string; icon: any; hint: string }> = {
  auth_error: {
    label: 'ميت', cls: 'badge-error', icon: ShieldAlert,
    hint: 'المفتاح مرفوض من المزود (401/403). احذفه أو استبدله — لن يعمل حتى يعيد المزود قبوله.'
  },
  quota_exhausted: {
    label: 'رصيد/حصة', cls: 'badge-warning', icon: AlertTriangle,
    hint: 'الحصة أو الرصيد انتهى. ينتظر العودة، أو اشحن الحساب.'
  },
  unknown: {
    label: 'لم يُختبر', cls: 'badge', icon: Clock,
    hint: 'لا توجد نتيجة بعد. شغّل فحصاً ليعرف النظام إن كان يعمل.'
  },
  ok: {
    label: 'يعمل', cls: 'badge-success', icon: CheckCircle2,
    hint: 'ردّ على طلب حقيقي — يدخل التوجيه.'
  }
};

type Filter = 'all' | 'problem' | 'ok' | 'unknown';

// حالةBusy لكل مفتاح — تمنع نقرتين متزامنتين على نفس الصف
type BusyMap = Record<number, string>;

// صدق البيانات: "يعمل" بلا استخدام حقيقي حديث هو ادعاء غير مؤكَّد — الحالة
// من فحص/نجاح قديم (رأينا صفوف "يعمل" آخر استخدام لها 33 يوماً وأخرى 0/20
// نموذجاً). الأسبوع حدّ معقول: بعده الشارة تُظهر الحقيقة ويظهر زر الفحص.
const OK_PROOF_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const okUnproven = (k: HealthKey): boolean =>
  k.status === 'ok' && (!k.lastUsed || (Date.now() - k.lastUsed) > OK_PROOF_WINDOW_MS);

export function HealthTab() {
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<BusyMap>({});
  const [bulk, setBulk] = useState<string>('');
  const [confirm, setConfirm] = useState<null | { keys: HealthKey[]; label: string }>(null);
  // المفتاح الجديد يُحفظ في حالة المكوّن فقط — لا في localStorage
  // (مفتاح في localStorage = قابل للقراءة من أي سكربت في الصفحة)
  const [replacing, setReplacing] = useState<HealthKey | null>(null);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // إجراءات جماعية — يبقى هنا لا بعد `if (isLoading) return`، وإلا اختلف عدد
  // الـhooks بين أول رسم (تحميل) والثاني (بيانات) فتنهار الشجرة كلها (React #310).
  const [bulkDisableAsk, setBulkDisableAsk] = useState<number | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    refetchInterval: 10000
  });

  const mark = (id: number, v: string) => setBusy(b => ({ ...b, [id]: v }));
  const clear = (id: number) => setBusy(b => {
    const n = { ...b }; delete n[id]; return n;
  });

  // ===== إجراءات على مفتاح واحد =====
  async function setEnabled(k: HealthKey, enabled: boolean) {
    mark(k.id, 'saving'); setErr(null);
    try {
      await api.updateProviderKey(k.provider, k.id, { enabled });
      clear(k.id);
      await refetch();
    } catch (e: any) { clear(k.id); setErr(e.message || 'فشل التعطيل'); }
  }

  async function removeKey(k: HealthKey) {
    mark(k.id, 'deleting'); setErr(null);
    try {
      await api.deleteProviderKey(k.provider, k.id);
      clear(k.id);
      setConfirm(null);
      await refetch();
    } catch (e: any) { clear(k.id); setErr(e.message || 'فشل الحذف'); }
  }

  async function replaceKey() {
    if (!replacing) return;
    const v = newKeyValue.trim();
    if (!v) { setErr('المفتاح الجديد فارغ'); return; }
    mark(replacing.id, 'saving'); setErr(null);
    try {
      // استبدال المفتاح يصفّر الحالة إلى unknown تلقائياً في الخادم
      await api.updateProviderKey(replacing.provider, replacing.id, { key: v });
      clear(replacing.id);
      setReplacing(null); setNewKeyValue('');
      await refetch();
    } catch (e: any) { clear(replacing.id); setErr(e.message || 'فشل الاستبدال'); }
  }

  async function retest(k: HealthKey) {
    mark(k.id, 'testing'); setErr(null);
    try {
      const r = await api.probeHealthKey(k.id);
      await refetch();
      const verdict: Record<string, string> = {
        ok: 'يعمل', slow: 'يعمل (بطيء)', rate_limited: 'حصة/رصيد',
        provider_auth: 'المفتاح مرفوض', rejected: 'النموذج ميت (لا المفتاح)', no_key: 'بلا مفتاح'
      };
      setErr(`${k.provider}: ${verdict[r.status] || r.status}` +
        (r.error ? ` — ${r.error.slice(0, 90)}` : ` (${r.model})`));
    } catch (e: any) { setErr(e.message || 'فشل الفحص'); }
    finally { clear(k.id); }
  }

  const counts = data?.counts;
  const visible = useMemo(() => {
    const keys = data?.keys || [];
    if (filter === 'problem') return keys.filter(k => k.status === 'auth_error' || k.status === 'quota_exhausted');
    if (filter === 'ok') return keys.filter(k => k.status === 'ok');
    if (filter === 'unknown') return keys.filter(k => k.status === 'unknown');
    return keys;
  }, [data?.keys, filter]);

  if (isLoading) {
    return <div className="text-sm text-ink-dim py-8 text-center">جارٍ قراءة الحالة…</div>;
  }

  const problems = (counts?.auth_error || 0) + (counts?.quota_exhausted || 0);

  async function bulkDisableDead() {
    const dead = (data?.keys || []).filter(k => k.status === 'auth_error' && k.enabled);
    if (!dead.length) return;
    // تعطيل جماعي بلا تأكيد كان نقرة واحدة تُخرج مفاتيح كثيرة من التوجيه فوراً —
    // نفس منطق الحذف (الأقل خطراً) يطلب تأكيداً، فهذا أولى.
    setBulkDisableAsk(dead.length);
  }

  async function runBulkDisable() {
    setBulkDisableAsk(null);
    const dead = (data?.keys || []).filter(k => k.status === 'auth_error' && k.enabled);
    setBulk('disabling'); setErr(null);
    let done = 0;
    const failed: string[] = [];
    for (const k of dead) {
      try { await api.updateProviderKey(k.provider, k.id, { enabled: false }); done++; }
      catch { failed.push(`${k.provider}#${k.id}`); }
    }
    setBulk('');
    await refetch();
    setErr(failed.length
      ? `عُطّل ${done} · فشل ${failed.length}: ${failed.slice(0, 4).join(', ')}`
      : `عُطّل ${done} مفتاح ميت.`);
  }

  async function bulkTestUnknown() {
    const unknown = (data?.keys || []).filter(k => k.status === 'unknown' && k.enabled);
    if (!unknown.length) return;
    setBulk('testing'); setErr(null);
    const tally: Record<string, number> = {};
    let failed = 0;
    // نفحص كل مفتاح على حدة — الفحص على مستوى المفتاح لا المزود.
    // نعرض التقدم (i/N) داخل الزر: الفحص تسلسلي وكل مفتاح قد يأخذ ثوانٍ،
    // وبلا مؤشر بدت العملية معلقة والمستخدم يظن أنها لم تفحص شيئاً.
    for (let i = 0; i < unknown.length; i++) {
      const k = unknown[i];
      setBulk(`testing ${i + 1}/${unknown.length}`);
      mark(k.id, 'testing');
      try {
        const r = await api.probeHealthKey(k.id);
        tally[r.status] = (tally[r.status] || 0) + 1;
      } catch { failed++; }
      clear(k.id);
    }
    setBulk('');
    await refetch();
    const parts = Object.entries(tally).map(([s, n]) => `${s}=${n}`).join(' · ');
    setErr(`فُحص ${unknown.length} مفتاح → ${parts || 'لا نتائج'}${failed ? ` · فشل ${failed}` : ''}`);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="إجمالي المفاتيح" value={counts?.total ?? 0}
          meta={`${counts?.enabled ?? 0} مفعّل`} icon={KeyRound} />
        <StatCard label="ميت" value={counts?.auth_error ?? 0}
          meta="مرفوض من المزود" icon={ShieldAlert} accent={counts?.auth_error ? 'error' : 'accent'} />
        <StatCard label="رصيد/حصة فارغ" value={counts?.quota_exhausted ?? 0}
          meta="ينتظر الشحن" icon={AlertTriangle} accent={counts?.quota_exhausted ? 'warning' : 'accent'} />
        <StatCard label="يعمل" value={counts?.ok ?? 0}
          meta={`${counts?.unknown ?? 0} لم يُختبر`} icon={CheckCircle2} accent="success" />
      </div>

      {/* الشريط يظهر للمشاكل **أو** للمفاتيح غير المختبرة — كان شرطه `problems>0`
          فقط، فلا وسيلة جماعية لفحص «مجهولة» إن لم يوجد ميت/منتهٍ معها. */}
      {(problems > 0 || (counts?.unknown ?? 0) > 0) && (
        <div className={cn('glass rounded-xl px-4 py-3 border-l-4 flex flex-wrap items-center gap-3',
          problems > 0 ? 'border-l-bad' : 'border-l-warn')}>
          <Info className={cn('w-4 h-4 mt-0.5 shrink-0', problems > 0 ? 'text-bad' : 'text-warn')} />
          <div className="text-xs text-ink-dim leading-relaxed flex-1 min-w-[220px]">
            {problems > 0 ? (
              <>
                <span className="text-bad font-semibold">{problems} مفتاح يحتاج تدخّلك.</span>{' '}
                {counts?.auth_error ? `${counts.auth_error} ميتة` : ''}
                {counts?.auth_error && counts?.quota_exhausted ? ' · ' : ''}
                {counts?.quota_exhausted ? `${counts.quota_exhausted} رصيد فارغ` : ''}
                {counts?.unknown ? ` · ${counts.unknown} لم يُختبر` : ''}
              </>
            ) : (
              <span className="text-warn font-semibold">{counts?.unknown} مفتاح لم يُختبر بعد — افحصها لتعرف حقيقتها.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!!counts?.auth_error && (
              <button onClick={bulkDisableDead} disabled={!!bulk}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-panel text-ink-dim hover:text-ink disabled:opacity-50">
                {bulk === 'disabling' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Power className="w-3 h-3" />}
                عطّل {counts.auth_error} ميتة
              </button>
            )}
            {!!counts?.unknown && (
              <button onClick={bulkTestUnknown} disabled={!!bulk}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-panel text-ink-dim hover:text-ink disabled:opacity-50">
                {bulk.startsWith('testing') ? (
                  <><RefreshCw className="w-3 h-3 animate-spin" /> يفحص {bulk.slice(8)}…</>
                ) : (
                  <><PlayCircle className="w-3 h-3" /> افحص {counts.unknown} مجهولة</>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {err && (
        <div className="glass rounded-xl px-4 py-2.5 border-l-4 border-l-primary-2 flex items-center gap-2.5">
          <span className="text-xs text-ink-dim flex-1">{err}</span>
          <button onClick={() => setErr(null)} className="text-ink-muted hover:text-ink">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {([['all', 'الكل'], ['problem', 'يحتاج تدخّل'], ['ok', 'يعمل'], ['unknown', 'لم يُختبر']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)}
            className={cn('px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              filter === id ? 'bg-primary text-white' : 'bg-panel text-ink-dim hover:text-ink')}>
            {label}
          </button>
        ))}
        <button onClick={() => refetch()} disabled={isFetching}
          className="mr-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-panel text-ink-dim hover:text-ink disabled:opacity-50">
          <RefreshCw className={cn('w-3 h-3', isFetching && 'animate-spin')} />
          تحديث
        </button>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-ink-muted">
              <tr className="border-b border-line">
                <th className="text-right font-semibold px-3 py-2.5">الحالة</th>
                <th className="text-right font-semibold px-3 py-2.5">المزود</th>
                <th className="text-right font-semibold px-3 py-2.5">المفتاح</th>
                <th className="text-right font-semibold px-3 py-2.5" title="نتائج فحص نماذج المزود (فحص حقيقي لكل نموذج) — تُجمَّع على مستوى المزود فتظهر نفسها على كل مفاتيحه. فحص مفتاح بعينه: زر ► في صفه.">
                  نماذج المزود
                </th>
                <th className="text-right font-semibold px-3 py-2.5">طلبات</th>
                <th className="text-right font-semibold px-3 py-2.5">آخر استخدام</th>
                <th className="text-right font-semibold px-3 py-2.5">آخر خطأ</th>
                <th className="text-right font-semibold px-3 py-2.5">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-dim">لا مفاتيح في هذا التصنيف</td></tr>
              )}
              {visible.map((k: HealthKey) => {
                const meta = STATUS_META[k.status] || STATUS_META.unknown;
                const Icon = meta.icon;
                return (
                  <tr key={k.id} className="border-b border-line/50 last:border-0 hover:bg-panel/50">
                    <td className="px-3 py-2.5">
                      <span className={cn('badge', meta.cls)} title={meta.hint}>
                        <Icon className="w-3 h-3 mr-1" />{meta.label}
                      </span>
                      {!k.enabled && <span className="badge mr-1">معطّل</span>}
                      {okUnproven(k) && (
                        <span
                          className="badge badge-warning mr-1"
                          title="غير مؤكَّد: آخر استخدام حقيقي قديم أو معدوم — الحالة من فحص سابق. اضغط زر الفحص للتأكيد الآن."
                        >
                          غير مؤكَّد
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-ink">{k.provider}</td>
                    <td className="px-3 py-2.5 font-mono text-ink-dim">
                      {k.masked}
                      {k.statusInferred && (
                        <span className="badge badge-warning mr-1" title={`الحالة المخزّنة: ${k.storedStatus} — استُنتجت من نص الخطأ`}>
                          مستنتجة
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-ink">
                      {k.modelsOk}
                      {k.modelsTotal > 0 && <span className="text-ink-muted"> / {k.modelsTotal}</span>}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-ink">{formatNumber(k.requests)}</td>
                    <td className="px-3 py-2.5 text-ink-muted">{timeAgo(k.lastUsed)}</td>
                    <td className="px-3 py-2.5 text-ink-dim max-w-[280px] truncate" title={k.lastError || ''}>
                      {k.lastError || '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1 justify-end">
                        {busy[k.id] && <RefreshCw className="w-3 h-3 animate-spin text-ink-muted" />}
                        {!busy[k.id] && (
                          <>
                            {/* رصيد/حصة أو لم يُختبر أو "يعمل" غير المؤكَّد → افحص ليعرف النظام الحقيقة */}
                            {(k.status === 'quota_exhausted' || k.status === 'unknown' || okUnproven(k)) && k.enabled && (
                              <button onClick={() => retest(k)} title="فحص هذا المزود بمفتاح حقيقي"
                                className="p-1 rounded hover:bg-panel text-ink-muted hover:text-ink">
                                <PlayCircle className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {/* ميت → استبدله بمفتاح جديد */}
                            {k.status === 'auth_error' && (
                              <button onClick={() => { setReplacing(k); setNewKeyValue(''); setErr(null); }}
                                title="استبدال بمفتاح جديد"
                                className="p-1 rounded hover:bg-panel text-ink-muted hover:text-ink">
                                <KeyRound className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {/* تعطيل/تفعيل — متاح دائماً */}
                            <button onClick={() => setEnabled(k, !k.enabled)}
                              title={k.enabled ? 'تعطيل — أخرجه من التوجيه' : 'تفعيل — أعده للتوجيه'}
                              className="p-1 rounded hover:bg-panel text-ink-muted hover:text-ink">
                              <Power className={cn('w-3.5 h-3.5', !k.enabled && 'text-warn')} />
                            </button>
                            <button onClick={() => setConfirm({ keys: [k], label: `${k.provider} · ${k.masked}` })}
                              title="حذف نهائي"
                              className="p-1 rounded hover:bg-panel text-ink-muted hover:text-bad">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {data && (
        <div className="text-[10px] text-ink-muted text-center">
          حُدّث {timeAgo(data.generatedAt)} · يتحدّث كل 10 ثوانٍ تلقائياً
        </div>
      )}

      {/* تأكيد التعطيل الجماعي */}
      {bulkDisableAsk !== null && (
        <ConfirmDialog
          title={`تعطيل ${bulkDisableAsk} مفتاحاً ميتاً؟`}
          message="تُخرج من التوجيه فوراً، ويمكنك إعادة تفعيل أي منها لاحقاً."
          confirmLabel="عطّل المفاتيح الميتة"
          onCancel={() => setBulkDisableAsk(null)}
          onConfirm={runBulkDisable}
        />
      )}

      {/* استبدال مفتاح ميت — الحقل يبقى في الذاكرة ولا يُكتب في التخزين */}
      {replacing && (
        <Modal
          title="استبدال مفتاح ميت"
          onClose={() => { setReplacing(null); setNewKeyValue(''); }}
          footer={
            <>
              <button type="button" onClick={() => { setReplacing(null); setNewKeyValue(''); }} className="btn btn-sm">
                إلغاء
              </button>
              <button type="button" onClick={replaceKey} disabled={!newKeyValue.trim() || !!busy[replacing.id]} className="btn btn-sm btn-primary">
                استبدال
              </button>
            </>
          }
        >
          <p className="text-xs text-ink-dim mb-3">
            {replacing.provider} · {replacing.masked}
          </p>
          <input
            type="password"
            value={newKeyValue}
            onChange={e => setNewKeyValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') replaceKey(); }}
            placeholder="الصق المفتاح الجديد"
            className="input"
          />
          <p className="text-[11px] text-ink-muted mt-2">
            يُخزَّن مشفّراً، وتُصفَّر حالته إلى «لم يُختبر» ليعيد الفحص.
          </p>
        </Modal>
      )}

      {/* تأكيد الحذف — لا رجعة فيه */}
      {confirm && (
        <ConfirmDialog
          title={`حذف ${confirm.keys.length} مفتاح نهائياً؟`}
          message={confirm.keys.length === 1 ? confirm.label : confirm.keys.map(k => `${k.provider}#${k.id}`).join('، ')}
          detail="لا يمكن التراجع. إن كان الخطأ من المفتاح فالحل أسهل: عطّله بدل حذفه."
          confirmLabel={`احذف ${confirm.keys.length}`}
          danger
          busy={confirm.keys.some(k => busy[k.id])}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            for (const k of confirm.keys) { mark(k.id, 'deleting'); await removeKey(k); }
          }}
        />
      )}
    </div>
  );
}
