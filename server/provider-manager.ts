// server/provider-manager.ts — Add/remove/test providers, fetch models
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'undici';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

const YAML_PATH = join(process.cwd(), 'server', 'providers.yaml');

export interface ProviderSpec {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  format: 'openai' | 'anthropic';
  tier: number;
  enabled: boolean;
  models: 'auto' | string[];
  headers?: Record<string, string>;
  apiKeyEnv?: string;
  modelList?: string[];
}

export function readProvidersYaml(): { providers: ProviderSpec[]; routing?: any } {
  if (!existsSync(YAML_PATH)) return { providers: [] };
  const text = readFileSync(YAML_PATH, 'utf8');
  return yamlParse(text) || { providers: [] };
}

export function writeProvidersYaml(data: { providers: ProviderSpec[]; routing?: any }) {
  writeFileSync(YAML_PATH, yamlStringify(data), 'utf8');
}

export async function testConnection(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; latencyMs: number; statusCode?: number; error?: string; sample?: any }> {
  const t0 = Date.now();
  try {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const { statusCode, body } = await request(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers, headersTimeout: 8000, bodyTimeout: 8000
    });
    const text = await body.text();
    let sample: any = null;
    try { sample = JSON.parse(text).data?.slice(0, 3) || null; } catch {}
    return { ok: statusCode < 400, latencyMs: Date.now() - t0, statusCode, sample };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: e.message };
  }
}

export async function fetchModels(baseUrl: string, apiKey?: string): Promise<Array<{ id: string; owned_by?: string }>> {
  try {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const { statusCode, body } = await request(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET', headers, headersTimeout: 10000, bodyTimeout: 10000
    });
    if (statusCode >= 400) return [];
    const data = await body.json() as any;
    const list = data.data || data.models || [];
    // نفس التطبيع في provider.ts: إزالة بادئة "models/" التي تستخدمها Google
    return list.map((m: any) => ({
      ...m,
      id: String(m.id ?? m.name ?? '').replace(/^models\//, '')
    }));
  } catch { return []; }
}

export function validateId(id: string): boolean {
  return /^[a-z0-9-]{2,32}$/.test(id);
}

// ===== توحيد وتحقق روابط المزودات (الشريحة 1: SSRF + تطبيع) =====
// القاعدة: https فقط، باستثناء localhost/127.0.0.1 (لـ Ollama المحلي).
// نرفض الشبكات الخاصة و169.254 (metadata) إلا للحالة المحلية الصريحة،
// ونرفض query/fragment والمسار الخاطئ /chat/completions الملصق خطأً.

const PRIVATE_CIDRS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^127\./,
  /^0\./,
];

function hostnameIsLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export function normalizeBaseUrl(raw: string): string {
  let s = String(raw || '').trim();
  // إزالة لاحقة /chat/completions إن لصقها المستخدم خطأً
  s = s.replace(/\/chat\/completions\/?$/i, '');
  s = s.replace(/\/+$/, '');
  return s;
}

export function validateBaseUrl(raw: string): { ok: boolean; normalized?: string; error?: string } {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'baseUrl مطلوب' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'رابط غير صالح' };
  }
  if (u.search || u.hash) return { ok: false, error: 'الرابط يجب ألا يحوي ? أو #' };
  if (!['https:', 'http:'].includes(u.protocol)) return { ok: false, error: 'البروتوكول يجب أن يكون https (أو http للمحلي فقط)' };
  const loopback = hostnameIsLoopback(u.hostname);
  if (u.protocol === 'http:' && !loopback) {
    return { ok: false, error: 'http مسموح للمحلي (localhost) فقط — استخدم https' };
  }
  if (!loopback) {
    if (u.protocol !== 'https:') return { ok: false, error: 'استخدم https للمزودات البعيدة' };
    if (PRIVATE_CIDRS.some((re) => re.test(u.hostname))) {
      return { ok: false, error: 'عناوين الشبكة الداخلية مرفوضة (SSRF)' };
    }
    // أسماء مضيفة داخلية شائعة
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) {
      return { ok: false, error: 'اسم مضيف داخلي مرفوض' };
    }
  }
  const normalized = normalizeBaseUrl(s);
  if (/\/{2,}/.test(normalized.replace(/^https?:\/\//, ''))) {
    return { ok: false, error: 'الرابط يحوي // مكررة في المسار' };
  }
  return { ok: true, normalized };
}

// ===== التحقق من روابط المزودات (SSRF guard) =====
// القاعدة: https فقط، باستثناء localhost/127.0.0.1 (لـ Ollama المحلي).
// نرفض: عناوين IP الخاصة/المحجوزة (169.254.x، 10/8، 192.168/16، 172.16/12...)
// ومسارات /chat/completions الملصقة خطأً، والاستعلامات والهاش.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackHostname(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [, a, b] = m.map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

export interface BaseUrlCheck {
  ok: boolean;
  normalized?: string;
  error?: string;
  warning?: string;
}

export function validateAndNormalizeBaseUrl(raw: string): BaseUrlCheck {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'baseUrl مطلوب' };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: 'رابط غير صالح — مثال: https://api.example.com/v1' };
  }
  const host = u.hostname.toLowerCase();
  const loopback = isLoopbackHostname(host);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    return { ok: false, error: 'الرابط يجب أن يبدأ بـ https:// (يُسمح بـ http:// فقط لـ localhost)' };
  }
  if (!loopback && (isPrivateIPv4(host) || host.endsWith('.local') || host === '[::1]')) {
    return { ok: false, error: 'روابط الشبكة الداخلية مرفوضة (حماية SSRF) — باستثناء Ollama المحلي' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'الرابط يجب ألا يحوي بيانات اعتماد' };
  }
  let warning: string | undefined;
  let path = u.pathname.replace(/\/+$/, '');
  // المستخدم لصق نقطة النهاية الكاملة بدل الجذر — نصلّحها وننبّه
  if (/\/chat\/completions\/?$/.test(path)) {
    path = path.replace(/\/chat\/completions\/?$/, '');
    warning = 'أُزيل اللاحقة /chat/completions من الرابط تلقائياً';
  }
  if (u.search || u.hash) {
    warning = [warning, 'أُهملت الاستعلامات/الهاش في الرابط'].filter(Boolean).join('؛ ');
  }
  const normalized = `${u.protocol}//${u.host}${path || ''}`;
  return { ok: true, normalized, warning };
}