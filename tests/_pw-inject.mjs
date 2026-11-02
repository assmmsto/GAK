// حقن مفتاحي اختبار (ميت + مجهول) في قاعدة المعزول — لفحص مسارات النوافذ الشرطية
import { createClient } from '@libsql/client';
import { encryptSecret, keyFingerprint } from '../server/crypto.ts';

const c = createClient({ url: 'file:data/pw-isolated.db' });
const now = Date.now();
const dead = encryptSecret('dahl_pw_dead_0001');
const unk = encryptSecret('dahl_pw_unknown_0002');
await c.execute({
  sql: "INSERT INTO provider_keys (provider,key,key_fp,label,enabled,status,last_error,ts,source) VALUES ('dahl',?,?,'pw-dead',1,'auth_error','Invalid API key (pw-test)',?,'manual')",
  args: [dead, keyFingerprint('dahl_pw_dead_0001'), now]
});
await c.execute({
  sql: "INSERT INTO provider_keys (provider,key,key_fp,label,enabled,status,ts,source) VALUES ('dahl',?,?,'pw-unknown',1,'unknown',?,'manual')",
  args: [unk, keyFingerprint('dahl_pw_unknown_0002'), now]
});
console.log('حُقن مفتاحان: ميت + مجهول');
await c.close();
