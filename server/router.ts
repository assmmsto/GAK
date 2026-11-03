// server/router.ts — routing + failover على مستويين: المفتاح ثم المزود
import { createHash } from 'node:crypto';
import { OpenAIProvider } from './provider.js';
import { scoreKey, type KeyScoreInput } from './key-score.js';
import { sanitizeErrorMessage } from './security.js';
import { OK_STALE_MS } from './probe.js';
import type { Config } from './config.js';
import type { EventDB } from './db.js';
import { noteStoreWriteFailure } from './db.js';

export interface RouteResult {
  ok: boolean; status: number; data?: any; stream?: any; headers?: any;
  providerId?: string; keyId?: string; model?: string; usage?: any;
  error?: string; attempts?: any[];
  _substituted?: { requested: string; actual: string; providerId: string };
}

// مفتاح واحد من مفاتيح مزود — له حالته الخاصة وعميله المستقل
export interface KeySlot {
  id: number | null;
  key: string;
  label: string;
  enabled: boolean;
  status: string;              // unknown | ok | quota_exhausted | auth_error
  blockedUntil?: number;
  requests: number;
  client: OpenAIProvider;
}

interface ProviderEntry {
  provider: OpenAIProvider;
  meta: any;
  status: string;
  enabled: boolean;
  lastError?: string;
  lastChecked: number;
  blockedUntil?: number;
  cachedModel?: string;
  knownModels?: string[];
  knownModelsAt?: number;
  transientErrors?: number;
  keys: KeySlot[];
}

// عزل المفتاح المنتهي حصته: 5 دقائق ثم يُجرَّب مجدداً
const KEY_QUOTA_BLOCK_MS = 5 * 60 * 1000;
// حصة مستنفدة **دائماً** ("monthly allowance used up", "insufficient_quota")
// لا تعود بعد 5 دقائق بل بعد أسبوع/شهر — العزل القصير كان يُبقي الموجّه يقرع
// المفتاح الميت كل 5 دقائق (قِيسَ: 314 طلباً فاشلاً على مفتاح واحد).
const KEY_QUOTA_PARKED_MS = 6 * 60 * 60 * 1000; // 6 ساعات
// دلالات النفاد الدائم **الدقيقة** — لا كلمات عامة مثل «top up» أو «balance»:
// رسالة ضغط التزامن من مزود (model_concurrency "…admitted first. Top up at…")
// طابقت «top up» فعُزلت 14 مفتاحاً سليماً 6 ساعات وأوقف النظام (خلل مُصلَح).
// الأولوية دائماً لكشف العابر: ضغط تزامن/إعادة محاولة ⇒ عزل قصير مهما بدا النص.
const TRANSIENT_RATE_RE = /concurrency|capacity|admitted first|try again|retry|temporarily|overloaded|slow down/i;
const PERMANENT_QUOTA_RE = /insufficient_quota|exhausted your current quota|allowance\s+(is\s+)?used\s+up|monthly allowance|out of credits/i;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
// صلاحية نتيجة الفحص: بعدها لا يُحجب النموذج — قد يكون المزود عاد أو تغيّر النموذج.
// بلا هذا، نموذج رُفض قبل شهر يبقى محجوباً للأبد بلا أي طريق للعودة.
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

const NON_CHAT_MODEL_RE = /translate|embedding|rerank|whisper|tts|stt|moderation|guard|content-safety|tiny-aya/i;

function maskKey(k: string): string {
  if (!k) return 'بلا مفتاح';
  // المفاتيح القصيرة لا تُكشف جزئياً — قد يكفي الجزء الظاهر لتخمينها
  if (k.length <= 12) return '••••••';
  return `${k.slice(0, 5)}…${k.slice(-4)}`;
}

export class Router {
  private providers = new Map<string, ProviderEntry>();

  // إعدادات التوجيه من providers.yaml — كانت مُعرَّفة في config.ts ولا يقرأها أحد،
  // فـmaxRetries و maxConcurrent و timeoutMs كانت زينة معطّلة. نقرأها هنا فعلاً.
  private readonly maxConcurrent: number;
  private readonly deadlineMs: number;
  private readonly maxRetries: number;

  constructor(config: Config, private db: EventDB) {
    const routing: any = (config as any).routing || {};
    // سقف التزامن لكل مزود — يمنع إغراق مزود واحد بمئات الطلبات المتوازية
    this.maxConcurrent = Math.max(1, Number(routing.maxConcurrent) || 20);
    // مهلة شاملة للطلب كله (كل المحاولات). كانت غائبة تماماً: بلا سقف،
    // أسوأ حالة = 18 مزوداً × محاولتا نموذج × 60 ثانية = 36 دقيقة تعليق.
    this.deadlineMs = Math.max(15_000, Number(routing.timeoutMs) || 60_000);
    // أقصى عدد مزودات نجرّبها في الطلب الواحد. كان مُعرَّفاً ولا يُقرأ.
    this.maxRetries = Math.max(1, Number(routing.maxRetries) || 3);

    for (const p of config.providers) {
      const fromEnv = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
      const apiKey = p.apiKey || fromEnv || undefined;
      this.providers.set(p.id, {
        provider: new OpenAIProvider(p.id, p.name, p.baseUrl, apiKey, p.tier, p.format, p.headers),
        meta: p, status: 'unknown', lastChecked: 0, enabled: p.enabled !== false,
        keys: [this.makeSlot(p, { key: apiKey || '', label: apiKey ? maskKey(apiKey) : 'بلا مفتاح', status: 'unknown' })]
      });
    }
  }

  // عدّاد التزامن الجاري لكل مزود (يُطبَّق في chat عبر الحارس أدناه)
  private inflight = new Map<string, number>();
  // درجات صحة المفاتيح (من وكيل التدوير) — تجعل ترتيب الاختيار فعّالاً
  private keyScores = new Map<number, number>();

  private acquire(pid: string): boolean {
    const n = this.inflight.get(pid) || 0;
    if (n >= this.maxConcurrent) return false;
    this.inflight.set(pid, n + 1);
    return true;
  }

  private release(pid: string): void {
    const n = (this.inflight.get(pid) || 1) - 1;
    if (n <= 0) this.inflight.delete(pid); else this.inflight.set(pid, n);
  }

  // ===== عدّاد استخدام المفاتيح (مؤجَّل) =====
  // لماذا: `touchProviderKey` كان كتابة قاعدة لكل طلب ناجح. الآن نجمّع العدّ ونكتب
  // دفعة واحدة كل 5 ثوانٍ — نفس المعلومة بكتابة واحدة لكل مفتاح في نافذة النبضة.
  private pendingTouches = new Map<number, number>();
  private touchTimer: any = null;

