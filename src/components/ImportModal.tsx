// src/components/ImportModal.tsx — استيراد جماعي: الصق كل مفاتيحك مرة واحدة
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  X, ClipboardPaste, Loader2, CheckCircle2, AlertTriangle, HelpCircle, Play, FileDown
} from 'lucide-react';
import { api, type ImportResult } from '../lib/api';
import { cn } from '../lib/utils';

const STATUS_META: Record<string, { label: string; cls: string; icon: any }> = {
  ok: { label: 'استُورد', cls: 'badge-success', icon: CheckCircle2 },
  ready: { label: 'جاهز', cls: 'badge-success', icon: CheckCircle2 },
  'provider-added': { label: 'أُضيف المزود', cls: 'badge-primary', icon: CheckCircle2 },
  'needs-provider': { label: 'مزوّد غير معروف', cls: 'badge-warning', icon: HelpCircle },
  'needs-url': { label: 'يحتاج رابطاً', cls: 'badge-warning', icon: AlertTriangle },
  error: { label: 'خطأ', cls: 'badge-error', icon: X },
  skipped: { label: 'تُجوهل', cls: 'badge', icon: HelpCircle }
};

export function ImportModal({ onClose, onToast }: {
  onClose: () => void;
  onToast?: (msg: string, type?: 'info' | 'success' | 'error') => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);

  const lineCount = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).length;

  const run = async (dryRun: boolean) => {
    if (!text.trim()) { onToast?.('الصق المفاتيح أولاً', 'error'); return; }
    setBusy(dryRun ? 'preview' : 'import');
    try {
      const r = await api.importProviders(text, dryRun);
      setPreview(r);
      if (!dryRun) {
        qc.invalidateQueries({ queryKey: ['providers'] });
        qc.invalidateQueries({ queryKey: ['status'] });
        onToast?.(`استُورد ${r.imported} من ${r.total}`, r.imported > 0 ? 'success' : 'error');
      }
    } catch (e: any) {
      onToast?.(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="card max-w-3xl w-full max-h-[90vh] overflow-y-auto p-0">
        <div className="sticky top-0 z-10 flex items-center justify-between p-5 border-b border-line bg-surface/95">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <ClipboardPaste className="w-5 h-5 text-primary" />
              استيراد جماعي
            </h2>
            <p className="text-xs text-ink-dim mt-0.5">
              الصق مفاتيحك مرة واحدة — النظام يتعرّف على المزوّد من شكل المفتاح ويكتب كل شيء بخطوة واحدة.
            </p>
          </div>
          <button onClick={onClose} className="btn btn-sm btn-ghost p-1.5 text-ink-muted hover:text-ink" aria-label="إغلاق">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-ink-muted font-semibold mb-1.5 block">
              المفاتيح — مفتاح لكل سطر
            </label>
            <textarea
              className="input font-mono !py-2"
              rows={8}
              value={text}
              onChange={e => { setText(e.target.value); setPreview(null); }}
              placeholder={
                'AIzaSy…            ← مفتاح وحده (يتعرّف على المزوّد من البادئة)\n' +
                'groq=gsk_…          ← مزود=مفتاح (للمفاتيح الغامضة)\n' +
                'openrouter: sk-or-… ← مزود: مفتاح\n' +
                '{"provider":"deepseek","key":"sk-…"}'
              }
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[11px] text-ink-dim">
                {lineCount > 0 ? `${lineCount} سطر للاستيراد` : 'الأسطر الفارغة والتي تبدأ بـ # تُتجاهل'}
              </span>
              <span className="text-[11px] text-ink-dim">
                المفاتيح الغامضة (مثل <code className="font-mono">sk-</code>) تحتاج تحديد المزوّد
              </span>
            </div>
          </div>

          <div className="flex gap-2">
            <button className="btn flex-1" onClick={() => run(true)} disabled={!!busy || !lineCount}>
              {busy === 'preview' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
              معاينة (بلا كتابة)
            </button>
            <button className="btn btn-primary flex-1" onClick={() => run(false)} disabled={!!busy || !lineCount}>
              {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              استيراد الآن
            </button>
          </div>

          {preview && (
            <div>
              <div className="flex items-center gap-3 mb-2 text-sm">
                <span className="font-semibold">
                  {preview.dryRun ? 'معاينة' : 'النتيجة'}:
                </span>
                <span className="badge badge-success">{preview.imported || preview.total - preview.needsAttention} جاهز</span>
                {preview.needsAttention > 0 && <span className="badge badge-warning">{preview.needsAttention} يحتاج انتباهاً</span>}
                <span className="text-ink-dim text-xs">من {preview.total}</span>
              </div>
              <div className="border border-line rounded-lg overflow-hidden max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-surface-2 sticky top-0">
                    <tr className="text-ink-muted text-[11px]">
                      <th className="text-right font-semibold px-3 py-2">السطر</th>
                      <th className="text-right font-semibold px-3 py-2 w-28">المزوّد</th>
                      <th className="text-right font-semibold px-3 py-2 w-32">الحالة</th>
                      <th className="text-right font-semibold px-3 py-2">ملاحظة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.results.map((r, i) => {
                      const meta = STATUS_META[r.status] || STATUS_META.error;
                      const Icon = meta.icon;
                      const shown = r.raw.length > 34 ? r.raw.slice(0, 14) + '…' + r.raw.slice(-8) : r.raw;
                      return (
                        <tr key={i} className="border-t border-line/40">
                          <td className="px-3 py-1.5 font-mono text-[11px] text-ink-dim truncate max-w-[180px]" title={r.raw}>{shown}</td>
                          <td className="px-3 py-1.5 font-mono text-[11px]">{r.provider || '—'}</td>
                          <td className="px-3 py-1.5">
                            <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold', meta.cls)}>
                              <Icon className="w-3 h-3" /> {meta.label}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-ink-dim truncate max-w-[220px]" title={r.reason}>{r.reason || ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {preview.results.some(r => r.status === 'needs-provider') && (
                <p className="text-[11px] text-warn mt-2">
                  الأسطر «مزوّد غير معروف»: اكتبها بصيغة <code className="font-mono">المزوّد=المفتاح</code> ثم أعد المحاولة.
                </p>
              )}
              {preview.results.some(r => r.status === 'needs-url') && (
                <p className="text-[11px] text-warn mt-1">
                  الأسطر «يحتاج رابطاً»: مزود غير موجود في الكتالوج — أضفه من نافذة «إضافة مزود» برابطه أولاً.
                </p>
              )}
            </div>
          )}

          <div className="border-t border-line/60 pt-3">
            <p className="text-[11px] text-ink-dim leading-relaxed">
              بعد الاستيراد: المفاتيح تُخزَّن محلياً، والمزودون يُفعَّلون تلقائياً.
              استخدم تبويب <b className="text-ink-muted">فرز النماذج</b> لفحص ما يعمل فعلاً.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
