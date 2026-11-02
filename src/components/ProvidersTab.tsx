// src/components/ProvidersTab.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, Trash2, Power, PowerOff, Loader2, Server, Globe, Key, Layers, KeyRound, Pencil, ClipboardPaste, KeySquare } from 'lucide-react';
import { api, type Provider } from '../lib/api';
import { StatusDot, TierBadge, ConfirmDialog } from './ui';
import { AddProviderModal } from './AddProviderModal';
import { KeysModal } from './KeysModal';
import { ImportModal } from './ImportModal';
import { timeAgo, cn } from '../lib/utils';

export function ProvidersTab({ onToast }: { onToast: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['providers'], queryFn: () => api.providers() });
  const [testing, setTesting] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const test = async (id: string) => {
    setTesting(id);
    try {
      const r = await api.test(id);
      onToast(`${id}: ${r.ok ? `✓ ${r.latencyMs} م.ث` : '✗ ' + (r.error || 'فشل')}`, r.ok ? 'success' : 'error');
      qc.invalidateQueries({ queryKey: ['providers'] });
    } catch (e: any) { onToast(e.message, 'error'); }
    finally { setTesting(null); }
  };

  const testAll = async () => {
    onToast('جارٍ فحص كل المزوّدين…', 'info');
    try {
      const r = await api.testAll();
      const up = r.results.filter(x => x.ok).length;
      onToast(`${up}/${r.results.length} مزوّد متاح`, up > 0 ? 'success' : 'error');
      qc.invalidateQueries({ queryKey: ['providers'] });
    } catch (e: any) { onToast(e.message, 'error'); }
  };

  const remove = async (id: string) => {
    setAskDelete(id);
  };

  const runRemove = async (id: string) => {
    // S12: الرسالة كانت تقول إن المفاتيح تُحذف بينما هي تبقى في القاعدة (بلا حذف).
    // الآن تقول الحقيقة: الحذف النهائي للمفاتيح يتطلّب طلباً صريحاً `?purgeKeys=1`.
    setAskDelete(null);
    try {
      await api.deleteProvider(id);
      onToast(`حُذف ${id} — المفاتيح باقية في القاعدة`, 'success');
      qc.invalidateQueries({ queryKey: ['providers'] });
    } catch (e: any) { onToast(e.message, 'error'); }
  };

  const toggle = async (id: string, currentlyEnabled: boolean) => {
    try {
      await api.toggleProvider(id, !currentlyEnabled);
      onToast(`${id} ${currentlyEnabled ? 'عُطّل' : 'فُعّل'}`, 'success');
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    } catch (e: any) { onToast(e.message, 'error'); }
  };

  const [askDelete, setAskDelete] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<{ id: string; name: string; baseUrl: string; tier: number; hasKey: boolean } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [keysFor, setKeysFor] = useState<Provider | null>(null);
  const openEdit = (p: Provider) => {
    setEditTarget({ id: p.id, name: p.name, baseUrl: p.baseUrl, tier: p.tier, hasKey: p.hasKey });
    setShowAdd(true);
  };
  const closeModal = () => { setShowAdd(false); setEditTarget(null); };

  if (isLoading) return (
    <div className="flex items-center justify-center py-12">
      <div className="spinner" />
    </div>
  );

  const providers = data?.providers || [];
  const enabledCount = providers.filter(p => p.enabled !== false).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Server className="w-5 h-5 text-primary-2" />
            المزوّدون
            <span className="badge">{providers.length}</span>
            <span className="badge badge-success">{enabledCount} مُفعّل</span>
          </h2>
          <p className="text-xs text-ink-dim mt-0.5">أضف نقاط نهاية متوافقة مع OpenAI ووجّه الطلبات عبرها</p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={testAll}>
            <Layers className="w-3.5 h-3.5" /> افحص الكل
          </button>
          <button className="btn" onClick={() => setShowImport(true)} title="الصق عدة مفاتيح مرة واحدة">
            <ClipboardPaste className="w-3.5 h-3.5" /> استيراد جماعي
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus className="w-4 h-4" /> أضف مزوّداً
          </button>
        </div>
      </div>

      {providers.length === 0 ? (
        <div className="card text-center py-12 border-dashed">
          <div className="inline-flex p-3 rounded-2xl bg-primary/10 mb-3">
            <Server className="w-8 h-8 text-primary" />
          </div>
          <h3 className="text-base font-semibold mb-1">لا مزوّدين بعد</h3>
          <p className="text-sm text-ink-muted mb-4">أضف أول مزوّد ذكاء اصطناعي لتبدأ توجيه الطلبات</p>
          <button onClick={() => setShowAdd(true)} className="btn btn-primary">
            <Plus className="w-4 h-4" /> أضف مزوّداً
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {providers.map(p => (
            <ProviderCard
              key={p.id} provider={p}
              onTest={() => test(p.id)} testing={testing === p.id}
              onDelete={() => remove(p.id)}
              onToggle={() => toggle(p.id, p.enabled !== false)}
              onEdit={() => openEdit(p)}
              onKeys={() => setKeysFor(p)}
            />
          ))}
        </div>
      )}

      <AddProviderModal
        open={showAdd}
        onClose={closeModal}
        onAdded={async () => {
          await qc.refetchQueries({ queryKey: ['providers'] });
          onToast(editTarget ? 'حُدّث المزوّد' : 'أُضيف المزوّد بنجاح', 'success');
          setEditTarget(null);
          closeModal();
        }}
        editTarget={editTarget}
      />

      {showImport && <ImportModal onClose={() => setShowImport(false)} onToast={onToast} />}
      {keysFor && (
        <KeysModal
          providerId={keysFor.id}
          providerName={keysFor.name}
          onClose={() => setKeysFor(null)}
          onToast={onToast}
        />
      )}
      {askDelete && (
        <ConfirmDialog
          title={`حذف "${askDelete}"؟`}
          message="يُحذف من providers.yaml ويُفرَّغ سطر متغيّر البيئة."
          detail="مفاتيحه تبقى محفوظة في قاعدة البيانات (تُستعاد لو أعدت إضافة المزوّد)."
          confirmLabel="احذف المزوّد"
          danger
          onCancel={() => setAskDelete(null)}
          onConfirm={() => runRemove(askDelete)}
        />
      )}
    </div>
  );
}

