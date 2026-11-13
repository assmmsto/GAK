// server/secrets/remote-sources.ts — مديرو أسرار حقيقيون: HashiCorp Vault،
// Doppler، 1Password Connect.
//
// قواعد الأمان المطبَّقة على كل مصدر بعيد (بلا استثناء):
//  1) العنوان يأتي من الإعداد → يمرّ من حارس SSRF قبل أي طلب.
//  2) التوكنات من متغيّرات البيئة فقط، ولا تُسجَّل ولا تُعاد ولا تُضمَّن في رسالة خطأ.
//  3) كل خطأ يمرّ من sanitizeErrorMessage قبل أن يُرى.
//  4) مهلة صريحة لكل طلب — مصدر بطيء لا يُعلّق المزامنة كلها.
import { request } from 'undici';
import { sanitizeErrorMessage, validateBaseUrl } from '../security.js';
import { isValidProviderId, providerIdFromEnvName, type KeySource, type SecretEntry } from './source.js';
import { EnvSecretSource, FileSecretSource } from './local-sources.js';

const HTTP_TIMEOUT_MS = 12_000;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_HOSTS === '1';

// D-19: validateBaseUrl تعدو DNS قبل السماح — checkUrl تعدو وعدةً ويُستدعى بـ await.
async function checkUrl(raw: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  return validateBaseUrl(raw, { allowPrivate: ALLOW_PRIVATE });
}

/** يبني مدخلات من كائن {اسم: قيمة} حيث الاسم معرّف مزود أو متغيّر بيئة. */
export function entriesFromMap(
  obj: Record<string, unknown>,
  source: SecretEntry['source'],
  priority: number
): SecretEntry[] {
  const out: SecretEntry[] = [];
  for (const [name, raw] of Object.entries(obj || {})) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      const val = String(v ?? '').trim();
      if (!val) continue;
      const lower = name.trim().toLowerCase();
      const pid = isValidProviderId(lower) ? lower : providerIdFromEnvName(name);
      if (!pid) continue; // اسم لا يطابق مزوداً معروفاً — نتجاهله عمداً
      out.push({ provider: pid, value: val, label: name, source, priority });
    }
  }
  return out;
}

// ===== HashiCorp Vault (KV v2) =====
export class VaultSecretSource implements KeySource {
  readonly id = 'vault' as const;
  readonly label = 'HashiCorp Vault (KV v2)';
  readonly priority = 10;

  private cfg() {
    return {
      addr: (process.env.VAULT_ADDR || '').trim().replace(/\/+$/, ''),
      token: (process.env.VAULT_TOKEN || '').trim(),
      mount: (process.env.VAULT_MOUNT || 'secret').trim().replace(/^\/+|\/+$/g, ''),
      path: (process.env.VAULT_SECRET_PATH || 'ai-gateway/keys').trim().replace(/^\/+|\/+$/g, ''),
      namespace: (process.env.VAULT_NAMESPACE || '').trim()
    };
  }

  configured(): boolean {
    const c = this.cfg();
    return !!(c.addr && c.token && c.mount && c.path);
  }

  async fetch(signal: AbortSignal): Promise<{ entries: SecretEntry[]; error?: string }> {
    const c = this.cfg();
    if (!c.addr || !c.token) return { entries: [], error: 'Vault غير مُهيَّأ' };
    const check = await checkUrl(c.addr);
    if (!check.ok) return { entries: [], error: `عنوان Vault مرفوض: ${check.error}` };

    const url = `${check.url}/v1/${c.mount}/data/${c.path}`;
    try {
      const { statusCode, body } = await request(url, {
        method: 'GET',
        headers: {
          'X-Vault-Token': c.token,
          Accept: 'application/json',
          ...(c.namespace ? { 'X-Vault-Namespace': c.namespace } : {})
        },
        signal,
        headersTimeout: HTTP_TIMEOUT_MS,
        bodyTimeout: HTTP_TIMEOUT_MS
      });
      if (statusCode === 401 || statusCode === 403) {
        await body.dump();
        return { entries: [], error: `Vault: صلاحية مرفوضة (HTTP ${statusCode}) — راجع VAULT_TOKEN وسياساته` };
      }
      if (statusCode === 404) {
        await body.dump();
        return { entries: [], error: `Vault: المسار غير موجود (${c.mount}/${c.path})` };
      }
      if (statusCode >= 400) {
        const text = await body.text().catch(() => '');
        return { entries: [], error: `Vault HTTP ${statusCode}: ${sanitizeErrorMessage(text, 120)}` };
      }
      const json = await body.json() as any;
      const data = json?.data?.data;
      if (!data || typeof data !== 'object') {
        return { entries: [], error: 'Vault: شكل الرد غير متوقّع (KV v2 يتوقّع data.data)' };
      }
      return { entries: entriesFromMap(data, 'vault', this.priority) };
    } catch (e: any) {
      return { entries: [], error: `Vault: ${sanitizeErrorMessage(e, 150)}` };
    }
  }
}

// ===== Doppler =====
export class DopplerSecretSource implements KeySource {
  readonly id = 'doppler' as const;
  readonly label = 'Doppler';
  readonly priority = 20;

  private cfg() {
    return {
      token: (process.env.DOPPLER_TOKEN || '').trim(),
      project: (process.env.DOPPLER_PROJECT || '').trim(),
      config: (process.env.DOPPLER_CONFIG || '').trim()
    };
  }

