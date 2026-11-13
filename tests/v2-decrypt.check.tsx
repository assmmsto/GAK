// اختبار فك التشفير — يتحقق أن مفاتيح النسخة تعمل فعلاً (لا enc:v1: بعد الفك)
import { createClient } from '@libsql/client';
import { decryptSecret, isEncryptedSecret } from '../server/crypto.js';

const c = createClient({ url: 'file:data/gateway.db' });
const r = await c.execute('SELECT id, provider, key FROM provider_keys ORDER BY id LIMIT 6');
let ok = 0, bad = 0;
for (const row of r.rows) {
  const plain = decryptSecret(row.key);
  if (plain && !isEncryptedSecret(plain)) {
    ok++;
    console.log(`#${row.id} ${row.provider} -> ${plain.slice(0, 8)}... FAILED-DECRYPT-OK`);
  } else {
    bad++;
    console.log(`#${row.id} ${row.provider} -> DECRYPT FAILED (${String(row.key).slice(0, 16)}...)`);
  }
}
console.log(`\nRESULT: ${ok} decrypted / ${bad} failed`);
process.exit(bad === 0 && ok > 0 ? 0 : 1);