  private deferTouch(keyId: number): void {
    this.pendingTouches.set(keyId, (this.pendingTouches.get(keyId) || 0) + 1);
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => { this.touchTimer = null; void this.flushTouches(); }, 5000);
    if (typeof this.touchTimer?.unref === 'function') this.touchTimer.unref();
  }

  /** يكتب عدّادات الاستخدام المعلّقة. عامّة لتُنادى من الاختبار وعند الإغلاق. */
  async flushTouches(): Promise<number> {
    if (!this.pendingTouches.size) return 0;
    const batch = [...this.pendingTouches.entries()];
    this.pendingTouches.clear();
    for (const [id, n] of batch) {
      try { await this.db.touchProviderKey(id, n); }
      catch (e) { noteStoreWriteFailure('touchProviderKey', e); }
    }
    return batch.length;
  }

  // ===== توفير الرموز + ذاكرة الردود المتطابقة =====
  private settings: Record<string, any> = {
    cacheEnabled: true,
    cacheTtlSec: 300,
    trimToolOutputs: true,
    maxToolChars: 2000,
    contextWindow: 0,
    maxTokensCeiling: 0
  };
  private responseCache = new Map<string, { at: number; payload: any }>();
  private cacheHits = 0;
  private cacheMisses = 0;

  async loadSettings(): Promise<void> {
    try {
      const rows = await this.db.getSettings();
      for (const [k, v] of Object.entries(rows)) {
        if (!(k in this.settings)) continue;
        this.settings[k] = typeof this.settings[k] === 'boolean' ? v === 'true'
          : typeof this.settings[k] === 'number' ? Number(v) || 0 : v;
      }
    } catch (e: any) {
      console.error('[settings] load failed:', e?.message || e);
    }
  }

  currentSettings() {
    return {
      ...this.settings,
      cacheSize: this.responseCache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses
    };
  }

  /**
   * تحويل قيمة منطقية قادمة من HTTP بأمان.
   * لماذا دالة؟ كان `!!v` ⇒ النص "false" يصبح `true` (خطأ صامت من الواجهة).
   */
  private toBool(v: any): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') { const s = v.trim().toLowerCase(); return s === 'true' || s === '1'; }
    return !!v;
  }

  /** عدد غير سالب ومعقول — لا NaN ولا قيم مهوِلة تُمرَّر للمزودين. */
  private toNum(v: any): number {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  applySettings(patch: Record<string, any>) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'clearCache') { this.responseCache.clear(); continue; }
      if (!(k in this.settings)) continue;
      if (typeof this.settings[k] === 'boolean') this.settings[k] = this.toBool(v);
      else if (typeof this.settings[k] === 'number') this.settings[k] = this.toNum(v);
      else this.settings[k] = v;
    }
  }

  private cacheKey(req: any): string {
    // يجب أن يشمل كل حقل يؤثر على الرد — وإلا أعدنا رداً مخزّناً لطلب مختلف
    const body = JSON.stringify({
      m: req.model || 'auto', msgs: req.messages,
      t: req.temperature ?? null, mt: req.max_tokens ?? null, tp: req.top_p ?? null,
      stop: req.stop ?? null, tools: req.tools ?? null, tc: req.tool_choice ?? null,
      rf: req.response_format ?? null, seed: req.seed ?? null, n: req.n ?? null,
      fp: req.frequency_penalty ?? null, pp: req.presence_penalty ?? null,
      u: req.user ?? null
    });
    return createHash('sha1').update(body).digest('hex');
  }

  private cacheGet(key: string): any | null {
    const hit = this.responseCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > Number(this.settings.cacheTtlSec) * 1000) {
      this.responseCache.delete(key);
      return null;
    }
    return hit.payload;
  }

  private cachePut(key: string, payload: any) {
    // سقف بسيط للذاكرة: نطرد الأقدم عند التجاوز
    if (this.responseCache.size > 500) {
      const oldest = [...this.responseCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
      for (const [k] of oldest) this.responseCache.delete(k);
    }
    this.responseCache.set(key, { at: Date.now(), payload });
  }

  // تقليم مخرجات الأدوات القديمة + نافذة سياق محدودة
  // هذه أكبر آليتين لتخفيف الاستهلاك في وكلاء البرمجة
  private prepareMessages(messages: any[]): { messages: any[]; trimmed: number; savedChars: number } {
    if (!Array.isArray(messages) || !messages.length) return { messages, trimmed: 0, savedChars: 0 };
    let out = messages;
    let savedChars = 0;
    let trimmed = 0;

    if (this.settings.trimToolOutputs) {
      const maxChars = Number(this.settings.maxToolChars) || 2000;
      const toolIdx: number[] = [];
      out.forEach((m, i) => { if (m?.role === 'tool' || m?.role === 'function') toolIdx.push(i); });
      // نُبقي آخر 3 مخرجات كاملة ونقلم ما قبلها فقط (لا نلمس السياق القريب)
      const keepFrom = toolIdx.length > 3 ? toolIdx[toolIdx.length - 3] : 0;
      out = out.map((m, i) => {
        if (!(m?.role === 'tool' || m?.role === 'function')) return m;
        if (i >= keepFrom) return m;
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        if (text.length <= maxChars) return m;
        savedChars += text.length - maxChars;
        trimmed++;
        return { ...m, content: text.slice(0, maxChars) + `\n…[قُلِّم ${text.length - maxChars} حرفاً لتوفير الرموز]` };
      });
    }

    const win = Number(this.settings.contextWindow) || 0;
    if (win > 0 && out.length > win + 1) {
      const sys = out.filter(m => m?.role === 'system');
      const rest = out.filter(m => m?.role !== 'system');
      const kept = rest.slice(-win);
      trimmed += rest.length - kept.length;
      out = [...sys.slice(0, 1), ...kept];
      // لا نترك استدعاء أدوات بلا نتائجه (المزودات ترفض الطلب بـ 400)
      while (out.length && out[out.length - 1]?.role === 'assistant' && Array.isArray(out[out.length - 1]?.tool_calls)) {
        out.pop();
      }
      // ولا نبدأ بنتيجة أداة يتيمة (فُقد استدعاؤها)
      let start = 0;
      while (start < out.length && (out[start]?.role === 'tool' || out[start]?.role === 'function')) start++;
      if (start > 0) out = out.slice(start);
    }

    return { messages: out, trimmed, savedChars };
  }

  // ===== المفاتيح =====
  private makeSlot(meta: any, k: any): KeySlot {
    return {
      id: k.id ?? null,
      key: k.key || '',
      label: k.label || maskKey(k.key || ''),
      enabled: k.enabled !== false && k.enabled !== 0,
      status: k.status || 'unknown',
      blockedUntil: k.blocked_until || k.blockedUntil || undefined,
      requests: Number(k.requests || 0),
      client: new OpenAIProvider(
        meta.id, meta.name || meta.id, meta.baseUrl, k.key || undefined,
        meta.tier ?? 4, meta.format || 'openai', meta.headers || {}
      )
    };
  }

  // نُحمّل المفاتيح من قاعدة البيانات، ونُهاجر مفتاح البيئة مرة واحدة ليكون مرئياً قابلاً للتحرير
  async loadProviderKeys(): Promise<void> {
    try {
      const rows = await this.db.listProviderKeys() as any[];
      const byProv = new Map<string, any[]>();
      for (const r of rows) {
        const arr = byProv.get(r.provider) || [];
        arr.push(r);
        byProv.set(r.provider, arr);
      }
      for (const [id, e] of this.providers) {
        const meta = e.meta || {};
        let list = byProv.get(id) || [];
        const envKey = meta.apiKeyEnv ? process.env[meta.apiKeyEnv] : undefined;
        // هجرة: مفتاح البيئة يُدخل مرة واحدة فقط إن لم يكن للمزود أي مفتاح في قاعدة البيانات
        if (envKey && list.length === 0) {
          try {
            const created = await this.db.addProviderKey(id, envKey, meta.apiKeyEnv);
            list = [...list, created];
          } catch { /* موجود مسبقاً */ }
        }
        e.keys = list.map(k => this.makeSlot(meta, k));
        // مزود يعمل بلا مفتاح (pollinations) → مفتاح افتراضي واحد
        if (!e.keys.length && !meta.apiKeyEnv) {
          e.keys = [this.makeSlot(meta, { key: '', label: 'بلا مفتاح', status: 'ok' })];
        }
        this.refreshPrimary(e);
      }
    } catch (e: any) {
      console.error('[provider-keys] load failed:', e?.message || e);
    }
  }

  // نعيد بناء مفاتيح مزود بعد تغييرها من الواجهة
  async reloadProviderKeys(pid: string): Promise<void> {
    const e = this.providers.get(pid);
    if (!e) return;
    const meta = e.meta || {};
    const rows = await this.db.listProviderKeys(pid) as any[];
    e.keys = rows.map(k => this.makeSlot(meta, k));
    if (!e.keys.length && !meta.apiKeyEnv) {
      e.keys = [this.makeSlot(meta, { key: '', label: 'بلا مفتاح', status: 'ok' })];
    }
    // مسح حالة المزود ليُعاد تقييمه
    if (e.status === 'auth_error' || e.status === 'quota_exhausted') {
      e.status = 'unknown';
      e.lastError = undefined;
      e.blockedUntil = undefined;
    }
    this.refreshPrimary(e);
  }

  // العميل الأساسي (يُستخدم لجلب النماذج والفحص) = أول مفتاح **متاح** فعلاً،
  // وليس أول مفتاح مُفعَّل — وإلا استُخدم مفتاح منتهي الحصة في اختفاء نماذج المزود
  private refreshPrimary(e: ProviderEntry) {
    const slot = this.availableKeySlots(e)[0] || e.keys.find(k => k.enabled) || e.keys[0];
    if (slot) e.provider = slot.client;
  }

  // المفاتيح المتاحة الآن لهذا المزود (مُفعَّلة وغير معزولة) — مرتَّبة **بالصحة**.
  // كان الترتيب بترتيب الإدراج (id) ⇒ مفتاح مُتعَب يسبق مفتاحاً حيّاً.
  // الوكيل يرفع الدرجات عبر setKeyScores؛ ودونها يبقى السلوك القديم (id) كما هو.
  availableKeySlots(e: any): KeySlot[] {
    if (!e || !Array.isArray(e.keys)) return [];
    const now = Date.now();
    const slots: KeySlot[] = e.keys.filter((s: KeySlot) => {
      if (!s.enabled) return false;
      if (s.status === 'auth_error') return false;
      if (s.blockedUntil && now < s.blockedUntil) return false;
      return true;
    });
    if (slots.length < 2) return slots;
    return slots.sort((a, b) => this.slotScore(b, now) - this.slotScore(a, now) || (a.id ?? 0) - (b.id ?? 0));
  }

  /** درجة مُدفوعة من الوكيل؛ بلا درجة نحسبها لحظياً من حالة الفتحة (نفس القاعدة). */
  private slotScore(s: KeySlot, now: number): number {
    const cached = s.id != null ? this.keyScores.get(s.id) : undefined;
    if (cached !== undefined) return cached;
    const row: KeyScoreInput = {
      id: s.id, status: s.status, enabled: s.enabled,
      requests: s.requests, blockedUntil: s.blockedUntil
    };
    return scoreKey(row, now).score;
  }

  /** يدفع وكلاء التدوير الدرجات ليصبح الترتيب **فعّالاً** لا تقريرياً. */
  setKeyScores(scores: Iterable<{ id: number; score: number }>): void {
    this.keyScores.clear();
    for (const s of scores) {
      if (s && Number.isFinite(s.id) && Number.isFinite(s.score)) this.keyScores.set(Number(s.id), Number(s.score));
    }
  }

  // نوقظ المفاتيح التي انتهت مدة عزلها
  private wakeKeySlots(e: ProviderEntry) {
    const now = Date.now();
    for (const s of e.keys) {
      if (s.blockedUntil && now >= s.blockedUntil) {
        s.blockedUntil = undefined;
        if (s.status === 'quota_exhausted') s.status = 'unknown';
        if (s.id) this.db.updateProviderKey(s.id, { status: 'unknown', blockMs: null }).catch((e) => noteStoreWriteFailure('updateProviderKey', e));
      }
    }
  }

  keySummary(e: any) {
    const keys: KeySlot[] = Array.isArray(e?.keys) ? e.keys : [];
    const now = Date.now();
    return {
      total: keys.length,
      available: this.availableKeySlots(e).length,
      exhausted: keys.filter(k => k.status === 'quota_exhausted' && k.blockedUntil && now < k.blockedUntil).length,
      invalid: keys.filter(k => k.status === 'auth_error').length
    };
  }

  /**
   * سياسة التفعيل التلقائي.
   *
   * القاعدة: مزود عنده **مفتاح صالح + اتصال غير معطوب** يُفعَّل تلقائياً،
   * بلا حاجة لأي تدخّل يدوي. المزود المطفأ عمداً (opt-out) لا يُلمس —
   * نميّز بين «مطفأ لأن لا مفتاح له» و«مطفأ بقرار من المستخدم».
   *
   * لماذا: كان 18 من 20 مزوداً مطفأين في providers.yaml، فتظهر والواجهة
   * تقول "لا مزود صالح" رغم وجود مفاتيح تعمل. السبب أن `enabled` كان
   * عَلَماً يدوياً يحجب كل الإشارات الحقيقية.
   */
  reconcileAutoEnable(): { enabled: string[]; skipped: { id: string; reason: string }[] } {
    const enabled: string[] = [];
    const skipped: { id: string; reason: string }[] = [];

    for (const [id, e] of this.providers) {
      const meta: any = e.meta || {};

      // 1) opt-out صريح من المستخدم → لا نلمسه أبداً
      if (meta.autoEnable === false) { skipped.push({ id, reason: 'autoEnable=false (إيقاف صريح)' }); continue; }
      // 2) المزود مُفعّل أصلاً → لا حاجة لعمل شيء
      if (e.enabled !== false) continue;
      // 3) مطفأ بسبب حقيقي (auth/quota/down) → أصلح السبب أولاً
      if (e.status === 'auth_error') { skipped.push({ id, reason: 'خطأ مصادقة — أصلح المفتاح' }); continue; }
      if (e.blockedUntil && Date.now() < e.blockedUntil) { skipped.push({ id, reason: 'معزول مؤقتاً (حصة/تعطّل)' }); continue; }
      // 4) بلا نماذج → لا فائدة من تفعيله
      const hasModels = !!(meta.models === 'auto' || (Array.isArray(meta.models) && meta.models.length > 0));
      if (!hasModels) { skipped.push({ id, reason: 'بلا نماذج' }); continue; }
      // 5) بلا مفتاح متاح → لا يُفعَّل (المفتاح شرط الاتصال)
      const slots = this.availableKeySlots(e);
      if (!slots.length) { skipped.push({ id, reason: 'بلا مفتاح صالح' }); continue; }

      // كل الشروط تحققت → تفعيل
      this.toggleProvider(id, true);
      enabled.push(id);
    }

    return { enabled, skipped };
  }

  snapshot() {
    return [...this.providers.entries()].map(([id, e]) => ({
      id, name: e.provider.name, tier: e.provider.tier, baseUrl: e.provider.baseUrl,
      status: e.status, lastError: e.lastError, lastChecked: e.lastChecked,
      hasKey: !!e.provider.apiKey,
      keyless: !!e.provider.keyless,
      enabled: e.enabled !== false,
      apiKeyEnv: e.meta?.apiKeyEnv || null,
      blockedUntil: e.blockedUntil || null,
      keys: this.keySummary(e),
      signupUrl: e.meta?.signupUrl || null,
      free: e.meta?.tier === 4
    }));
  }

  // تفاصيل المفاتيح للواجهة (بلا كشف القيمة كاملة)
  keyDetails(pid: string) {
    const e = this.providers.get(pid);
    if (!e) return null;
    const now = Date.now();
    return e.keys.map(s => ({
      id: s.id, label: s.label, masked: maskKey(s.key),
      enabled: s.enabled, status: s.status,
      blockedUntil: s.blockedUntil || null,
      blocked: !!(s.blockedUntil && now < s.blockedUntil),
      requests: s.requests,
      live: this.availableKeySlots(e).includes(s)
    }));
  }

  addProvider(p: any) {
    const fromEnv = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    const apiKey = p.apiKey || fromEnv;
    const entry: ProviderEntry = {
      provider: new OpenAIProvider(p.id, p.name || p.id, p.baseUrl, apiKey, p.tier ?? 4, p.format || 'openai', p.headers || {}),
      meta: p, status: 'unknown', lastChecked: 0, enabled: p.enabled !== false,
      keys: [this.makeSlot(p, { key: apiKey || '', label: apiKey ? maskKey(apiKey) : 'بلا مفتاح', status: 'unknown' })]
    };
    this.providers.set(p.id, entry);
  }

  removeProvider(id: string) {
    this.providers.delete(id);
  }

  toggleProvider(id: string, enabled: boolean) {
    const e = this.providers.get(id);
    if (!e) return false;
    e.enabled = enabled;
    if (!enabled) {
      e.status = 'disabled';
      e.blockedUntil = undefined;
    } else if (e.status === 'disabled') {
      e.status = 'unknown';
      e.lastError = undefined;
      e.blockedUntil = undefined;
      e.transientErrors = 0;
    }
    return true;
  }

  // فشل المصادقة على مستوى المزود كله
  markAuthError(id: string, error?: string) {
    const e = this.providers.get(id);
    if (e) { e.status = 'auth_error'; e.lastError = error || 'invalid API key'; e.lastChecked = Date.now(); e.blockedUntil = undefined; }
  }

  getProviderIds() { return [...this.providers.keys()]; }
  getProvider(id: string) { return this.providers.get(id); }

  // ===== النماذج المرفوضة من الفحص + النماذج المُتحقَّق منها =====
  // القيمة = وقت الرفض، لأن الصلاحية (PROBE_TTL_MS) يجب أن تُحترم **أثناء التشغيل**
  // أيضاً — كانت تُطبَّق عند الإقلاع فقط، فتبقى عملية تعمل أسبوعاً تحجب نموذجاً رُفض أمس.
  private probeRejections = new Map<string, Map<string, number>>();
  private probeVerified = new Map<string, Set<string>>();
  private static EMPTY_SET: Set<string> = new Set();

  async loadProbeRejections(): Promise<void> {
    try {
      const rows = await this.db.getProbes() as any[];
      const now = Date.now();
      for (const r of rows) {
        // نتجاهل نتائج الفحص المنتهية الصلاحية — مزود عاد للحياة يجب ألّا يبقى محجوباً
        const age = now - Number(r.checked_at || 0);
        if (age > PROBE_TTL_MS) continue;
        // 'rejected' فقط تحجب. 'provider_auth' مشكلة مفتاح لا تُحجب نموذجاً.
        if (r.status === 'rejected') {
          let s = this.probeRejections.get(r.provider);
          if (!s) { s = new Map(); this.probeRejections.set(r.provider, s); }
          s.set(r.model, Number(r.checked_at) || now);
        } else if (r.status === 'ok' && age <= OK_STALE_MS) {
          // "متحقَّق منه" له صلاحية أيضاً: نجاح منذ 36 يوماً لا يجعل النموذج
          // يتقدم على غيره في التوجيه — دورة auto-probe تعيد التحقق ثم تعيده هنا.
          let v = this.probeVerified.get(r.provider);
          if (!v) { v = new Set(); this.probeVerified.set(r.provider, v); }
          v.add(r.model);
        }
      }
    } catch (e: any) {
      console.error('[probe-rejections] load failed:', e?.message || e);
    }
  }

  noteProbe(provider: string, model: string, status: string): void {
    // 'rejected' = النموذج ميت/غير مدعوم → يُحجب.
    // 'provider_auth' = المفتاح خاطئ → لا يمسّ النموذج، بل يُزيل أي حجب سابق
    //   (فقد يكون حُجب سابقاً بسبب نفس المفتاح المعطّل).
    let s = this.probeRejections.get(provider);
    if (status === 'rejected') {
      if (!s) { s = new Map(); this.probeRejections.set(provider, s); }
      s.set(model, Date.now());
    } else if (s) {
      s.delete(model);
    }
    let v = this.probeVerified.get(provider);
    if (status === 'ok') {
      if (!v) { v = new Set(); this.probeVerified.set(provider, v); }
      v.add(model);
    } else if (v) {
      v.delete(model);
    }
  }

  clearProbeRejections(provider?: string): void {
    if (provider) { this.probeRejections.delete(provider); this.probeVerified.delete(provider); }
    else { this.probeRejections.clear(); this.probeVerified.clear(); }
  }

  /**
   * النماذج المحجوبة الآن لهذا المزود.
   * تُسقط ما انتهت صلاحيته (PROBE_TTL_MS) **لحظياً** لا عند الإقلاع فقط، وإلا بقي
   * نموذج عاد للحياة محجوباً في عملية لم تُعَد تشغيلها.
   */
  rejectedModels(pid: string): Set<string> {
    const s = this.probeRejections.get(pid);
    if (!s || !s.size) return Router.EMPTY_SET;
    const now = Date.now();
    for (const [model, at] of s) {
      if (now - at > PROBE_TTL_MS) s.delete(model);
    }
    if (!s.size) { this.probeRejections.delete(pid); return Router.EMPTY_SET; }
    return new Set(s.keys());
  }

  // نماذج نجح فحصها فعلاً (طلب محادثة حقيقي) — أساس الاختيار التلقائي
  verifiedModels(pid: string): Set<string> {
    const s = this.probeVerified.get(pid);
    return s || Router.EMPTY_SET;
  }

  /** 0 = للمزود نموذج نجح فحصه فعلاً · 1 = لا نتائج فحص بعد (أو كلها فشلت). */
  private verifiedRank(e: any): number {
    return this.verifiedModels(e?.provider?.id)?.size ? 0 : 1;
  }

  // نموذج ميت أو مدفوع اكتُشف من طلب حقيقي → نعلّمه مرفوضاً في الذاكرة وقاعدة البيانات
  // فيُحجب من التوجيه ومن /v1/models بلا حاجة لفحص يدوي (النظام يتعلّم من الواقع)
  private markModelDead(pid: string, model: string, error?: string): void {
    this.noteProbe(pid, model, 'rejected');
    const e = this.providers.get(pid);
    if (e && Array.isArray(e.knownModels)) {
      e.knownModels = e.knownModels.filter(m => m !== model);
      if (e.cachedModel === model) e.cachedModel = undefined;
    }
    this.db.upsertProbe(pid, model, 'rejected', 0, (error || 'unavailable').slice(0, 200)).catch((e) => noteStoreWriteFailure('upsertProbe', e));
    this.db.logEvent('model.auto_rejected', {
      provider: pid, model, status: 'error',
      error: (error || '').slice(0, 150),
      meta: { learnedFrom: 'live request' }
    }).catch((e) => noteStoreWriteFailure('logEvent:auto_rejected', e));
  }

  // المزود صالح للتوجيه: مُفعَّل + غير معطوب + عنده مفتاح متاح على الأقل
  private usable(e: any): boolean {
    if (!e) return false;
    if (e.enabled === false) return false;
    if (e.status === 'disabled' || e.status === 'down' || e.status === 'auth_error') return false;
    if (e.blockedUntil && Date.now() < e.blockedUntil) return false;
    return this.availableKeySlots(e).length > 0;
  }

  // blockMs: مدة عزل المزود قبل إعادة تجربته
  setStatus(id: string, status: string, error?: string, blockMs?: number) {
    const e = this.providers.get(id);
    if (!e) return;
    // نجاح فحص الصحة لا يلغي عزلاً قائماً (نفاد حصة / خطأ عابر)
    if (status === 'up' && e.blockedUntil && Date.now() < e.blockedUntil) {
      e.lastChecked = Date.now();
      return;
    }
    e.status = status;
    e.lastError = error;
    e.lastChecked = Date.now();
    e.blockedUntil = blockMs ? Date.now() + blockMs : undefined;
  }

  private resolve(modelStr?: string) {
    if (!modelStr || modelStr === 'auto') {
      // الأفضلية لمزود **نجح فحصه فعلاً** قبل ترتيب tier: مزودات tier=1 المجهولة
      // كانت تُقدَّم على مزودات معروفة تعمل، فيفشل «auto» رغم توفّر نموذج متحقّق منه.
      const sorted = [...this.providers.values()]
        .filter(e => this.usable(e))
        .sort((a, b) =>
          this.verifiedRank(a) - this.verifiedRank(b) ||
          a.provider.tier - b.provider.tier);
      return sorted[0] ? { providerId: sorted[0].provider.id, model: 'auto' } : null;
    }
    if (modelStr.includes('/')) {
      const [pid, ...rest] = modelStr.split('/');
      const e = this.providers.get(pid);
      if (e) return { providerId: pid, model: rest.join('/') || 'auto' };
    }
    const first = [...this.providers.values()].filter(e => this.usable(e))[0];
    return first ? { providerId: first.provider.id, model: modelStr } : null;
  }

  private buildOrder(initial: ReturnType<Router['resolve']>) {
    const now = Date.now();
    for (const e of this.providers.values()) {
      if (e.blockedUntil && now >= e.blockedUntil) {
        e.blockedUntil = undefined;
        if (e.status === 'quota_exhausted' || e.status === 'down') {
          e.status = 'unknown'; e.lastError = undefined; e.transientErrors = 0;
        }
      }
      this.wakeKeySlots(e);
    }

    const all = [...this.providers.values()].filter(e => this.usable(e));
    if (!all.length) return [];

    const sortByTier = (a: any, b: any) => {
      const aBad = (a.status === 'quota_exhausted' || a.status === 'down') ? 1 : 0;
      const bBad = (b.status === 'quota_exhausted' || b.status === 'down') ? 1 : 0;
      return (aBad - bBad)
        || (a.provider.tier - b.provider.tier)
        // مزود بلا أي نموذج مُتحقَّق منه = احتمال فشل أعلى ⇒ يأتي بعد غيره
        || (this.verifiedRank(a) - this.verifiedRank(b));
    };
    const wantModel = initial?.model && initial.model !== 'auto' ? initial.model : 'auto';
    if (!initial || !this.usable(this.providers.get(initial.providerId))) {
      return all.sort(sortByTier).map(e => ({ providerId: e.provider.id, model: wantModel }));
    }
    const rest = all.filter(e => e.provider.id !== initial.providerId).sort(sortByTier);
    return [
      { providerId: initial.providerId, model: initial.model },
      ...rest.map(e => ({ providerId: e.provider.id, model: wantModel })),
      ...rest.filter(() => wantModel !== 'auto').map(e => ({ providerId: e.provider.id, model: 'auto' as const }))
    ];
  }

  private async pickModel(entry: any, requested: string | null): Promise<{ model: string | null; notFound: boolean }> {
    const pid = entry.provider.id;
    const stale = !entry.knownModels || !entry.knownModelsAt || (Date.now() - entry.knownModelsAt) > MODEL_CACHE_TTL_MS;
    if (stale) {
      try {
        entry.knownModels = (await this.listProviderModels(pid)).map((m: { id: string }) => m.id);
        entry.knownModelsAt = Date.now();
      } catch {
        if (!entry.knownModels) entry.knownModels = [];
        // فشل الجلب → نعيد المحاولة بعد 30 ثانية بدل تجميد المزود 5 دقائق
        entry.knownModelsAt = Date.now() - MODEL_CACHE_TTL_MS + 30_000;
      }
    }
    if (pid === 'pollinations') {
      const pk = (entry.knownModels as string[]) || [];
      const pool = pk.length ? pk : ['openai-fast'];
      if (!requested || requested === 'auto') return { model: pool.includes('openai-fast') ? 'openai-fast' : pool[0], notFound: false };
      if (pool.includes(requested)) return { model: requested, notFound: false };
      if (pool.length) return { model: null, notFound: true };
    }
    let models = (entry.knownModels as string[]) || [];
    const rejected = this.rejectedModels(pid);
    if (rejected.size) models = models.filter(m => !rejected.has(m));
    const verified = this.verifiedModels(pid);
    // الأفضلية لنموذج نجح فحصه فعلاً — التخمين بالاسم اختار نماذج ميتة في الواقع
    const best = (list: string[]) =>
      list.find(m => verified.has(m)) ||
      list.find(m => /free|flash|mini|small|8b/i.test(m)) ||
      list[0];
    if (requested && requested !== 'auto') {
      if (models.includes(requested)) return { model: requested, notFound: false };
      if (rejected.has(requested)) return { model: best(models) || null, notFound: false };
      if (models.length > 0) return { model: null, notFound: true };
      return { model: null, notFound: false };
    }
    // auto → نموذج مُتحقَّق منه أولاً، ثم التخمين، ثم الأول
    const chatOnly = models.filter(m => !NON_CHAT_MODEL_RE.test(m));
    const pool = chatOnly.length ? chatOnly : models;
    if (entry.cachedModel && pool.includes(entry.cachedModel) &&
      (!verified.size || verified.has(entry.cachedModel))) {
      return { model: entry.cachedModel, notFound: false };
    }
    const chosen = best(pool) || null;
    if (chosen) entry.cachedModel = chosen;
    return { model: chosen, notFound: false };
  }

  // جلب نماذج مزود: نجرّب كل مفتاح متاح حتى ينجح أحدها.
  // مفتاح واحد ميت لا يجب أن يُعمي المزود كله عن قائمة نماذجه.
  async listProviderModels(pid: string): Promise<Array<{ id: string }>> {
    const e = this.providers.get(pid);
    if (!e) return [];
    const slots = this.availableKeySlots(e);
    for (const slot of slots) {
      try {
        const list = await slot.client.listModels();
        if (list.length) return list;
      } catch { /* جرّب المفتاح التالي */ }
    }
    // لا مفتاح متاح أو كلها فشلت → نحاول بالعميل الأساسي كحل أخير
    try { return await e.provider.listModels(); } catch { return []; }
  }

  // مزودات يمكن مخاطبتها فعلاً (لتفادي مخاطبة مزودات ميتة).
  // يكفي مفتاح متاح واحد، أو **مفتاح فارغ** واحد: مزود محلي (Ollama) لا يحتاج
  // سرّاً، وكان يستبعد هنا فيختفي من /v1/models و/qwen لا يُوجَّه إليه إلا من
  // خلال صف مفتاح وهمي في القاعدة. حالة المفتاح لكن لا قيمة له → صالح للاتصال.
  reachableProviderIds(): string[] {
    return [...this.providers.entries()]
      .filter(([, e]) => e.enabled !== false && Array.isArray(e.keys) && e.keys.some(k => k.enabled))
      .map(([id]) => id);
  }

  // هل المزود يعمل بلا اعتماد (مفتاح فارغ معرَّف)؟ نستخدمه لتمييز «بلا مفتاح»
  // المشروع عن «مفتاح مفقود» الذي يعني مزوداً معطّلاً فعلاً.
  isKeylessProvider(pid: string): boolean {
    const e = this.providers.get(pid);
    if (!e || !Array.isArray(e.keys) || !e.keys.length) return false;
    return e.keys.every((k: any) => !k.key);
  }

  // نمرّر حزم البث كما هي ونقرأ usage منها (ندعم stream_options.include_usage)
  // ثم نسجّل الاستخدام عند انتهاء البث — بدونه كان استهلاك وكلاء البرمجة غير مرئي
  private async *teeStreamUsage(src: any, providerId: string, trackKey: string, model: string, t0: number, onDone?: () => void) {
    let buf = '';
    let usage: any = null;
    let sawError = false;
    try {
      for await (const chunk of src) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        buf += text;
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.usage) usage = j.usage;
            if (j.error) sawError = true;
          } catch { /* سطر غير مكتمل */ }
        }
        yield chunk;
      }
    } finally {
      // نُسجّل حتى لو انقطع العميل — الرموز استُهلكت فعلاً
      if (usage) await this.db.logUsage(providerId, trackKey, model, usage).catch((e) => noteStoreWriteFailure('logUsage', e));
      await this.db.logEvent(sawError ? 'chat.stream_error' : 'chat.success', {
        provider: providerId, keyId: trackKey, model,
        status: sawError ? 'error' : 'success',
        latencyMs: Date.now() - t0,
        meta: { streamed: true, usageCaptured: !!usage }
      }).catch((e) => noteStoreWriteFailure('logEvent', e));
      // تحرير عدّاد التزامن — في finally ليُحرَّر حتى لو انقطع البث بخطأ
      try { onDone?.(); } catch { /* لا نُفشل البث بسبب خطأ تحرير */ }
    }
  }

  async chat(
    req: {
      model?: string; messages: any[]; stream?: boolean; temperature?: number;
      max_tokens?: number; top_p?: number; stop?: any; tools?: any; tool_choice?: any;
      response_format?: any; seed?: number; n?: number; frequency_penalty?: number;
      presence_penalty?: number; user?: string;
    },
    callerKey: string | null = null
  ): Promise<RouteResult> {
    const t0 = Date.now();
    // ===== توفير الرموز قبل أي إرسال =====
    const prepared = this.prepareMessages(req.messages);
    const upstream: any = { ...req, messages: prepared.messages };
    if (Number(this.settings.maxTokensCeiling) > 0) {
      const ceil = Number(this.settings.maxTokensCeiling);
      upstream.max_tokens = req.max_tokens ? Math.min(req.max_tokens, ceil) : ceil;
    }
    // ذاكرة الردود المتطابقة (لغير البث فقط — البث لا يمكن إعادة تشغيله بأمان)
    const cKey = (!req.stream && this.settings.cacheEnabled) ? this.cacheKey(upstream) : '';
    if (cKey) {
      const hit = this.cacheGet(cKey);
      if (hit) {
        this.cacheHits++;
        // الحمولة المخزَّنة {data, sub}: نُعيد وسم الاستبدال معها — كان يضيع عند
        // الإصابة فيرى العميل X-Provider:cache بلا أي إشارة أن النموذج غُيّر،
        // بينما النداء الأول أعلنه (خلل اتساق مثبت).
        const payload = hit.data ?? hit;
        await this.db.logEvent('chat.cache_hit', { model: payload.model, status: 'success', latencyMs: Date.now() - t0 }).catch((e) => noteStoreWriteFailure('logEvent', e));
        return {
          ok: true, status: 200, data: payload, model: payload.model, providerId: 'cache',
          keyId: callerKey || 'k1',
          _substituted: hit.sub || undefined,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
      }
      this.cacheMisses++;
    }

    const initial = this.resolve(req.model);
    const order = this.buildOrder(initial);
    const tried = new Set<string>();
    const errors: any[] = [];
    const wantModel = initial?.model && initial.model !== 'auto' ? initial.model : null;

    // لا مزود قابل للمحاولة: نُفسّر السبب بدل «All providers failed» المبهمة —
    // هذا هو الفرق بين «متصل لكن لا يعمل» وبين رسالة تقول الحقيقة والإصلاح.
    if (!order.length) {
      const reasons = [...this.providers.entries()].map(([id, e]) => {
        if (e.enabled === false) return `${id}: معطّل`;
        if (e.status === 'down') return `${id}: down (${e.lastError || 'transient'})`;
        if (e.status === 'auth_error') return `${id}: مفتاح خاطئ`;
        if (e.blockedUntil && Date.now() < e.blockedUntil) return `${id}: معزول ${Math.ceil((e.blockedUntil - Date.now()) / 1000)}s`;
        const slots = this.availableKeySlots(e);
        if (!slots.length) return `${id}: لا مفتاح متاح (${e.keys.length} مفتاح، ${e.keys.filter((k: any) => k.status === 'quota_exhausted').length} منتهي الحصة)`;
        return `${id}: غير جاهز`;
      });
      await this.db.logEvent('chat.all_failed', { status: 'error', error: 'no usable provider: ' + reasons.join(' | ').slice(0, 300) }).catch((e) => noteStoreWriteFailure('logEvent', e));
      return {
        ok: false, status: 503,
        error: `No usable provider — ${reasons.join(' · ')}`,
        attempts: []
      };
    }

    // ===== سقف زمني شامل للطلب كله =====
    // بلا هذا، محاولة كل مزود على حدة بمهلته (60 ثانية) تعني أن أسوأ حالة
    // تصل إلى 36 دقيقة قبل أن يرى العميل أي خطأ. السقف يوقف التوسّع ويُعيد
    // أفضل خطأ مُجمَّع بدل ترك الطلب معلّقاً بلا نهاية.
    const deadlineAt = Date.now() + this.deadlineMs;
    const deadlineHit = () => Date.now() >= deadlineAt;

    // إبلاغ العميل بصراحة عند قطع المحاولات بسبب السقف الزمني
    const deadlineError = () => ({
      providerId: '(deadline)', status: 0,
      error: `deadline of ${Math.round(this.deadlineMs / 1000)}s reached after ${tried.size} providers`
    });

    for (const attempt of order) {
      if (tried.has(attempt.providerId)) continue;
      // احترام maxRetries: نجرّب هذا العدد من المزودات على الأكثر
      if (tried.size >= this.maxRetries) break;
      if (deadlineHit()) {
        errors.push(deadlineError());
        break;
      }
      const entry = this.providers.get(attempt.providerId);
      if (!entry) continue;
      if (!this.usable(entry)) continue;

      // احترام سقف التزامن: مزود مشبع نتركه وننتقل لغيره بدل الانتظار
      // S4: التخطي هنا **لا يستهلك محاولة** — كان `tried.add` قبل الفحص، فمزوّدان
      // مشبعان يُنهيان الطلب بـ«All providers failed» رغم وجود مزود جاهز لم يُجرَّب.
      if (!this.acquire(attempt.providerId)) {
        errors.push({ providerId: attempt.providerId, status: 0, error: 'provider at maxConcurrent — skipped (does not count as an attempt)' });
        continue;
      }
      tried.add(attempt.providerId);

      const firstPick = await this.pickModel(entry, wantModel);
      let modelForThis = firstPick.model;
      if (!modelForThis) {
        if (firstPick.notFound) {
          errors.push({ providerId: attempt.providerId, status: 404, error: `model "${wantModel}" not offered by ${attempt.providerId}`, model: wantModel });
          this.release(attempt.providerId);
          continue;
        }
        // قائمة النماذج قد تكون فارغة لأن جلبها فشل (مفاتيح خاطئة مثلاً).
        // لا نتخطّى المزود بصمت — نجرّب موديلاً حتى نكتشف 401 ونوسم المفاتيح الخاطئة،
        // وإلا بقي المزود يبدو سليماً بمفاتيح "متاحة" لا تعمل.
        const candidateSlots = this.availableKeySlots(entry);
        const unverified = candidateSlots.some(s => s.status === 'unknown' && s.requests === 0);
        if (!candidateSlots.length || !unverified) {
          errors.push({ providerId: attempt.providerId, status: 0, error: 'no models available' });
          this.release(attempt.providerId);
          continue;
        }
        modelForThis = wantModel || 'auto';
      }
      if (wantModel && wantModel !== modelForThis && this.rejectedModels(attempt.providerId).has(wantModel)) {
        errors.push({ providerId: attempt.providerId, status: 0, error: `model "${wantModel}" rejected by probe — using ${modelForThis}` });
      }

      // ===== تدوير المفاتيح داخل المزود =====
      let providerLevelFailure: { status: number; error?: string } | null = null;
      let keyTried = 0;
      let retryWithAnotherModel = false;

      // محاولتان على الأكثر: إن مات النموذج (404/410) أو كان مدفوعاً (403)
      // نجرّب نموذجاً آخر من نفس المزود قبل التخلي عن المزود كله
      for (let modelTry = 0; modelTry < 2; modelTry++) {
        retryWithAnotherModel = false;
        const slots = this.availableKeySlots(entry);
        for (const slot of slots) {
        keyTried++;
        const result = await slot.client.chat({
          model: modelForThis, messages: upstream.messages, stream: req.stream,
          temperature: upstream.temperature, max_tokens: upstream.max_tokens,
          top_p: upstream.top_p, stop: upstream.stop,
          tools: upstream.tools, tool_choice: upstream.tool_choice,
          response_format: upstream.response_format, seed: upstream.seed,
          n: upstream.n, frequency_penalty: upstream.frequency_penalty,
          presence_penalty: upstream.presence_penalty, user: upstream.user
        });

        if (result.ok) {
          // S6: كان كل طلب ناجح يكتب صفّين على مفتاحه (عدّاد + حالة). العدّاد صار
          // دفعياً كل 5 ثوانٍ، والحالة تُكتب **مرة واحدة عند تغيّرها** فقط.
          const statusChanged = slot.status !== 'ok';
          slot.status = 'ok';
          slot.blockedUntil = undefined;
          slot.requests++;
          if (slot.id) {
            this.deferTouch(slot.id);
            if (statusChanged) {
              this.db.updateProviderKey(slot.id, { status: 'ok', error: null, blockMs: null })
                .catch((e) => noteStoreWriteFailure('updateProviderKey:ok', e));
            }
          }
          entry.status = 'up';
          entry.lastError = undefined;
          entry.transientErrors = 0; // نجاح واحد يُصفّر عدّاد الأخطاء العابرة
          this.refreshPrimary(entry);

          const trackKey = callerKey || 'k1';
          const out: any = {
            ...result, providerId: attempt.providerId, keyId: trackKey,
            model: modelForThis, providerKeyLabel: slot.label
          };
          // تشخيص: مزودون تُخطّوا (سقف تزامن) قبل هذا النجاح — يُعادون للعميل
          // رغم نجاح الطلب، فيبقى أثر التخطي مرئياً بدل أن يضيع.
          if (errors.length) out.attempts = errors;
          if (wantModel && wantModel !== modelForThis) {
            out._substituted = { requested: wantModel, actual: modelForThis, providerId: attempt.providerId };
          }
          if (req.stream && result.stream) {
            // البث يُستهلك لاحقاً خارج هذه الدالة، فنحرّر عدّاد التزامن عند انتهائه
            // (لا الآن) وإلا حسبنا طلباً منتهياً بينما هو ما زال يسحب رموزاً.
            out.stream = this.teeStreamUsage(result.stream, attempt.providerId, trackKey, modelForThis, t0, () => this.release(attempt.providerId));
          } else {
            if (cKey && result.data) this.cachePut(cKey, { data: result.data, sub: out._substituted || null });
            // S6: الاستخدام والسجل مستقلان ⇒ بالتوازي لا بالتسلسل (زمن إضافي مجاني)
            await Promise.all([
              result.usage
                ? this.db.logUsage(attempt.providerId, trackKey, modelForThis, result.usage)
                    .catch((e) => noteStoreWriteFailure('logUsage', e))
                : Promise.resolve(),
              this.db.logEvent('chat.success', {
                provider: attempt.providerId, keyId: trackKey, model: modelForThis,
                status: 'success', latencyMs: Date.now() - t0,
                meta: {
                  providerKey: slot.label, keysTried: keyTried,
                  trimmed: prepared.trimmed, savedChars: prepared.savedChars
                }
              }).catch((e) => noteStoreWriteFailure('logEvent:chat.success', e))
            ]);
            this.release(attempt.providerId);
          }
          return out;
        }

        // نص الخطأ يصل العميل في `attempts` ويُخزَّن في القاعدة — نص خام من مزود
        // قد يُضمّن مفتاحها نفسها (وهذا سبب وجود sanitizeErrorMessage أصلاً).
        const snippet = sanitizeErrorMessage(result.error, 200);
        // 429 → عزل هذا المفتاح وحده وتجربة المفتاح التالي فوراً.
        // نص الخطأ يفرّق العابر من الدائم: ضغط التزامن عابر (دقائق)، ونفاد
        // الحصة الشهرية دائم (ساعات). الترتيب مقصود: العابر يُفحص أولاً.
        if (result.status === 429) {
          const permanentQuota = !TRANSIENT_RATE_RE.test(snippet || '') && PERMANENT_QUOTA_RE.test(snippet || '');
          const parkMs = permanentQuota ? KEY_QUOTA_PARKED_MS : KEY_QUOTA_BLOCK_MS;
          slot.status = 'quota_exhausted';
          slot.blockedUntil = Date.now() + parkMs;
          if (slot.id) this.db.updateProviderKey(slot.id, { status: 'quota_exhausted', error: snippet, blockMs: parkMs }).catch((e) => noteStoreWriteFailure('updateProviderKey', e));
          await this.db.logEvent('key.quota_exhausted', {
            provider: attempt.providerId, model: modelForThis, status: 'error',
            error: snippet, meta: { providerKeyId: slot.id, label: slot.label, permanentQuota, parkMs }
          }).catch((e) => noteStoreWriteFailure('logEvent', e));
          errors.push({ providerId: attempt.providerId, status: 429, error: `key ${slot.label}: quota exhausted`, model: modelForThis });
          continue;
        }
        // 401 = مفتاح خاطئ دائماً → يوسم نهائياً وينتقل للتالي
        if (result.status === 401) {
          slot.status = 'auth_error';
          if (slot.id) this.db.updateProviderKey(slot.id, { status: 'auth_error', error: snippet }).catch((e) => noteStoreWriteFailure('updateProviderKey', e));
          await this.db.logEvent('key.auth_error', {
            provider: attempt.providerId, status: 'error',
            error: snippet, meta: { providerKeyId: slot.id, label: slot.label }
          }).catch((e) => noteStoreWriteFailure('logEvent', e));
          errors.push({ providerId: attempt.providerId, status: 401, error: `key ${slot.label}: invalid`, model: modelForThis });
          continue;
        }
        // 403 قد يعني «مفتاح بلا صلاحية» أو «نموذج مدفوع» — نفرّق بالرسالة.
        // **ترتيب الفحص مقصود**: نصّ يخصّ المفتاح (api key/permission/unauthorized…)
        // يُقدَّم دائماً — كان المطابق لكلمة مثل "insufficient" وحدها يوسم النموذج
        // ميتاً رغم أن الرسالة عن المفتاح ("insufficient permissions for this API
        // key")، فيُقتل نموذج سليم 24 ساعة (خلل مثبت بإعادة إنتاج داخل العملية).
        if (result.status === 403) {
          const keyText = /api\s?key|permission|unauthor|authentication|forbidden|invalid token|not allowed/i.test(snippet || '');
          const modelLevel = !keyText && /premium|paid|plan|balance|subscribe|wallet|upgrade|credits?|insufficient|deposited/i.test(snippet || '');
          if (!modelLevel) {
            slot.status = 'auth_error';
            if (slot.id) this.db.updateProviderKey(slot.id, { status: 'auth_error', error: snippet }).catch((e) => noteStoreWriteFailure('updateProviderKey', e));
            errors.push({ providerId: attempt.providerId, status: 403, error: `key ${slot.label}: forbidden`, model: modelForThis });
            continue;
          }
          // مشكلة في النموذج نفسه → نعلّمه مرفوضاً ونجرّب نموذجاً آخر من نفس المزود
          this.markModelDead(attempt.providerId, modelForThis, snippet);
          errors.push({ providerId: attempt.providerId, status: 403, error: `model ${modelForThis}: needs paid plan`, model: modelForThis });
          retryWithAnotherModel = true;
          break;
        }
        // 404/410 → النموذج مات أو أُحيل للتقاعد: نعلّمه مرفوضاً ونجرّب غيره
        if (result.status === 404 || result.status === 410) {
          this.markModelDead(attempt.providerId, modelForThis, snippet);
          errors.push({ providerId: attempt.providerId, status: result.status, error: `model ${modelForThis}: unavailable`, model: modelForThis });
          retryWithAnotherModel = true;
          break;
        }
        // خطأ على مستوى المزود → لا فائدة من بقية المفاتيح
        providerLevelFailure = { status: result.status, error: snippet };
        errors.push({ providerId: attempt.providerId, status: result.status, error: snippet, model: modelForThis });
        break;
        } // نهاية حلقة المفاتيح

        // النموذج كان ميتاً/مدفوعاً → نجرّب نموذجاً آخر من نفس المزود قبل التخلي عنه
        if (retryWithAnotherModel && modelTry === 0) {
          const next = await this.pickModel(entry, wantModel);
          if (next.model && next.model !== modelForThis) {
            modelForThis = next.model;
            continue;
          }
        }
        break;
      } // نهاية حلقة محاولات النموذج

      // ===== معالجة ما بعد محاولات المفاتيح =====
      if (providerLevelFailure) {
        await this.db.logEvent('chat.error', {
          provider: attempt.providerId, model: modelForThis, status: 'error',
          error: providerLevelFailure.error, latencyMs: Date.now() - t0
        }).catch((e) => noteStoreWriteFailure('logEvent', e));
        const st = providerLevelFailure.status;
        if (st === 502 || st === 503 || st === 504 || st === 500) {
          entry.transientErrors = (entry.transientErrors || 0) + 1;
          if (entry.transientErrors >= 3) {
            entry.status = 'down';
            entry.lastError = 'transient errors (3x)';
            entry.lastChecked = Date.now();
            entry.blockedUntil = Date.now() + 60_000;
          }
        }
        if ((st === 410 || st === 404) && Array.isArray(entry.knownModels)) {
          entry.knownModels = entry.knownModels.filter((m: string) => m !== modelForThis);
          entry.cachedModel = entry.cachedModel === modelForThis
            ? (entry.knownModels[0] || undefined)
            : entry.cachedModel;
        }
      } else if (this.availableKeySlots(entry).length === 0) {
        // نفدت كل المفاتيح (أو كلها خاطئة) → عزل المزود مؤقتاً والانتقال للتالي
        const allInvalid = entry.keys.length > 0 && entry.keys.every(k => k.status === 'auth_error');
        entry.status = allInvalid ? 'auth_error' : 'quota_exhausted';
        entry.lastError = allInvalid ? 'all keys invalid' : 'all keys exhausted';
        entry.lastChecked = Date.now();
        entry.blockedUntil = allInvalid ? undefined : Date.now() + 60_000;
        await this.db.logEvent('provider.exhausted', {
          provider: attempt.providerId, status: 'error',
          meta: { keys: entry.keys.length, invalid: allInvalid }
        }).catch((e) => noteStoreWriteFailure('logEvent', e));
      }

      // تحرير عدّاد التزامن لهذا المزود بعد انتهاء محاولاته كلها
      this.release(attempt.providerId);
    }

    const deadlineReached = errors.some(e => e.providerId === '(deadline)');
    await this.db.logEvent('chat.all_failed', { status: 'error', error: JSON.stringify(errors).slice(0, 500), latencyMs: Date.now() - t0 }).catch((e) => noteStoreWriteFailure('logEvent', e));
    const noKey = errors.length > 0 && errors.every(e => e.status === 0 || e.status === 401 || e.status === 403);
    const notFound = errors.length > 0 && errors.every(e => e.status === 404 || e.status === 410);
    const quota = errors.length > 0 && errors.every(e => e.status === 429);
    // كل المحاولات رفضاً من طبقة العميل (400/422): الطلب نفسه غير صالح —
    // إعادته كـ504 عابرة تُغري بإعادة محاولة لا معنى لها (خلل مثبت: رسائل فارغة
    // وmax_tokens نصي كانا يعودان 504 «All providers failed»).
    const clientErr = errors.length > 0 && errors.every(e => e.status === 400 || e.status === 422);
    return {
      // رمز صادق: نموذج غير موجود = 404 (كما OpenAI/Anthropic)، طلب غير صالح = 400.
      ok: false, status: notFound ? 404 : clientErr ? 400 : 504,
      error: deadlineReached
        ? `Request deadline reached (${Math.round(this.deadlineMs / 1000)}s) after trying ${tried.size} providers — increase routing.timeoutMs or fix slow providers`
        : quota
          ? 'All keys are quota-exhausted — add more keys for these providers, or wait for the quota to reset'
          : notFound
            ? `Model "${wantModel}" is not offered by any provider — check the exact id in /v1/models, or use auto`
            : clientErr
              ? `Request rejected by provider: ${String(errors[0]?.error || '').slice(0, 200)}`
              : noKey
                ? 'No usable provider — add or fix API keys on the Providers tab'
                : 'All providers failed',
      attempts: errors
    };
  }
}
