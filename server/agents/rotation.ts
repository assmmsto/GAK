// server/agents/rotation.ts — وكيل التدوير: قواطع دائرة لكل مفتاح + ترتيب بالأهمّية.
//
// لماذا لا نموذج لغوي: قرار التدوير يجب أن يكون **حتمياً وقابلاً للاختبار**.
// القواعد مكتوبة هنا صراحةً، وكل حالة لها أثر مُختبَر.
//
// قاعدة القاطع الواحد:
//   closed    → المفتاح يعمل، يُستخدم
//   open      → معطّل (خطأ مصادقة/حصة/عطل) حتى يحين وقته
//   half-open → انتهت المهلة، يُجرَّب مجدداً؛ نجاح ⇒ closed، فشل ⇒ open أطول
// الضمانة: لا يُعطَّل مفتاح بلا سبب مكتوب، وكل تعطيل يُسجَّل في key_rotations.
import type { EventDB } from '../db.js';
import type { Router } from '../router.js';
// منطق الدرجة **مشترك** مع الموجّه (مصدر حقيقة واحد) — انظر server/key-score.ts
import { scoreKey, authorityOf, type CircuitState } from '../key-score.js';

export type { CircuitState };

export interface KeyCircuit {
  id: number;
  provider: string;
  keyFp: string | null;
  source: string;
  /** أولوية السلطة (الأصغر أعلى) — مفاتيح المستخدم 90 فلا يُلمسها شيء آلي */
  authority: number;
  status: string;
  enabled: boolean;
  state: CircuitState;
  /** 0..100 — أساس ترتيب المفاتيح (أعلى = أول استخدام) */
  score: number;
  requests: number;
  blockedUntil: number | null;
  retryInMs: number | null;
  /** خطأ مصادقة + مصدر آلي ⇒ يستحق إعادة جلب من المصدر */
  needsResync: boolean;
}

export interface RotationReport {
  ts: number;
  durationMs: number;
  keys: KeyCircuit[];
  /** مزودات فقدت كل مفاتيح ⇒ عزلها حتى يصل مفتاح جديد */
  isolatedProviders: string[];
  counts: { closed: number; open: number; halfOpen: number; needsResync: number };
}

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * حالة المفتاح محسوبة من حقوله المخزّنة فقط — بلا أي طلب شبكة.
 * السرعة شرط: هذه الدورة تعمل كل دقيقة، فلا يجوز أن تكلّف اتصالاً.
 * (التنفيذ في key-score.ts — نفس الدالة التي يستعملها الموجّه، لا نسخة.)
 */
export function circuitOf(row: any, now: number): KeyCircuit {
  const { state, score } = scoreKey(row, now);
  const status = String(row?.status || 'unknown');
  const enabled = row?.enabled !== 0 && row?.enabled !== false;
  const blockedUntil = row?.blocked_until ?? row?.blockedUntil ?? null;
  const source = row?.source || 'manual';
  const requests = Number(row?.requests || 0);
  const authority = authorityOf(source);

  return {
    id: Number(row?.id),
    provider: String(row?.provider || ''),
    keyFp: row?.key_fp ? String(row.key_fp) : null,
    source,
    authority,
    status,
    enabled,
    state,
    score,
    requests,
    blockedUntil: blockedUntil || null,
    retryInMs: blockedUntil && blockedUntil > now ? blockedUntil - now : null,
    needsResync: enabled && status === 'auth_error' && authority < 90
  };
}

/** ترتيب المفاتيح للاستخدام: الأصحّ ← فالأعلى سلطةً ← فالأقلّ حركةً. */
export function rankCircuits(keys: KeyCircuit[]): KeyCircuit[] {
  return [...keys].sort((a, b) => (
    b.score - a.score ||
    a.authority - b.authority ||
    b.requests - a.requests ||
    a.id - b.id
  ));
}

export class RotationAgent {
  /** عدّاد تكرار نفاد الحصة لكل مفتاح (في الذاكرة — يُصفَّر عند التعافي). */
  private quotaStreak = new Map<number, number>();

  constructor(private db: EventDB, private router: Router, private emit?: (e: any) => void) {}

  /** قراءة الحالة الحالية بلا كتابة — تستخدمها الواجهة والتشخيص. */
  async inspect(): Promise<KeyCircuit[]> {
    const rows = await this.db.listProviderKeysRaw();
    const now = Date.now();
    return rows.map(r => circuitOf(r, now));
  }

