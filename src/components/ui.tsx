// src/components/ui.tsx — small reusable components
import { useEffect, useRef } from 'react';
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
    1: { text: 'مدفوع',  cls: 'badge-primary' },
    2: { text: 'رخيص',   cls: 'badge-primary' },
    3: { text: 'احتياطي', cls: 'badge-warning' },
    4: { text: 'مجاني',  cls: 'badge-success' },
  };
  const info = labels[tier] || { text: '—', cls: '' };
  return <span className={cn('badge', info.cls)}>T{tier} · {info.text}</span>;
}

export function Toast({ msg, type = 'info' }: { msg: string; type?: 'info' | 'success' | 'error' }) {
  const colors = {
    info:    { border: 'border-s-primary-2', icon: 'ℹ', iconColor: 'text-primary-2' },
    success: { border: 'border-s-ok',        icon: '✓', iconColor: 'text-ok' },
    error:   { border: 'border-s-bad',       icon: '✗', iconColor: 'text-bad' },
  };
  const c = colors[type];
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'glass rounded-xl px-4 py-3 text-sm',
        'flex items-center gap-2.5 min-w-[260px] max-w-md',
        'border-s-4',
        c.border
      )}
    >
      <span aria-hidden="true" className={cn('text-base font-bold', c.iconColor)}>{c.icon}</span>
      <span className="flex-1">{msg}</span>
    </div>
  );
}

export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <span className={cn('inline-block rounded-full border-2 border-ink-muted border-t-primary', size === 'sm' ? 'w-3 h-3' : size === 'lg' ? 'w-6 h-6 border-[3px]' : 'w-4 h-4')}
    style={{ animation: 'spin 0.6s linear infinite' }} />;
}

/**
 * نافذة حوارية موحّدة: طبقة معتمة + ESC للإغلاق + إرجاع التركيز للعنصر الذي
 * فتحها. كانت هناك نوافذ مبنية يدوياً في كل مكوّن بلا ESC ولا إدارة تركيز،
 * وأخرى native (confirm/prompt) تُستخدم بدلاً منها.
 */
export function Modal({ title, onClose, children, footer, maxWidth = 'max-w-md' }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // التركيز ينتقل إلى الحوار، لا يبقى خلف الطبقة المعتمة
    boxRef.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} role="dialog" aria-modal="true" aria-label={title}
        className={cn('glass rounded-2xl p-5 w-full', maxWidth)}>
        <h3 className="text-sm font-semibold text-ink mb-3">{title}</h3>
        {children}
        {footer && <div className="flex items-center justify-end gap-2 mt-4">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, detail, confirmLabel, danger, busy, onConfirm, onCancel }: {
  title: string;
  message: React.ReactNode;
  detail?: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel} className="btn btn-sm">
            إلغاء
          </button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className={cn('btn btn-sm', danger ? 'btn-danger' : 'btn-primary')}>
            {busy ? <Spinner size="sm" /> : confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-xs text-ink-muted leading-relaxed">{message}</div>
      {detail && <div className="text-xs text-bad mt-2 leading-relaxed">{detail}</div>}
    </Modal>
  );
}

export { Activity, AlertCircle, CheckCircle2, Clock, Cpu, Zap };