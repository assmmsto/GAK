// src/components/ui.tsx — small reusable components
import { cn } from '../lib/utils';
import { Activity, AlertCircle, CheckCircle2, Clock, Cpu, Zap } from 'lucide-react';

const ACCENT_COLORS = {
  success: { icon: 'text-ok' },
  warning: { icon: 'text-warn' },
  error:   { icon: 'text-bad' },
  accent:  { icon: 'text-primary' },
  'accent-2': { icon: 'text-primary-2' },
};

export function StatCard({ label, value, meta, icon: Icon, accent = 'accent' }: {
  label: string; value: string | number; meta?: string; icon?: any; accent?: keyof typeof ACCENT_COLORS;
}) {
  const c = ACCENT_COLORS[accent];
  return (
    <div className="stat-card group cursor-default">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-ink-muted font-semibold">{label}</span>
        {Icon && (
          <div className={cn('p-1.5 rounded-lg transition-all', c.icon, 'group-hover:scale-110')}>
            <Icon className="w-3.5 h-3.5" />
          </div>
        )}
      </div>
      <div className="text-3xl font-bold text-ink tabular-nums tracking-tight">{value}</div>
      {meta && <div className="text-[11px] text-ink-dim mt-1">{meta}</div>}
    </div>
  );
}

export function StatusDot({ status }: { status: string }) {
  const styles: Record<string, string> = {
    up: 'bg-ok ',
    down: 'bg-bad',
    unknown: 'bg-warn',
    auth_error: 'bg-bad '
  };
  return <span className={cn('inline-block w-2 h-2 rounded-full mr-1.5 align-middle', styles[status] || 'bg-ink-dim')} />;
}

export function TierBadge({ tier }: { tier: number }) {
  const labels: Record<number, { text: string; cls: string }> = {
    1: { text: 'paid',     cls: 'badge-primary' },
    2: { text: 'cheap',    cls: 'badge-primary' },
    3: { text: 'fallback', cls: 'badge-warning' },
    4: { text: 'free',     cls: 'badge-success' },
  };
  const info = labels[tier] || { text: '—', cls: '' };
  return <span className={cn('badge', info.cls)}>t{ tier } · {info.text}</span>;
}

export function Toast({ msg, type = 'info' }: { msg: string; type?: 'info' | 'success' | 'error' }) {
  const colors = {
    info:    { border: 'border-l-primary-2',  icon: 'ℹ', iconColor: 'text-primary-2' },
    success: { border: 'border-l-ok',        icon: '✓', iconColor: 'text-ok' },
    error:   { border: 'border-l-bad',       icon: '✗', iconColor: 'text-bad' },
  };
  const c = colors[type];
  return (
    <div className={cn(
      'glass rounded-xl px-4 py-3 text-sm',
      'flex items-center gap-2.5 min-w-[260px] max-w-md',
      'border-l-4 ',
      c.border
    )}>
      <span className={cn('text-base font-bold', c.iconColor)}>{c.icon}</span>
      <span className="flex-1">{msg}</span>
    </div>
  );
}

export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <span className={cn('inline-block rounded-full border-2 border-ink-muted border-t-primary', size === 'sm' ? 'w-3 h-3' : size === 'lg' ? 'w-6 h-6 border-[3px]' : 'w-4 h-4')}
    style={{ animation: 'spin 0.6s linear infinite' }} />;
}

export { Activity, AlertCircle, CheckCircle2, Clock, Cpu, Zap };