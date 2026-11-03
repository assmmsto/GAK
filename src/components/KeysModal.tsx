// src/components/KeysModal.tsx — إدارة مفاتيح مزود واحد (متعددة مع تدوير)
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, KeyRound, Plus, Trash2, RefreshCw, Power, AlertTriangle,
  CheckCircle2, Loader2, Clock, KeySquare
} from 'lucide-react';
import { api, type ProviderKeyInfo } from '../lib/api';
import { cn, PROVIDER_KEYS_LABEL } from '../lib/utils';
import { ConfirmDialog } from './ui';

const STATUS_META: Record<string, { label: string; cls: string; icon: any }> = {
  ok: { label: 'متاح', cls: 'badge-success', icon: CheckCircle2 },
  unknown: { label: 'لم يُختبر بعد', cls: 'badge', icon: Clock },
  quota_exhausted: { label: 'نفدت الحصة', cls: 'badge-warning', icon: AlertTriangle },
  auth_error: { label: 'مفتاح خاطئ', cls: 'badge-error', icon: X }
};

export function KeysModal({ providerId, providerName, onClose, onToast }: {
  providerId: string;
  providerName?: string;
  onClose: () => void;
  onToast?: (msg: string, type?: 'info' | 'success' | 'error') => void;
}) {
  const qc = useQueryClient();
  const [bulk, setBulk] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState<number | null>(null);
  const [replaceValue, setReplaceValue] = useState('');
  const [askDelete, setAskDelete] = useState<ProviderKeyInfo | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['provider-keys', providerId],
    queryFn: () => api.providerKeys(providerId),
    refetchInterval: 5000
  });
  const keys: ProviderKeyInfo[] = data?.keys || [];
  const summary = data?.summary;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['provider-keys', providerId] });
    qc.invalidateQueries({ queryKey: ['providers'] });
    qc.invalidateQueries({ queryKey: ['status'] });
  };

  const addKeys = async () => {
    const list = bulk.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!list.length) { onToast?.('الصق مفتاحاً واحداً على الأقل', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.addProviderKeys(providerId, list, label.trim() || undefined);
      // المكرّر لا يُضاف صفاً جديداً (يُعاد تفعيله) — نقول ذلك صراحةً بدل
      // «أُضيف 1» الكاذب حين يكون المفتاح موجوداً أصلاً.
      if (!r.added && r.duplicates) onToast?.(`المفتاح موجود مسبقاً — أُعيد تفعيله`, 'info');
      else if (r.duplicates) onToast?.(`أُضيف ${r.added} · ${r.duplicates} موجود مسبقاً`, 'success');
      else onToast?.(`أُضيف ${r.added} مفتاح إلى ${providerId}`, 'success');
      setBulk(''); setLabel('');
      refresh();
    } catch (e: any) { onToast?.(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const patch = async (keyId: number, body: any, msg: string) => {
    try {
      await api.updateProviderKey(providerId, keyId, body);
      onToast?.(msg, 'success');
      refresh();
    } catch (e: any) { onToast?.(e.message, 'error'); }
  };

  const remove = async (k: ProviderKeyInfo) => {
    setAskDelete(k);
  };

  const runRemove = async (k: ProviderKeyInfo) => {
    setAskDelete(null);
    try {
      await api.deleteProviderKey(providerId, k.id);
      onToast?.('حُذف المفتاح', 'success');
      refresh();
    } catch (e: any) { onToast?.(e.message, 'error'); }
  };

  const doReplace = async (k: ProviderKeyInfo) => {
    if (!replaceValue.trim()) return;
    await patch(k.id, { key: replaceValue.trim() }, 'استُبدل المفتاح وأُعيد تفعيله');
    setReplacing(null);
    setReplaceValue('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="card max-w-2xl w-full max-h-[90vh] overflow-y-auto p-0">
        <div className="sticky top-0 z-10 flex items-center justify-between p-5 border-b border-line bg-surface/95">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-primary" />
              {PROVIDER_KEYS_LABEL}: <code className="font-mono text-sm">{providerName || providerId}</code>
            </h2>
            <p className="text-xs text-ink-dim mt-0.5">
              عدة مفاتيح لنفس المصدر = سعة أكبر. عند نفاد حصة مفتاح ينتقل النظام للتالي تلقائياً.
            </p>
            <p className="text-[11px] text-ink-muted mt-1">
              هذه مفاتيح تُصادِق هذه البوابة مع المزوّد — لا تُشارَك مع أدواتك، ولا علاقة لها بمفاتيح GAK.
            </p>
          </div>
          <button onClick={onClose} className="btn btn-sm btn-ghost p-1.5 text-ink-muted hover:text-ink" aria-label="إغلاق">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* الملخّص */}
          {summary && (
            <div className="grid grid-cols-4 gap-2">
              {[
                { l: 'الإجمالي', v: summary.total, c: 'text-ink' },
                { l: 'متاحة', v: summary.available, c: 'text-ok' },
                { l: 'نفدت حصتها', v: summary.exhausted, c: 'text-warn' },
                { l: 'خاطئة', v: summary.invalid, c: 'text-bad' }
              ].map(s => (
                <div key={s.l} className="bg-surface-2 rounded-lg py-2 text-center border border-line">
                  <div className={cn('text-xl font-bold tabular-nums', s.c)}>{s.v}</div>
                  <div className="text-[11px] text-ink-dim">{s.l}</div>
                </div>
              ))}
            </div>
          )}

          {/* القائمة */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-muted font-semibold mb-2">
              المفاتيح المحفوظة {isLoading && <Loader2 className="w-3 h-3 inline animate-spin" />}
            </div>
            {keys.length === 0 ? (
              <div className="text-sm text-ink-dim italic border border-dashed border-line rounded-lg p-4 text-center">
                لا مفاتيح بعد — الصق مفتاحاً بالأسفل
              </div>
            ) : (
              <div className="space-y-1.5">
                {keys.map(k => {
                  const meta = STATUS_META[k.status] || STATUS_META.unknown;
                  const Icon = meta.icon;
                  const disabled = !k.enabled;
                  return (
                    <div key={k.id} className={cn('rounded-lg border border-line bg-surface-2 p-2.5', disabled && 'opacity-60')}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Icon className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                        <span className="text-xs font-medium truncate max-w-[130px]" title={k.label}>{k.label}</span>
                        <code className="text-[11px] font-mono text-ink-dim">{k.masked}</code>
                        <span className={cn('badge', meta.cls)}>{meta.label}</span>
                        {disabled && <span className="badge">معطّل</span>}
                        {k.requests > 0 && <span className="text-[10px] text-ink-dim tabular-nums">{k.requests} طلب</span>}

                        <div className="flex items-center gap-1 mr-auto">
                          {k.status === 'quota_exhausted' && (
                            <button className="btn btn-sm" onClick={() => patch(k.id, { reactivate: true }, 'أُعيد تفعيل المفتاح')}
                              title="قد تكون الحصة تجددت — أعد تفعيله">
                              <RefreshCw className="w-3 h-3" /> إعادة تفعيل
                            </button>
                          )}
                          <button className="btn btn-sm" onClick={() => { setReplacing(replacing === k.id ? null : k.id); setReplaceValue(''); }}
                            title="استبدال قيمة المفتاح (للمفتاح المنتهي)">
                            <KeySquare className="w-3 h-3" /> استبدال
                          </button>
                          <button className="btn btn-sm" onClick={() => patch(k.id, { enabled: !k.enabled }, k.enabled ? 'عُطّل المفتاح' : 'فُعّل المفتاح')}
                            title={k.enabled ? 'تعطيل مؤقت' : 'تفعيل'}>
                            <Power className={cn('w-3 h-3', k.enabled ? 'text-warn' : 'text-ok')} />
                          </button>
                          <button className="btn btn-sm btn-danger" onClick={() => remove(k)} title="حذف نهائي">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {replacing === k.id && (
                        <div className="flex gap-1.5 mt-2">
                          <input
                            className="input font-mono flex-1 !py-1"
                            placeholder="الصق المفتاح الجديد…"
                            value={replaceValue}
                            onChange={e => setReplaceValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') doReplace(k); }}
                            autoFocus
                          />
                          <button className="btn btn-sm btn-primary" onClick={() => doReplace(k)} disabled={!replaceValue.trim()}>
                            حفظ
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* الإضافة */}
          <div className="border-t border-line/60 pt-4">
            <div className="text-[11px] uppercase tracking-wider text-ink-muted font-semibold mb-2">
              إضافة مفاتيح (مفتاح لكل سطر — يمكن لصق عدة مفاتيح مرة واحدة)
            </div>
            <textarea
              className="input font-mono !py-2"
              rows={4}
              placeholder={'AIza…\nAIza…\nAIza…'}
              value={bulk}
              onChange={e => setBulk(e.target.value)}
            />
            <div className="flex gap-2 mt-2">
              <input
                className="input !py-1.5 flex-1"
                placeholder="تسمية اختيارية (مثال: حساب 1)"
                value={label}
                onChange={e => setLabel(e.target.value)}
              />
              <button className="btn btn-primary" onClick={addKeys} disabled={busy || !bulk.trim()}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                إضافة {bulk.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length || ''}
              </button>
            </div>
            <p className="text-[11px] text-ink-dim mt-2">
              المفاتيح تُخزَّن في قاعدة البيانات محلياً ولا تُكتب في ملفات الإعداد.
            </p>
          </div>
        </div>
      </div>

      {askDelete && (
        <ConfirmDialog
          title={`حذف مفتاح المزوّد "${askDelete.label}"؟`}
          message="لا يمكن التراجع."
          detail={`مفتاح مزوّد واحد يُحذف نهائياً — لا يتأثر مزوّد آخر ولا مفاتيح العملاء. زر «تعطيل» يوقف استعماله بلا فقدانه.`}
          confirmLabel="حذف نهائي"
          danger
          onCancel={() => setAskDelete(null)}
          onConfirm={() => runRemove(askDelete)}
        />
      )}
    </div>
  );
}
