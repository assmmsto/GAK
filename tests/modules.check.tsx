// tests/modules.check.tsx — حراسة انحدار على الوحدات المستخرجة من index.ts.
// لماذا: نقل دوال من ملف ضخم إلى وحدات مستقلة لا يجب أن يغيّر أي سلوك.
// هذا الفحص يثبّت عقد كل وحدة (مدخلات → مخرجات) ويمنع:
//   1) تغيّراً صامتاً في السلوك أثناء أي نقل قادم.
//   2) تكرار الدالة (نسخة في index.ts وأخرى في الوحدة) — وهو الانحدار الأخطر.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCatalog, detectProvider, catalogEntry, deriveEnvName, maskImportLine, parseImportText
} from '../server/services/catalog.js';
import { guardBaseUrl } from '../server/services/url-guard.js';
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
check('رابط عام يُقبل', guardBaseUrl('https://api.groq.com/openai/v1').ok);
check('169.254 يُرفض', !guardBaseUrl('http://169.254.169.254/latest/meta-data').ok);
check('http عام يُرفض', !guardBaseUrl('http://api.groq.com/v1').ok);
check('نص ليس رابطاً يُرفض', !guardBaseUrl('not-a-url').ok);

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
console.log('\n' + '='.repeat(46));
console.log(`حراسة الوحدات: ${passed} نجاح / ${failures.length} فشل`);
if (failures.length) {
  console.log('\nالانحدارات المكتشفة:');
  failures.forEach(f => console.log(' ✗ ' + f));
}
console.log('='.repeat(46));
process.exit(failures.length ? 1 : 0);
