// server/services/env-store.ts — الكتابة في ملف .env.
// لماذا: المفاتيح تعيش في قاعدة البيانات، لكن .env يبقى مصدر الإقلاع الأول
// وتُحدَّث نسخته عند إضافة/حذف مزود. فصل هذا هنا يمنع نسيان «هل كتبنا .env؟».
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENV_PATH = join(process.cwd(), '.env');

// نكتب/نحدّث/نحذف مفتاحاً في .env (للإقلاع والتنظيف فقط — المفاتيح تعيش في قاعدة البيانات)
export function upsertEnvVar(name: string, value: string | null) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const out: string[] = [];
  let found = false;
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (m && m[1] === name) {
      found = true;
      if (value !== null) out.push(`${name}=${value}`);
      continue; // value === null → نحذف السطر
    }
    out.push(line);
  }
  if (!found && value !== null) out.push(`${name}=${value}`);
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  writeFileSync(ENV_PATH, out.join('\n') + '\n', 'utf8');
  if (value === null) delete process.env[name];
  else process.env[name] = value;
}
