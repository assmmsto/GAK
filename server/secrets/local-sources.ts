// server/secrets/local-sources.ts — مصدران محليان: ملف الأسرار ومتغيّرات البيئة.
//
// لماذا الملف: تصدير Vault/1Password/Doppler يكون غالباً ملفاً أو نصاً لاصقاً.
// ملصق JSON واحد يغطي كل مدير أسرار بلا تكامل SDK، ويعمل بلا شبكة.
//
// لا يقرأ هذا الملف أي سر من مكان غير معلوم: مسار الملف صريح في الإعداد،
// ومتغيّرات البيئة تُقرأ من قائمة مغلقة مستخرجة من الكتالوج.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, deriveEnvName, configuredProviders } from '../services/catalog.js';
import { isValidProviderId, providerIdFromEnvName, type KeySource, type SecretEntry } from './source.js';

const SECRETS_FILE = join(process.cwd(), 'data', 'secrets.json');
const SECRETS_FILE_ENV = 'SECRETS_FILE';

/** مسار ملف الأسرار المحلي (قابل للتجاوز بمتغيّر بيئة). */
function secretsFilePath(): string {
  const custom = (process.env[SECRETS_FILE_ENV] || '').trim();
  return custom ? join(process.cwd(), custom) : SECRETS_FILE;
}

type FileShape = Record<string, string | string[] | { key?: string; value?: string; keys?: string[]; label?: string }>;

/**
 * يحوّل محتوى الملف إلى مدخلات. يقبل:
 *   {"groq": "gsk_...", "openrouter": ["sk-or-a","sk-or-b"]}
 *   {"groq": {"keys": ["gsk_a"], "label": "prod"}}
 *   [{"provider":"groq","key":"gsk_..."}]
 */
export function parseSecretFile(raw: string): SecretEntry[] {
  const out: SecretEntry[] = [];
  const push = (provider: unknown, value: unknown, label: unknown) => {
    const pid = String(provider ?? '').trim().toLowerCase();
    const val = String(value ?? '').trim();
    if (!isValidProviderId(pid) || !val) return;
    out.push({ provider: pid, value: val, label: label ? String(label) : null, source: 'file', priority: 40 });
  };

  let json: any;
  try { json = JSON.parse(raw); } catch { return out; }

  if (Array.isArray(json)) {
    for (const item of json) {
      const keys = Array.isArray(item?.keys) ? item.keys : [item?.key ?? item?.value ?? item?.apiKey];
      for (const k of keys) push(item?.provider, k, item?.label);
    }
    return out;
  }
  if (json && typeof json === 'object') {
    for (const [provider, v] of Object.entries(json as FileShape)) {
      if (typeof v === 'string') { push(provider, v, null); continue; }
      if (Array.isArray(v)) { for (const k of v) push(provider, k, null); continue; }
      if (v && typeof v === 'object') {
        const keys = Array.isArray(v.keys) ? v.keys : [v.key ?? v.value];
        for (const k of keys) push(provider, k, v.label ?? null);
      }
    }
  }
  return out;
}

/** ملف أسرار محلي (اختياري) — أعلى من env وأدنى من مديري الأسرار. */
export class FileSecretSource implements KeySource {
  readonly id = 'file' as const;
  readonly label = 'ملف محلي (data/secrets.json)';
  readonly priority = 40;

  configured(): boolean {
    try { return existsSync(secretsFilePath()); } catch { return false; }
  }

  async fetch(signal: AbortSignal): Promise<{ entries: SecretEntry[]; error?: string }> {
    if (signal.aborted) return { entries: [], error: 'أُلغي الجلب' };
    const path = secretsFilePath();
    try {
      if (!existsSync(path)) return { entries: [] };
      const stat = statSync(path);
      // ملف ضخم = خطأ إعداد لا «أسرار كثيرة»؛ نرفض بوضوح بدل استنزاف الذاكرة
      if (stat.size > 2 * 1024 * 1024) {
        return { entries: [], error: `ملف الأسرار أكبر من 2MB (${Math.round(stat.size / 1024)}KB) — قسّمه أو صحّح المسار` };
      }
      return { entries: parseSecretFile(readFileSync(path, 'utf8')) };
    } catch (e: any) {
      return { entries: [], error: `تعذّر قراءة ملف الأسرار: ${e?.code || e?.message || 'خطأ غير معروف'}` };
    }
  }
}

/**
 * متغيّرات البيئة. لا نمسح process.env كله بحثاً عن أنماط: نقصر البحث على
 * أسماء يعرفها الكتالوج أو تنتهي بـ `_API_KEY` ويطابق جذرها معرّفاً صالحاً.
 */
export class EnvSecretSource implements KeySource {
  readonly id = 'env' as const;
  readonly label = 'متغيّرات البيئة (.env)';
  readonly priority = 50;

  configured(): boolean { return true; }

  async fetch(): Promise<{ entries: SecretEntry[]; error?: string; ignored?: string[] }> {
    const out: SecretEntry[] = [];
    const seen = new Set<string>();

    // 1) أسماء الكتالوج أولاً — مطابقة مؤكدة من مصدر واحد للحقيقة
    for (const p of loadCatalog().providers) {
      const envName = p.apiKeyEnv || deriveEnvName(p.id);
      const val = (process.env[envName] || '').trim();
      if (!val) continue;
      const fp = `${p.id}:${val}`;
      if (seen.has(fp)) continue;
      seen.add(fp);
      out.push({ provider: p.id, value: val, label: envName, source: 'env', priority: 50 });
    }

    // 2) متغيّرات تشبه مفتاح مزود — **لمزوّد معروف فقط** (الكتالوج ∪ providers.yaml).
    // S8: كان أي `*_API_KEY` في البيئة يُحفظ مفتاحاً لمزود غير موجود (مثل
    // ATRIA_DAWN_PREVIEW_API_KEY) ⇒ نسخة سرّية إضافية بلا مستهلك، وقد تُظهر المزود
    // في العدّادات. المعروض فقط يُخزَّن، والباقي يُبلَّغ عنه بلا كتابة.
    // وكانت «المعروف» = الكتالوج وحده، فأُسقط مفتاح كل مزود مُعرَّف في providers.yaml
    // وجاهز للعمل (dahl مثلاً) — أي تعطيل مصدر البيئة للمزودات المُشغَّلة فعلياً.
    const configured = configuredProviders();
    const known = new Set<string>(loadCatalog().providers.map(p => p.id));
    for (const p of configured) known.add(p.id);
    const ignored: string[] = [];
    for (const [name, raw] of Object.entries(process.env)) {
      if (!/^[A-Z0-9_]+_API_KEYS?$/.test(name)) continue;
      const val = String(raw || '').trim();
      if (!val) continue;
      // اسم المتغيّر المعلن في providers.yaml يفوز على تخمين المعرّف من الاسم
      const pid = configured.find(p => p.apiKeyEnv === name)?.id || providerIdFromEnvName(name);
      if (!pid || !known.has(pid)) { ignored.push(name); continue; }
      const fp = `${pid}:${val}`;
      if (seen.has(fp)) continue;
      seen.add(fp);
      out.push({ provider: pid, value: val, label: name, source: 'env', priority: 50 });
    }
    if (ignored.length) {
      console.warn(`[env-source] أُهمل ${ignored.length} متغيّر *_API_KEY لمزود غير معروف (لم يُخزَّن): ${ignored.slice(0, 5).join(', ')}`);
    }
    return { entries: out, ignored };
  }
}