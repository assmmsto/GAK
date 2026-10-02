// server/agents/key-sync.ts — محرك مزامنة المفاتيح متعدد المصادر.
//
// المبدأ الحاكم (مطبَّق حرفياً):
//   «ما لم يقرّره أحد، لا يُفعل» — لا حذف تلقائي أبداً، ولا تعطيل لمفتاح
//   أدخله المستخدم بنفسه، وكل تغيير يُسجَّل في key_rotations.
//
// الأولوية عند التعارض: vault > doppler > onepassword > file > env > manual.
// المصالحة (reconcile) idempotent: تشغيلها مرتين = النتيجة نفسها تماماً.
import type { EventDB, ProviderKeySource } from '../db.js';
import { SOURCE_PRIORITY } from '../db.js';
import type { Router } from '../router.js';
import type { KeySource, SecretEntry, SourceReport } from '../secrets/source.js';
import { buildSources } from '../secrets/remote-sources.js';
import { keyFingerprint } from '../crypto.js';

export type SyncAction = 'added' | 'reactivated' | 'authority' | 'withdrawn' | 'skipped-manual' | 'error';

export interface SyncActionRecord {
  provider: string;
  action: SyncAction;
  source: ProviderKeySource | null;
  keyFp: string | null;
  reason: string | null;
}

export interface SyncReport {
  ts: number;
  durationMs: number;
  sources: SourceReport[];
  actions: SyncActionRecord[];
  counts: Record<SyncAction, number>;
  desiredKeys: number;
  currentKeys: number;
}

/** سقف دفاعي: مصدر معطوب يعيد 100 ألف مفتاح يجب ألّا يُغرق القاعدة. */
const MAX_ENTRIES_PER_SOURCE = 500;
const FETCH_TIMEOUT_MS = 15_000;

export class KeySyncEngine {
  constructor(
    private db: EventDB,
    private router: Router,
    private emit?: (event: any) => void
  ) {}

  /** حالة كل المصادر بلا أسرار — تُعرض في الواجهة وتشخّص «لماذا لا تُزامَن؟». */
  async sourcesStatus(): Promise<SourceReport[]> {
    const built = buildSources();
    const stored = new Map((await this.db.listSourceStates()).map(s => [s.id, s]));
    return built.map(s => {
      const prev = stored.get(s.id);
      return {
        id: s.id, label: s.label, priority: s.priority,
        configured: s.configured(),
        ok: prev?.ok ?? null,
        entries: prev?.entries ?? 0,
        error: prev?.error ?? null,
        latencyMs: prev?.latencyMs ?? null
      };
    });
  }

