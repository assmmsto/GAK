// src/lib/api.ts — typed API client
export interface KeySummary {
  total: number; available: number; exhausted: number; invalid: number;
}

export interface ProviderKeyInfo {
  id: number; label: string; masked: string; enabled: boolean;
  status: string; blockedUntil: number | null; blocked: boolean;
  requests: number; live: boolean;
}

export interface CatalogEntry {
  id: string; name: string; baseUrl: string;
  apiKeyEnv?: string | null; tier?: number; free?: boolean;
  keyless?: boolean; signupUrl?: string | null; configured?: boolean;
}

export interface TokenSettings {
  cacheEnabled: boolean; cacheTtlSec: number;
  trimToolOutputs: boolean; maxToolChars: number;
  contextWindow: number; maxTokensCeiling: number;
  cacheSize: number; cacheHits: number; cacheMisses: number;
}

export interface ImportLineResult {
  raw: string; provider?: string | null; status: string; reason?: string;
}
export interface ImportResult {
  dryRun: boolean; total: number; imported: number; needsAttention: number;
  results: ImportLineResult[];
}

export interface Provider {
  id: string;
  name: string;
  tier: number;
  baseUrl: string;
  status: string;
  lastError?: string;
  lastChecked: number;
  hasKey: boolean;
  keyless?: boolean;
  enabled?: boolean;
  apiKeyEnv?: string | null;
  blockedUntil?: number | null;
  keys?: KeySummary;
  signupUrl?: string | null;
  free?: boolean;
}

export interface Status {
  uptime: number;
  startTime: number;
  providers: Provider[];
  stats: { total: number; success: number; error: number };
  usage: Array<{ provider: string; requests: number; tokens: number }>;
}

export interface LogEvent {
  id: number;
  ts: number;
  type: string;
  provider?: string;
  key_id?: string;
  model?: string;
  status?: string;
  latency_ms?: number;
  error?: string;
  meta?: string;
}

export interface Model {
  id: string;
  object: string;
  owned_by: string;
  _provider: string;
  _tier: number;
  _upstream_id: string;
}

// ===== توكن الإدارة =====
// لا تُخزَّن قيمة سرية في JS إطلاقاً: التوكن يُستبدل بكوكي HttpOnly عبر
// POST /api/auth — غير مقروء من سكربتات الصفحة (تحصين ضد سرقته عبر XSS).
function initAdminToken() {
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('token');
    if (!t) return;
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t })
    }).catch(() => {});
    // نظّف ما كان يُخزَّن في النسخ القديمة (توكن في localStorage كان قابلاً للسرقة)
    localStorage.removeItem('gw_admin_token');
  } catch { /* بيئة بلا window */ }
}
initAdminToken();

// رسالة الخطأ قد تصل كنص ({error: "..."}) أو ككائن ({error: {message}})
// بدون هذا تُستبدل كل رسائل الخادم بنص الحالة العام مثل "Conflict"
function errorMessage(err: any, fallback: string): string {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err.error === 'string') return err.error;
  return err.error?.message || err.message || fallback;
}

// الكوكي HttpOnly يُرسَل تلقائياً مع كل طلب نفس الأصل — لا ترويسة يدوية
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers as any) }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessage(err, res.statusText));
  }
  return res.json();
}

// مفتاح تلقائي للواجهة نفسها (الـ dashboard يستخدم /v1 بدون ما المستخدم يكتب مفتاح)
// المفتاح الكامل لا يخرج من القاعدة بعد إنشائه (تُخزَّن hash) — لذا تحفظه الواجهة
// محلياً عند أول إنشاء.
const UI_KEY_STORAGE = 'gw_ui_key';
let _uiKey = '';
export async function getUiKey(): Promise<string> {
  if (_uiKey) return _uiKey;
  try {
    _uiKey = localStorage.getItem(UI_KEY_STORAGE) || '';
  } catch { /* بيئة بلا localStorage */ }
  if (_uiKey) return _uiKey;
  // لا إنشاء تلقائي: كان كل متصفح بلا تخزين محلي (وضع خاص، متصفح آخر، مسح
  // البيانات) ينشئ مفتاحاً جديداً باسم «playground <وقت>» لا يعود إليه أحد —
  // تضخّم في api_keys بلا فائدة. المفتاح يُنشأ مرة واحدة صراحةً من قائمة
  // المفاتيح، فإن لم يوجد يعمل التبويب بمفتاح يدوي.
  return '';
}

