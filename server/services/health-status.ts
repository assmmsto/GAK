// server/services/health-status.ts — استنتاج حالة المفتاح من آخر خطأ مخزَّن.
//
// لماذا: `wakeKeySlots` تُصفّر `status` إلى 'unknown' عند انتهاء مدة العزل،
// ويبقى `last_error` محفوظاً. بلا هذا الاستنتاج كان مفتاح له 27 طلباً ورسالة
// `model_concurrency` يُعرض في تبويب الحالة كأنه «لم يُختبر» — ادّعاء غير صحيح.
//
// الترتيب مقصود: نصوص المصادقة أولاً (لأن «insufficient permissions for this
// API key» تحتوي كلمة insufficient)، ثم الضغط العابر، ثم الحصة الدائمة.
// رسالة الضغط قد تذكر «Top up» فتُقرأ حصةً وهي عابرة (خلل مُصلَح سابقاً في الموجّه).

export type HealthStatus = 'ok' | 'unknown' | 'quota_exhausted' | 'auth_error' | 'rate_limited';

const AUTH_RE = /\b40[13]\b|invalid api key|invalid apikey|incorrect api key|unauthorized|authentication_error|forbidden|permission|api key not valid/i;
const TRANSIENT_RE = /\b429\b|concurrency|capacity|rate.?limit|too many requests|slow down|temporarily/i;
const QUOTA_RE = /quota|exceeded your current quota|insufficient|balance|credit|allowance/i;

/**
 * الحالة الفعلية للعرض. المخزَّن غير 'unknown' يُعاد كما هو (لا نُكذّب القاعدة).
 * @param stored قيمة `provider_keys.status`
 * @param lastError قيمة `provider_keys.last_error` (بعد التعقيم)
 */
export function inferHealthStatus(stored: string, lastError: string | null | undefined): HealthStatus {
  const s = String(stored || 'unknown');
  if (s !== 'unknown' || !lastError) return s as HealthStatus;
  const e = String(lastError);
  if (AUTH_RE.test(e)) return 'auth_error';
  if (TRANSIENT_RE.test(e)) return 'rate_limited';
  if (QUOTA_RE.test(e)) return 'quota_exhausted';
  return 'unknown';
}
