// src/App.tsx
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Activity, Zap, Clock, CheckCircle2, Sparkles, Wifi, WifiOff, ShieldCheck } from 'lucide-react';
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
  { id: 'providers', label: 'المزوّدون', icon: Cpu, description: 'إدارة مزوّدي الذكاء الاصطناعي' },
  { id: 'sort', label: 'فرز النماذج', icon: FlaskConical, description: 'اللي يشتغل مقابل المرفوض' },
  { id: 'usage', label: 'الاستهلاك', icon: Activity, description: 'استهلاك التوكنات' },
  { id: 'logs', label: 'السجلات', icon: Zap, description: 'أحدث الأحداث' },
  { id: 'playground', label: 'اختبار محادثة', icon: Sparkles, description: 'اختبار المحادثة' }
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
  // 0/0 ليس 100% — لا طلبات تعني «لا بيانات» لا «نجاح كامل».
  const rate = requests > 0 ? Math.round((success / requests) * 100) : null;
  const recent = logsData?.events?.[0];
  const isHealthy = total > 0 && up > 0;

  // شارة الاتصال تعكس الحقيقة: الاتصال بالخادم نفسه، لا مجرد وجود مزوّد.
  // كانت مكتوبة «Online» ثابتة بلا أي شرط — تهبط بالحالة نفسها لو كان كل
  // المزوّدين ميتين أو الخادم لا يستجيب.
  const conn = status === undefined
    ? { label: 'جارٍ الاتصال…', cls: 'bg-ink-dim/10 border-ink-dim/30 text-ink-muted', Icon: Wifi }
    : !isHealthy
      ? { label: total === 0 ? 'لا مزوّدين' : 'لا مزوّد متاح', cls: 'bg-bad/10 border-bad/30 text-bad', Icon: WifiOff }
      : up < total
        ? { label: `مزوّد متعطّل ${total - up}/${total}`, cls: 'bg-warn/10 border-warn/30 text-warn', Icon: Wifi }
        : { label: 'يعمل', cls: 'bg-ok/10 border-ok/30 text-ok', Icon: Wifi };

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between pb-5 mb-6 border-b border-line/60">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="text-4xl heading-accent font-black">⚡</div>
            <div className={cn(
              'absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full ring-2 ring-canvas',
              isHealthy ? 'bg-ok' : 'bg-ink-dim'
            )} />
          </div>
          <div>
            <h1 className="text-2xl font-bold heading-accent " dir="ltr">
              GAK
            </h1>
            <p className="text-xs text-ink-muted mt-0.5">
              Generate API Key · بوابتك الموحّدة لعدة مزوّدين · v1.0.0
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className={cn('hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full border', conn.cls)}>
            <conn.Icon className="w-3.5 h-3.5" />
            <span className="text-xs font-medium">{conn.label}</span>
          </div>
          <span className="badge badge-primary">v1.0</span>
        </div>
      </header>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard
          label="المزوّدون"
          value={`${up}/${total}`}
          meta={total === 0 ? 'لا مزوّدين مضافين' : up > 0 ? `${up} متاح` : 'لا شيء متاح'}
          icon={Cpu}
          accent="success"
        />
        <StatCard
          label="الطلبات (24 ساعة)"
          value={formatNumber(requests)}
          meta={requests > 0 ? `${formatNumber(success)} ناجحة` : 'لا حركة'}
          icon={Activity}
          accent="accent"
        />
        <StatCard
          label="نسبة النجاح"
          value={rate === null ? '—' : `${rate}%`}
          meta={rate === null ? 'لا بيانات كافية' : `${formatNumber(requests - success)} أخطاء`}
          icon={CheckCircle2}
          accent={rate === null ? 'accent' : rate >= 95 ? 'success' : rate >= 70 ? 'warning' : 'error'}
        />
        <StatCard
          label="مدة التشغيل"
          value={formatUptime(status?.uptime || 0)}
          meta="منذ الإقلاع"
          icon={Clock}
          accent="accent-2"
        />
      </div>

      {/* Last event ticker */}
      {recent && (
        <div className="card mb-5 flex items-center gap-3 text-xs overflow-hidden relative ps-4">
          <div className="absolute inset-y-0 start-0 w-1 bg-primary" />
          <span className="text-ink-dim shrink-0">أحدث حدث:</span>
          <span className="font-mono text-ink-muted shrink-0">{new Date(recent.ts).toLocaleTimeString()}</span>
          <span className={cn(
            'font-mono font-semibold shrink-0',
            recent.status === 'success' ? 'text-ok' :
            recent.status === 'error' ? 'text-bad' : 'text-ink'
          )}>{recent.type}</span>
          {recent.provider && <span className="font-mono text-ink-muted shrink-0">· {recent.provider}</span>}
          {recent.latency_ms != null && <span className="font-mono text-ink-muted shrink-0">· {recent.latency_ms}ms</span>}
          {recent.error && <span className="font-mono text-bad truncate min-w-0" title={recent.error}>· {recent.error}</span>}
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
      <main>
        {tab === 'health' && <HealthTab />}
        {tab === 'agents' && <AgentsTab showToast={showToast} />}
        {tab === 'providers' && <ProvidersTab onToast={showToast} />}
        {tab === 'sort' && <SortTab onToast={showToast} />}
        {tab === 'usage' && <UsageTab />}
        {tab === 'logs' && <LogsTab />}
        {tab === 'playground' && <PlaygroundTab onToast={showToast} />}
      </main>

      {/* Toasts — منطقي (end) حتى لا تخرج عن الشاشة في RTL */}
      <div className="fixed bottom-4 end-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto">
            <Toast msg={t.msg} type={t.type} />
          </div>
        ))}
      </div>
    </div>
  );
}