  /** ترتيب مفاتيح مزوّد معيّن حسب الصحة والسلطة. */
  async ranking(provider: string): Promise<KeyCircuit[]> {
    return rankCircuits((await this.inspect()).filter(c => c.provider === provider));
  }

  /**
   * دورة واحدة:
   *   1) تمديد عزل الحصة المتكررة (تراجع أسّي بسقف 15 دقيقة).
   *   2) عزل المزوّد الذي فقد كل مفاتيح — يمنع محاولة فاشلة في كل طلب.
   *   3) لا كتابة إن لم يتغيّر شيء (سرعة + أقل رجوع للقاعدة).
   */
  async tick(): Promise<RotationReport> {
    const t0 = Date.now();
    const now = Date.now();
    const rows = await this.db.listProviderKeysRaw();
    const circuits = rows.map(r => circuitOf(r, now));

    // 0) **الربط الحاسم**: نمرّر الدرجات للموجّه ⇒ ترتيب اختيار المفاتيح يصبح فعّالاً.
    //    بدون هذا السطر يبقى وكيل التدوير مرصِداً يقرأ ولا يُغيّر (خلل S1).
    this.router.setKeyScores(circuits.map(c => ({ id: c.id, score: c.score })));

    // 1) العزل التصاعدي للحصص المتكررة
    for (const c of circuits) {
      if (c.status !== 'quota_exhausted' || !c.enabled) {
        if (c.status !== 'quota_exhausted') this.quotaStreak.delete(c.id);
        continue;
      }
      // لا نلمس مفتاحاً ما زال ضمن مدة عزله — التكرار يُقاس عند انتهائها
      if (c.blockedUntil && c.blockedUntil > now) continue;
      const streak = (this.quotaStreak.get(c.id) ?? 0) + 1;
      this.quotaStreak.set(c.id, streak);
      const blockMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * streak);
      await this.db.updateProviderKey(c.id, { status: 'quota_exhausted', blockMs });
      await this.db.logRotation({
        provider: c.provider, keyId: c.id, keyFp: c.keyFp, action: 'backoff',
        reason: `حصة متكررة (${streak}) — عزل ${Math.round(blockMs / 1000)}ث`
      });
    }

    // 2) عزل المزوّد الذي فقد كل مفاتيح — مرة واحدة فقط
    // لماذا «مرة واحدة»: إعادة العزل كل دورة تُغرق سجل التدقيق بلا معلومة جديدة،
    // والمزوّد بلا مفاتيح أصلاً (لا صف له) ليس «فقد» مفاتيحه بل لم تُمنح له أصلاً.
    const isolated: string[] = [];
    for (const pid of this.router.getProviderIds()) {
      const entry = this.router.getProvider(pid);
      if (!entry || entry.enabled === false) continue;
      const mine = circuits.filter(c => c.provider === pid);
      if (!mine.length) continue;                       // لا صفوف مفاتيح أصلاً — ليس مسؤوليتنا
      if (!mine.some(c => c.enabled)) continue;         // كل مفاتيحه معطّلة يدوياً — احترام قرار المستخدم
      if (entry.status === 'auth_error') continue;     // معزول أصلاً — لا نكرّر
      if (this.router.availableKeySlots(entry).length > 0) continue;
      this.router.setStatus(pid, 'auth_error', 'كل المفاتيح معطّلة', undefined);
      isolated.push(pid);
      await this.db.logRotation({ provider: pid, action: 'provider_isolated', reason: 'لا مفتاح صالح' });
    }

    if (isolated.length) {
      await this.db.logEvent('agents.rotation', {
        status: 'error', meta: { isolatedProviders: isolated.length, keys: circuits.length }
      }).catch(() => {});
      this.emit?.({ type: 'rotation', isolated: isolated.length, ts: Date.now() });
    }

    const counts = {
      closed: circuits.filter(c => c.state === 'closed').length,
      open: circuits.filter(c => c.state === 'open').length,
      halfOpen: circuits.filter(c => c.state === 'half-open').length,
      needsResync: circuits.filter(c => c.needsResync).length
    };

    return { ts: Date.now(), durationMs: Date.now() - t0, keys: circuits, isolatedProviders: isolated, counts };
  }
}