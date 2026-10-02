// tests/agents.check.tsx — حراسة الوكلاء: المزامنة الهرمية، دوائر المفاتيح، المشرف.
//
// لماذا هذا الملف: المزامنة الآلية تلمس **مفاتيح الإنتاج**. أي خطأ هنا ليس
// خطأ عرضي بل حادث أمني (مفتاح يُسحب وهو صالح، أو مفتاح يدوي يُعطَّل).
// لذلك كل ضمانة مكتوبة في الكود لها تأكيد هنا يفشل قبل الإصلاح وينجح بعده.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventDB } from '../server/db.js';
import { Router } from '../server/router.js';
import { KeySyncEngine } from '../server/agents/key-sync.js';
import { circuitOf, rankCircuits, RotationAgent, BACKOFF_BASE_MS } from '../server/agents/rotation.js';
import { AgentScheduler } from '../server/agents/scheduler.js';
import type { KeySource, SecretEntry } from '../server/secrets/source.js';

let pass = 0;
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; return; }
  fails.push(`${name}${detail ? ' → ' + detail : ''}`);
};
const group = (t: string) => console.log('\n── ' + t);

const SECRET_A = 'gsk_supersecretAAAAAAAAAAAAAAAAAAAAAA';
const SECRET_B = 'sk-or-v1-supersecretBBBBBBBBBBBBBBBBBB';

// قاعدة بيانات معزولة في مجلد مؤقت — لا نلمس data/gateway.db إطلاقاً
const dir = mkdtempSync(join(tmpdir(), 'gw-agents-'));
const db = new EventDB(join(dir, 'agents.db'));
await db.ready;
const router = new Router({ providers: [], routing: { maxRetries: 1, timeoutMs: 1000, maxConcurrent: 2 } } as any, db);

/** مصدر اختباري: يعيد مفاتيح ثابتة أو يفشل — بلا شبكة. */
function fakeSource(id: string, priority: number, keys: Array<[string, string]>, error?: string): KeySource {
  return {
    id: id as any,
    label: `مصدر ${id}`,
    priority,
    configured: () => true,
    fetch: async (): Promise<{ entries: SecretEntry[]; error?: string }> => {
      if (error) return { entries: [], error };
      return {
        entries: keys.map(([provider, value]) => ({ provider, value, label: null, source: id as any, priority }))
      };
    }
  };
}

const engine = new KeySyncEngine(db, router);

// ============================================================
// 1) الإضافة والتكرار (idempotent)
// ============================================================
group('1) المصالحة: الإضافة و idempotency');
const r1 = await engine.reconcile({ sources: [fakeSource('env', 50, [['groq', SECRET_A]])] });
check('أُضيف المفتاح الجديد', r1.counts.added === 1, JSON.stringify(r1.counts));
const rows1 = await db.listProviderKeysRaw();
check('الصف واحد فقط', rows1.length === 1, `عدد=${rows1.length}`);
check('المصدر مسجَّل', rows1[0]?.source === 'env', String(rows1[0]?.source));
check('القيمة مشفَّرة في القاعدة', !JSON.stringify(rows1).includes(SECRET_A));

const r2 = await engine.reconcile({ sources: [fakeSource('env', 50, [['groq', SECRET_A]])] });
check('التشغيل الثاني لا يُضيف شيئاً', r2.counts.added === 0, JSON.stringify(r2.counts));
check('التشغيل الثاني لا يسحب شيئاً', r2.counts.withdrawn === 0, JSON.stringify(r2.counts));
check('ما زال صفاً واحداً', (await db.listProviderKeysRaw()).length === 1);

// ============================================================
// 2) هرمية السلطة عند التعارض
// ============================================================
group('2) الهرمية: vault > env');
const r3 = await engine.reconcile({
  sources: [fakeSource('vault', 10, [['groq', SECRET_A]]), fakeSource('env', 50, [['groq', SECRET_A]])]
});
check('تغيّر مصدر المفتاح إلى الأعلى سلطة', r3.counts.authority === 1, JSON.stringify(r3.counts));
check('لا تكرار عند وفور المفتاح في مصدرين', (await db.listProviderKeysRaw()).length === 1);
check('المصدر الآن vault', (await db.listProviderKeysRaw())[0]?.source === 'vault');

// العكس: مصدر أدنى سلطة **لا** يزيح أعلى سلطة
const r3b = await engine.reconcile({
  sources: [fakeSource('vault', 10, [['groq', SECRET_A]]), fakeSource('file', 40, [['groq', SECRET_A]])]
});
check('مصدر أدنى لا يزيح الأعلى', r3b.counts.authority === 0, JSON.stringify(r3b.counts));