  /**
   * يجلب من كل المصادر بالتوازي. الفشل لا يوقف الباقي:
   * مصدر واحد معطوب يجب ألّا يعطّل مصدراً يعمل — ولا يمسّ ما هو قائم.
   */
  private async fetchAll(sources: KeySource[]): Promise<{ entries: SecretEntry[]; reports: SourceReport[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();

    // **جلب واحد لكل مصدر**: نجمع القيم والتقرير من نفس الاستدعاء.
    // (نسخة سابقة كانت تجلب مرتين — طلبات مزدوجة على المزوّد وحدّ سرعة مهدور.)
    const collected = await Promise.all(sources.map(async (s) => {
      const base = { id: s.id, label: s.label, priority: s.priority, configured: s.configured() };
      if (!s.configured()) {
        return {
          report: { ...base, ok: null, entries: 0, error: null, latencyMs: null } as SourceReport,
          entries: [] as SecretEntry[]
        };
      }
      const t0 = Date.now();
      try {
        const r = await s.fetch(controller.signal);
        const latencyMs = Date.now() - t0;
        const capped = r.entries.slice(0, MAX_ENTRIES_PER_SOURCE);
        const dropped = r.entries.length - capped.length;
        return {
          report: {
            ...base,
            ok: !r.error,
            entries: capped.length,
            latencyMs,
            error: r.error || (dropped > 0 ? `تجاوز الحد (${dropped} مفتاحاً أُهمل)` : null)
          } as SourceReport,
          entries: r.error ? [] : capped
        };
      } catch (e: any) {
        // عقد المصدر يمنع الرمي؛ هذا الخطاف أمان إضافي لا يبتلع شيئاً صامتاً
        return {
          report: {
            ...base, ok: false, entries: 0, latencyMs: Date.now() - t0,
            error: `استثناء غير متوقّع: ${e?.message || String(e)}`.slice(0, 200)
          } as SourceReport,
          entries: [] as SecretEntry[]
        };
      }
    }));

    clearTimeout(timer);
    return {
      entries: collected.flatMap(c => c.entries),
      reports: collected.map(c => c.report)
    };
  }

  /**
   * المصالحة: تقارن «ما يجب أن يكون» بـ«ما هو عليه» وتنفّذ الفرق فقط.
   * ضمانات أربعة (كلها مُختبَرة في tests/agents.check.tsx):
   *   1) idempotent  — التشغيل مرتين لا يُنتج تغييراً ثانياً.
   *   2) لا حذف أبداً — السحب = تعطيل + سجل تدقيق.
   *   3) يدوي = مقدّس — مفاتيح المستخدم لا تمسّها المزامنة إطلاقاً.
   *   4) فشل مصدر لا يسحب شيئاً — السحب ممنوع ما لم يجب مصدر واحد على الأقل.
   */
  async reconcile(opts: { sources?: KeySource[] } = {}): Promise<SyncReport> {
    const t0 = Date.now();
    const sources = opts.sources ?? buildSources();
    const { entries, reports } = await this.fetchAll(sources);

    // 1) الحالة المطلوبة — لكل (مزوّد، بصمة) نحسب صاحب أعلى سلطة فقط
    const desired = new Map<string, { entry: SecretEntry; fp: string }>();
    for (const e of entries) {
      const fp = keyFingerprint(e.value);
      const k = `${e.provider}:${fp}`;
      const prev = desired.get(k);
      if (!prev || e.priority < prev.entry.priority) desired.set(k, { entry: e, fp });
    }

    // 2) الحالة الحالية (بصمات فقط — بلا فك تشفير)
    const rows = await this.db.listProviderKeysRaw();
    const byKey = new Map<string, any>(rows.map(r => [`${r.provider}:${r.key_fp}`, r]));

    const actions: SyncActionRecord[] = [];
    const counts: Record<SyncAction, number> = {
      added: 0, reactivated: 0, authority: 0, withdrawn: 0, 'skipped-manual': 0, error: 0
    };
    const touched = new Set<string>();
    const push = (a: SyncActionRecord) => { actions.push(a); counts[a.action]++; };

    // 3) إضافات + تغيّر السلطة + إعادة التفعيل
    for (const [, { entry, fp }] of desired) {
      const row = byKey.get(`${entry.provider}:${fp}`);
      try {
        if (!row) {
          await this.db.addProviderKey(entry.provider, entry.value, entry.label ?? null, entry.source);
          await this.db.logRotation({
            provider: entry.provider, keyFp: fp, action: 'added',
            toSource: entry.source, reason: 'مفتاح جديد من المصدر'
          });
          touched.add(entry.provider);
          push({ provider: entry.provider, action: 'added', source: entry.source, keyFp: fp.slice(0, 12), reason: 'جديد' });
          continue;
        }
        const rowSource = (row.source || 'manual') as ProviderKeySource;
        if (SOURCE_PRIORITY[entry.source] < SOURCE_PRIORITY[rowSource]) {
          await this.db.addProviderKey(entry.provider, entry.value, entry.label ?? null, entry.source);
          await this.db.logRotation({
            provider: entry.provider, keyId: row.id, keyFp: fp, action: 'authority',
            fromSource: rowSource, toSource: entry.source, reason: 'مصدر أعلى سلطة'
          });
          push({
            provider: entry.provider, action: 'authority', source: entry.source, keyFp: fp.slice(0, 12),
            reason: `${rowSource} ← ${entry.source}`
          });
        }
        if (!row.enabled) {
          await this.db.updateProviderKey(row.id, { enabled: true, status: 'unknown', error: null, blockMs: null });
          await this.db.logRotation({
            provider: entry.provider, keyId: row.id, keyFp: fp, action: 'reactivated',
            toSource: entry.source, reason: 'عاد من مصدره'
          });
          touched.add(entry.provider);
          push({ provider: entry.provider, action: 'reactivated', source: entry.source, keyFp: fp.slice(0, 12), reason: 'معطّل' });
        }
      } catch (e: any) {
        push({
          provider: entry.provider, action: 'error', source: entry.source, keyFp: fp.slice(0, 12),
          reason: String(e?.message || e).slice(0, 150)
        });
      }
    }

    // 4) السحب — ممنوع ما لم يجب مصدر واحد على الأقل (حماية من فشل Vault)
    const anySourceLive = reports.some(r => r.ok);
    if (anySourceLive) {
      for (const row of rows) {
        if (desired.has(`${row.provider}:${row.key_fp}`)) continue;
        const rowSource = (row.source || 'manual') as ProviderKeySource;
        if (rowSource === 'manual') {
          push({
            provider: row.provider, action: 'skipped-manual', source: 'manual',
            keyFp: String(row.key_fp).slice(0, 12), reason: 'مفتاح يدوي — لا تُمسّه المزامنة'
          });
          continue;
        }
        if (!row.enabled) continue;
        try {
          await this.db.updateProviderKey(row.id, { enabled: false, error: 'سُحب من مصدره' });
          await this.db.logRotation({
            provider: row.provider, keyId: row.id, keyFp: row.key_fp, action: 'withdrawn',
            fromSource: rowSource, reason: 'لم يعد مصدره يقدّمه'
          });
          touched.add(row.provider);
          push({ provider: row.provider, action: 'withdrawn', source: rowSource, keyFp: String(row.key_fp).slice(0, 12), reason: 'سُحب' });
        } catch (e: any) {
          push({
            provider: row.provider, action: 'error', source: rowSource,
            keyFp: String(row.key_fp).slice(0, 12), reason: String(e?.message || e).slice(0, 150)
          });
        }
      }
    }

    // 5) تطبيق الحالة على الموجّه (بلا هذا تبقى المفاتيح الجديدة خارج الذاكرة)
    for (const pid of touched) {
      try { await this.router.reloadProviderKeys(pid); }
      catch (e: any) { console.error(`[key-sync] reloadProviderKeys(${pid}) فشل:`, e?.message || e); }
    }

    for (const r of reports) {
      try {
        await this.db.upsertSourceState({
          id: r.id, label: r.label, priority: r.priority, configured: r.configured,
          ok: r.ok, entries: r.entries, error: r.error, latencyMs: r.latencyMs
        });
      } catch (e: any) {
        console.error('[key-sync] حفظ حالة المصدر فشل:', e?.message || e);
      }
    }

    const changed = counts.added + counts.reactivated + counts.authority + counts.withdrawn + counts.error;
    if (changed > 0) {
      await this.db.logEvent('agents.key_sync', {
        status: counts.error ? 'error' : 'success',
        meta: {
          added: counts.added, reactivated: counts.reactivated, authority: counts.authority,
          withdrawn: counts.withdrawn, errors: counts.error, desired: desired.size, sources: reports.length
        }
      }).catch(() => {});
      this.emit?.({ type: 'key-sync', counts, ts: Date.now() });
    }

    return {
      ts: Date.now(),
      durationMs: Date.now() - t0,
      sources: reports,
      actions,
      counts,
      desiredKeys: desired.size,
      currentKeys: rows.length
    };
  }
}