function ProviderCard({ provider: p, onTest, testing, onDelete, onToggle, onEdit, onKeys }: {
  provider: Provider; onTest: () => void; testing: boolean;
  onDelete: () => void; onToggle: () => void; onEdit: () => void; onKeys: () => void;
}) {
  const isEnabled = p.enabled !== false;
  const isDown = !isEnabled || p.status === 'down';
  const keyCount = p.keys?.total || 0;
  const keyAvailable = p.keys?.available ?? 0;
  return (
    <div className={cn('card group', isDown && 'opacity-70')}>
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <StatusDot status={p.status} />
            <h3 className="font-semibold text-ink truncate">{p.name}</h3>
            {p.free && <span className="badge badge-success">مجاني</span>}
            {!isEnabled && <span className="badge badge-warning">معطَّل</span>}
          </div>
          <code className="text-[11px] text-ink-dim font-mono" dir="ltr">{p.id}</code>
        </div>
        <TierBadge tier={p.tier} />
      </div>

      <div className="space-y-1.5 text-xs mb-3">
        <div className="flex items-center gap-2 text-ink-muted">
          <Globe className="w-3 h-3 shrink-0 text-ink-dim" />
          <code className="truncate flex-1" title={p.baseUrl}>{p.baseUrl}</code>
        </div>
        <div className="flex items-center gap-2">
          <Key className={cn('w-3 h-3 shrink-0', p.hasKey ? 'text-ok' : p.keyless ? 'text-primary-2' : 'text-warn')} />
          <span className={cn('font-medium', p.hasKey ? 'text-ok' : p.keyless ? 'text-primary-2' : 'text-warn')}>
            {p.hasKey ? 'موثَّق' : p.keyless ? 'بلا مفتاح' : 'لا يوجد مفتاح API'}
          </span>
          <span className="text-ink-dim">·</span>
          <span className="text-ink-muted">{p.lastChecked ? timeAgo(p.lastChecked) : 'لم يُفحص'}</span>
          {keyCount > 0 && (
            <>
              <span className="text-ink-dim">·</span>
              <span className={cn(keyAvailable > 0 ? 'text-ink-muted' : 'text-warn')}>
                {keyCount === 1 ? 'مفتاح واحد' : `${keyCount} مفاتيح`}
                {keyCount > 1 ? ` (${keyAvailable} متاح)` : ''}
              </span>
            </>
          )}
        </div>
      </div>

      {p.lastError && (
        <div className="text-xs text-bad bg-bad/10 border border-bad/20 rounded-md px-2 py-1.5 mb-3 truncate font-mono" title={p.lastError}>
          {p.lastError.slice(0, 80)}
        </div>
      )}

      <div className="grid grid-cols-6 gap-1.5 pt-3 border-t border-line/50">
        <button className="btn btn-sm" onClick={onTest} disabled={testing} title="افحص الاتصال بهذا المزوّد">
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : 'افحص'}
        </button>
        <button
          className="btn btn-sm"
          onClick={onKeys}
          title="إدارة المفاتيح — عدة مفاتيح لنفس المصدر = سعة أكبر مع تدوير تلقائي"
        >
          <KeySquare className="w-3 h-3" />
          {keyCount > 0 && <span className={cn('text-[10px] font-bold tabular-nums', keyAvailable === 0 && 'text-warn')}>{keyCount}</span>}
        </button>
        <button
          className={cn('btn btn-sm', !isEnabled && 'btn-ghost')}
          onClick={onToggle}
          data-tooltip={isEnabled ? 'تعطيل' : 'تفعيل'}
          title={isEnabled ? 'تعطيل — استبعاد من التوجيه' : 'تفعيل — تضمين في التوجيه'}
        >
          {isEnabled ? <PowerOff className="w-3 h-3 text-warn" /> : <Power className="w-3 h-3 text-ok" />}
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={onEdit}
          data-tooltip="تعديل"
          title="تعديل (المفتاح/العنوان/الفئة)"
        >
          <Pencil className="w-3 h-3" />
        </button>
        {p.signupUrl ? (
          <a
            href={p.signupUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm btn-ghost"
            data-tooltip="احصل على مفتاح"
            title="احصل على مفتاح API"
          >
            <KeyRound className="w-3 h-3" />
          </a>
        ) : (
          <span className="btn btn-sm btn-ghost opacity-30" title="لا يوجد رابط تسجيل">
            <KeyRound className="w-3 h-3" />
          </span>
        )}
        <button className="btn btn-sm btn-danger" onClick={onDelete} data-tooltip="حذف" aria-label={`احذف المزوّد ${p.id}`} title="احذف المزوّد">
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}