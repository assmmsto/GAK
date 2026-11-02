// server/db.ts — SQLite (libsql) events, usage, key health
import { createHash, randomBytes } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encryptSecret, decryptSecret, isEncryptedSecret, keyFingerprint, CRED_PREFIX
} from './crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// مسار القاعدة قابل للتجاوز عبر GATEWAY_DB_PATH — يسمح بتشغيل نسخة معزولة
// (اختبار/تجربة) بلا لمس قاعدة الاستخدام الحقيقية.
const DB_PATH = process.env.GATEWAY_DB_PATH || join(__dirname, '..', 'data', 'gateway.db');

/**
 * مصدر المفتاح — يحدد من أي طبقة جاء، وأيها يملك السلطة عند التعارض.
 * vault(10) > doppler(20) > onepassword(30) > file(40) > env(50) > manual(90)
 *manual = أدخله المستخدم من الواجهة: المزامنة الآلية لا تسحبه ولا تعطّله.
 */
export type ProviderKeySource = 'vault' | 'doppler' | 'onepassword' | 'file' | 'env' | 'manual';

/** أولوية السلطة لكل مصدر (الأصغر أعلى). manual = 90 فلا يتقدّم عليه مصدر آلي. */
export const SOURCE_PRIORITY: Record<ProviderKeySource, number> = {
  vault: 10,
  doppler: 20,
  onepassword: 30,
  file: 40,
  env: 50,
  manual: 90
};

const writeFailureLoggedAt = new Map<string, number>();

// ===== مفاتيح العملاء: hash لا نص =====
// عمود api_keys.key يخزّن الآن **SHA-256** من المفتاح (لا النص). لماذا: تسريب
// نسخة القاعدة (نسخة احتياطية، مشاركة مجلد، سرقة جهاز) يجب ألّا يسلّم مفاتيح
// العملاء — مثل مفاتيح أي مزود حقيقي (OpenAI/Anthropic تعرض المفتاح مرة واحدة).
// key_hint = أول 6 محارف + آخر 4 للعرض فقط. التوليد crypto.randomBytes —
// Math.random غير صالح لتوليد أسرار (قابل للتوقّع).
const API_KEY_PREFIX = process.env.API_KEY_PREFIX || 'gw_';
const BASE62 = 'abcdefghijklmnopqrstuvwxyz0123456789';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
/** بصمة مفتاح عميل — تستخدمها السجلات (usage/events) بدل النص الخام. */
export function clientKeyHash(raw: string): string {
  return sha256Hex(raw);
}

