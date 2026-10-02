// server/key-score.ts — درجة صحة المفتاح: مصدر حقيقة واحد.
//
// لماذا ملف مستقل: درجة المفتاح يحتاجها **موجّه** (ليختار ترتيب المفاتيح)
// و**وكيل التدوير** (ليقرر العزل). لو نُسخت في الاثنين لتطابقتا اليوم وانحازتا
// غداً — وهذا بالضبط كيف يحدث انحراف صامت بين المنطق والمراقبة.
//
// القواعد مكتوبة هنا صريحة، والدالة **نقية**: لا I/O، لا حالة، لا Date.now داخلها.
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface KeyScoreInput {
  id?: number | null;
  status?: string | null;
  enabled?: boolean | number | null;
  requests?: number | null;
  blocked_until?: number | null;
  blockedUntil?: number | null;
}

export interface KeyScore {
  state: CircuitState;
  /** 0..100 — أعلى = يُستخدم أولاً */
  score: number;
}

/** درجة افتراضية لمفتاح بلا بيانات: محايد — لا يُقدَّم ولا يُقدَّم بعد غيره. */
export const DEFAULT_KEY_SCORE = 50;

/** درجة مصدر المفتاح (الأصغر أعلى سلطة). manual=90 فلا يتقدّم عليه مصدر آلي. */
export function authorityOf(source: unknown): number {
  const map: Record<string, number> = {
    vault: 10, doppler: 20, onepassword: 30, file: 40, env: 50, manual: 90
  };
  return map[String(source)] ?? 90;
}

/**
 * الحالة والدرجة من حقول المخزَّنة فقط — صفر تكلفة شبكة.
 * السرعة شرط: هذه الدالة تُستدعى في المسار الساخن لكل طلب.
 */
export function scoreKey(row: KeyScoreInput, now: number): KeyScore {
  const status = String(row.status || 'unknown');
  const enabled = row.enabled !== 0 && row.enabled !== false && row.enabled !== null;
  const blockedUntil = row.blocked_until ?? row.blockedUntil ?? null;
  const blocked = !!blockedUntil && blockedUntil > now;
  const requests = Number(row.requests || 0);

  let state: CircuitState;
  if (!enabled) state = 'open';
  else if (status === 'auth_error') state = 'open';
  else if (blocked) state = 'open';
  else if (status === 'quota_exhausted') state = 'half-open';
  else if (status === 'ok' && requests > 0) state = 'closed';
  else state = 'half-open';

  let score = DEFAULT_KEY_SCORE;
  if (state === 'closed') score = 100;
  else if (state === 'open') score = status === 'auth_error' ? 0 : 10;
  else if (status === 'quota_exhausted') score = 25;

  return { state, score };
}