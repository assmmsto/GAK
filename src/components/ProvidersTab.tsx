// src/components/ProvidersTab.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, Trash2, Power, PowerOff, Loader2, Server, Globe, Key, Layers, KeyRound, Pencil, ClipboardPaste, KeySquare } from 'lucide-react';
import { api, type Provider } from '../lib/api';
import { StatusDot, TierBadge } from './ui';
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
      onToast(`${id}: ${r.ok ? `✓ ${r.latencyMs}ms` : '✗ ' + (r.error || 'failed')}`, r.ok ? 'success' : 'error');
      qc.invalidateQueries({ queryKey: ['providers'] });
    } catch (e: any) { onToast(e.message, 'error'); }
    finally { setTesting(null); }
  };

  const testAll = async () => {
    onToast('Testing all providers…', 'info');
    try {
      const r = await api.testAll();
      const up = r.results.filter(x => x.ok).length;
      onToast(`${up}/${r.results.length} providers up`, up > 0 ? 'success' : 'error');
      qc.invalidateQueries({ queryKey: ['providers'] });
    } catch (e: any) { onToast(e.message, 'error'); }
  };

  const remove = async (id: string) => {
    if (!confirm(`Delete "${id}"?\n\nThis removes it from providers.yaml and .env.`)) return;
    try {
      await api.deleteProvider(id);
      onToast(`Deleted ${id}`, 'success');
      qc.invalidateQueries({ queryKey: ['providers'] });
    } catch (e: any) { onToast(e.message, 'error'); }
  };

  const toggle = async (id: string, currentlyEnabled: boolean) => {
    try {
      await api.toggleProvider(id, !currentlyEnabled);
      onToast(`${id} ${currentlyEnabled ? 'disabled' : 'enabled'}`, 'success');
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    } catch (e: any) { onToast(e.message, 'error'); }
  };

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
            Providers
            <span className="badge">{providers.length}</span>
            <span className="badge badge-success">{enabledCount} active</span>
          </h2>
          <p className="text-xs text-ink-dim mt-0.5">Add OpenAI-compatible endpoints and route through them</p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={testAll}>
            <Layers className="w-3.5 h-3.5" /> Test All
          </button>
          <button className="btn" onClick={() => setShowImport(true)} title="الصق عدة مفاتيح مرة واحدة">
            <ClipboardPaste className="w-3.5 h-3.5" /> استيراد جماعي
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus className="w-4 h-4" /> Add Provider
          </button>
        </div>
      </div>

      {providers.length === 0 ? (
        <div className="card text-center py-12 border-dashed">
          <div className="inline-flex p-3 rounded-2xl bg-primary/10 mb-3">
            <Server className="w-8 h-8 text-primary" />
          </div>
          <h3 className="text-base font-semibold mb-1">No providers yet</h3>
          <p className="text-sm text-ink-muted mb-4">Add your first AI provider to start routing requests</p>
          <button onClick={() => setShowAdd(true)} className="btn btn-primary">
            <Plus className="w-4 h-4" /> Add Provider
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
          onToast(editTarget ? 'Provider updated' : 'Provider added successfully', 'success');
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
            {p.free && <span className="badge badge-success">free</span>}
            {!isEnabled && <span className="badge badge-warning">disabled</span>}
          </div>
          <code className="text-[10px] text-ink-dim font-mono">{p.id}</code>
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
            {p.hasKey ? 'authenticated' : p.keyless ? 'keyless' : 'no API key'}
          </span>
          <span className="text-ink-dim">·</span>
          <span className="text-ink-muted">{p.lastChecked ? timeAgo(p.lastChecked) : 'untested'}</span>
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
        <button className="btn btn-sm" onClick={onTest} disabled={testing}>
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Test'}
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
          data-tooltip={isEnabled ? 'Disable' : 'Enable'}
          title={isEnabled ? 'Disable — exclude from routing' : 'Enable — include in routing'}
        >
          {isEnabled ? <PowerOff className="w-3 h-3 text-warn" /> : <Power className="w-3 h-3 text-ok" />}
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={onEdit}
          data-tooltip="Edit"
          title="Edit (key/URL/tier)"
        >
          <Pencil className="w-3 h-3" />
        </button>
        {p.signupUrl ? (
          <a
            href={p.signupUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm btn-ghost"
            data-tooltip="Get API key"
            title="Get API key"
          >
            <KeyRound className="w-3 h-3" />
          </a>
        ) : (
          <span className="btn btn-sm btn-ghost opacity-30" title="No signup URL">
            <KeyRound className="w-3 h-3" />
          </span>
        )}
        <button className="btn btn-sm btn-danger" onClick={onDelete} data-tooltip="Delete" aria-label={`Delete ${p.id}`} title="Delete">
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}