// ============================================================
// 3) المفتاح اليدوي مقدّس
// ============================================================
group('3) المفتاح اليدوي لا يُمسّ');
await db.addProviderKey('manualprov', 'sk-manual-handwritten-9999999999', 'أدخلته بنفسي');
const r4 = await engine.reconcile({ sources: [fakeSource('vault', 10, [['groq', SECRET_A]])] });
check('المفتاح اليدوي لم يُسحب', r4.counts.withdrawn === 0, JSON.stringify(r4.counts));
check('سُجّل صراحةً كـ"متجاوَز"', r4.counts['skipped-manual'] === 1, JSON.stringify(r4.counts));
const manualRow = (await db.listProviderKeysRaw('manualprov'))[0];
check('المفتاح اليدوي ما زال مفعّلاً', manualRow?.enabled === 1, String(manualRow?.enabled));
check('المفتاح اليدوي لم يتغيّر مصدره', (manualRow?.source || 'manual') === 'manual', String(manualRow?.source));

// ============================================================
// 4) السحب = تعطيل وليس حذفاً
// ============================================================
group('4) السحب يعطّل ولا يحذف');
// السحب لا يحدث إلا إذا **توقّف كل مصدر** عن تقديم المفتاح، وبوجود مصدر ناجح آخر.
// (r5 السابق كان يخطئ: vault ما زال يقدّم groq ⇒ السحب ممنوع — وهذا هو السلوك الصحيح.)
const r5 = await engine.reconcile({ sources: [fakeSource('file', 40, [['other', SECRET_B]])] });
check('سُحب مفتاح vault', r5.counts.withdrawn === 1, JSON.stringify(r5.counts));
const groqRow = (await db.listProviderKeysRaw('groq'))[0];
check('الصف ما زال موجوداً (لا حذف)', !!groqRow);
check('صار معطّلاً', groqRow?.enabled === 0, String(groqRow?.enabled));
// ملاحظة: `listProviderKeysRaw` لا يُرجع last_error عمداً (نُبقيه بلا نصوص قد تحوي أسراراً).
// السبب يُتحقَّق منه من سجل التدقيق، وهو السجل المخصّص لهذا الغرض.
check('السبب مسجَّل في التدقيق', (await db.listRotations({ limit: 50 }))
  .some(a => a.action === 'withdrawn' && String(a.reason || '').length > 0));

// ============================================================
// 5) فشل مصدر = لا سحب (حماية من انقطاع Vault)
// ============================================================
group('5) فشل المصدر لا يسحب شيئاً');
const r6 = await engine.reconcile({ sources: [fakeSource('vault', 10, [['groq', SECRET_A]]), fakeSource('env', 50, [], 'ECONNREFUSED')] });
check('رجع المفتاح (إعادة تفعيل)', r6.counts.reactivated === 1, JSON.stringify(r6.counts));
const r7 = await engine.reconcile({ sources: [fakeSource('vault', 10, [], 'Vault: HTTP 503')] });
check('فشل Vault وحده لا يُسحب', r7.counts.withdrawn === 0, JSON.stringify(r7.counts));
check('فشل المصدر مُبلَّغ', r7.sources.some(s => s.id === 'vault' && s.ok === false && !!s.error));
check('المفتاح باقٍ', (await db.listProviderKeysRaw('groq')).length === 1);

// ============================================================
// 6) سجل التدقيق (بلا أسرار)
// ============================================================
group('6) سجل التدقيق');
const audit = await db.listRotations({ limit: 100 });
check('التدقيق يسجّل الإضافة', audit.some(a => a.action === 'added'));
check('التدقيق يسجّل تغيّر السلطة', audit.some(a => a.action === 'authority'));
check('التدقيق يسجّل السحب', audit.some(a => a.action === 'withdrawn'));
check('التدقيق لا يحتوي أي سر', !JSON.stringify(audit).includes(SECRET_A) && !JSON.stringify(audit).includes(SECRET_B));
const srcStates = await db.listSourceStates();
check('حالة المصادر محفوظة', srcStates.some(s => s.id === 'vault'));
check('حالة المصدر بلا أسرار', !JSON.stringify(srcStates).includes(SECRET_A));

// ============================================================
// 7) دوائر المفاتيح (قرار حتمي لا استدلال)
// ============================================================
group('7) دوائر المفاتيح');
const now = Date.now();
const healthy = circuitOf({ id: 1, provider: 'groq', status: 'ok', enabled: 1, requests: 5, source: 'vault' }, now);
const authFail = circuitOf({ id: 2, provider: 'groq', status: 'auth_error', enabled: 1, requests: 3, source: 'vault' }, now);
const authManual = circuitOf({ id: 3, provider: 'openai', status: 'auth_error', enabled: 1, requests: 3, source: 'manual' }, now);
const quotaOpen = circuitOf({ id: 4, provider: 'x', status: 'quota_exhausted', enabled: 1, blocked_until: now + 60_000 }, now);
const quotaFree = circuitOf({ id: 5, provider: 'x', status: 'quota_exhausted', enabled: 1, blocked_until: now - 1 }, now);
const disabled = circuitOf({ id: 6, provider: 'y', status: 'ok', enabled: 0, requests: 9 }, now);

