// src/App.tsx
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Activity, Zap, Clock, CheckCircle2, Sparkles, Wifi, ShieldCheck } from 'lucide-react';
import { api } from './lib/api';
import { formatUptime, formatNumber, cn } from './lib/utils';
import { StatCard, Toast } from './components/ui';
import { ProvidersTab } from './components/ProvidersTab';
import { UsageTab } from './components/UsageTab';
import { LogsTab } from './components/LogsTab';
import { PlaygroundTab } from './components/PlaygroundTab';
import { SortTab } from './components/SortTab';
import { HealthTab } from './components/HealthTab';
import { AgentsTab } from './components/AgentsTab';
import { EndpointBanner } from './components/EndpointBanner';
import { FlaskConical } from 'lucide-react';

type Tab = 'health' | 'agents' | 'providers' | 'sort' | 'usage' | 'logs' | 'playground';

const TABS: { id: Tab; label: string; icon: any; description: string }[] = [
  { id: 'health', label: 'الحالة', icon: ShieldCheck, description: 'أي مفتاح ميت؟' },
  { id: 'agents', label: 'الوكلاء', icon: Activity, description: 'المزامنة والتدوير التلقائي' },
  { id: 'providers', label: 'Providers', icon: Cpu, description: 'Manage AI providers' },
  { id: 'sort', label: 'فرز النماذج', icon: FlaskConical, description: 'اللي يشتغل vs المرفوض' },
  { id: 'usage', label: 'Usage', icon: Activity, description: 'Token consumption' },
  { id: 'logs', label: 'Logs', icon: Zap, description: 'Recent events' },
  { id: 'playground', label: 'Playground', icon: Sparkles, description: 'Test chat' }
];

export default function App() {
  const [tab, setTab] = useState<Tab>('providers');
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; type: 'info' | 'success' | 'error' }>>([]);

  const { data: status } = useQuery({ queryKey: ['status'], queryFn: () => api.status(), refetchInterval: 4000 });
  const { data: logsData } = useQuery({ queryKey: ['logs-recent'], queryFn: () => api.logs(5), refetchInterval: 4000 });

  const showToast = (msg: string, type: 'info' | 'success' | 'error' = 'info') => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  };

  // كشف الـ drift: لو صار مزود auth_error ولم يكن قبل (مرة واحدة لكل انتقال)
  const [knownAuthErrors, setKnownAuthErrors] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!status?.providers) return;
    const current = new Set(status.providers.filter(p => p.status === 'auth_error').map(p => p.id));
    // S11: أول لقطة تُحفظ بلا تنبيه — حتى لو كان فيها مزودات ميتة أصلاً. كان
    // الشرط يتطلّب لقطة أولى **فارغة**، فمن عنده مفتاح ميت يرى تنبيهاً كاذباً كل مرة.
    if (knownAuthErrors === null) {
      setKnownAuthErrors(current);
      return;
    }
    // الفرق: مزودين صاروا auth_error ولم يكونوا قبل
    const newOnes = [...current].filter(id => !knownAuthErrors.has(id));
    if (newOnes.length) {
      showToast(`⚠ مفتاح ${newOnes.join(', ')} غير صالح — حُجب من التوجيه`, 'error');
    }
    setKnownAuthErrors(current);
  }, [status?.providers]);

  const up = status?.providers.filter(p => p.status === 'up').length || 0;
  const total = status?.providers.length || 0;
  const requests = status?.stats.total || 0;
  const success = status?.stats.success || 0;
  const rate = requests > 0 ? Math.round((success / requests) * 100) : 100;
  const recent = logsData?.events?.[0];
  const isHealthy = total > 0 && up > 0;

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between pb-5 mb-6 border-b border-line/60">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="text-4xl heading-accent font-black">⚡</div>
            <div className={cn(
              'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full',
              isHealthy ? 'bg-ok ' : 'bg-ink-dim'
            )} />
          </div>
          <div>
            <h1 className="text-2xl font-bold heading-accent ">
              AI Gateway
            </h1>
            <p className="text-xs text-ink-muted mt-0.5">
              Unified multi-provider proxy · v1.0.0
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ok/10 border border-ok/30">
            <Wifi className="w-3.5 h-3.5 text-ok" />
            <span className="text-xs font-medium text-ok">Online</span>
          </div>
          <span className="badge-primary">v1.0</span>
        </div>
      </header>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard
          label="Providers"
          value={`${up}/${total}`}
          meta={up > 0 ? `${up} active` : 'none active'}
          icon={Cpu}
          accent="success"
        />
        <StatCard
          label="Requests (24h)"
          value={formatNumber(requests)}
          meta={`${success} successful`}
          icon={Activity}
          accent="accent"
        />
        <StatCard
          label="Success Rate"
          value={`${rate}%`}
          meta={requests > 0 ? `${requests - success} errors` : 'no traffic'}
          icon={CheckCircle2}
          accent={rate >= 95 ? 'success' : rate >= 70 ? 'warning' : 'error'}
        />
        <StatCard
          label="Uptime"
          value={formatUptime(status?.uptime || 0)}
          meta="since start"
          icon={Clock}
          accent="accent-2"
        />
      </div>

      {/* Last event ticker */}
      {recent && (
        <div className="card mb-5  flex items-center gap-3 text-xs overflow-hidden relative">
          <div className="absolute inset-y-0 left-0 w-1 bg-primary" />
          <span className="text-ink-dim ml-2">latest:</span>
          <span className="font-mono text-ink-muted">{new Date(recent.ts).toLocaleTimeString()}</span>
          <span className={cn(
            'font-mono font-semibold',
            recent.status === 'success' ? 'text-ok' :
            recent.status === 'error' ? 'text-bad' : 'text-ink'
          )}>{recent.type}</span>
          {recent.provider && <span className="font-mono text-ink-muted">· {recent.provider}</span>}
          {recent.latency_ms != null && <span className="font-mono text-ink-muted">· {recent.latency_ms}ms</span>}
          {recent.error && <span className="font-mono text-bad truncate">· {recent.error.slice(0, 50)}</span>}
        </div>
      )}

      {/* Unified endpoint: URL + API key generator */}
      <EndpointBanner onToast={showToast} />

      {/* Tabs */}
      <nav className="flex gap-1 border-b border-line/60 mb-5 overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon;
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              data-tooltip={t.description}
              className={cn(
                'group flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 -mb-px whitespace-nowrap',
                isActive
                  ? 'text-ink border-primary'
                  : 'text-ink-muted border-transparent hover:text-ink hover:border-line'
              )}
            >
              <Icon className={cn('w-4 h-4 transition-transform', isActive && 'scale-110')} />
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Content */}
      <main className="">
        {tab === 'health' && <HealthTab />}
      {tab === 'agents' && <AgentsTab showToast={showToast} />}
      {tab === 'providers' && <ProvidersTab onToast={showToast} />}
        {tab === 'sort' && <SortTab onToast={showToast} />}
        {tab === 'usage' && <UsageTab />}
        {tab === 'logs' && <LogsTab />}
        {tab === 'playground' && <PlaygroundTab />}
      </main>

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto">
            <Toast msg={t.msg} type={t.type} />
          </div>
        ))}
      </div>
    </div>
  );
}