function keyHint(k: string): string {
  if (!k) return '';
  if (k.length <= 12) return '••••••';
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function isSha256Hex(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/**
 * يُستدعى عند فشل كتابة خلفية للمخزون (حالة مفتاح، حكم فحص...).
 * لماذا دالة: كانت كلها `.catch(()=>{})` ⇒ فشل القاعدة صامت تماماً — طلبات
 * تعمل وحالات لا تُحفظ ولا أحد يعلم. الآن تحذير **مخنوق** (مرة/دقيقة لكل
 * عملية): يُرى في السجل، ولا يُغرق عند عطل مستمر، ولا يكسر الطلب الأصلي.
 */
export function noteStoreWriteFailure(op: string, err: unknown): void {
  const now = Date.now();
  const last = writeFailureLoggedAt.get(op) || 0;
  if (now - last < 60_000) return;
  writeFailureLoggedAt.set(op, now);
  console.warn(`[provider-keys] ${op} failed:`, (err as any)?.message || err);
}

export class EventDB {
  private db!: Client;
  // الوصول للعميل من برام (للاستعلامات المخصصة)
  get client(): Client { return this.db; }
  ready!: Promise<void>;

  constructor(path = DB_PATH) {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    this.db = createClient({ url: `file:${path}` });
    this.ready = this._migrate();
  }

  private async _migrate() {
    await this.db.execute(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, provider TEXT, key_id TEXT, model TEXT, status TEXT, latency_ms INTEGER, error TEXT, meta TEXT)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC)`);
    await this.db.execute(`CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL, key_id TEXT, model TEXT NOT NULL, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts DESC)`);
    await this.db.execute(`CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, ts INTEGER NOT NULL, last_used INTEGER, requests INTEGER DEFAULT 0)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key)`);
    // ----- نتيجة فحص النماذج (يعمل / مرفوض) -----
    await this.db.execute(`CREATE TABLE IF NOT EXISTS model_probe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      error TEXT,
      checked_at INTEGER NOT NULL,
      UNIQUE(provider, model)
    )`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_model_probe_provider ON model_probe(provider)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_model_probe_status ON model_probe(status)`);
    // ----- مفاتيح المزودات: عدة مفاتيح لكل مزود مع حالة مستقلة وتدوير -----
    // ملاحظة: key يُخزَّن مشفّراً (enc:v1:...) وkey_fp بصمة HMAC لمنع التكرار
    await this.db.execute(`CREATE TABLE IF NOT EXISTS provider_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      key TEXT NOT NULL,
      key_fp TEXT,
      label TEXT,
      enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'unknown',
      blocked_until INTEGER,
      requests INTEGER DEFAULT 0,
      last_used INTEGER,
      last_error TEXT,
      ts INTEGER NOT NULL,
      UNIQUE(provider, key)
    )`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_provider_keys_status ON provider_keys(status)`);
    // ----- إعدادات عامة (توفير الرموز وغيرها) -----
    await this.db.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // ----- مصدر كل مفتاح: من أين جاء (لمصالحته الهرمية) -----
    // 'manual' = أدخله المستخدم بنفسه → لا تمسّه المزامنة الآلية أبداً.
    await this._ensureColumn('provider_keys', 'source', `ALTER TABLE provider_keys ADD COLUMN source TEXT`);
    // ----- سجل تدقيق كل تغيير مفتاح (إضافة/سحب/إعادة تفعيل/تغيّر سلطة) -----
    // لا يحتوي أي قيمة سرّية — بصمات فقط.
    await this.db.execute(`CREATE TABLE IF NOT EXISTS key_rotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      provider TEXT NOT NULL,
      key_id INTEGER,
      key_fp TEXT,
      action TEXT NOT NULL,
      reason TEXT,
      from_source TEXT,
      to_source TEXT,
      ok INTEGER DEFAULT 1,
      detail TEXT
    )`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_key_rotations_ts ON key_rotations(ts DESC)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_key_rotations_provider ON key_rotations(provider)`);
    // ----- آخر حالة جلب لكل مصدر (تشخيص: أي مصدر يُجيب وأي لا) -----
    await this.db.execute(`CREATE TABLE IF NOT EXISTS secret_sources (
      id TEXT PRIMARY KEY,
      label TEXT,
      priority INTEGER,
      configured INTEGER DEFAULT 0,
      ok INTEGER,
      entries INTEGER DEFAULT 0,
      error TEXT,
      latency_ms INTEGER,
      last_sync INTEGER
    )`);
    await this._migrateProbeAuthErrors();
    await this._migrateSecretStorageInternal();
    await this._migrateApiKeyHashing();
  }

  /**
   * ترحيل مفاتيح العملاء إلى تخزين hash (idempotent).
   * أي صف لا يزال نصاً صريحاً (64 hex لا) يُحوَّل: key = sha256(النص)،
   * key_hint = بصمة عرض. بعد الترحيل لا يمكن إظهار المفتاح كاملاً —
   * الأدوات تستخدم النسخة التي حصل عليها عند الإنشاء، وإلا يُعاد توليدها.
   */
  private async _migrateApiKeyHashing() {
    try {
      await this._ensureColumn('api_keys', 'key_hint', `ALTER TABLE api_keys ADD COLUMN key_hint TEXT`);
      const rows = await this.db.execute(`SELECT id, key FROM api_keys`);
      let moved = 0;
      for (const row of rows.rows as any[]) {
        const plain = String(row.key ?? '');
        if (!plain || isSha256Hex(plain)) continue; // مُهجَّر سابقاً أو فارغ
        await this.db.execute({
          sql: `UPDATE api_keys SET key = ?, key_hint = ? WHERE id = ?`,
          args: [sha256Hex(plain), keyHint(plain), Number(row.id)]
        });
        moved++;
      }
      if (moved > 0) {
        console.log(`🔐 ترحيل مفاتيح العملاء: حُوِّل ${moved} مفتاحاً إلى تخزين hash (النص الصريح لم يعد في القاعدة)`);
      }
      await this._migrateLogKeyIds();
    } catch (e: any) {
      console.warn('⚠ فشل ترحيل hash مفاتيح العملاء:', e?.message || e);
    }
  }

  /**
   * السجلات (usage/events) كانت تخزن **النص الخام** لمفتاح العميل في key_id —
   * ناقل تسريب عبر /api/logs، وربط إحصاءات المفتاح يُكسر بعد ترحيل api_keys
   * إلى hash. نحوّل كل قيمة ليست hash إلى hash (idempotent).
   */
  private async _migrateLogKeyIds() {
    for (const table of ['usage', 'events']) {
      try {
        const rows = await this.db.execute(`SELECT DISTINCT key_id FROM ${table} WHERE key_id IS NOT NULL AND key_id != ''`);
        for (const row of rows.rows as any[]) {
          const raw = String(row.key_id ?? '');
          if (!raw || isSha256Hex(raw)) continue;
          await this.db.execute({
            sql: `UPDATE ${table} SET key_id = ? WHERE key_id = ?`,
            args: [sha256Hex(raw), raw]
          });
        }
      } catch (e: any) {
        console.warn(`⚠ تعذّر ترحيل key_id في ${table}:`, e?.message || e);
      }
    }
  }

  /** يضيف عموداً إن لم يكن موجوداً (idempotent) — أساس كل ترقية لاحقة. */
  private async _ensureColumn(table: string, column: string, alterSql: string): Promise<boolean> {
    try {
      const cols = await this.db.execute(`PRAGMA table_info(${table})`);
      if ((cols.rows as any[]).some((c: any) => c.name === column)) return false;
      await this.db.execute(alterSql);
      return true;
    } catch (e: any) {
      console.warn(`⚠ تعذّر.ensure عمود ${table}.${column}:`, e?.message || e);
      return false;
    }
  }

  /**
   * ترحيل تصحيحي لمرة واحدة (idempotent) — يعمل تلقائياً عند كل إقلاع.
   *
   * الخلل التاريخي: كانت أخطاء المصادقة (401/403 من المزود) تُسجَّل بالحالة
   * 'rejected'، فيُوسَم النموذج بأنه ميت بلا رجعة، بينما السبب مفتاح معطّل
   * لا علاقة له بالنموذج. النتيجة كانت مئات النماذج "الميتة" بسبب مفتاح واحد.
   *
   * لا يُنفَّذ شيء إن لم توجد صفوف مطابقة → آمن للتشغيل المتكرر.
   */
  private async _migrateProbeAuthErrors() {
    try {
      const r = await this.db.execute({
        sql: `UPDATE model_probe SET status = 'provider_auth'
              WHERE status = 'rejected' AND (
                lower(error) LIKE '%invalid or disabled clientapikey%'
                OR lower(error) LIKE '%invalid api key%'
                OR lower(error) LIKE '%invalid apikey%'
                OR lower(error) LIKE '%incorrect api key%'
                OR lower(error) LIKE '%api key not valid%'
                OR lower(error) LIKE '%unauthorized%'
                OR lower(error) LIKE '%authentication_error%'
                OR lower(error) LIKE '%invalid_api_key%'
                OR lower(error) LIKE '%invalid authentication%'
                OR lower(error) LIKE '%key expired%'
              )`,
        args: [],
      });
      const moved = Number((r as any)?.rowsAffected || 0);
      if (moved > 0) console.log(`↻ ترحيل الفحص: نُقل ${moved} صفاً من 'rejected' إلى 'provider_auth' (خطأ مفتاح لا موت نموذج)`);
    } catch (e: any) {
      // لا نُسقط الإقلاع بسبب ترحيل تصحيحي
      console.warn('⚠ فشل ترحيل أخطاء مصادقة الفحص:', e?.message || e);
    }
  }

  /**
   * ترحيل تشفير أسرار المخزون (idempotent) — يعمل تلقائياً عند كل إقلاع.
   *  1) يضمن وجود عمود key_fp للبصمة وفهرسه الفريد لمنع التكرار.
   *  2) يشفّر أي مفتاح مخزّن كنص صريح (كان موجوداً قبل تفعيل التشفير).
   *  3) يملأ key_fp لأي صف يفتقر إليها.
   */
  private async _migrateSecretStorageInternal(): Promise<{ encrypted: number; fingerprinted: number; indexed: boolean }> {
    try {
      const cols = await this.db.execute(`PRAGMA table_info(provider_keys)`);
      const hasFp = (cols.rows as any[]).some(c => c.name === 'key_fp');
      if (!hasFp) {
        await this.db.execute(`ALTER TABLE provider_keys ADD COLUMN key_fp TEXT`);
      }

      const rows = await this.db.execute(`SELECT id, provider, key, key_fp FROM provider_keys`);
      let encrypted = 0;
      let fingerprinted = 0;

      for (const row of rows.rows as any[]) {
        const id = Number(row.id);
        const raw = String(row.key ?? '');
        const needsEnc = !isEncryptedSecret(raw);
        const plain = needsEnc ? raw : decryptSecret(raw);

        if (needsEnc && raw.length > 0) {
          const enc = encryptSecret(raw);
          await this.db.execute({
            sql: `UPDATE provider_keys SET key = ? WHERE id = ?`,
            args: [enc, id]
          });
          encrypted++;
        }

        if ((!row.key_fp || needsEnc) && plain !== null && plain !== '') {
          const fp = keyFingerprint(plain);
          await this.db.execute({
            sql: `UPDATE provider_keys SET key_fp = ? WHERE id = ?`,
            args: [fp, id]
          });
          fingerprinted++;
        }
      }

      let indexed = false;
      try {
        await this.db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_keys_fp ON provider_keys(provider, key_fp)`);
        indexed = true;
      } catch (idxErr: any) {
        console.warn('⚠ تعذّر إنشاء الفهرس الفريد لبصمات المفاتيح (قد توجد صفوف مكررة):', idxErr?.message || idxErr);
      }

      if (encrypted > 0) {
        console.log(`🔐 ترحيل التشفير: شُفِّر ${encrypted} مفتاح مزود في قاعدة البيانات (كانت نصاً صريحاً)`);
      }
      return { encrypted, fingerprinted, indexed };
    } catch (e: any) {
      console.warn('⚠ فشل ترحيل تشفير أسرار المخزون:', e?.message || e);
      return { encrypted: 0, fingerprinted: 0, indexed: false };
    }
  }

  /** غلاف عام قابل للنداء من الاختبارات بعد اكتمال ready */
  async migrateSecretStorage(): Promise<{ encrypted: number; fingerprinted: number; indexed: boolean }> {
    await this.ready;
    return this._migrateSecretStorageInternal();
  }

  /** يولّد مفتاح عميل جديداً: بادئة + 40 محرفاً من randomBytes (ليس Math.random). */
  private generateClientKey(): string {
    return API_KEY_PREFIX + Array.from(randomBytes(40), b => BASE62[b % BASE62.length]).join('');
  }

  /**
   * ينشئ مفتاح عميل ويعيد النص الكامل **مرة واحدة** — بعدها لا يُسترجع من
   * القاعدة (تُخزَّن بصمته فقط). الواجهة تعرضه لحظة الإنشاء مع زر نسخ.
   */
  async createApiKey(name: string): Promise<{ key: string; name: string; id: number }> {
    await this.ready;
    const key = this.generateClientKey();
    const r = await this.db.execute({
      sql: `INSERT INTO api_keys (key, key_hint, name, ts) VALUES (?, ?, ?, ?) RETURNING id`,
      args: [sha256Hex(key), keyHint(key), name, Date.now()]
    });
    return { key, name, id: Number((r.rows[0] as any)?.id) };
  }

  /** القائمة تعيد البصمة (key_hint) — لا يوجد نص كامل ليعود من القاعدة. */
  async listApiKeys() {
    await this.ready;
    const r = await this.db.execute({
      sql: `SELECT id, COALESCE(key_hint, '••••••') AS key, name, ts, last_used, requests FROM api_keys ORDER BY ts DESC`,
      args: []
    });
    return r.rows;
  }

  async deleteApiKey(id: number) {
    await this.ready;
    await this.db.execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
  }

  // ===== عدّ استخدام مفاتيح العملاء (دفعي) =====
  // كان كل طلب /v1 يكتب UPDATE على api_keys — كتابة قاعدة لكل طلب تُثقل SQLite
  // تحت الحمل. الآن يُجمَّع العدّ في الذاكرة ويُكتب كل 5 ثوانٍ (نفس نمط deferTouch).
  private pendingApiTouches = new Map<number, number>();
  private apiTouchTimer: any = null;

  private deferApiTouch(id: number): void {
    this.pendingApiTouches.set(id, (this.pendingApiTouches.get(id) || 0) + 1);
    if (this.apiTouchTimer) return;
    this.apiTouchTimer = setTimeout(() => { this.apiTouchTimer = null; void this.flushApiTouches(); }, 5000);
    if (typeof this.apiTouchTimer?.unref === 'function') this.apiTouchTimer.unref();
  }

  /** يكتب عدّادات الاستخدام المعلّقة. عامة للاختبار وللإغلاق النظيف. */
  async flushApiTouches(): Promise<number> {
    if (!this.pendingApiTouches.size) return 0;
    const batch = [...this.pendingApiTouches.entries()];
    this.pendingApiTouches.clear();
    for (const [id, n] of batch) {
      try {
        await this.db.execute({
          sql: `UPDATE api_keys SET requests = requests + ?, last_used = ? WHERE id = ?`,
          args: [n, Date.now(), id]
        });
      } catch (e) {
        noteStoreWriteFailure('apiTouch', e);
      }
    }
    return batch.length;
  }

  async checkApiKey(rawKey: string): Promise<boolean> {
    if (!rawKey) return false;
    await this.ready;
    // البحث بالبصمة — القاعدة لا تحتفظ بالنص الأصلي إطلاقاً
    const r = await this.db.execute({ sql: `SELECT id FROM api_keys WHERE key = ?`, args: [sha256Hex(rawKey)] });
    if (r.rows.length === 0) return false;
    const id = Number((r.rows[0] as any).id);
    this.deferApiTouch(id);
    return true;
  }

  async logEvent(type: string, payload: Record<string, any> = {}) {
    await this.ready;
    await this.db.execute({
      sql: `INSERT INTO events (ts, type, provider, key_id, model, status, latency_ms, error, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [Date.now(), type, payload.provider ?? null, payload.keyId ?? null, payload.model ?? null, payload.status ?? null, payload.latencyMs ?? null, payload.error ?? null, payload.meta ? JSON.stringify(payload.meta) : null]
    });
  }

  async logUsage(provider: string, keyId: string | null, model: string, usage: any) {
    await this.ready;
    await this.db.execute({
      sql: `INSERT INTO usage (ts, provider, key_id, model, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [Date.now(), provider, keyId, model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, usage.total_tokens ?? 0]
    });
  }

  async getRecentEvents(limit = 100) {
    await this.ready;
    const r = await this.db.execute({ sql: `SELECT * FROM events ORDER BY ts DESC LIMIT ?`, args: [limit] });
    return r.rows;
  }

  async getRecentUsage(limit = 50) {
    await this.ready;
    const r = await this.db.execute({ sql: `SELECT * FROM usage ORDER BY ts DESC LIMIT ?`, args: [limit] });
    return r.rows;
  }

  /**
   * إحصاءات الطلبات — **بعدّ حسب نوع الحدث لا عمود status**.
   * لماذا: أحداث الصحة والفحص تكتب `status='ok'` لا `'success'` ⇒ الإحصاء القديم
   * كان يحسبها «لا نجاح ولا فشل» ويضخّم المقام ⇒ نسبة النجاح في اللوحة خاطئة.
   * كما أن مزج فحص الصحة بنسبة نجاح الطلبات مخطأ دلالياً.
   * S10: ورد الكاش (200) كان يسقط من البسط ويبقى في المقام ⇒ معدل نجاح أقل من
   * الحقيقة. الرد المخزَّن ردٌّ ناجح، فيُحسب نجاحاً.
   */
  async getStats(sinceMs: number) {
    await this.ready;
    const r = await this.db.execute({
      sql: `SELECT COUNT(*) as total,
                   SUM(CASE WHEN type IN ('chat.success','chat.cache_hit') THEN 1 ELSE 0 END) as success,
                   SUM(CASE WHEN type IN ('chat.error','chat.all_failed','chat.stream_error') THEN 1 ELSE 0 END) as error
            FROM events WHERE ts > ? AND type LIKE 'chat%'`,
      args: [sinceMs]
    });
    return r.rows[0] || { total: 0, success: 0, error: 0 };
  }

  /**
   * تنظيف السجلات القديمة (سياسة احتفاظ صريحة).
   * لماذا: `health.ok` كل 60ث × 15 مزوّداً ≈ 21,600 صف/يوم بلا سقف ⇒ القاعدة تنمو
   * بلا حدّ. سياسة الاحتفاظ مكتوبة في هذا الملف وحده (لا أحد يخمّن مدة أخرى).
   */
  async prune(opts: { eventsDays?: number; usageDays?: number; rotationsKeep?: number; probesDays?: number; idleKeyDays?: number } = {}) {
    await this.ready;
    const now = Date.now();
    const eventsDays = Math.max(1, Number(opts.eventsDays) || 30);
    const usageDays = Math.max(1, Number(opts.usageDays) || 90);
    const rotationsKeep = Math.max(100, Number(opts.rotationsKeep) || 5000);
    // صفوف الفحص كانت لا تُنظَّف أبداً: صف نموذج/مزود محذوف يبقى للأبد ويغذي
    // «نماذج المزود» بنتيجة عمرها شهور (خلل مثبت بالقراءة). نتائج أقدم من أسبوع
    // بلا قيمة — كل الأحكام لها TTL أقصر من ذلك في التوجيه والفحص.
    const probesDays = Math.max(1, Number(opts.probesDays) || 7);
    // مفاتيح العملاء كانت لا تُحذف أبداً: كل متصفح بلا تخزين محلي ينشئ مفتاحاً
    // (باسم playground) ولا شيء يزيله ⇒ القائمة تتضخم بمفاتيح ميتة. المفتاح الذي
    // لم يُستخدم منذ idleKeyDays ولم يزد عدّاده يعني تخلّى عنه صاحبه. المفاتيح
    // الجديدة تُمنح مهلة كاملة من لحظة الإنشاء (ts) حتى لو لم تُستخدم بعد.
    const idleKeyDays = Math.max(1, Number(opts.idleKeyDays) || 30);
    const count = (r: any) => Number(r?.rowsAffected || 0);
    const idleCutoff = now - idleKeyDays * 86400000;

    const events = count(await this.db.execute({ sql: `DELETE FROM events WHERE ts < ?`, args: [now - eventsDays * 86400000] }));
    const usage = count(await this.db.execute({ sql: `DELETE FROM usage WHERE ts < ?`, args: [now - usageDays * 86400000] }));
    const rotations = count(await this.db.execute({
      sql: `DELETE FROM key_rotations WHERE id NOT IN (SELECT id FROM key_rotations ORDER BY id DESC LIMIT ?)`,
      args: [rotationsKeep]
    }));
    const probes = count(await this.db.execute({ sql: `DELETE FROM model_probe WHERE checked_at < ?`, args: [now - probesDays * 86400000] }));
    const apiKeys = count(await this.db.execute({
      sql: `DELETE FROM api_keys WHERE COALESCE(last_used, ts) < ?`,
      args: [idleCutoff]
    }));
    return { events, usage, rotations, probes, apiKeys };
  }

  /**
   * يعيد مساحة الصفحات الحرة إلى نظام الملفات بعد `prune`.
   * SQLite لا يقلّص الملف تلقائياً: الحذف يترك الصفحات حرة داخل الملف، فيبقى
   * الملف كبيراً بلا سبب (‎1,444 من 1,478 صفحة حرة في قياس فعلي‎). VACUUM يعيد
   * بناء الملف مضغوطاً. لا يغطّي قيمة الإعداد الافتراضي (auto_vacuum=FULL) لأنه
   * كان سيضيف كتابة على كل commit — التمرير الدوري بعد التنظيف هو الحلّ الأنسب.
   */
  async vacuum(): Promise<void> {
    await this.ready;
    await this.db.execute('VACUUM');
  }

  async getUsageByProvider(sinceMs: number) {
    await this.ready;
    const r = await this.db.execute({
      sql: `SELECT provider, COUNT(*) as requests, SUM(total_tokens) as tokens FROM usage WHERE ts > ? GROUP BY provider ORDER BY tokens DESC`,
      args: [sinceMs]
    });
    return r.rows;
  }

  // ===== مفاتيح المزودات (عدة مفاتيح لكل مزود مع تدوير) =====
  async listProviderKeys(provider?: string): Promise<any[]> {
    await this.ready;
    const r = provider
      ? await this.db.execute({ sql: `SELECT * FROM provider_keys WHERE provider = ? ORDER BY id`, args: [provider] })
      : await this.db.execute(`SELECT * FROM provider_keys ORDER BY provider, id`);
    return (r.rows as any[]).map(row => {
      const plain = decryptSecret(row.key);
      return { ...row, key: plain !== null ? plain : '' };
    });
  }

  async addProviderKey(provider: string, key: string, label?: string | null, source?: ProviderKeySource): Promise<any> {
    await this.ready;
    const encKey = encryptSecret(key);
    const fp = keyFingerprint(key);
    // هل البصمة موجودة مسبقاً؟ يُحسم **قبل** الإدراج لأن ON CONFLICT يُحدّث الصف
    // نفسه بدل إدراج صف جديد، فيستحيل التمييز بعده. اللصق المكرر ليس خطأً، لكن
    // على الاستدعاء أن يعرف أنه لم يُضف مفتاحاً جديداً كي لا يبلّغ بـ«أُضيف».
    const dup = await this.db.execute({
      sql: `SELECT id FROM provider_keys WHERE provider = ? AND key_fp = ?`,
      args: [provider, fp]
    });
    const existed = dup.rows.length > 0;
    // COALESCE على التعارض: من لم يحدّد مصدراً لا يحطّم مصدراً أعلى منه مسجَّلاً مسبقاً.
    const r = await this.db.execute({
      sql: `INSERT INTO provider_keys (provider, key, key_fp, label, ts, source) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, key_fp) DO UPDATE SET
              enabled = 1, status = 'unknown', blocked_until = NULL, last_error = NULL,
              source = COALESCE(?, source)
            RETURNING *`,
      args: [provider, encKey, fp, label ?? null, Date.now(), source ?? 'manual', source ?? null]
    });
    const row = r.rows[0] as any;
    return row ? { ...row, key, existed } : row;
  }

  /**
   * صفوف المفاتيح الخام (بلا فك تشفير) للمصالحة.
   * لماذا: المزامنة تقارن **بصمات** لا قيماً — لا داعي لفك تشفير كل مفتاح في كل دورة.
   */
  async listProviderKeysRaw(provider?: string): Promise<any[]> {
    await this.ready;
    const r = provider
      ? await this.db.execute({ sql: `SELECT id, provider, key_fp, label, enabled, status, blocked_until, requests, source FROM provider_keys WHERE provider = ? ORDER BY id`, args: [provider] })
      : await this.db.execute(`SELECT id, provider, key_fp, label, enabled, status, blocked_until, requests, source FROM provider_keys ORDER BY provider, id`);
    return r.rows as any[];
  }

  /** تسجيل تدقيق. لا تُمرَّر هنا أي قيمة سرّية — البصمة تكفي. */
  async logRotation(e: {
    provider: string; keyId?: number | null; keyFp?: string | null;
    action: string; reason?: string | null;
    fromSource?: ProviderKeySource | null; toSource?: ProviderKeySource | null;
    ok?: boolean; detail?: string | null;
  }): Promise<void> {
    await this.ready;
    await this.db.execute({
      sql: `INSERT INTO key_rotations (ts, provider, key_id, key_fp, action, reason, from_source, to_source, ok, detail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        Date.now(), e.provider, e.keyId ?? null, e.keyFp ?? null, e.action,
        e.reason ?? null, e.fromSource ?? null, e.toSource ?? null,
        e.ok === false ? 0 : 1, (e.detail ?? '').slice(0, 300)
      ]
    });
  }

  async listRotations(opts: { limit?: number; provider?: string } = {}): Promise<any[]> {
    await this.ready;
    const limit = Math.min(Math.max(1, Number(opts.limit) || 50), 500);
    const r = opts.provider
      ? await this.db.execute({ sql: `SELECT * FROM key_rotations WHERE provider = ? ORDER BY ts DESC LIMIT ?`, args: [opts.provider, limit] })
      : await this.db.execute({ sql: `SELECT * FROM key_rotations ORDER BY ts DESC LIMIT ?`, args: [limit] });
    return r.rows as any[];
  }

  /** حالة آخر جلب لكل مصدر — تشخيص بلا أسرار. */
  async upsertSourceState(s: {
    id: string; label: string; priority: number; configured: boolean;
    ok: boolean | null; entries: number; error?: string | null; latencyMs?: number | null;
  }): Promise<void> {
    await this.ready;
    await this.db.execute({
      sql: `INSERT INTO secret_sources (id, label, priority, configured, ok, entries, error, latency_ms, last_sync)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              label = excluded.label, priority = excluded.priority,
              configured = excluded.configured, ok = excluded.ok, entries = excluded.entries,
              error = excluded.error, latency_ms = excluded.latency_ms, last_sync = excluded.last_sync`,
      args: [
        s.id, s.label, s.priority, s.configured ? 1 : 0,
        s.ok === null ? null : (s.ok ? 1 : 0), s.entries,
        (s.error ?? null), s.latencyMs ?? null, Date.now()
      ]
    });
  }

  async listSourceStates(): Promise<any[]> {
    await this.ready;
    const r = await this.db.execute(`SELECT * FROM secret_sources ORDER BY priority ASC`);
    return (r.rows as any[]).map(row => ({
      id: row.id, label: row.label, priority: Number(row.priority),
      configured: !!row.configured,
      ok: row.ok === null || row.ok === undefined ? null : !!row.ok,
      entries: Number(row.entries || 0),
      error: row.error ?? null,
      latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
      lastSync: row.last_sync ?? null
    }));
  }

  async updateProviderKey(id: number, patch: {
    key?: string; label?: string; enabled?: boolean; status?: string;
    error?: string | null; blockMs?: number | null; requests?: number;
  }) {
    await this.ready;
    const sets: string[] = [];
    const args: any[] = [];
    if (patch.key !== undefined) {
      sets.push('key = ?');
      args.push(encryptSecret(patch.key));
      sets.push('key_fp = ?');
      args.push(keyFingerprint(patch.key));
    }
    if (patch.label !== undefined) { sets.push('label = ?'); args.push(patch.label); }
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0); }
    if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status); }
    if (patch.error !== undefined) { sets.push('last_error = ?'); args.push(patch.error); }
    if (patch.requests !== undefined) { sets.push('requests = ?'); args.push(patch.requests); }
    if (patch.blockMs !== undefined) {
      sets.push('blocked_until = ?');
      args.push(patch.blockMs ? Date.now() + patch.blockMs : null);
    }
    if (!sets.length) return;
    args.push(id);
    await this.db.execute({ sql: `UPDATE provider_keys SET ${sets.join(', ')} WHERE id = ?`, args });
  }

  async deleteProviderKey(id: number) {
    await this.ready;
    await this.db.execute({ sql: `DELETE FROM provider_keys WHERE id = ?`, args: [id] });
  }

  /**
   * عدّاد استخدام المفتاح. يقبل دفعة (count): الموجّه يجمّع العدّ كل 5 ثوانٍ
   * ويكتب مرة واحدة، بدل كتابة قاعدة لكل طلب ناجح.
   */
  async touchProviderKey(id: number, count = 1) {
    const n = Math.max(1, Math.floor(Number(count) || 1));
    await this.ready;
    await this.db.execute({
      sql: `UPDATE provider_keys SET requests = requests + ?, last_used = ? WHERE id = ?`,
      args: [n, Date.now(), id]
    });
  }

  // ===== الإعدادات العامة =====
  async getSettings(): Promise<Record<string, string>> {
    await this.ready;
    const r = await this.db.execute(`SELECT key, value FROM settings`);
    const out: Record<string, string> = {};
    for (const row of r.rows as any[]) out[row.key] = row.value;
    return out;
  }

  async setSettings(patch: Record<string, string>) {
    await this.ready;
    for (const [k, v] of Object.entries(patch)) {
      await this.db.execute({
        sql: `INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [k, String(v)]
      });
    }
  }

  async close() { await this.db.close(); }

  // ===== فحص النماذج (model probe) =====
  async upsertProbe(provider: string, model: string, status: string, latencyMs: number, error?: string) {
    await this.ready;
    await this.db.execute({
      sql: `INSERT INTO model_probe (provider, model, status, latency_ms, error, checked_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider, model) DO UPDATE SET
              status = excluded.status, latency_ms = excluded.latency_ms,
              error = excluded.error, checked_at = excluded.checked_at`,
      args: [provider, model, status, latencyMs, error ?? null, Date.now()]
    });
  }

  async getProbes(provider?: string): Promise<any[]> {
    await this.ready;
    const r = provider
      ? await this.db.execute({ sql: `SELECT * FROM model_probe WHERE provider = ? ORDER BY model`, args: [provider] })
      : await this.db.execute(`SELECT * FROM model_probe ORDER BY provider, model`);
    return r.rows as any[];
  }

  async clearProbes(provider?: string) {
    await this.ready;
    if (provider) await this.db.execute({ sql: `DELETE FROM model_probe WHERE provider = ?`, args: [provider] });
    else await this.db.execute(`DELETE FROM model_probe`);
  }

  async getProbeSummary() {
    await this.ready;
    const r = await this.db.execute(`
      SELECT status, COUNT(*) as n FROM model_probe GROUP BY status
    `);
    return r.rows as any[];
  }
}