/**
 * يضمن وجود مفتاح واجهة: يعيد المخزَّن، وإلا ينشئ واحداً **مرة واحدة** ويحفظه.
 * يُستدعى فقط عند إجراء صريح من المستخدم (تشغيل في الملعب)، لا في تحميل الصفحة.
 */
export async function ensureUiKey(): Promise<string> {
  const existing = await getUiKey();
  if (existing) return existing;
  const created = await api.createKey('playground');
  _uiKey = created.key || '';
  if (_uiKey) {
    try { localStorage.setItem(UI_KEY_STORAGE, _uiKey); } catch { /* لا تخزين — يبقى في الذاكرة */ }
  }
  return _uiKey;
}

/** المفتاح المخزَّن للواجهة (إن وُجد) — لعرضه في تفاصيل الاتصال السريع. */
export function storedUiKey(): string {
  try { return localStorage.getItem(UI_KEY_STORAGE) || ''; } catch { return ''; }
}

// نسخة من req بس تضيف المفتاح على طلبات /v1
async function reqAuth<T>(path: string, init?: RequestInit): Promise<T> {
  const key = await getUiKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessage(err, res.statusText));
  }
  return res.json();
}

export interface ApiKey {
  id: number; key: string; name: string; ts: number;
  last_used?: number | null; requests?: number;
}

// ===== أنواع واجهة الوكلاء =====
export type TaskState = {
  name: string; intervalMs: number; enabled: boolean; running: boolean;
  lastRun: number | null; lastMs: number | null; lastOk: boolean | null; lastError: string | null;
  runs: number; failures: number; skipped: number; nextDueInMs: number | null;
};

export type SourceStatus = {
  id: string; label: string; priority: number;
  configured: boolean; ok: boolean | null;
  entries: number; error: string | null; latencyMs: number | null; lastSync: number | null;
};

export type AgentKeyCircuit = {
  id: number; provider: string; keyFp: string | null; source: string; authority: number;
  status: string; enabled: boolean; state: 'closed' | 'open' | 'half-open';
  score: number; requests: number; blockedUntil: number | null; retryInMs: number | null;
  needsResync: boolean;
};

export type RotationAudit = {
  id: number; ts: number; provider: string; key_id: number | null; key_fp: string | null;
  action: string; reason: string | null; from_source: string | null; to_source: string | null;
  ok: number; detail: string;
};

export type AgentsStatus = {
  scheduler: { running: boolean; tickMs: number; uptimeMs: number; tasks: TaskState[] };
  rotation: { total: number; closed: number; open: number; halfOpen: number; needsResync: number };
  sources: SourceStatus[];
};

export type SyncAction = 'added' | 'reactivated' | 'authority' | 'withdrawn' | 'skipped-manual' | 'error';
export type SyncCounts = Record<SyncAction, number>;

export type SyncResult = {
  ok: boolean; durationMs: number; counts: SyncCounts;
  desiredKeys: number; currentKeys: number;
  sources: SourceStatus[];
  actions: Array<{ provider: string; action: SyncAction; source: string | null; keyFp: string | null; reason: string | null }>;
};

export type RotateResult = {
  ok: boolean; durationMs: number;
  counts: { closed: number; open: number; halfOpen: number; needsResync: number };
  isolatedProviders: string[];
};

export interface KeysResponse {
  keys: ApiKey[];
  baseUrl: string;
}

