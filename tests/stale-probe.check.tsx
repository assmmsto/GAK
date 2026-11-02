// tests/stale-probe.check.tsx — حراسات صدق بيانات الفحص: لكل حكم صلاحية.
//
// لماذا هذا الملف: كان الفحص التلقائي يعيد فحص rate_limited/slow/rejected فقط،
// وصفوف 'ok' بقيت للأبد — فظهرت 147 حالة "يعمل" قديمة (أحدثها 12 يوماً وأقدمها
// 36 يوماً) والمستخدم يختار أحدها فيفشل: "not offered" أو "needs paid plan".
// الإصلاح: selectStaleProbeCandidates تختار القديم بأي حالة، وok بسقف دفاعي.
//
// لا شبكة ولا قاعدة: الدوال نقية من probe.ts (نفس أسلوب routing.check.tsx).
import {
  selectStaleProbeCandidates, resolveProbeVerdict,
  OK_STALE_MS, OK_STALE_CAP, PROBE_REJECTED_STALE_MS,
  type ProbeRowLike, type ProbeResult
} from '../server/probe.js';

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
};
const group = (t: string) => console.log('\n── ' + t);

const NOW = 1_800_000_000_000;
const row = (status: string, ageMs: number, model = 'm'): ProbeRowLike =>
  ({ provider: 'p1', model, status, checked_at: NOW - ageMs });

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ============================================================
// 1) الترشيح: من يستحق إعادة الفحص؟
// ============================================================
group('ترشيح إعادة الفحص (selectStaleProbeCandidates)');

check('ok حديث (23 ساعة) لا يُعاد فحصه',
  !selectStaleProbeCandidates([row('ok', DAY - HOUR)], NOW).length);

check('ok قديم (25 ساعة) يُعاد فحصه',
  selectStaleProbeCandidates([row('ok', DAY + HOUR)], NOW).length === 1);

check(`rejected قديم (>${PROBE_REJECTED_STALE_MS / HOUR} ساعات) يُعاد فحصه`,
  selectStaleProbeCandidates([row('rejected', PROBE_REJECTED_STALE_MS + HOUR)], NOW).length === 1);

check('rejected حديث لا يُعاد فحصه',
  !selectStaleProbeCandidates([row('rejected', PROBE_REJECTED_STALE_MS - HOUR)], NOW).length);

check('provider_auth قديم يُعاد فحصه (المفتاح ربما أُصلح)',
  selectStaleProbeCandidates([row('provider_auth', PROBE_REJECTED_STALE_MS + HOUR)], NOW).length === 1);

check('rate_limited بأي عمر يُعاد فحصه (عابر بطبيعته)',
  selectStaleProbeCandidates([row('rate_limited', 0)], NOW).length === 1);

check('slow بأي عمر يُعاد فحصه',
  selectStaleProbeCandidates([row('slow', 0)], NOW).length === 1);

check('no_key لا يُعاد فحصه (لا مفتاح = لا معنى للفحص)',
  !selectStaleProbeCandidates([row('no_key', 30 * DAY)], NOW).length);

// ============================================================
// 2) السقف والترتيب: الأقدم أولاً وبلا إغراق
// ============================================================
group('السقف الدفاعي والترتيب');

// الأعمار متناقصة مع الفهرس: m0 الأقدم (54 ساعة) وm29 الأحدث (25 ساعة)
const many = Array.from({ length: 30 }, (_, i) => row('ok', DAY + HOUR + (29 - i) * HOUR, 'm' + i));
const picked = selectStaleProbeCandidates(many, NOW);
check(`30 صف ok قديماً → يُفحص ${OK_STALE_CAP} فقط`, picked.length === OK_STALE_CAP);
check('الأقدم أولاً', picked[0].model === 'm0' && picked[1].model === 'm1');
check('الأحدث يخرج بالسقف ولا يطرد الأقدم',
  !picked.some(p => p.model === 'm29'));

const mixed = [row('ok', DAY + (1.5 * HOUR), 'new-ok'), ...many];
const pickedMixed = selectStaleProbeCandidates(mixed, NOW);
check('حتى مع المؤقتات يبقى السقف على ok فقط',
  pickedMixed.filter(r => r.status === 'ok').length === OK_STALE_CAP);
check('ok الحديث لا يزيح الأقدم منه المقعد',
  pickedMixed.filter(r => r.status === 'ok')[0].model === 'm0'
  && !pickedMixed.some(p => p.model === 'new-ok'));

// السقف يشمل الفئات «المستحقة» أيضاً: rejected بلا سقف كان يدفع دورة واحدة
// لقرع مزود واحد ساعات (كل فحص حتى 25 ثانية)
const manyRej = Array.from({ length: 150 }, (_, i) => row('rejected', PROBE_REJECTED_STALE_MS + (150 - i) * HOUR, 'r' + i));
const pickedRej = selectStaleProbeCandidates(manyRej, NOW);
check('150 رفضاً قديماً → سقف 4×cap (100)', pickedRej.length === 100, 'got=' + pickedRej.length);
check('الرفض الأقدم أولاً في السقف', pickedRej[0].model === 'r0' && pickedRej[1].model === 'r1');

// ============================================================
// 3) العمر قرار جدولة لا قرار حكم: النتيجة ok القديمة تبقى ok حتى يُعاد فحصها
// ============================================================
group('الحكم لا يتأثر بالعمر (resolveProbeVerdict)');
const okOld: ProbeResult = { provider: 'p', model: 'm', status: 'ok', latencyMs: 5, error: 'OK' };
const v = resolveProbeVerdict([okOld]);
check('ok يبقى ok بغضّ النظر عن عمر الصف', v.status === 'ok');
check('الحكم لا يوسم نتيجة سليمة ظلماً', v.status !== 'rejected' && v.status !== 'provider_auth');

// ============================================================
console.log('\n' + '='.repeat(46));
console.log(`حراسة صدق بيانات الفحص: ${passed} نجاح / ${failures.length} فشل`);
if (failures.length) {
  console.log('\nالإخفاقات:');
  failures.forEach(f => console.log(' ✗ ' + f));
}
console.log('='.repeat(46));
process.exit(failures.length ? 1 : 0);
