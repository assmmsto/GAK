// server/db.ts — SQLite (libsql) events, usage, key health
import { createClient, type Client } from '@libsql/client';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encryptSecret, decryptSecret, isEncryptedSecret, keyFingerprint, CRED_PREFIX
} from './crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'gateway.db');

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
    await this._migrateProbeAuthErrors();
    await this._migrateSecretStorageInternal();
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

  async createApiKey(name: string): Promise<{ key: string; name: string; id: number }> {
    await this.ready;
    const key = 'gw_' + Array.from({ length: 40 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    const r = await this.db.execute({ sql: `INSERT INTO api_keys (key, name, ts) VALUES (?, ?, ?) RETURNING id`, args: [key, name, Date.now()] });
    return { key, name, id: Number((r.rows[0] as any)?.id) };
  }

  async listApiKeys() {
    await this.ready;
    const r = await this.db.execute({ sql: `SELECT id, key, name, ts, last_used, requests FROM api_keys ORDER BY ts DESC`, args: [] });
    return r.rows;
  }

  async deleteApiKey(id: number) {
    await this.ready;
    await this.db.execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
  }

  async checkApiKey(rawKey: string): Promise<boolean> {
    if (!rawKey) return false;
    await this.ready;
    const r = await this.db.execute({ sql: `SELECT id FROM api_keys WHERE key = ?`, args: [rawKey] });
    if (r.rows.length === 0) return false;
    await this.db.execute({ sql: `UPDATE api_keys SET last_used = ?, requests = requests + 1 WHERE key = ?`, args: [Date.now(), rawKey] });
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

  async getStats(sinceMs: number) {
    await this.ready;
    const r = await this.db.execute({
      sql: `SELECT COUNT(*) as total, SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error FROM events WHERE ts > ?`,
      args: [sinceMs]
    });
    return r.rows[0] || { total: 0, success: 0, error: 0 };
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

  async addProviderKey(provider: string, key: string, label?: string | null): Promise<any> {
    await this.ready;
    const encKey = encryptSecret(key);
    const fp = keyFingerprint(key);
    const r = await this.db.execute({
      sql: `INSERT INTO provider_keys (provider, key, key_fp, label, ts) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(provider, key_fp) DO UPDATE SET
              enabled = 1, status = 'unknown', blocked_until = NULL, last_error = NULL
            RETURNING *`,
      args: [provider, encKey, fp, label ?? null, Date.now()]
    });
    const row = r.rows[0] as any;
    return row ? { ...row, key } : row;
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

  async touchProviderKey(id: number) {
    await this.ready;
    await this.db.execute({
      sql: `UPDATE provider_keys SET requests = requests + 1, last_used = ? WHERE id = ?`,
      args: [Date.now(), id]
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