export interface KeyStatsModel {
  model: string; requests: number; tokens: number;
  prompt: number; completion: number; avgMs: number;
}
export interface KeyStats {
  models: KeyStatsModel[];
  series: Array<{ ts: number; n: number; tokens: number }>;
}

// ===== أنواع فحص النماذج =====
// provider_auth: مشكلة في مفتاح المزود — لا تعني أن النموذج ميت، فلا يُحجب
export type ProbeStatus = 'ok' | 'rejected' | 'provider_auth' | 'rate_limited' | 'slow' | 'no_key';
export type ProbeReason = 'auth' | 'not_found' | 'quota' | 'timeout' | 'server' | 'format' | 'unknown';

export interface ProbeResult {
  provider: string;
  model: string;
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
  reason?: ProbeReason;
}

export interface PingResult {
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  authValid: boolean;
  error?: string;
}

export interface ProbeRow {
  id: number;
  provider: string;
  model: string;
  status: ProbeStatus;
  latency_ms: number;
  error: string | null;
  checked_at: number;
}

// ===== حالة كل مفتاح في جدول واحد (GET /api/health) =====
// تُجيب سؤال "أي مفتاح ميت؟" بلا فتح كل مزود على حدة
export type HealthStatus = 'ok' | 'unknown' | 'quota_exhausted' | 'auth_error';

export interface HealthKey {
  id: number;
  provider: string;
  providerStatus: string;
  label: string | null;
  masked: string;
  enabled: boolean;
  status: HealthStatus;
  /** الحالة كما هي في القاعدة — تختلف عن `status` إن استُنتجت من الخطأ */
  storedStatus: string;
  statusInferred: boolean;
  blocked: boolean;
  blockedUntil: number | null;
  retryInMs: number | null;
  requests: number;
  lastUsed: number | null;
  lastError: string | null;
  modelsOk: number;
  modelsRejected: number;
  modelsTotal: number;
}

export interface HealthResponse {
  generatedAt: number;
  counts: {
    total: number; auth_error: number; quota_exhausted: number;
    unknown: number; ok: number; enabled: number;
  };
  keys: HealthKey[];
}