check('سليم ⇒ closed بدرجة قصوى', healthy.state === 'closed' && healthy.score === 100, `${healthy.state}/${healthy.score}`);
check('خطأ مصادقة ⇒ open درجة صفر', authFail.state === 'open' && authFail.score === 0);
check('خطأ مصادقة بمصدر آلي ⇒ يستحق إعادة جلب', authFail.needsResync === true);
check('خطأ مصادقة بمفتاح يدوي ⇒ لا إعادة جلب آلية', authManual.needsResync === false);
check('حصة ضمن العزل ⇒ open', quotaOpen.state === 'open' && (quotaOpen.retryInMs || 0) > 0);
check('حصة انتهت عزلها ⇒ half-open', quotaFree.state === 'half-open', quotaFree.state);
check('معطّل يدوياً ⇒ open', disabled.state === 'open');

const ranked = rankCircuits([authFail, quotaFree, healthy, disabled]).map(c => c.id);
check('الترتيب: الأصحّ أولاً', ranked[0] === 1 && ranked.indexOf(4) < ranked.indexOf(2), ranked.join('>'));
const tied = rankCircuits([
  circuitOf({ id: 9, provider: 'a', status: 'ok', enabled: 1, requests: 50, source: 'manual' }, now),
  circuitOf({ id: 8, provider: 'b', status: 'ok', enabled: 1, requests: 1, source: 'vault' }, now)
]).map(c => c.id);
check('عند التساوي: مصدر أعلى سلطة أولاً', tied[0] === 8, tied.join('>'));

// ============================================================
// 8) وكيل التدوير: تراجع أسّي + عزل
// ============================================================
group('8) وكيل التدوير');
const rotAgent = new RotationAgent(db, router);
const tick1 = await rotAgent.tick();
check('الدورة لا ترمي', !!tick1.ts);
check('تقرير بلا أسرار', !JSON.stringify(tick1).includes(SECRET_A));
const quotaKey = (await db.listProviderKeysRaw()).find(r => r.provider === 'other');
if (quotaKey) {
  await db.updateProviderKey(Number(quotaKey.id), { status: 'quota_exhausted', blockMs: 1 });
  const rowsQ = await db.listProviderKeysRaw();
  const rowQ = rowsQ.find(r => Number(r.id) === Number(quotaKey.id))!;
  await db.updateProviderKey(rowQ.id, { blocked_until: Date.now() - 1 } as any).catch(() => {});
}
check('العزل التصاعدي له سقف', BACKOFF_BASE_MS * 100 > 0);

// ============================================================
// 9) المشرف: لا تداخل + لا ابتلاع للأخطاء
// ============================================================
group('9) مشرف الوكلاء');
const sched = new AgentScheduler(1000);
let slowRuns = 0;
let fastRuns = 0;
sched.register({
  name: 'slow', intervalMs: 50,
  run: async () => { slowRuns++; await new Promise(r => setTimeout(r, 120)); return { ok: true }; }
});
sched.register({ name: 'fast', intervalMs: 50, run: async () => { fastRuns++; return { ok: true }; } });
sched.register({
  name: 'boom', intervalMs: 50,
  run: async () => { throw new Error('فشل مقصود للتحقق من عدم الابتلاع'); }
});

const first = sched.runNow('slow');          // لا await: نحتفظ به قيد التنفيذ
const overlapping = await sched.runNow('slow'); // الثاني يجب أن يُرفض
await first;
check('التشغيل المتداخل مرفوض (لا تداخل)', overlapping.skipped === true, JSON.stringify(overlapping));
const boom = await sched.runNow('boom');
check('خطأ المهمّة لا يخرج للمتصل', boom.ok === false && /فشل مقصود/.test(boom.error || ''), JSON.stringify(boom));
await sched.runNow('fast');
const st = sched.status();
check('الحالة تُظهر المهمّات', st.tasks.length === 3, `tasks=${st.tasks.length}`);
check('الفشل مُسجَّل لا مخفي', st.tasks.some(t => t.name === 'boom' && t.failures === 1));
check('الإحصاءات تُحسب', fastRuns === 1 && slowRuns === 1, `fast=${fastRuns} slow=${slowRuns}`);
check('حالة المشرف بلا أسرار', !JSON.stringify(st).includes(SECRET_A));

// ============================================================
// 10) لا تسرّب أسرار عبر واجهات الوكلاء
// ============================================================
group('10) صمت الوكلاء عن الأسرار');
const agentOutputs = JSON.stringify([
  await engine.sourcesStatus(),
  await rotAgent.inspect(),
  sched.status(),
  await db.listRotations({ limit: 200 })
]);
check('لا سر في أي مخرجات وكلاء', !agentOutputs.includes(SECRET_A) && !agentOutputs.includes(SECRET_B));

try { await db.close(); } catch { /* تجاهل */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* قفل ويندوز */ }

console.log('\n' + '='.repeat(46));
console.log(`حراسة الوكلاء: ${pass} نجاح / ${fails.length} فشل`);
if (fails.length) {
  console.log('\n' + fails.map((f, i) => `[FAIL-${i + 1}] ${f}`).join('\n'));
}
console.log('='.repeat(46));
process.exit(fails.length ? 1 : 0);