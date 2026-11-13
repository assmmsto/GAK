// tests/modules.check.tsx — حراسة انحدار على الوحدات المستخرجة من index.ts.
// لماذا: نقل دوال من ملف ضخم إلى وحدات مستقلة لا يجب أن يغيّر أي سلوك.
// هذا الفحص يثبّت عقد كل وحدة (مدخلات → مخرجات) ويمنع:
//   1) تغيّراً صامتاً في السلوك أثناء أي نقل قادم.
//   2) تكرار الدالة (نسخة في index.ts وأخرى في الوحدة) — وهو الانحدار الأخطر.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCatalog, detectProvider, catalogEntry, deriveEnvName, maskImportLine, parseImportText
} from '../server/services/catalog.js';
import { guardBaseUrl } from '../server/services/url-guard.js';
import { inferHealthStatus } from '../server/services/health-status.js';
import { deriveSignupUrl } from '../server/services/signup-url.js';
import { loadConfig } from '../server/config.js';
import {
  callerKeyOf, anthropicToOpenAIMessages, anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI, openAIMessageToAnthropicBlocks
} from '../server/routes/anthropic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? ' → ' + detail : ''}`);
};
const group = (t: string) => console.log('\n── ' + t);

// ============================================================
// 1) خدمات الكتالوج
// ============================================================
group('services/catalog');
const cat = loadCatalog();
check('الكتالوج يُقرأ', cat.providers.length > 20, `عدد=${cat.providers.length}`);
check('البصمات تُقرأ', cat.keyPatterns.length > 5, `عدد=${cat.keyPatterns.length}`);
check('detectProvider(gsk_) → groq', detectProvider('gsk_abcdef') === 'groq');
check('detectProvider(xai-) → xai', detectProvider('xai-abc') === 'xai');
check('detectProvider(فراغ) → null', detectProvider('') === null);
check('catalogEntry(together) صحيح', catalogEntry('together')?.baseUrl === 'https://api.together.ai/v1');
check('catalogEntry(مجهول) → undefined', catalogEntry('unknown-provider') === undefined);
check('deriveEnvName يوحّد الشَرْطة', deriveEnvName('google-ai') === 'GOOGLE_AI_API_KEY');
check('deriveEnvName بلا شَرْطة', deriveEnvName('openai') === 'OPENAI_API_KEY');
const masked = maskImportLine('sk-' + 'a'.repeat(40));
check('maskImportLine يقنّع السطر الطويل', masked.includes('…') && !masked.includes('a'.repeat(20)));
check('maskImportLine يبقي السطر القصير', maskImportLine('short') === 'short');

// parseImportText: توقيع جديد (المعرّفات تُمرَّر بدل قراءتها من الموجّه)
const imported = parseImportText('groq=gsk_abc123', ['groq']);
check('صيغة "مزود=مفتاح" مقروءة', imported.length === 1 && imported[0].provider === 'groq' && imported[0].key === 'gsk_abc123');
check('JSON مقروء', (() => {
  const r = parseImportText(JSON.stringify([{ provider: 'openai', apiKey: 'sk-proj-xxxx' }]));
  return r.length === 1 && r[0].provider === 'openai' && r[0].raw === 'JSON';
})());
check('سطر تعليق يُتجاهل', parseImportText('# ملاحظة').length === 0);
check('معرّفات الموجّه تُمرَّر للمحلّل', (() => {
  // مزود ليس في الكتالوج لكنه معرّف في الموجّه → يجب أن يُفهم كـ"مزود=مفتاح"
  const r = parseImportText('myprovider=AAAA1111BBBB2222CCCC3333', ['myprovider']);
  return r.length === 1 && r[0].provider === 'myprovider';
})());

// ============================================================
// 2) حارس العناوين (مضاد SSRF)
// ============================================================
group('services/url-guard');
// D-19: guardBaseUrl يعيد وعداً الآن (يعدو DNS) — بلا await تصير كل التأكيدات صفرية
check('رابط عام يُقبل', (await guardBaseUrl('https://api.groq.com/openai/v1')).ok);
check('169.254 يُرفض', !(await guardBaseUrl('http://169.254.169.254/latest/meta-data')).ok);
check('http عام يُرفض', !(await guardBaseUrl('http://api.groq.com/v1')).ok);
check('نص ليس رابطاً يُرفض', !(await guardBaseUrl('not-a-url')).ok);

