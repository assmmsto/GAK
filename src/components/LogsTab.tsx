// src/components/LogsTab.tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Zap, Filter } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';

const FILTERS = [
  { v: 'all', l: 'All', cls: 'bg-ink-dim' },
  { v: 'chat.success', l: 'Success', cls: 'bg-ok' },
  { v: 'chat.error', l: 'Errors', cls: 'bg-bad' },
  { v: 'health.ok', l: 'Health OK', cls: 'bg-primary-2' },
  { v: 'health.fail', l: 'Health Fail', cls: 'bg-warn' },
  { v: 'provider.added', l: 'Provider', cls: 'bg-primary' },
];

export function LogsTab() {
  const { data, isLoading } = useQuery({ queryKey: ['logs'], queryFn: () => api.logs(300), refetchInterval: 5000 });
  const [filter, setFilter] = useState('all');

  if (isLoading) return (
    <div className="flex items-center justify-center py-12">
      <div className="spinner" />
    </div>
  );

  const all = data?.events || [];
  const filtered = filter === 'all' ? all : all.filter(e => e.type === filter);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" /> Logs
            <span className="badge">{filtered.length}</span>
            <span className="badge-primary badge">live</span>
          </h2>
          <p className="text-xs text-ink-dim mt-0.5">Real-time event stream · auto-refreshes every 5s</p>
        </div>
      </div>

      {/* Filters */}
      <div className="card !p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-ink-muted" />
          {FILTERS.map(f => {
            const count = f.v === 'all' ? all.length : all.filter(e => e.type === f.v).length;
            return (
              <button
                key={f.v}
                className={cn(
                  'px-3 py-1.5 text-xs rounded-lg transition-all flex items-center gap-1.5',
                  filter === f.v
                    ? 'bg-primary text-white font-semibold '
                    : 'bg-surface-2 text-ink-muted hover:text-ink hover:bg-surface'
                )}
                onClick={() => setFilter(f.v)}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full', f.cls)} />
                {f.l}
                {count > 0 && <span className="text-[10px] opacity-70">({count})</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Events list */}
      {filtered.length === 0 ? (
        <div className="card text-center text-ink-muted py-12">
          <Zap className="w-8 h-8 mx-auto mb-2 text-ink-dim" />
          No events match the filter
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
          {filtered.slice(0, 100).map((e, i) => {
            const isSuccess = e.status === 'success' || e.type?.includes('ok') || e.type?.includes('added');
            const isError = e.status === 'error' || e.type?.includes('fail') || e.type?.includes('removed');
            const klass = isSuccess
              ? 'border-l-ok bg-ok/5'
              : isError
                ? 'border-l-bad bg-bad/5'
                : e.type?.includes('health')
                  ? 'border-l-primary-2 bg-primary-2/5'
                  : 'border-l-warn bg-warn/5';
            const time = new Date(e.ts).toLocaleTimeString();
            const detail = [e.provider, e.model, e.latency_ms != null ? `${e.latency_ms}ms` : null]
              .filter(Boolean).join(' · ');
            return (
              <div
                key={e.id}
                className={cn(
                  'glass border-l-4 rounded-lg px-3 py-2 text-xs grid grid-cols-[80px_1fr] gap-3 items-center',
                  '',
                  klass
                )}
                style={{ animationDelay: `${Math.min(i * 10, 200)}ms` }}
              >
                <span className="font-mono text-ink-dim tabular-nums">{time}</span>
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn(
                    'font-mono font-semibold shrink-0',
                    isSuccess ? 'text-ok' : isError ? 'text-bad' : 'text-ink'
                  )}>{e.type}</span>
                  {detail && <span className="font-mono text-ink-muted truncate">{detail}</span>}
                  {e.error && (
                    <span className="font-mono text-bad truncate ml-auto" title={e.error}>
                      · {e.error.slice(0, 60)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}