  configured(): boolean { return !!this.cfg().token; }

  async fetch(signal: AbortSignal): Promise<{ entries: SecretEntry[]; error?: string }> {
    const c = this.cfg();
    if (!c.token) return { entries: [], error: 'Doppler غير مُهيَّأ' };
    // العنوان ثابت (خدمة معروفة) — نمرّره بالحارس رغم ذلك: قاعدة واحدة بلا استثناء
    const check = await checkUrl('https://api.doppler.com');
    if (!check.ok) return { entries: [], error: `عنوان Doppler مرفوض: ${check.error}` };

    const qs = new URLSearchParams({ format: 'json', include_dynamic_secrets: 'false' });
    if (c.project) qs.set('project', c.project);
    if (c.config) qs.set('config', c.config);
    const url = `${check.url}/v3/configs/config/secrets/download?${qs.toString()}`;
    try {
      const { statusCode, body } = await request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' },
        signal,
        headersTimeout: HTTP_TIMEOUT_MS,
        bodyTimeout: HTTP_TIMEOUT_MS
      });
      if (statusCode >= 400) {
        const text = await body.text().catch(() => '');
        const hint = statusCode === 401 || statusCode === 403
          ? 'راجع DOPPLER_TOKEN'
          : statusCode === 404 ? 'راجع DOPPLER_PROJECT/DOPPLER_CONFIG' : '';
        return { entries: [], error: `Doppler HTTP ${statusCode}: ${sanitizeErrorMessage(text, 100)} ${hint}`.trim() };
      }
      const json = await body.json() as any;
      if (!json || typeof json !== 'object') return { entries: [], error: 'Doppler: شكل الرد غير متوقّع' };
      return { entries: entriesFromMap(json, 'doppler', this.priority) };
    } catch (e: any) {
      return { entries: [], error: `Doppler: ${sanitizeErrorMessage(e, 150)}` };
    }
  }
}

// ===== 1Password Connect =====
export class OnePasswordSecretSource implements KeySource {
  readonly id = 'onepassword' as const;
  readonly label = '1Password Connect';
  readonly priority = 30;

  private cfg() {
    return {
      host: (process.env.OP_CONNECT_HOST || '').trim().replace(/\/+$/, ''),
      token: (process.env.OP_CONNECT_TOKEN || '').trim(),
      vault: (process.env.OP_VAULT_ID || '').trim(),
      item: (process.env.OP_ITEM_ID || '').trim()
    };
  }

  configured(): boolean {
    const c = this.cfg();
    return !!(c.host && c.token && c.vault && c.item);
  }

  async fetch(signal: AbortSignal): Promise<{ entries: SecretEntry[]; error?: string }> {
    const c = this.cfg();
    if (!c.host || !c.token) return { entries: [], error: '1Password Connect غير مُهيَّأ' };
    const check = await checkUrl(c.host);
    if (!check.ok) return { entries: [], error: `عنوان 1Password مرفوض: ${check.error}` };

    const url = `${check.url}/v1/vaults/${encodeURIComponent(c.vault)}/items/${encodeURIComponent(c.item)}`;
    try {
      const { statusCode, body } = await request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' },
        signal,
        headersTimeout: HTTP_TIMEOUT_MS,
        bodyTimeout: HTTP_TIMEOUT_MS
      });
      if (statusCode >= 400) {
        const text = await body.text().catch(() => '');
        const hint = statusCode === 401 || statusCode === 403
          ? 'راجع OP_CONNECT_TOKEN'
          : statusCode === 404 ? 'راجع OP_VAULT_ID/OP_ITEM_ID' : '';
        return { entries: [], error: `1Password HTTP ${statusCode}: ${sanitizeErrorMessage(text, 100)} ${hint}`.trim() };
      }
      const json = await body.json() as any;
      const fields = Array.isArray(json?.fields) ? json.fields : [];
      // في 1Password: عنوان الحقل (label) هو ما نقرأ منه معرّف المزود
      const map: Record<string, unknown> = {};
      for (const f of fields) {
        const name = String(f?.label || f?.id || '').trim();
        const value = String(f?.value ?? '').trim();
        if (!name || !value) continue;
        map[name] = value;
      }
      if (!Object.keys(map).length) {
        return { entries: [], error: '1Password: العنصر بلا حقول قابلة للقراءة (اجعل عنوان كل حقل = معرّف المزود)' };
      }
      return { entries: entriesFromMap(map, 'onepassword', this.priority) };
    } catch (e: any) {
      return { entries: [], error: `1Password: ${sanitizeErrorMessage(e, 150)}` };
    }
  }
}

/**
 * كل المصادر مرتّبة بالأولوية (الأصغر أعلى سلطة).
 * المصادر غير المُهيَّأة تبقى في القائمة (لتظهر في التقرير كـ"غير مُهيَّأ")
 * لكن المزامنة تتخطّاها بلا طلب شبكة.
 */
export function buildSources(): KeySource[] {
  return [
    new VaultSecretSource(),
    new DopplerSecretSource(),
    new OnePasswordSecretSource(),
    new FileSecretSource(),
    new EnvSecretSource()
  ].sort((a, b) => a.priority - b.priority);
}