// ============================================================
// 3) تحويلات Anthropic ↔ OpenAI
// ============================================================
group('routes/anthropic');
const conv = anthropicToOpenAIMessages({
  system: 'system-prompt',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: { a: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'result' }] }
  ]
});
check('system يُحوَّل لأول رسالة', conv[0]?.role === 'system' && conv[0].content === 'system-prompt');
check('نص المستخدم يُحوَّل', conv[1]?.role === 'user' && conv[1].content === 'hello');
check('tool_use → tool_calls', Array.isArray(conv[2]?.tool_calls) && conv[2].tool_calls[0].function.name === 'f');
check('tool_result → رسالة tool', conv[3]?.role === 'tool' && conv[3].tool_call_id === 'tu1' && conv[3].content === 'result');
check('أدوات تُحوَّل', anthropicToolsToOpenAI([{ name: 'f', description: 'd', input_schema: { type: 'object' } }])?.[0].function.name === 'f');
check('أدوات فارغة → undefined', anthropicToolsToOpenAI([]) === undefined);
check('tool_choice any → required', anthropicToolChoiceToOpenAI({ type: 'any' }) === 'required');
check('tool_choice tool → function', anthropicToolChoiceToOpenAI({ type: 'tool', name: 'f' })?.function?.name === 'f');
const back = openAIMessageToAnthropicBlocks({ content: 'done', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"x":2}' } }] });
check('نص → كتلة text', back.blocks.some(b => b.type === 'text' && b.text === 'done'));
check('tool_calls → كتلة tool_use مع input محلول', back.blocks.some(b => b.type === 'tool_use' && b.id === 'c1' && b.input?.x === 2));
check('stop_reason = tool_use', back.stopReason === 'tool_use');
check('رد فارغ → كتلة نص فارغة لا مصفوفة فارغة', (() => {
  const r = openAIMessageToAnthropicBlocks({});
  return r.blocks.length === 1 && r.blocks[0].type === 'text' && r.stopReason === 'end_turn';
})());
check('callerKeyOf يقرأ x-api-key', callerKeyOf({ headers: { 'x-api-key': 'k123' } }) === 'k123');
check('callerKeyOf يقرأ Bearer', callerKeyOf({ headers: { authorization: 'Bearer k9' } }) === 'k9');
check('callerKeyOf بلا مفتاح → null', callerKeyOf({ headers: {} }) === null);

// ============================================================
// 4) لا نسخة مكرّرة: الدوال المنقولة لم تبقَ في index.ts
// ============================================================
group('منع التكرار بعد النقل');
const indexSrc = read('server/index.ts');
for (const fn of [
  'function loadCatalog', 'function detectProvider', 'function catalogEntry',
  'function deriveEnvName', 'function maskImportLine', 'function parseImportText',
  'function guardBaseUrl', 'function upsertEnvVar', 'function callerKeyOf',
  'function anthropicToOpenAIMessages', 'function openAIMessageToAnthropicBlocks'
]) {
  check(`index.ts لا يعرّف ${fn}`, !indexSrc.includes(fn));
}
check('index.ts يستورد المنقولات من وحداتها',
  indexSrc.includes('./services/catalog.js') && indexSrc.includes('./services/url-guard.js') &&
  indexSrc.includes('./services/env-store.js') && indexSrc.includes('./routes/anthropic.js'));

// ============================================================
// 5) محرّك الفحص: لا يقبل «200» كدليل على نموذج محادثة
// ============================================================
group('محرّك الفحص (probeModel) — حكم على المحتوى لا على رمز الحالة');
{
  const { createServer } = await import('node:http');
  const { probeModel } = await import('../server/probe.js');
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let model = '';
      try { model = JSON.parse(raw || '{}').model || ''; } catch { /* جسم غير JSON */ }
      const json = (code: number, obj: any) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (model === 'good') return json(200, { choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { completion_tokens: 1 } });
      // 200 بلا أي محتوى: هذا ما كان الفحص الضعيف يقبله كـ«يعمل»
      if (model === 'tts') return json(200, { choices: [], usage: { completion_tokens: 0 } });
      if (model === 'empty') return json(200, {});
      if (model === 'audio') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.from([0xff, 0xf1, 0x00, 0x00])); }
      if (model === 'auth') return json(401, { error: { message: 'Invalid API key' } });
      if (model === 'gone') return json(404, { error: { message: 'model not found' } });
      return json(500, { error: { message: 'boom' } });
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  const base = `http://127.0.0.1:${port}/v1`;
  try {
    const good = await probeModel('p', base, 'k', 'good');
    check('نموذج يرد نصاً = ok', good.status === 'ok', good.status);
    const tts = await probeModel('p', base, 'k', 'tts');
    check('200 بلا choices = rejected (كان يُقبل بالفحص الضعيف)', tts.status === 'rejected', tts.status);
    const empty = await probeModel('p', base, 'k', 'empty');
    check('200 بجسم فارغ = rejected', empty.status === 'rejected', empty.status);
    const audio = await probeModel('p', base, 'k', 'audio');
    check('200 بمحتوى صوتي = rejected', audio.status === 'rejected', audio.status);
    const auth = await probeModel('p', base, 'k', 'auth');
    check('401 = provider_auth لا rejected', auth.status === 'provider_auth', auth.status);
    const gone = await probeModel('p', base, 'k', 'gone');
    check('404 = rejected', gone.status === 'rejected', gone.status);
    const server = await probeModel('p', base, 'k', 'server-error');
    check('500 = slow لا rejected', server.status === 'slow', server.status);
  } finally {
    await new Promise<void>(r => srv.close(() => r()));
  }
}

