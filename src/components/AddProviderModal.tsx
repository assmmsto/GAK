// src/components/AddProviderModal.tsx
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Check, Loader2, Server, Key, Globe, Layers, Sparkles, ArrowRight, ExternalLink, Pencil, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
  // وضع التحرير — لو موجود، نحمّل بياناته ونعرض عنوان مختلف
  editTarget?: { id: string; name: string; baseUrl: string; tier: number; hasKey: boolean } | null;
}

// احتياطي فقط عند تعطّل /api/catalog — المصدر الحقيقي server/catalog.yaml.
// سبب وجوده: شاشة الإضافة تبقى قابلة للاستخدام لو فشل الطلب.
// تحذير صيانة: لا تُوسّع هذه القائمة يدوياً — أضف المزود في catalog.yaml.
const FALLBACK_PRESETS = [
  { id: 'groq', name: 'Groq Cloud', baseUrl: 'https://api.groq.com/openai/v1', tier: 4, free: true, signupUrl: 'https://console.groq.com/keys' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', tier: 3, free: false, signupUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', tier: 2, free: false, signupUrl: 'https://openrouter.ai/keys' },
  { id: 'zai', name: 'Z.AI (GLM)', baseUrl: 'https://api.z.ai/v1', tier: 3, free: false, signupUrl: 'https://z.ai/manage-apikey' },
  { id: 'google-ai', name: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', tier: 3, free: true, signupUrl: 'https://aistudio.google.com/apikey' },
  { id: 'mistral', name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', tier: 4, free: true, signupUrl: 'https://console.mistral.ai/api-keys/' },
  { id: 'cohere', name: 'Cohere', baseUrl: 'https://api.cohere.com/v1', tier: 4, free: true, signupUrl: 'https://dashboard.cohere.com/api-keys' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.ai/v1', tier: 4, free: true, signupUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', tier: 4, free: true, signupUrl: 'https://fireworks.ai/account/api-keys' },
  { id: 'cerebras', name: 'Cerebras (Free)', baseUrl: 'https://api.cerebras.ai/v1', tier: 4, free: true, signupUrl: 'https://cloud.cerebras.ai/' },
  { id: 'chutes', name: 'Chutes AI (Free)', baseUrl: 'https://llm.chutes.ai/v1', tier: 4, free: true, signupUrl: 'https://chutes.ai/app/settings' },
  { id: 'sambanova', name: 'SambaNova (Free)', baseUrl: 'https://api.sambanova.ai/v1', tier: 4, free: true, signupUrl: 'https://cloud.sambanova.ai/apis' },
  { id: 'siliconflow', name: 'SiliconFlow (Free)', baseUrl: 'https://api.siliconflow.cn/v1', tier: 4, free: true, signupUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'modelscope', name: 'ModelScope (Free)', baseUrl: 'https://api-inference.modelscope.cn/v1', tier: 4, free: true, signupUrl: 'https://modelscope.cn/my/myaccesstoken' },
  { id: 'pollinations', name: 'Pollinations (Free)', baseUrl: 'https://text.pollinations.ai/openai', tier: 4, free: true, signupUrl: 'https://pollinations.ai/' },
];

// الشكل الموحّد لعنصر «اختيار سريع» — يخدم الكتالوج والاحتياطي معاً
type QuickPreset = {
  id: string; name: string; baseUrl: string; tier: number;
  free?: boolean; signupUrl?: string | null;
};

export function AddProviderModal({ open, onClose, onAdded, editTarget }: Props) {
  const isEdit = !!editTarget;
  const [step, setStep] = useState<'form' | 'models'>('form');
  const [id, setId] = useState(editTarget?.id || '');
  const [name, setName] = useState(editTarget?.name || '');
  const [baseUrl, setBaseUrl] = useState(editTarget?.baseUrl || '');
  const [apiKey, setApiKey] = useState('');
  const [tier, setTier] = useState(editTarget?.tier ?? 4);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; error?: string; statusCode?: number } | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<{ id: string; status?: string; latencyMs?: number; error?: string }[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // قائمة المزودات الموجودة — نُنبّه المستخدم قبل محاولة الحفظ بدل أن يفشل بصمت
  const { data: existingData } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.providers(),
    enabled: open
  });
  const existingIds = (existingData?.providers || []).map(p => p.id);
  const idExists = !!id && existingIds.includes(id) && (!isEdit || editTarget!.id !== id);

  // الاختيار السريع يأتي من الكتالوج الموحّد (/api/catalog) لا من نسخة محلية.
  // لماذا: النسخة المحلية كانت تتفرّع عن الكتالوج — مثال حقيقي وقع فعلاً:
  // chutes كان هنا api.chutes.ai/v1 وفي الكتالوج llm.chutes.ai/v1، فينجح أو
  // يفشل الاتصال حسب المسار الذي دخل منه المستخدم. مرجع واحد يمنع هذا الصنف كله.
  const { data: catalogData } = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api.catalog(),
    enabled: open,
    staleTime: 5 * 60 * 1000
  });
  const quickPresets: QuickPreset[] = catalogData?.providers?.length
    ? catalogData.providers
        .filter(p => !existingIds.includes(p.id))
        .map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, tier: p.tier ?? 4, free: p.free, signupUrl: p.signupUrl }))
    : FALLBACK_PRESETS;

  // نُزامن الحقول مع المزود المطلوب تحريره.
  // بدونه: الحالة الابتدائية في useState تُحسب مرة واحدة فقط، فيُفتح نموذج التحرير
  // فارغاً ويبقى زر الحفظ معطّلاً — وهذا سبب "الحفظ لا يعمل".
  useEffect(() => {
    if (!open) return;
    if (editTarget) {
      setId(editTarget.id);
      setName(editTarget.name);
      setBaseUrl(editTarget.baseUrl);
      setTier(editTarget.tier);
      setApiKey('');
    } else {
      setId(''); setName(''); setBaseUrl(''); setApiKey(''); setTier(4);
    }
    setStep('form');
    setTestResult(null);
    setAvailableModels([]);
    setSelectedModels(new Set());
    setFetchingModels(false);
    setTesting(false);
  }, [open, editTarget?.id]);

  if (!open) return null;

  const reset = () => {
    setStep('form');
    setId(''); setName(''); setBaseUrl(''); setApiKey(''); setTier(4);
    setTestResult(null); setAvailableModels([]); setSelectedModels(new Set());
  };

  const close = () => { reset(); onClose(); };

  const applyPreset = (p: QuickPreset) => {
    setId(p.id); setName(p.name); setBaseUrl(p.baseUrl); setTier(p.tier);
  };

  const test = async () => {
    if (!baseUrl) return;
    setTesting(true); setTestResult(null);
    try {
      const r = await api.testConnection(baseUrl, apiKey || undefined);
      setTestResult(r);
    } catch (e: any) { setTestResult({ ok: false, latencyMs: 0, error: e.message }); }
    finally { setTesting(false); }
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    try {
      const r = await api.fetchModels(baseUrl, apiKey || undefined);
      setAvailableModels(r.models.map(m => ({ id: m.id })));
      setSelectedModels(new Set(r.models.map(m => m.id)));
      if (r.models.length > 0) setStep('models');
      else setTestResult({ ok: false, latencyMs: 0, error: 'لم يُعِد المزوّد أي نماذج — قد يستخدم واجهة غير متوافقة مع OpenAI' });
    } catch (e: any) { setTestResult({ ok: false, latencyMs: 0, error: e.message }); }
    finally { setFetchingModels(false); }
  };

  const testAllModels = async () => {
    if (!availableModels.length) return;
    // اختبر النماذج على دفعات متوازية (batch) بدلاً من إرسالها دفعة واحدة
    // عشان لا نضغط على المزود ولا ننخنق بحد المعدل
    setTesting(true);
    setTestResult(null);
    try {
      if (isEdit) {
        // S13: نداء دفعي واحد بدل طلب لكل نموذج. كان مزود بـ100+ نموذج يتجاوز
        // حد المعدل (60/دقيقة) فيُوسم «فشل» وهو لم يُفحص أصلاً.
        const r = await api.probeAll(editTarget!.id, Math.min(availableModels.length, 200));
        const byModel = new Map((r.results || []).map(x => [x.model, x]));
        setAvailableModels(prev => prev.map(p => {
          const hit = byModel.get(p.id);
          if (!hit) return p;
          return {
            ...p,
            // rate_limited ليست حكماً على النموذج — تُعاد إلى «لم يُفحص»
            status: hit.status === 'ok' ? 'ok' : hit.status === 'rate_limited' ? undefined : 'rejected',
            latencyMs: hit.latencyMs, error: hit.error
          };
        }));
        const okCount = (r.results || []).filter(x => x.status === 'ok').length;
        setTestResult({
          ok: okCount > 0, latencyMs: 0,
          error: okCount === 0 ? 'لم ينجح أي نموذج في الفحص' : undefined
        });
        return;
      }
      const BATCH = 5;
      const results: { id: string; status?: string; latencyMs?: number; error?: string }[] = [];
      for (let i = 0; i < availableModels.length; i += BATCH) {
        const slice = availableModels.slice(i, i + BATCH);
        const batch = await Promise.all(
          slice.map(async (m) => {
                  try {
                    // وضع التحرير عالجه نداء دفعي واحد أعلاه؛ ما تبقّى هو وضع الإضافة:
                    // نفحص عبر baseUrl و apiKey مباشرةً بلا مزود محفوظ بعد.
                    const res = await api.probeConnect(baseUrl, apiKey || undefined, m.id);
                    return {
                      id: m.id,
                      status: res.status,
                      latencyMs: res.latencyMs,
                      error: res.error
                    };
                  } catch (e: any) {
                    // S13: تجاوز حد المعدل ليس حكماً على النموذج ⇒ «لم يُفحص» لا «فشل»
                    const limited = /429|rate limit|تجاوزت حد/i.test(String(e?.message || ''));
                    return { id: m.id, status: limited ? undefined : 'rejected', error: e.message };
                  }
                })
        );
        results.push(...batch);
        // حدّث الواجهة بعد كل دفعة حتى يبين التقدم
        setAvailableModels(prev => {
          const map = new Map(results.map(r => [r.id, r]));
          return prev.map(p => map.get(p.id) ?? p);
        });
      }
      const okCount = results.filter(r => r.status === 'ok').length;
      setTestResult({
        ok: okCount > 0,
        latencyMs: 0,
        error: okCount === 0 ? 'فشلت كل النماذج في الفحص' : undefined
      });
    } catch (e: any) {
      setTestResult({ ok: false, latencyMs: 0, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    // لا نرجع بصمت — المستخدم يجب أن يعرف لماذا لم يُحفظ
    if (!id || !name || !baseUrl) {
      setTestResult({ ok: false, latencyMs: 0, error: 'المعرّف والاسم والرابط مطلوبة' });
      return;
    }
    setSaving(true);
    setTestResult(null);
    try {
      // النماذج الناجحة فقط تُحفظ (وإن لم يُختبر شيء نتركها auto)
      const successfulModels = availableModels.filter(m => m.status === 'ok').map(m => m.id);
      if (isEdit) {
        const update: any = { name, baseUrl, tier };
        if (apiKey === '__clear__') update.apiKey = '';
        else if (apiKey.length > 0) update.apiKey = apiKey;
        if (successfulModels.length > 0) update.models = successfulModels;
        await api.editProvider(editTarget!.id, update);
        onAdded();
        close();
        return;
      }
      try {
        await api.addProvider({
          id, name, baseUrl,
          apiKey: apiKey || undefined,
          tier,
          models: successfulModels.length > 0 ? successfulModels : 'auto'
        } as any);
      } catch (e: any) {
        // المزود موجود مسبقاً (409) → نُحدّثه بدل أن يفشل الحفظ
        if (/already exists/i.test(e.message || '')) {
          const update: any = { name, baseUrl, tier };
          if (apiKey) update.apiKey = apiKey;
          if (successfulModels.length > 0) update.models = successfulModels;
          await api.editProvider(id, update);
        } else {
          throw e;
        }
      }
      onAdded();
      close();
    } catch (e: any) {
      setTestResult({ ok: false, latencyMs: 0, error: e.message || String(e) });
    } finally {
      setSaving(false);
    }
  };

  // الاسم الحقيقي لمتغيّر البيئة: نأخذه من المزود الموجود (apiKeyEnv) وإلا نشتقّه من المعرّف.
  // بدون هذا كان التلميح يعرض اسماً مختلفاً عن الذي يكتبه الخادم فعلاً (مثال: google-ai → GEMINI_API_KEY)
  const existingProvider = (existingData?.providers || []).find(p => p.id === id);
  const envVarName = existingProvider?.apiKeyEnv
    || catalogData?.providers?.find(p => p.id === id)?.apiKeyEnv
    || (id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY');
  const okModelsCount = availableModels.filter(m => m.status === 'ok').length;
  const saveLabel = okModelsCount > 0
    ? `حفظ ${okModelsCount} نموذج`
    : isEdit ? 'تحديث المزود' : idExists ? 'تحديث المزود الموجود' : 'حفظ المزود';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 ">
      <div className="card max-w-2xl w-full max-h-[90vh] overflow-y-auto p-0  ">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between p-5 border-b border-line bg-surface/95">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              {step === 'form' ? (
                <>{isEdit ? <Pencil className="w-5 h-5 text-primary" /> : <Server className="w-5 h-5 text-primary" />} {isEdit ? `تحرير: ${editTarget!.id}` : 'أضف مزوّداً'}</>
              ) : (
                <><Layers className="w-5 h-5 text-primary-2" /> اختر النماذج ({selectedModels.size}/{availableModels.length})</>
              )}
            </h2>
            <p className="text-xs text-ink-dim mt-0.5">
              {step === 'form' ? 'اضبط بيانات الاتصال' : 'اختر أي النماذج تُتاح عبر البوابة'}
            </p>
          </div>
          <button onClick={close} aria-label="إغلاق" className="btn-ghost btn btn-sm p-1.5 text-ink-muted hover:text-ink">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* شريط النتيجة/الخطأ — يظهر في كل الخطوات حتى لا يفشل الحفظ بصمت */}
        {testResult && (
          <div className={cn(
            'mx-5 mt-4 p-3 rounded-lg border text-sm flex items-start gap-2',
            testResult.ok ? 'border-ok/40 bg-ok/10 text-ok' : 'border-bad/40 bg-bad/10 text-bad'
          )}>
            {testResult.ok
              ? <Check className="w-4 h-4 shrink-0 mt-0.5" />
              : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
            <span className="font-mono text-xs break-words">
              {testResult.ok
                ? `نجح الاتصال · ${testResult.latencyMs} م.ث` + (testResult.statusCode ? ` · HTTP ${testResult.statusCode}` : '')
                : (testResult.error || 'خطأ غير معروف')}
            </span>
          </div>
        )}

        {step === 'form' ? (
          <div className="p-5 space-y-5">
            {/* Quick presets */}
            <div>
              <label className="flex items-center gap-1.5 text-[11px] uppercase text-ink-muted font-semibold tracking-wider mb-2">
                <Sparkles className="w-3 h-3" /> Quick Presets
                <span className="text-[10px] normal-case tracking-normal text-ink-dim font-normal">
                  {catalogData?.providers?.length ? `من الكتالوج (${quickPresets.length} متاح)` : 'احتياطي محلي'}
                </span>
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-52 overflow-y-auto pr-1">
                {quickPresets.map(p => (
                  <div
                    key={p.id}
                    onClick={() => applyPreset(p)}
                    className={cn(
                      'px-3 py-2 text-xs rounded-lg text-left transition-all cursor-pointer',
                      'bg-surface-2 border border-line hover:border-primary hover:bg-primary/5',
                      'flex flex-col gap-0.5 group relative'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-ink">{p.name}</span>
                      {p.signupUrl && (
                        <a
                          href={p.signupUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-primary-2"
                          title="Get API key"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                    {p.free && <span className="text-[9px] text-ok font-medium">FREE TIER</span>}
                  </div>
                ))}
              </div>
            </div>

            <div className="h-px bg-line/50" />

            {/* ID */}
            <div>
              <label className="flex items-center gap-1.5 text-[11px] uppercase text-ink-muted font-semibold tracking-wider mb-1.5">
                ID <span className="text-ink-dim normal-case font-normal">(unique slug)</span>
              </label>
              <input
                className="input" value={id}
                onChange={e => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-'))}
                placeholder="my-provider"
              />
              {id && (
                <p className="text-[10px] text-ink-dim mt-1 font-mono">
                  Env: <code className="text-primary-2">{envVarName}</code>
                </p>
              )}
              {idExists && (
                <p className="text-[11px] text-warn mt-1.5 flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  هذا المعرّف موجود مسبقاً — الحفظ سيُحدّث المزود الحالي بدل إنشاء واحد جديد.
                </p>
              )}
            </div>

            {/* Name */}
            <div>
              <label className="block text-[11px] uppercase text-ink-muted font-semibold tracking-wider mb-1.5">Display Name</label>
              <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="My Provider" />
            </div>

            {/* Base URL */}
            <div>
              <label className="flex items-center gap-1.5 text-[11px] uppercase text-ink-muted font-semibold tracking-wider mb-1.5">
                <Globe className="w-3 h-3" /> Base URL
              </label>
              <input className="input font-mono" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1" />
            </div>

            {/* API Key */}
            <div>
              <label className="flex items-center gap-1.5 text-[11px] uppercase text-ink-muted font-semibold tracking-wider mb-1.5">
                <Key className="w-3 h-3" /> API Key
                <span className="text-ink-dim normal-case font-normal">
                  {isEdit
                    ? (editTarget!.hasKey ? '(محفوظ — اكتب قيمة جديدة للاستبدال)' : '(لا يوجد مفتاح محفوظ)')
                    : '(optional)'}
                </span>
              </label>
              <div className="flex gap-1.5">
                <input
                  type="password" className="input font-mono flex-1" value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={isEdit ? "••••••••" : "sk-..."}
                />
                {isEdit && editTarget!.hasKey && (
                  <button
                    type="button"
                    onClick={() => setApiKey('__clear__')}
                    className="btn btn-sm text-bad border-bad/30 hover:bg-bad/5"
                    title="احذف المفتاح الحالي من المزود"
                  >
                    حذف المفتاح
                  </button>
                )}
              </div>
              {apiKey === '__clear__' && (
                <div className="text-[11px] text-bad bg-bad/10 border border-bad/20 rounded mt-1.5 px-2 py-1">
                  ⚠ سيُحذف المفتاح الحالي عند الحفظ — المزود يصير keyless
                </div>
              )}
              {apiKey && apiKey !== '__clear__' && id && (
                <div className="text-[11px] text-ink-dim mt-1.5 flex items-center gap-1.5">
                  <Check className="w-3 h-3 text-ok" />
                  يُخزَّن مشفّراً في <code className="bg-surface-2 px-1.5 py-0.5 rounded text-primary-2">data/gateway.db</code> — متغيّر البيئة: <code className="bg-surface-2 px-1.5 py-0.5 rounded text-primary-2">{envVarName}</code>
                </div>
              )}
            </div>

            {/* Tier */}
            <div>
              <label className="block text-[11px] uppercase text-ink-muted font-semibold tracking-wider mb-1.5">Priority Tier</label>
              <div className="grid grid-cols-4 gap-1.5">
                {[1, 2, 3, 4].map(t => (
                  <button
                    key={t}
                    onClick={() => setTier(t)}
                    className={cn(
                      'px-2 py-2 text-xs rounded-lg border transition-all',
                      tier === t
                        ? 'border-primary bg-primary/10 text-primary-2 font-semibold'
                        : 'border-line bg-surface-2 text-ink-muted hover:border-line-hover'
                    )}
                  >
                    T{t}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-ink-dim mt-1.5">
                T1 paid → T2 cheap → T3 fallback → T4 free. Lower = tried first.
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 pt-2">
              <button onClick={test} disabled={!baseUrl || testing} className="btn flex-1">
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Test'}
              </button>
              <button onClick={fetchModels} disabled={!baseUrl || fetchingModels} className="btn btn-primary flex-1">
                {fetchingModels ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Fetch Models →'}
              </button>
            </div>

            <div className="flex gap-2 pt-2 border-t border-line/50">
              <button onClick={close} className="btn flex-1">Cancel</button>
              <button
                onClick={save} disabled={!id || !name || !baseUrl || saving}
                className="btn btn-primary flex-1"
              >
                {saving
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> جارٍ الحفظ…</>
                  : (isEdit ? 'تحديث المزود' : idExists ? 'تحديث المزود الموجود' : 'حفظ المزود')}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <button
                onClick={testAllModels}
                disabled={availableModels.length === 0 || testing}
                className="btn btn-sm btn-primary"
              >
                {testing ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Testing...</> : <><Layers className="w-3.5 h-3.5" /> Test All</>}
              </button>
              <span className="text-xs text-ink-muted">
                {availableModels.length} نموذج · {okModelsCount} ناجح
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-96 overflow-y-auto pr-1">
              {availableModels.map(m => (
                <label
                  key={m.id}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border cursor-pointer transition-all',
                    m.status === 'ok'
                      ? 'border-ok bg-ok/10'
                      : 'border-line bg-surface-2 hover:border-line-hover'
                  )}
                >
                  <input
                    type="checkbox" checked={m.status === 'ok'}
                    disabled
                    readOnly
                    title="يُدار تلقائياً من نتيجة الفحص — النموذج الذي يرد فعلاً يُختار للحفظ"
                    className="accent-primary w-3.5 h-3.5 opacity-80"
                  />
                  <span className="font-mono text-xs truncate flex-1">{m.id}</span>
                  {m.latencyMs !== undefined && (
                    <span className="text-[10px] text-ink-dim font-mono">
                      {m.latencyMs}ms
                    </span>
                  )}
                  {m.status && (
                    <span className={cn(
                      // الأحمر/الأخضر مع تباين كافٍ على الخلفية الداكنة
                      'text-[11px] font-bold px-1.5 py-0.5 rounded',
                      m.status === 'ok' ? 'bg-ok/20 text-ok' : 'bg-bad/20 text-bad'
                    )}>
                      {m.status === 'ok' ? 'يعمل' : 'فشل'}
                    </span>
                  )}
                </label>
              ))}
            </div>

            <div className="flex gap-2 pt-3 border-t border-line/50">
              <button onClick={() => setStep('form')} className="btn">
                {/* في RTL «رجوع» يشير يميناً — السهم الأيسر كان يقلب الاتجاه */}
                <ArrowRight className="w-3.5 h-3.5" /> رجوع
              </button>
              <button
                onClick={save} disabled={saving || testing}
                className="btn btn-primary flex-1"
              >
                {saving
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> جارٍ الحفظ…</>
                  : saveLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}