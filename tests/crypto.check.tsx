// tests/crypto.check.tsx — حراسة تشفير المفاتيح (AES-256-GCM)
// يُشغَّل قبل التنفيذ ليثبت الفشل، وبعده ليثبت الإصلاح.
// الأخطر في هذا التغيير ليس التشفير نفسه، بل ما يكسره:
//   كان UNIQUE(provider, key) يعتمد على النص الصريح لكشف التكرار.
//   مع IV عشوائي يصبح كل تشفير مختلفاً → نفس المفتاح يُضاف مرتين. لذلك
//   الاختبار يتحقق من بصمة ثابتة (key_fp) تمنع التكرار، ومن سلامة
//   الترحيل (لا مفتاح يُفقد ولا نص صريح يبقى).
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventDB } from '../server/db';
import {
  encryptSecret, decryptSecret, isEncryptedSecret, loadCredKey, CRED_PREFIX, keyFingerprint
} from '../server/crypto';

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(`${name}${detail ? ' → ' + detail : ''}`);
  console.log('  ✗ ' + name + (detail ? ' → ' + detail : ''));
}
function group(t: string): void { console.log('\n── ' + t); }

const PLAIN = 'gsk_abcdef1234567890abcdefghij';

// ============================================================
group('1) تشفير/فك تشفير');
const enc = encryptSecret(PLAIN);
check('يحمل البادئة enc:v1', enc.startsWith(CRED_PREFIX), enc.slice(0, 16));
check('لا يظهر النص الأصلي', !enc.includes(PLAIN));
check('الفك يعيد الأصل', decryptSecret(enc) === PLAIN, String(decryptSecret(enc)));
check('IV عشوائي: تشفيران مختلفان', encryptSecret(PLAIN) !== enc);
check('كلاهما يُفك إلى الأصل', decryptSecret(encryptSecret(PLAIN)) === PLAIN);
check('isEncryptedSecret يميّز المشفّر عن الصريح', isEncryptedSecret(enc) && !isEncryptedSecret(PLAIN));
check('نص صريح قديم يمر كما هو (توافق خلفي)', decryptSecret('sk-legacy-plain-123') === 'sk-legacy-plain-123');
check('نص لا يبدأ بـenc:v1 ليس مشفّراً', !isEncryptedSecret('enc-nope'));
check('قيمة فارغة لا تُشفَّر', encryptSecret('') === '' && decryptSecret('') === '');
check('تشفير تالف يعيد null لا استثناء', decryptSecret('enc:v1:zz:zz:zz') === null);
check('عبث بالبايتات لا يعيد النص الأصلي', decryptSecret(enc.slice(0, -4) + 'AAAA') !== PLAIN);
check('البصمة ثابتة ولا تكشف المفتاح', keyFingerprint(PLAIN) === keyFingerprint(PLAIN) && !keyFingerprint(PLAIN).includes(PLAIN));
check('بصمتان مختلفتان لمفتاحين مختلفين', keyFingerprint(PLAIN) !== keyFingerprint(PLAIN + 'x'));

// ============================================================
group('2) مفتاح التشفير (CRED_KEY أو ملف محلي)');
const key = loadCredKey();
check('طول المفتاح 32 بايت (AES-256)', key.length === 32, `length=${key.length}`);
check('المفتاح ثابت بين النداءات', loadCredKey().equals(key));
const credFile = join(process.cwd(), 'data', '.credkey');
check('مفتاح محلي محفوظ أو مأخوذ من البيئة', !!process.env.CRED_KEY || existsSync(credFile));

// ============================================================
group('3) لا نص صريح في قاعدة البيانات');
const dir = mkdtempSync(join(tmpdir(), 'gw-crypto-'));
const db = new EventDB(join(dir, 't.db'));
await db.ready;

await db.addProviderKey('groq', PLAIN, 'first');
let raw = await db.client.execute(`SELECT key, key_fp FROM provider_keys WHERE provider='groq'`);
check('الصف المخزّن مشفّر', String((raw.rows[0] as any).key).startsWith(CRED_PREFIX), String((raw.rows[0] as any).key).slice(0, 16));
check('البصمة مخزّنة مع الصف', !!(raw.rows[0] as any).key_fp);

const viaApi = await db.listProviderKeys('groq');
check('القراءة عبر الـAPI تعيد النص الأصلي', viaApi[0].key === PLAIN, String(viaApi[0].key).slice(0, 16));

// نفس المفتاح مرة ثانية: يجب ألا يُنشئ صفاً ثانياً
await db.addProviderKey('groq', PLAIN, 'again');
const cnt = await db.client.execute(`SELECT COUNT(*) n FROM provider_keys WHERE provider='groq'`);
check('لا تكرار لنفس المفتاح (key_fp يعمل)', Number((cnt.rows[0] as any).n) === 1, `n=${(cnt.rows[0] as any).n}`);

// ============================================================
group('4) ترحيل المفاتيح القديمة (نص صريح)');
const LEGACY = 'sk-plain-legacy-0987654321abcdef';
await db.client.execute({
  sql: `INSERT INTO provider_keys (provider, key, ts) VALUES (?, ?, ?)`,
  args: ['openrouter', LEGACY, Date.now()]
});
const mig = await db.migrateSecretStorage();
check('الترحيل شفّر صفاً واحداً على الأقل', mig.encrypted >= 1, JSON.stringify(mig));

raw = await db.client.execute(`SELECT key, key_fp FROM provider_keys WHERE provider='openrouter'`);
check('لا نص صريح بعد الترحيل', String((raw.rows[0] as any).key).startsWith(CRED_PREFIX), String((raw.rows[0] as any).key).slice(0, 16));
check('البصمة أُضيفت للصف القديم', !!(raw.rows[0] as any).key_fp);

const legacyRead = await db.listProviderKeys('openrouter');
check('المفتاح القديم ما زال صالحاً بعد الترحيل', legacyRead[0].key === LEGACY, String(legacyRead[0].key).slice(0, 16));

const mig2 = await db.migrateSecretStorage();
check('الترحيل idempotent (لا عمل ثانٍ)', mig2.encrypted === 0, JSON.stringify(mig2));

// ============================================================
group('5) التحديث يخزّن مشفّراً');
const NEWKEY = 'sk-updated-1122334455667788990';
await db.updateProviderKey(Number(legacyRead[0].id), { key: NEWKEY, status: 'unknown' });
raw = await db.client.execute(`SELECT key FROM provider_keys WHERE provider='openrouter'`);
check('التحديث مخزّن مشفّراً', String((raw.rows[0] as any).key).startsWith(CRED_PREFIX));
const after = await db.listProviderKeys('openrouter');
check('التحديث يُقرأ صحيحاً', after[0].key === NEWKEY, String(after[0].key).slice(0, 16));

const allRaw = await db.client.execute(`SELECT provider, key FROM provider_keys`);
const plainRows = (allRaw.rows as any[]).filter(r => !String(r.key).startsWith(CRED_PREFIX));
check('لا صف نصي صريح في الجدول كله', plainRows.length === 0, plainRows.map(r => r.provider).join(','));

try { await db.close(); } catch { /* تجاهل */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file lock */ }

// ============================================================
console.log('\n' + '='.repeat(46));
console.log(`حراسة التشفير: ${pass} نجاح / ${fails.length} فشل`);
fails.forEach(f => console.log('  ✗ ' + f));
console.log('='.repeat(46));
process.exit(fails.length ? 1 : 0);

