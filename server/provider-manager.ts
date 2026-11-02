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

// ===== حارس العناوين =====
// كان هنا حارسان إضافيان (normalizeBaseUrl + validateBaseUrl + validateAndNormalizeBaseUrl)
// بلا مستهلك واحد — نسختان ميتتان من نفس المنطق تضلّلان أي قارئ لاحق.
// الحارس الفعّال الوحيد: server/security.ts → validateBaseUrl عبر
// server/services/url-guard.ts (guardBaseUrl) — مستخدم في كل مسار يقبل رابطاً.
// نسخ متعددة من حارس أمني = انحراف صامت؛ حارس الاختبار يمنع عودتها.
