// tests/_fixtures.mjs — مفاتيح الاختبار تُقرأ من ملف محلي غير متتبع.
// لماذا: سكربتات المتصفح/API تحتاج مفاتيح مزود حقيقية لبعض الفحوص الحية،
// والمستودع مفتوح المصدر — لا يجوز تثبيت أي مفتاح في الكود.
// الاستخدام: أنشئ data/.testkeys.json (مستثنى من git):
//   { "dahl": ["dahl_...", "dahl_...", ...] }
// بدونه: الفحوص المعتمدة على مزود حقيقي تُتخطى بصدق والبقية تعمل.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_PATH = join(process.cwd(), 'data', '.testkeys.json');

/** يقرأ ملف التركيبات أو null إن لم يوجد. */
export function loadFixture() {
  if (!existsSync(FIXTURE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** مفاتيح dahl للاختبار أو [] إن لم يوجد ملف التركيبات. */
export function dahlTestKeys() {
  return loadFixture()?.dahl ?? [];
}
