// server/crypto.ts — تشفير أسرار المخزون (AES-256-GCM)
//
// لماذا: مفاتيح المزودات كانت نصاً صريحاً في data/gateway.db. نسخُ الملف
// (نسخة احتياطية، مشاركة مجلد، سرقة جهاز) = تسليم كل المفاتيح. التشفير هنا
// يحوّل «قيمة الملف» إلى قيمة لا تنفع بلا مفتاح التشفير.
//
// مصدر مفتاح التشفير، بالترتيب:
//   1) CRED_KEY من البيئة — لمن يريد التحكم الكامل (ونسخه للاستعادة).
//   2) ملف data/.credkey يُنشأ تلقائياً (0600) — الأبسط لمستخدم محلي.
// إن تعذّر الاثنان نفشل بوضوح بدل المتابعة ببيانات غير محمية (لا ابتلاع صامت).
//
// ملاحظة صدق: هذا حماية «عند السكون» (at rest). من يملك الملف ومفتاح
// التشفير معاً يقرأ المفاتيح — لا يوجد تشفير يمنع ذلك على نفس الجهاز.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** بادئة القيمة المشفّرة — تغييرها يعني تغيير صيغة المخزون (ترحيل جديد). */
export const CRED_PREFIX = 'enc:v1:';
const ENV_VAR = 'CRED_KEY';
const KEY_FILE = join(process.cwd(), 'data', '.credkey');
const SCRYPT_SALT = 'ai-gateway-cred-v1';

let cachedKey: Buffer | null = null;

/** يجهّز مفتاح التشفير (32 بايت) ويخزّنه في الذاكرة — يقرأ البيئة أو الملف المحلي. */
export function loadCredKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = (process.env[ENV_VAR] || '').trim();
  if (fromEnv) {
    cachedKey = scryptSync(fromEnv, SCRYPT_SALT, 32);
    return cachedKey;
  }

  try {
    if (existsSync(KEY_FILE)) {
      const raw = readFileSync(KEY_FILE, 'utf8').trim();
      cachedKey = /^[0-9a-f]{64}$/i.test(raw)
        ? Buffer.from(raw, 'hex')            // ملف مُولَّد: 32 بايت خام
        : scryptSync(raw, SCRYPT_SALT, 32);  // ملف كتبه المستخدم: عبارة مرور
      return cachedKey;
    }
    const generated = randomBytes(32);
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, generated.toString('hex'), { mode: 0o600 });
    try { chmodSync(KEY_FILE, 0o600); } catch { /* Windows لا يطبّق mode — القيد هناك عبر ACL */ }
    cachedKey = generated;
    console.log(`🔐 أُنشئ مفتاح تشفير محلي: ${KEY_FILE}`);
    console.log('   احتفظ به مع النسخ الاحتياطي — فقدانه يعني فقدان المفاتيح المخزّنة.');
    return cachedKey;
  } catch (e: any) {
    throw new Error(
      `تعذّر تجهيز مفتاح التشفير (${KEY_FILE}): ${e?.message || e}. ` +
      `اضبط CRED_KEY في البيئة لتجاوز الملف.`
    );
  }
}

export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(CRED_PREFIX);
}

/** يشفّر نصاً. الفراغ يبقى فراغاً، والمشفّر مسبقاً لا يُشفَّر مرتين. */
export function encryptSecret(plain: unknown): string {
  const s = String(plain ?? '');
  if (!s) return '';
  if (isEncryptedSecret(s)) return s;

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadCredKey(), iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  return CRED_PREFIX + [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ct.toString('base64')
  ].join(':');
}

/**
 * يفكّ التشفير. يعيد:
 *  - النص الأصلي للقيمة المشفّرة،
 *  - القيمة كما هي إن كانت نصاً صريحاً قديماً (توافق خلفي قبل الترحيل)،
 *  - null إن فشل الفك (مفتاح مختلف أو بيانات معبوث بها) — لا استثناء.
 */
export function decryptSecret(stored: unknown): string | null {
  const s = String(stored ?? '');
  if (!s) return '';
  if (!isEncryptedSecret(s)) return s;

  const parts = s.slice(CRED_PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', loadCredKey(), Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // GCM يكتشف أي عبث أو مفتاح خاطئ
  }
}

/**
 * بصمة ثابتة للمفتاح — للكشف عن التكرار بدل مقارنة النص الصريح.
 * لماذا: تشفير GCM بـIV عشوائي يعطي ناتجاً مختلفاً لنفس المدخل، فيصبح
 * UNIQUE(provider, key) بلا قيمة ونُخزّن نفس المفتاح مرات. البصمة (HMAC
 * بمفتاح التشفير) ثابتة ولا تكشف المفتاح.
 */
export function keyFingerprint(plain: unknown): string {
  return createHmac('sha256', loadCredKey()).update(String(plain ?? ''), 'utf8').digest('hex');
}