// ============================================================
// 6) استنتاج حالة المفتاح من آخر خطأ (تبويب الحالة)
// ============================================================
group('inferHealthStatus — لا «لم يُختبر» على مفتاح فشل فعلاً');
{
  const dahlMsg = '{"error":{"code":"model_concurrency","message":"This model is at concurrency capacity. Paid accounts are admitted first. Top up at https://inference.dahl.global/account — $0.02 per 1M tokens"}}';
  check('ضغط تزامن = rate_limited لا unknown', inferHealthStatus('unknown', dahlMsg) === 'rate_limited',
    inferHealthStatus('unknown', dahlMsg));
  check('429 صريح = rate_limited', inferHealthStatus('unknown', 'HTTP 429 Too Many Requests') === 'rate_limited');
  check('invalid api key = auth_error', inferHealthStatus('unknown', 'Invalid API key provided') === 'auth_error');
  check('insufficient permissions ليست حصة', inferHealthStatus('unknown', 'insufficient permissions for this API key') === 'auth_error');
  check('insufficient_quota = quota', inferHealthStatus('unknown', 'insufficient_quota: you exceeded your current quota') === 'quota_exhausted');
  check('الحالة المخزَّنة غير unknown تُحترم', inferHealthStatus('ok', 'anything') === 'ok');
  check('بلا خطأ = unknown', inferHealthStatus('unknown', null) === 'unknown');
  check('خطأ مجهول يبقى unknown', inferHealthStatus('unknown', 'weird failure') === 'unknown');
}

// ============================================================
// 7) loadConfig يحمل autoEnable (كان يُسقَط فيُفعَّل المزوّد رغم الإيقاف)
// ============================================================
group('loadConfig — autoEnable');
{
  const tmp = mkdtempSync(join(tmpdir(), 'gw-cfg-'));
  mkdirSync(join(tmp, 'server'), { recursive: true });
  writeFileSync(join(tmp, 'server', 'providers.yaml'),
    'providers:\n  - id: opt\n    name: Opt\n    baseUrl: https://opt.test/v1\n    enabled: false\n    autoEnable: false\n    models: auto\n');
  const prev = process.cwd();
  process.chdir(tmp);
  try {
    const cfg = loadConfig();
    check('autoEnable:false محفوظ بعد التحميل', cfg.providers[0]?.autoEnable === false,
      JSON.stringify(cfg.providers[0]));
    check('enabled:false محفوظ', cfg.providers[0]?.enabled === false);
  } finally {
    process.chdir(prev);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ============================================================
// رابط «احصل على مفتاح» المشتق من نطاق الـAPI
// ============================================================
group('signup-url');
check('api.x → x', deriveSignupUrl('https://api.freeaiapikey.com/v1') === 'https://freeaiapikey.com');
check('www.x → x', deriveSignupUrl('https://www.getunikey.ai/v1') === 'https://getunikey.ai');
check('api.b.ai → b.ai', deriveSignupUrl('https://api.b.ai/v1') === 'https://b.ai');
check('مسار /api/v1 يُهمَل', deriveSignupUrl('https://coarena.ai/api/v1') === 'https://coarena.ai');
check('استثناء صريح (tokenharbor → dashboard)', deriveSignupUrl('https://tokenharbor.ai/v1', 'tokenharbor') === 'https://tokenharbor.ai/dashboard');
check('localhost ⇒ لا رابط', deriveSignupUrl('http://127.0.0.1:3000/v1') === null);
check('رابط فارغ ⇒ لا رابط', deriveSignupUrl('') === null && deriveSignupUrl(null) === null);

// ============================================================
console.log('\n' + '='.repeat(46));
console.log(`حراسة الوحدات: ${passed} نجاح / ${failures.length} فشل`);
if (failures.length) {
  console.log('\nالانحدارات المكتشفة:');
  failures.forEach(f => console.log(' ✗ ' + f));
}
console.log('='.repeat(46));
process.exit(failures.length ? 1 : 0);
