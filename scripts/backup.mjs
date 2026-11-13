// scripts/backup.mjs — نسخة احتياطية متّسقة لقاعدة البوابة ومفتاح التشفير.
//
// كيف يعمل:
// 1) `VACUUM INTO '<النسخة>'` — النسخ يحتسبها SQLite نفسه من لقطة متّسقة، وهي
//    **آمنة مع WAL والخادم شغال**: لا يقتضي قفلاً حصرياً على الملف الحي، فستغيب
//    بعض عمليات الكتابة الجارية فقط في النسخة التالية. إن فشل (lock حقيقي)
//    نخرج بـ exit(1) مع رسالة — لا نصف نسخ ولا ملفات تالفة.
// 2) `data/.credkey` (مفتاح فك تشفير مفاتيح المزودات) يُنسخ بجوار النسخة
//    بصلاحيات 0600 (فعّالة على Linux/macOS؛ ويندوز يتجاهل الصلاحيات).
//    نسخة `gateway.db` بلا `.credkey` لا تُستعاد منها المفاتيح — لهذا إن كان
//    مفقوداً نحذّر ولا نُسقط العملية.
// 3) النسخ الاحتفاظ: أحدث 10 نسخ `gateway-*.db` في `data/backups/`،
//    والأقدم منها تُحذف.
//
// مسار القاعدة: `GATEWAY_DB_PATH` (نفس override في `server/db.ts`) أو
// `data/gateway.db` في جذر المشروع إن لم يُضبط.
//
// الاعتمادات: `@libsql/client` (موجود أصلاً) + `node:fs` + `node:path`.
// تشغيله: `npm run backup`

import { createClient } from '@libsql/client';
import {
  existsSync, mkdirSync, copyFileSync, chmodSync, readdirSync, statSync, rmSync
} from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = dirname(import.meta.dirname); // جذر المشروع (هذا السكربت في scripts/)
const DATA_DIR = join(ROOT, 'data');
const DB_PATH = process.env.GATEWAY_DB_PATH || join(DATA_DIR, 'gateway.db');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const CREDKEY = join(DATA_DIR, '.credkey');
const KEEP = 10;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(DATA_DIR)) fail(`مجلد البيانات غير موجود: ${DATA_DIR} — المجلد إلزامي عند النشر، تحقق من أن المشروع كامل.`);
if (!existsSync(DB_PATH)) {
  fail(
    `قاعدة البيانات غير موجودة: ${DB_PATH}\n` +
    `  إذا كان خادمتك تعمل بمسار تجاوز (GATEWAY_DB_PATH)، شغّل: GATEWAY_DB_PATH=<المسار> node scripts/backup.mjs`
  );
}

// اسم النسخة بتوقيت UTC: gateway-<YYYYMMDD-HHmmss>.db — الترتيب الأبجدي = الزمني.
const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const DEST = join(BACKUP_DIR, `gateway-${ts}.db`);

mkdirSync(BACKUP_DIR, { recursive: true });

const client = createClient({ url: `file:${DB_PATH}` });
try {
  // إدراج علامات الاقتباس: المسار ولّدناه، لكن هذه صيغة سليمة في كل الأحوال.
  const sql = `VACUUM INTO '${DEST.replace(/'/g, "''")}'`;
  await client.execute(sql);
} catch (err) {
  fail(
    `فشلت النسخة (VACUUM INTO): ${err.message}\n` +
    `  إن كان الخادم تحت حمل عالٍ أو قاعدة أخرى تمسك قفلاً حصرياً، أعد المحاولة بعد قليل.`
  );
} finally {
  await client.close();
}

// مفتاح التشفير: بلاه لا تُفكّ مفاتيح المزودات المخزّنة (enc:v1:).
let credCopied = false;
if (existsSync(CREDKEY)) {
  const credDest = join(BACKUP_DIR, '.credkey');
  copyFileSync(CREDKEY, credDest);
  chmodSync(credDest, 0o600);
  credCopied = true;
} else {
  console.warn('⚠ data/.credkey مفقود — نسخة القاعدة موجودة لكن مفاتيح المزودات لن تُفكّ منها.');
}

// الاحتفاظ: أحدث KEEP نسخة، والبقية (gateway-*.db فقط، لا غير) تُحذف.
const backups = readdirSync(BACKUP_DIR)
  .filter((f) => /^gateway-.+\.db$/.test(f))
  .sort(); // أبجدي = أقدم أول
const toDelete = backups.slice(0, Math.max(0, backups.length - KEEP));
for (const f of toDelete) rmSync(join(BACKUP_DIR, f));

const sizeKb = statSync(DEST).size / 1024;
const size = sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${Math.round(sizeKb)} KB`;
console.log(`✓ نسخة: ${DEST} (${size})`);
console.log(`  .credkey: ${credCopied ? 'نُسخ بجوارها (0600)' : 'مفقود — مفاتيح المزودات لن تُفكّ'}`);
console.log(`  الاحتفاظ: ${backups.length - toDelete.length}/${KEEP} نسخ في ${BACKUP_DIR}`);
