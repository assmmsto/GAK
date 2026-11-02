// server/services/catalog.ts — كتالوج المزودات (catalog.yaml) + تحليل نص الاستيراد.
// لماذا ملف مستقل: هذه الدوال ثابتة (لا تلمس حالة متغيّرة في الخادم)، وكانت
// متكدّسة في index.ts فتختلط أدوات البيانات بمنطق الـ HTTP.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

const CATALOG_PATH = join(process.cwd(), 'server', 'catalog.yaml');
const PROVIDERS_PATH = join(process.cwd(), 'server', 'providers.yaml');

export type CatalogEntry = {
  id: string; name: string; baseUrl: string;
  apiKeyEnv?: string | null; tier?: number; free?: boolean;
  keyless?: boolean; signupUrl?: string | null;
};

type KeyPattern = { prefix: string; provider: string | null };

let catalogCache: { providers: CatalogEntry[]; keyPatterns: KeyPattern[] } | null = null;
let catalogMtime = 0;

export function loadCatalog() {
  // نُبطل الذاكرة إذا تغيّر الملف — وإلا فمزود جديد في الكتالوج لا يُعرَف بلا إعادة تشغيل
  try {
    const mt = existsSync(CATALOG_PATH) ? statSync(CATALOG_PATH).mtimeMs : 0;
    if (catalogCache && mt === catalogMtime) return catalogCache;
    catalogMtime = mt;
  } catch { /* نتجاهل ونُعيد القراءة */ }
  try {
    const raw = existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, 'utf8') : '';
    const j = raw ? (yamlParse(raw) as any) : {};
    catalogCache = {
      providers: (j.providers || []) as CatalogEntry[],
      keyPatterns: (j.keyPatterns || []) as KeyPattern[]
    };
  } catch {
    catalogCache = catalogCache || { providers: [], keyPatterns: [] };
  }
  return catalogCache;
}

// مزودات providers.yaml كما هي على القرص — بلا قيم مفاتيح، فقط الهوية واسم متغيّر
// البيئة. تُستخدم لمعرفة «أي مزود معروف» دون الاعتماد على حالة الخادم المُحمَّلة.
export function configuredProviders(): Array<{ id: string; apiKeyEnv: string | null }> {
  try {
    if (!existsSync(PROVIDERS_PATH)) return [];
    const j = (yamlParse(readFileSync(PROVIDERS_PATH, 'utf8')) as any) || {};
    return (j.providers || [])
      .map((p: any) => ({ id: String(p?.id || '').trim(), apiKeyEnv: p?.apiKeyEnv ? String(p.apiKeyEnv) : null }))
      .filter((p: { id: string }) => p.id);
  } catch {
    return [];
  }
}

// تخمين المزوّد من بادئة المفتاح — «الصق المفتاح فقط»
export function detectProvider(key: string): string | null {
  const k = (key || '').trim();
  if (!k) return null;
  for (const p of loadCatalog().keyPatterns) {
    if (p?.prefix && k.startsWith(p.prefix)) return p.provider || null;
  }
  return null;
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return loadCatalog().providers.find(p => p.id === id);
}

export function deriveEnvName(id: string) {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

// نقنّع الأسطر في الاستجابة — السطر قد يكون مفتاحاً كاملاً
export function maskImportLine(line: string): string {
  const s = String(line || '');
  if (s.length <= 14) return s;
  return s.slice(0, 6) + '…' + s.slice(-4);
}

// يقبل: سطر مفتاح وحده · "مزود=مفتاح" · "مزود: مفتاح" · JSON (حتى المنسّق على أسطر)
// knownProviderIds: معرّفات المزودات المُعرَّفة حالياً في الموجّه (تُمرَّر لمنع
// اعتماد هذه الوحدة على حالة الخادم).
export function parseImportText(
  text: string,
  knownProviderIds: string[] = []
): Array<{ provider: string | null; key: string; raw: string }> {
  const out: Array<{ provider: string | null; key: string; raw: string }> = [];
  const src = String(text || '').trim();
  if (src.startsWith('{') || src.startsWith('[')) {
    try {
      const j = JSON.parse(src);
      for (const item of (Array.isArray(j) ? j : [j])) {
        const k = String(item?.key || item?.apiKey || '').trim();
        if (k) out.push({ provider: item?.provider ? String(item.provider).trim() : detectProvider(k), key: k, raw: 'JSON' });
      }
      if (out.length) return out;
    } catch { /* ليس JSON صالحاً → نكمل تحليلاً سطرياً */ }
  }
  const knownIds = new Set<string>([
    ...loadCatalog().providers.map(p => p.id),
    ...knownProviderIds
  ]);
  // شكل المفتاح: بادئة معروفة أو طول كافٍ — يمنع تقسيم مفتاح يحوي = أو :
  const looksLikeKey = (s: string) =>
    /^(sk[-_]|apx_|AIza|gsk_|xai-|hf_|nvapi-|pplx-|cpk_|fn_)/.test(s) || s.length >= 32;

  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9._-]{2,40})\s*[=:]\s*(\S+)$/);
    if (m) {
      const left = m[1];
      const right = m[2];
      // «مزود=مفتاح» إذا كان الطرف الأيسر معرّفاً معروفاً، أو الطرف الأيمن يبدو مفتاحاً
      // والطرف الأيسر لا يبدو مفتاحاً (وإلا فالمفتاح نفسه يحوي = أو :)
      const isProviderForm = knownIds.has(left.toLowerCase()) ||
        (looksLikeKey(right) && !looksLikeKey(left));
      if (isProviderForm) {
        out.push({ provider: left.trim(), key: right.trim(), raw: line });
        continue;
      }
    }
    out.push({ provider: detectProvider(line), key: line, raw: line });
  }
  return out;
}