export const api = {
  status: () => req<Status & { drift?: { ts: number; models: number; upProviders: number; authErrors: string[] } }>('/api/status'),
  health: () => req<HealthResponse>('/api/health'),
  // فحص مفتاح واحد بمفتاحه بالذات — يعمل حتى لمزود غير مفعّل في providers.yaml
  probeHealthKey: (keyId: number) =>
    req<{ provider: string; model: string; status: string; latencyMs: number; error?: string; keyId: number }>(
      `/api/health/${keyId}/probe`, { method: 'POST', body: '{}' }
    ),
  providers: () => req<{ providers: Provider[] }>('/api/providers'),
  logs: (limit = 100) => req<{ events: LogEvent[] }>(`/api/logs?limit=${limit}`),
  usage: () => req<{ usage: any[] }>('/api/usage'),
  models: () => reqAuth<{ data: Model[]; _meta?: { total: number; hidden: number; hiddenList: Array<{ provider: string; model: string; reason: string }> } }>('/v1/models'),
  test: (providerId?: string) =>
    req<{ ok: boolean; latencyMs: number; statusCode?: number; error?: string }>('/api/test', {
      method: 'POST',
      body: JSON.stringify(providerId ? { providerId } : {})
    }),
  testAll: () => req<{ results: any[] }>('/api/test', { method: 'POST', body: '{}' }),
  testConnection: (baseUrl: string, apiKey?: string) =>
    req<{ ok: boolean; latencyMs: number; statusCode?: number; error?: string }>(
      '/api/providers/test-connection', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey }) }
    ),
  fetchModels: (baseUrl: string, apiKey?: string) =>
    req<{ count: number; models: Array<{ id: string; owned_by?: string }> }>(
      '/api/providers/fetch-models', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey }) }
    ),
  addProvider: (data: {
    id: string; name: string; baseUrl: string; apiKey?: string;
    tier?: number; format?: 'openai' | 'anthropic'; models?: string[];
  }) => req<{ ok: boolean; provider: any }>(
    '/api/providers/add', { method: 'POST', body: JSON.stringify(data) }
  ),
  deleteProvider: (id: string) =>
    req<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' }),
  editProvider: (id: string, data: { name?: string; baseUrl?: string; tier?: number; apiKey?: string; models?: string[] }) =>
    req<{ ok: boolean; provider: any }>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  toggleProvider: (id: string, enabled: boolean) =>
    req<{ ok: boolean; enabled: boolean }>(`/api/providers/${id}/toggle`, {
      method: 'POST', body: JSON.stringify({ enabled })
    }),
  keys: () => req<KeysResponse>('/api/keys'),

  // ===== الكتالوج الموحّد =====
  catalog: () => req<{ providers: CatalogEntry[]; keyPatterns: Array<{ prefix: string; provider: string | null }>; count: number }>('/api/catalog'),

  // ===== مفاتيح المزودات (متعددة مع تدوير) =====
  providerKeys: (id: string) =>
    req<{ provider: string; keys: ProviderKeyInfo[]; summary: KeySummary }>(`/api/providers/${encodeURIComponent(id)}/keys`),
  addProviderKeys: (id: string, keys: string[], label?: string) =>
    req<{ ok: boolean; added: number; duplicates: number; keys: ProviderKeyInfo[]; summary: KeySummary }>(
      `/api/providers/${encodeURIComponent(id)}/keys`,
      { method: 'POST', body: JSON.stringify({ keys, label }) }
    ),
  updateProviderKey: (id: string, keyId: number, patch: { label?: string; enabled?: boolean; key?: string; reactivate?: boolean }) =>
    req<{ ok: boolean; keys: ProviderKeyInfo[]; summary: KeySummary }>(
      `/api/providers/${encodeURIComponent(id)}/keys/${keyId}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),
  deleteProviderKey: (id: string, keyId: number) =>
    req<{ ok: boolean; keys: ProviderKeyInfo[]; summary: KeySummary }>(
      `/api/providers/${encodeURIComponent(id)}/keys/${keyId}`, { method: 'DELETE' }
    ),

  // ===== الاستيراد الجماعي =====
  importProviders: (text: string, dryRun = false) =>
    req<ImportResult>('/api/providers/import', { method: 'POST', body: JSON.stringify({ text, dryRun }) }),

  // ===== إعدادات توفير الرموز =====
  settings: () => req<{ settings: TokenSettings }>('/api/settings'),
  updateSettings: (patch: Partial<TokenSettings> & { clearCache?: boolean }) =>
    req<{ ok: boolean; settings: TokenSettings }>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  keyStats: (id: number) => req<KeyStats>(`/api/keys/${id}/stats`),
  createKey: (name: string) => req<ApiKey>('/api/keys', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteKey: (id: number) => req<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),
  regenerateKey: (id: number) => req<ApiKey>(`/api/keys/${id}/regenerate`, { method: 'POST' }),

  // ===== فحص النماذج (الفرز) =====
  // نتائج الفحص المحفوظة + الملخّص (يقرأهما تبويب فرز النماذج)
  probeResults: (provider?: string) =>
    req<{ probes: ProbeRow[]; summary: Record<string, number>; total: number }>(
      provider ? `/api/probe/results?provider=${encodeURIComponent(provider)}` : '/api/probe/results'
    ),
  // فحص كل نماذج مزود واحد
  probeAll: (providerId: string, cap = 50) =>
    req<{ provider: string; tested: number; ok: number; results: ProbeResult[]; note?: string }>(
      `/api/probe/${encodeURIComponent(providerId)}/all?cap=${cap}`, { method: 'POST', body: '{}' }
    ),
  probePing: (baseUrl: string, apiKey?: string) =>
    req<PingResult>('/api/probe/ping', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey }) }),
  probeModels: (baseUrl: string, apiKey?: string) =>
    req<{ count: number; models: Array<{ id: string }> }>('/api/probe/models', {
      method: 'POST', body: JSON.stringify({ baseUrl, apiKey })
    }),
  probeOne: (providerId: string, model: string) =>
    req<ProbeResult>(`/api/probe/${encodeURIComponent(providerId)}/model/${encodeURIComponent(model)}`, { method: 'POST', body: '{}' }),
  probeConnect: (baseUrl: string, apiKey: string | undefined, model: string) =>
    req<{ provider: string; model: string; status: string; latencyMs: number; error?: string }>(
      '/api/probe/connect', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, model }) }
    ),
  probeClear: (provider?: string) =>
    req<{ ok: boolean }>(
      provider ? `/api/probe/results?provider=${provider}` : '/api/probe/results',
      { method: 'DELETE' }
    ),
  probeRetryRejected: (provider?: string) =>
    req<{ tested: number; recovered?: number; results: ProbeResult[] }>(
      provider
        ? `/api/probe/retry-rejected?provider=${provider}`
        : `/api/probe/retry-rejected`,
      { method: 'POST', body: '{}' }
    ),
  probeEverything: (cap = 8) =>
    req<{ tested: number; ok: number; providers: number; results: ProbeResult[] }>(
      `/api/probe/everything?cap=${cap}`,
      { method: 'POST', body: '{}' }
    ),
  drift: (sinceMs?: number) => req<{
    sinceMs: number;
    current: { models: number; up: number; auth: string[] };
    previous?: { models: number; up: number; auth: string[]; ts: number };
    deltas?: { models: number; up: number };
    newAuthErrors?: string[];
    resolvedAuth?: string[];
  }>(sinceMs ? `/api/drift?sinceMs=${sinceMs}` : '/api/drift'),

  agentsStatus: (init?: RequestInit) => req<AgentsStatus>('/api/agents/status', init),
  agentsSync: (init?: RequestInit) => req<SyncResult>('/api/agents/sync', init),
  agentsRotate: (init?: RequestInit) => req<RotateResult>('/api/agents/rotate', init),
  agentsKeys: (init?: RequestInit) => req<{ keys: AgentKeyCircuit[] }>('/api/agents/keys', init),
  agentsAudit: (params?: { limit?: number; provider?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.provider) q.set('provider', params.provider);
    const qs = q.toString();
    return req<{ rotations: RotationAudit[] }>(`/api/agents/audit${qs ? `?${qs}` : ''}`);
  },

  // explicitKey: المفتاح الذي كتبه المستخدم في الملعب — يتقدّم على مفتاح الواجهة.
  // بلا مفتاح صريح يُنشأ مفتاح الواجهة **مرة واحدة** (ensureUiKey) بقرار صريح من
  // المستخدم بضغط «أرسل»، لا بمجرد تحميل الصفحة.
  chat: async (body: any, onChunk?: (chunk: string) => void, explicitKey?: string) => {
    const key = explicitKey || await ensureUiKey();
    const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) authHeaders['Authorization'] = `Bearer ${key}`;
    const fail = async (res: Response, kind: string) => {
      const err = await res.json().catch(() => ({}));
      throw new Error(errorMessage(err, `${kind} — ${res.status} ${res.statusText}`));
    };
    if (onChunk) {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ...body, stream: true })
      });
      if (!res.ok || !res.body) await fail(res, 'فشل الطلب المتدفّق');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder('utf-8'); // stream=true يحافظ على الحروف متعددة البايت
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // value = بايتات خام. الـ decoder بخاصية stream يحفظ البايتات الناقصة
        // لحتى يجي الباقي، فالحروف العربية ما تتكسر
        const text = decoder.decode(value, { stream: true });
        full += text;
        onChunk(text);
      }
      return full;
    }
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(body)
    });
    // كان يتجاهل res.ok فيعيد كائن خطأ كأنه نجاح؛ الآن يرمي الرسالة الفعلية.
    if (!res.ok) await fail(res, 'فشل الطلب');
    return res.json();
  }
};
