// server/secrets/source.ts — عقد مصادر الأسرار (Source of Truth Chain).
//
// لماذا واجهة واحدة لأربعة مصادر: منطق المزامنة يجب أن يبقى واحداً مهما
// تغيّر المصدر. لو كتبنا كل مصدر داخل المزامنة لصار كل مصدر جديد نقطة خطأ
// جديدة في المنطق الحسّاس (تعديل مفاتيح إنتاج).
//
// الأولوية (الأصغر يفوز عند التعارض): ما يُدار إنسانياً في مدير أسرار أعلى
// سلطةً من ملف محلي، والملف المحلي أعلى من مفتاح بيئة عابر.
import type { ProviderKeySource } from '../db.js';

export type { ProviderKeySource };

export interface SecretEntry {
  /** معرّف المزود (مفتاح في providers.yaml أو catalog.yaml) */
  provider: string;
  /** القيمة السرية نفسها — لا تُسجَّل ولا تُعاد عبر أي API */
  value: string;
  /** تسمية بشرية اختيارية */
  label: string | null;
  /** أين وُجد */
  source: ProviderKeySource;
  /** أولوية المصدر: الأصغر أعلى سلطة */
  priority: number;
}

export interface SourceReport {
  id: ProviderKeySource;
  label: string;
  priority: number;
  /** هل المصدر مُهيَّأ (توكن/ملف موجود)؟ */
  configured: boolean;
  /** هل جرى جلبه بنجاح؟ (null = لم يُجرَّب) */
  ok: boolean | null;
  entries: number;
  /** رسالة خطأ معقّمة — بلا أي سر */
  error: string | null;
  /** كم استغرق الجلب (لقياس السرعة) */
  latencyMs: number | null;
}

export interface KeySource {
  readonly id: ProviderKeySource;
  readonly label: string;
  readonly priority: number;
  /** هل التوكنات/الملف موجودة؟ المصدر غير المُهيَّأ لا يُسأل ولا يُعدّ فشلاً. */
  configured(): boolean;
  /**
   * يجلب كل الأسرار التي يملكها هذا المصدر.
   * العقد: لا يرمي أبداً — أي فشل يُعاد داخل النتيجة مع رسالة معقّمة،
   * لأن الفشل يجب ألّا يُسقط المزامنة ولا يمسّ المفاتيح القائمة.
   */
  fetch(signal: AbortSignal): Promise<{ entries: SecretEntry[]; error?: string }>;
}

/** تحقق من شكل معرّف المزود — نفس القاعدة المستخدمة عند إضافة مزود. */
export function isValidProviderId(id: unknown): boolean {
  return /^[a-z0-9-]{2,32}$/.test(String(id || '').trim());
}

/**
 * معرّف متغيّر البيئة ← معرّف المزود.
 * "GROQ_API_KEY" → "groq" · "GOOGLE_AI_API_KEY" → "google-ai"
 * نستنتج المعرّف لأن الشرطات تُطوى إلى "_" عند التسمية، فنعيد المحاولة
 * بمطابقة الكتالوج أولاً (أدق) ثم بالتخمين.
 */
export function providerIdFromEnvName(envName: string): string | null {
  const m = String(envName || '').trim().toUpperCase().match(/^([A-Z0-9_]+?)_API_KEYS?$/);
  if (!m) return null;
  const slug = m[1].toLowerCase().replace(/_/g, '-');
  return isValidProviderId(slug) ? slug : null;
}