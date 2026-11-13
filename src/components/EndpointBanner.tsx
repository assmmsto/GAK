// src/components/EndpointBanner.tsx — unified API key + URL generator
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Copy, Check, Plus, Trash2, Loader2, Link2, Activity, RefreshCw, BarChart3 } from 'lucide-react';
import { api, KeyStats } from '../lib/api';
import { timeAgo, cn, CLIENT_KEYS_LABEL, SYSTEM_TAGLINE } from '../lib/utils';
import { ConfirmDialog, Modal, Spinner } from './ui';

const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

// شريط أفقي صغير يمثل الرموز لكل نموذج
function TokenBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.max(3, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-ink-muted font-mono w-28 truncate shrink-0" title={label}>{label}</span>
      <div className="flex-1 h-3.5 bg-surface-2 rounded overflow-hidden border border-line">
        <div className="h-full bg-primary/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-mono text-ink w-16 text-end shrink-0">{fmt(value)}</span>
    </div>
  );
}

// خط بياني لزمني (نقاط الاستخدام)
function Sparkline({ series }: { series: Array<{ ts: number; n: number }> }) {
  if (!series.length) {
    return <div className="text-[10px] text-ink-dim italic py-4 text-center">لا يوجد نشاط بعد — استخدم المفتاح في أداة وارجع هنا</div>;
  }
  const max = Math.max(1, ...series.map(s => s.n));
  const W = 100, H = 30;
  const step = series.length > 1 ? W / (series.length - 1) : W;
  const pts = series.map((s, i) => {
    const x = i * step;
    const y = H - (s.n / max) * (H - 4) - 2;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div className="bg-surface-2 border border-line rounded-lg p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16" preserveAspectRatio="none">
        <polyline
          points={pts}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex items-center justify-between mt-1 text-[11px] font-mono text-ink-dim">
        <span>{timeAgo(series[0].ts)}</span>
        <span>الآن</span>
      </div>
    </div>
  );
}

export function EndpointBanner({ onToast }: { onToast: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['keys'], queryFn: () => api.keys(), refetchInterval: 5000 });
  // أحداث الحذف: سجل /api/logs هو الأثر الوحيد الباقي بعد محو الصف (القاعدة تحفظ hash فقط).
  // بلا عرضه لا يبقى للمستخدم أي وسيلة لمعرفة ما الذي أُبطل.
  const { data: revocations } = useQuery({
    queryKey: ['keys-revoked'],
    queryFn: async () => {
      const { events } = await api.logs(300);
      return events
        .filter(e => e.type === 'key.deleted' || e.type === 'key.regenerated')
        .map(e => {
          let m: any = {};
          try { m = JSON.parse(e.meta || '{}'); } catch { /* meta ليست JSON */ }
          return { id: String(m.id ?? ''), name: m.name as string | null, hint: m.hint as string | null, ts: e.ts, kind: e.type };
        });
    },
    refetchInterval: 30000,
    retry: 1
  });
  const [showRevoked, setShowRevoked] = useState(false);
  const [creating, setCreating] = useState(false);
  const [regenId, setRegenId] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  // المفتاح الكامل يُعرض مرة واحدة عند الإنشاء/إعادة التوليد — بعدها لا يمكن
  // استرجاعه (الخادم يخزّن hash فقط). هذا هو سلوك مزودات API الحقيقية.
  const [freshKey, setFreshKey] = useState<{ key: string; note: string } | null>(null);
  // حوارات منبثقة بدل prompt/confirm الأصلية (تُحجب في بعض المتصفحات وتكسر RTL)
  const [namingKey, setNamingKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('my-key');
  const [ask, setAsk] = useState<null | { kind: 'regen' | 'delete'; id: number; name: string }>(null);

  const baseUrl = data?.baseUrl || '';
  const keys = data?.keys || [];
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      onToast(`نُسخ ${label}`, 'success');
      setTimeout(() => setCopied(null), 1500);
    } catch {
      onToast('تعذّر النسخ إلى الحافظة', 'error');
    }
  };

  const create = async () => {
    const name = newKeyName.trim();
    if (!name) return;
    setNamingKey(false);
    setCreating(true);
    try {
      const k = await api.createKey(name);
      setFreshKey({ key: k.key, note: `المفتاح الجديد "${name}"` });
      onToast('أُنشئ مفتاح GAK', 'success');
      qc.invalidateQueries({ queryKey: ['keys'] });
    } catch (e: any) {
      onToast(e.message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const regenerate = async (id: number, name: string) => {
    setAsk(null);
    setRegenId(id);
    try {
      const k = await api.regenerateKey(id);
      setFreshKey({ key: k.key, note: `المفتاح بعد إعادة التوليد "${name}"` });
      onToast('أُعيد توليد المفتاح — حدّث أدواتك', 'success');
      qc.invalidateQueries({ queryKey: ['keys'] });
      if (activeId === id) qc.invalidateQueries({ queryKey: ['key-stats', id] });
    } catch (e: any) {
      onToast(e.message, 'error');
    } finally {
      setRegenId(null);
    }
  };

  const remove = async (id: number, name: string) => {
    setAsk(null);
    try {
      await api.deleteKey(id);
      if (activeId === id) setActiveId(null);
      onToast('حُذف المفتاح', 'success');
      qc.invalidateQueries({ queryKey: ['keys'] });
    } catch (e: any) {
      onToast(e.message, 'error');
    }
  };

  const mask = (k: string) => k.slice(0, 8) + '••••••••••••••••••••';

  return (
    <div className="card mb-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold" dir="ltr">{CLIENT_KEYS_LABEL}</h2>
          <span className="badge badge-primary">{SYSTEM_TAGLINE} · تخاطب كل المزوّدين</span>
        </div>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => { setNewKeyName('my-key'); setNamingKey(true); }}
          disabled={creating}
          title="Generate API Key"
        >
          {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Generate API Key
        </button>
      </div>

      {/*
        كان الشريط يعرض «مفتاح واحد · كل المزوّدين» وزر «توليد مفتاح» بلا توضيح
        أن هذه مفاتيح **عملاء** تُصادِق أدواتك، لا مفاتيح المزوّدين التي تُصادِق
        Gateway معهم. المستخدم حذفها ظناً أنها مفاتيح المزوّد — والنتيجة فقدان
        مفاتيح GAK دون مساس بمفاتيح المزوّدين. التوضيح هنا إلزامي.
      */}
      <div className="mb-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11px] text-ink-muted leading-relaxed">
        <span className="font-semibold text-ink">هذه مفاتيح عملائك (GAK)، لا مفاتيح مزوّدين.</span>{' '}
        مفتاح GAK (<code className="font-mono text-primary-2" dir="ltr">gw_…</code>) هو ما تضعه في أدواتك لتتصل بهذه البوابة.
        أما مفاتيح المزوّدين (Dahl، Ollama…) فتُدار من تبويب{' '}
        <span className="font-semibold text-ink">المزوّدون</span> ← زر المفتاح في بطاقة كل مزوّد، ولا يُمسّ حذف هذه.
      </div>

      {/* عرض المفتاح الكامل مرة واحدة فقط — انسخه الآن */}
      {freshKey && (
        <div className="mb-3 rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-ink">
            <KeyRound className="w-3.5 h-3.5 text-primary" />
            {freshKey.note} — انسخه الآن، لن يُعرض مجدداً
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-surface-2 border border-line rounded-lg px-3 py-2 text-xs text-ink font-mono break-all">
              {freshKey.key}
            </code>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => copy(freshKey.key, 'المفتاح')}
              title="انسخ المفتاح"
            >
              {copied === 'المفتاح' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              نسخ
            </button>
            <button className="btn btn-sm" onClick={() => setFreshKey(null)}>تم</button>
          </div>
        </div>
      )}

      {/* URL الجامع */}
      <div className="space-y-2">
        <div>
          <label className="text-[11px] tracking-wider text-ink-dim font-semibold">عنوان الأساس (Base URL)</label>
          <div className="flex items-center gap-2 mt-1">
            <code className="flex-1 bg-surface-2 border border-line rounded-lg px-3 py-2 text-xs text-ink font-mono truncate" dir="ltr">
              {baseUrl || 'http://localhost:3001'}/v1
            </code>
            <button
              className="btn btn-sm"
              onClick={() => copy(`${baseUrl}/v1`, 'العنوان')}
              title="انسخ العنوان"
            >
              {copied === 'العنوان' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {/* المفاتيح */}
        {isLoading ? (
          <div className="text-xs text-ink-dim py-2">جارٍ تحميل المفاتيح…</div>
        ) : keys.length === 0 ? (
          <div className="text-xs text-ink-dim py-2">
            لا مفاتيح GAK بعد — localhost مفتوح. ولّد مفتاحاً لتقييد الوصول (مفاتيح المزوّدين منفصلة ولا تتأثر).
          </div>
        ) : (
          <div className="space-y-1.5">
            {keys.map(k => (
              <div key={k.id}>
                <div className="flex items-center gap-2 bg-surface-2 border border-line rounded-lg px-3 py-2">
                  <span className="text-[10px] text-ink-muted font-medium w-20 truncate" title={k.name}>{k.name}</span>
                  {/* البصمة فقط — المفتاح الكامل يُعرض مرة واحدة عند إنشائه */}
                  <code className="flex-1 text-xs text-ink font-mono truncate" dir="ltr" title="بصمة المفتاح — القيمة الكاملة عند الإنشاء فقط">
                    {mask(k.key as string)}
                  </code>
                  <span className="text-[11px] text-ink-dim whitespace-nowrap">
                    {k.requests || 0} طلب
                    {k.last_used ? ` · ${timeAgo(k.last_used as number)}` : ''}
                  </span>
                  <button
                    className={cn('btn btn-sm btn-ghost', activeId === k.id && 'text-primary')}
                    onClick={() => setActiveId(activeId === k.id ? null : (k.id as number))}
                    title={activeId === k.id ? 'إخفاء النشاط' : 'نشاط المفتاح'}
                  >
                    <Activity className="w-3 h-3" />
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => setAsk({ kind: 'regen', id: k.id as number, name: k.name as string })}
                    disabled={regenId === k.id}
                    title="إعادة توليد المفتاح (يلغي القديم ويعرض الجديد مرة واحدة)"
                  >
                    {regenId === k.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => setAsk({ kind: 'delete', id: k.id as number, name: k.name as string })}
                    title="حذف المفتاح"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                {/* لوحة النشاط */}
                {activeId === k.id && <KeyStatsPanel keyId={k.id as number} />}
              </div>
            ))}
          </div>
        )}

        {/* سجل الإبطال — ما حُذف أو أُعيد توليده من مفاتيح GAK */}
        {revocations && revocations.length > 0 && (
          <div className="pt-1">
            <button
              type="button"
              className="text-[11px] text-ink-dim hover:text-ink underline underline-offset-2"
              onClick={() => setShowRevoked(v => !v)}
              aria-expanded={showRevoked}
            >
              {showRevoked ? 'أخفِ' : 'أظهر'} سجل المفاتيح المُبطلة ({revocations.length})
            </button>
            {showRevoked && (
              <div className="mt-1.5 max-h-52 overflow-auto rounded-lg border border-line bg-surface divide-line">
                <p className="px-3 py-1.5 text-[10px] text-ink-dim bg-surface-2">
                  القيمة الكاملة لا يمكن استرجاعها (تُخزَّن hash فقط). البصمة تحدّد أي أداة تكسّرت؛ الأداة تُصلَح بتوليد مفتاح جديد.
                </p>
                {revocations.map((r, i) => (
                  <div key={`${r.id}-${r.ts}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                    <span className={cn('shrink-0 font-medium', r.kind === 'key.regenerated' ? 'text-primary-2' : 'text-bad')}>
                      {r.kind === 'key.regenerated' ? 'أُعيد توليده' : 'حُذف'}
                    </span>
                    <span className="truncate text-ink w-32" title={r.name ?? `#${r.id}`}>{r.name ?? `#${r.id}`}</span>
                    <code className="font-mono text-ink-muted shrink-0" dir="ltr">{r.hint ?? '—'}</code>
                    <span className="ms-auto text-ink-dim shrink-0">{timeAgo(r.ts)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* اختصار الاستخدام */}
      <div className="mt-3 pt-3 border-t border-line/50 flex items-center gap-1.5 text-[11px] text-ink-dim flex-wrap">
        <Link2 className="w-3 h-3" />
        وجّه أي أداة متوافقة مع OpenAI إلى هنا:
        <code className="text-primary-2 font-mono" dir="ltr">base URL</code> +
        <code className="text-primary-2 font-mono" dir="ltr">key</code>
      </div>

      {/* تسمية مفتاح جديد */}
      {namingKey && (
        <Modal
          title="اسم مفتاح GAK"
          onClose={() => setNamingKey(false)}
          footer={
            <>
              <button type="button" className="btn btn-sm" onClick={() => setNamingKey(false)}>إلغاء</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={create} disabled={!newKeyName.trim() || creating}>
                {creating ? <Spinner size="sm" /> : 'أنشئ المفتاح'}
              </button>
            </>
          }
        >
          <label className="text-[11px] text-ink-dim font-semibold">
            اسم يميّز الأداة المستخدمة (cursor، codex، my-app…)
          </label>
          <p className="text-[11px] text-ink-dim mt-1.5">
            هذا مفتاح GAK يتصل بهذه البوابة — لا علاقة له بمفاتيح المزوّدين، وتوليده لا يغيّرها.
          </p>
          <input
            className="input mt-1.5"
            value={newKeyName}
            onChange={e => setNewKeyName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') create(); }}
            placeholder="my-key"
            maxLength={64}
          />
        </Modal>
      )}

      {ask && (
        <ConfirmDialog
          title={ask.kind === 'regen' ? `إعادة توليد مفتاح GAK "${ask.name}"؟` : `حذف مفتاح GAK "${ask.name}"؟`}
          message={ask.kind === 'regen'
            ? 'القيمة القديمة تبطل مباشرة — كل أداة تستخدمها يجب أن تحدّثها.'
            : 'الأدوات التي تستخدمه ستتوقف عن العمل فوراً.'}
          detail="مفاتيح المزوّدين (Dahl، Ollama…) لا تتأثر بهذا الإجراء."
          confirmLabel={ask.kind === 'regen' ? 'أعد التوليد' : 'حذف'}
          danger
          onCancel={() => setAsk(null)}
          onConfirm={() => (ask.kind === 'regen' ? regenerate(ask.id, ask.name) : remove(ask.id, ask.name))}
        />
      )}
    </div>
  );
}

function KeyStatsPanel({ keyId }: { keyId: number }) {
  const { data, isLoading, isError } = useQuery<KeyStats>({
    queryKey: ['key-stats', keyId],
    queryFn: () => api.keyStats(keyId),
    refetchInterval: 4000
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 bg-surface border border-line border-t-0 rounded-b-lg text-[11px] text-ink-dim">
        <Loader2 className="w-3 h-3 animate-spin" /> تحميل النشاط…
      </div>
    );
  }
  if (isError || !data) {
    return <div className="px-3 py-2.5 bg-surface border border-line border-t-0 rounded-b-lg text-[11px] text-bad">فشل تحميل النشاط</div>;
  }

  const totalTokens = data.models.reduce((a, m) => a + m.tokens, 0);
  const totalReqs = data.models.reduce((a, m) => a + m.requests, 0);
  const maxTokens = Math.max(1, ...data.models.map(m => m.tokens));
  const avgMs = data.models.length
    ? Math.round(data.models.reduce((a, m) => a + m.avgMs, 0) / data.models.length)
    : 0;

  if (!data.models.length && !data.series.length) {
    return (
      <div className="px-3 py-3 bg-surface border border-line border-t-0 rounded-b-lg text-[11px] text-ink-dim">
        <BarChart3 className="w-3 h-3 inline-block mr-1.5" />
        لا يوجد نشاط على هذا المفتاح بعد. استخدمه بأي أداة (Cursor, Cline…) وستظهر الإحصائيات هنا تلقائياً.
      </div>
    );
  }

  return (
    <div className="px-3 py-3 bg-surface border border-line border-t-0 rounded-b-lg space-y-3">
      {/* الملخص */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'الرموز', value: fmt(totalTokens) },
          { label: 'الطلبات', value: fmt(totalReqs) },
          { label: 'النماذج', value: String(data.models.length) },
          { label: 'زمن الاستجابة', value: avgMs ? `${fmt(avgMs)}ms` : '—' }
        ].map(s => (
          <div key={s.label} className="text-center bg-surface-2 rounded-lg py-1.5 border border-line">
            <div className="text-sm font-mono font-semibold text-ink">{s.value}</div>
            <div className="text-[11px] text-ink-dim">{s.label}</div>
          </div>
        ))}
      </div>

      {/* الرسم الزمني */}
      <div>
        <div className="text-[11px] text-ink-muted font-semibold mb-1">النشاط الزمني</div>
        <Sparkline series={data.series} />
      </div>

      {/* الرموز لكل نموذج */}
      {data.models.length > 0 && (
        <div>
          <div className="text-[11px] text-ink-muted font-semibold mb-1.5">الرموز حسب النموذج</div>
          <div className="space-y-1.5">
            {data.models.map(m => (
              <div key={m.model} className="group">
                <TokenBar label={m.model} value={m.tokens} max={maxTokens} />
                <div className="flex items-center gap-3 text-[11px] text-ink-dim ps-[7.5rem] opacity-80">
                  <span>{m.requests} طلب</span>
                  <span>·</span>
                  <span>دخل {fmt(m.prompt)} / خرج {fmt(m.completion)}</span>
                  {m.avgMs > 0 && (<><span>·</span><span>{m.avgMs}ms</span></>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
