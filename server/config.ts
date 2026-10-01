// server/config.ts — loads providers.yaml + .env
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  // اسم متغيّر البيئة المرتبط بالمفتاح — كان يُسقط عند التحميل فتظهر الواجهة اسماً مخالفاً
  apiKeyEnv?: string | null;
  format: 'openai' | 'anthropic';
  tier: number;
  enabled: boolean;
  models: 'auto' | string[];
  headers?: Record<string, string>;
  signupUrl?: string | null;
}

export interface Config {
  providers: Provider[];
  routing: {
    maxRetries: number;
    timeoutMs: number;
    maxConcurrent: number;
  };
}

function maskKey(k: string): string {
  if (!k || k.length < 8) return '***';
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

export function loadConfig(): Config {
  const yamlPath = join(process.cwd(), 'server', 'providers.yaml');
  let yamlData: any = { providers: [] };
  if (existsSync(yamlPath)) {
    try {
      const text = readFileSync(yamlPath, 'utf8');
      yamlData = yamlParse(text);
    } catch (e) {
      console.error('YAML parse error:', e);
    }
  }

  // Load .env (simple key=value)
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }

  const providers: Provider[] = (yamlData.providers || []).map((p: any) => {
    // apiKeyEnv = اسم متغيّر البيئة (المصدر المفضّل) — apiKey = قيمة صريحة كخطة بديلة
    const key = (p.apiKeyEnv ? process.env[p.apiKeyEnv] : '') || p.apiKey || '';
    return {
      id: p.id,
      name: p.name || p.id,
      baseUrl: (p.baseUrl || '').replace(/\/+$/, ''),
      apiKey: key || undefined,
      apiKeyEnv: p.apiKeyEnv || null,
      format: p.format || 'openai',
      tier: p.tier ?? 4,
      enabled: p.enabled !== false,
      models: p.models || 'auto',
      headers: p.headers || {},
      signupUrl: p.signupUrl || null
    };
  });

  return {
    providers,
    routing: { maxRetries: 3, timeoutMs: 60000, maxConcurrent: 20, ...yamlData.routing }
  };
}

export { maskKey };
