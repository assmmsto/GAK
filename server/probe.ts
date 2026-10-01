// server/probe.ts — محرك فحص النماذج: يفرز اللي يشتغل عن اللي مرفوض
// منهج مأخوذ من OmniRoute modelTestRunner: probe حقيقي (شات صغير) + تصنيف دقيق للخطأ
import { request } from 'undici';

// provider_auth: مشكلة في مفتاح المزود نفسه — لا يعني أن النموذج ميت إطلاقاً.
// كان يُخلط سابقاً مع 'rejected' فتُوسم مئات النماذج بالموت بسبب مفتاح واحد معطّل.
export type ProbeStatus = 'ok' | 'rejected' | 'provider_auth' | 'rate_limited' | 'slow' | 'no_key';

export interface ProbeResult {
  provider: string;
  model: string;
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
  // سبب الرفض (للتصنيف الدقيق)
  reason?: 'auth' | 'not_found' | 'quota' | 'timeout' | 'server' | 'format' | 'unknown';
}

const PROBE_TIMEOUT_MS = 25_000;
// 16 كان صغيراً جداً: نماذج التفكير تستهلكه كله في التفكير فترجع 200 بلا نص،
// فيُرفض نموذج سليم ظلماً. 64 كافية لنموذج عادي، وعند الرد الفارغ نعيد المحاولة بـ 256.
const PROBE_MAX_TOKENS = 64;
const PROBE_RETRY_MAX_TOKENS = 256;

// نص الفحص: قصير ومحدد عشان لا نستهلك حصة كبيرة
const PROBE_MESSAGES = [
  { role: 'user', content: 'Reply with exactly: OK' }
];

// محاولة محادثة واحدة (تُستخدم للمحاولة الثانية بميزانية رموز أكبر)
async function callChat(
  url: string,
  headers: Record<string, string>,
  model: string,
  maxTokens: number,
  signal: AbortSignal
): Promise<{ statusCode: number; body: string }> {
  const res = await request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: PROBE_MESSAGES,
      max_tokens: maxTokens,
      temperature: 0,
      stream: false
    }),
    signal,
    headersTimeout: PROBE_TIMEOUT_MS,
    bodyTimeout: PROBE_TIMEOUT_MS
  });
  return { statusCode: res.statusCode, body: await readBody(res) };
}

/**
 * يفرز بين "المزود يشتغل فعلاً" و"مرفوض"
 * النموذج اللي يرجع كلام = يعمل، غير كذا = مرفوض مع سبب
 */
export async function probeModel(
  providerId: string,
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  keyless = false
): Promise<ProbeResult> {
  const t0 = Date.now();
  const fullUrl = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  if (!apiKey && !keyless) {
    return {
      provider: providerId, model, status: 'no_key', latencyMs: 0,
      reason: 'auth', error: 'no API key configured'
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROBE_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await request(fullUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: PROBE_MESSAGES,
        max_tokens: PROBE_MAX_TOKENS,
        temperature: 0,
        stream: false
      }),
      signal: controller.signal,
      headersTimeout: PROBE_TIMEOUT_MS,
      bodyTimeout: PROBE_TIMEOUT_MS
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;

    // 429 — ممكن يكون مؤقت (حصة) أو دائم
    if (res.statusCode === 429) {
      const errText = await readBody(res);
      const permanent = /exhausted|allowance|balance|insufficient|quota/i.test(errText);
      return {
        provider: providerId, model, status: 'rate_limited', latencyMs,
        reason: 'quota',
        error: permanent
          ? 'quota permanently exhausted (needs top-up)'
          : 'rate limited (retry later)'
      };
    }

    // أخطاء المصادقة — المفتاح غلط أو ما عنده صلاحية.
    // مهم: هذا خطأ على مستوى المفتاح لا النموذج، فلا يجوز وسم النموذج مرفوضاً.
    // التصنيف المنفصل يمنع حجب مئات النماذج بسبب مفتاح واحد معطّل.
    if (res.statusCode === 401 || res.statusCode === 403) {
      const errText = await readBody(res);
      return {
        provider: providerId, model, status: 'provider_auth', latencyMs,
        reason: 'auth',
        error: extractMsg(errText) || `auth failed (${res.statusCode})`
      };
    }

    // النموذج غير موجود / انتهت صلاحيته
    if (res.statusCode === 404 || res.statusCode === 410) {
      const errText = await readBody(res);
      return {
        provider: providerId, model, status: 'rejected', latencyMs,
        reason: 'not_found',
        error: extractMsg(errText) || 'model not found or retired'
      };
    }

    // أخطاء السيرفر — نعتبرها "بطيء/غير متاح" مو رفض دائم
    if (res.statusCode >= 500) {
      const errText = await readBody(res);
      return {
        provider: providerId, model, status: 'slow', latencyMs,
        reason: 'server',
        error: extractMsg(errText) || `server error ${res.statusCode}`
      };
    }

    // نجاح — نتأكد إنو رجع كلام فعلاً (مو مجرد 200 فاضي)
    if (res.statusCode < 400) {
      const body = await readBody(res);
      const text = extractContent(body);
      if (!text) {
        // نماذج التفكير تستهلك كل ميزانية الرموز في التفكير فترجع 200 بلا نص ظاهر.
        // نحاول مرة ثانية بميزانية أكبر قبل الحكم عليها — وإلا حجبنا نموذجاً سليماً ظلماً.
        const retry = await callChat(fullUrl, headers, model, PROBE_RETRY_MAX_TOKENS, controller.signal);
        if (retry.statusCode < 400) {
          const retryText = extractContent(retry.body);
          if (retryText) {
            return {
              provider: providerId, model, status: 'ok', latencyMs: Date.now() - t0,
              error: retryText.slice(0, 40)
            };
          }
          if (extractCompletionTokens(retry.body) > 0) {
            // يستهلك رموزاً لكن لا يُظهر نصاً → يعمل، لكن لا نحجبه (slow غير محجوب)
            return {
              provider: providerId, model, status: 'slow', latencyMs: Date.now() - t0,
              reason: 'format',
              error: 'reasoning-only reply — no visible text (needs larger max_tokens)'
            };
          }
        }
        // فعلاً لا يرد نصاً ولا يستهلك رموزاً → ليس نموذج محادثة
        return {
          provider: providerId, model, status: 'rejected', latencyMs: Date.now() - t0,
          reason: 'format',
          error: extractCompletionTokens(body) > 0
            ? 'reply had no visible text content'
            : 'returned 200 but no text content (not a chat model?)'
        };
      }
      return {
        provider: providerId, model, status: 'ok', latencyMs,
        error: text.slice(0, 40)
      };
    }

    // 400/422 — الطلب مرفوض: غالباً النموذج لا يدعم المحادثة (نماذج الصوت/الصور/التضمين)
    if (res.statusCode === 400 || res.statusCode === 422) {
      const errText = await readBody(res);
      return {
        provider: providerId, model, status: 'rejected', latencyMs,
        reason: 'format',
        error: extractMsg(errText) || `model rejected the chat request (HTTP ${res.statusCode})`
      };
    }

    // أي شي ثاني
    const errText = await readBody(res);
    return {
      provider: providerId, model, status: 'rejected', latencyMs,
      reason: 'unknown',
      error: extractMsg(errText) || `HTTP ${res.statusCode}`
    };
  } catch (e: any) {
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    if (timedOut) {
      return {
        provider: providerId, model, status: 'slow', latencyMs,
        reason: 'timeout', error: `no response within ${PROBE_TIMEOUT_MS / 1000}s`
      };
    }
    return {
      provider: providerId, model, status: 'rate_limited', latencyMs,
      reason: 'server',
      error: (e.message || String(e)).slice(0, 200)
    };
  }
}

async function readBody(res: any): Promise<string> {
  try {
    return await res.body.text();
  } catch {
    return '';
  }
}

function extractMsg(body: string): string {
  try {
    const j = JSON.parse(body);
    return j.error?.message || j.error || j.message || j.detail || '';
  } catch {
    return body.slice(0, 150);
  }
}

function extractContent(body: string): string {
  try {
    const j = JSON.parse(body);
    return j.choices?.[0]?.message?.content || j.choices?.[0]?.text || '';
  } catch {
    return '';
  }
}

// عدد رموز الإكمال: يخبرنا إن كان النموذج يستهلك رموزاً فعلاً (نموذج تفكير) أم لا يرد إطلاقاً
function extractCompletionTokens(body: string): number {
  try {
    const j = JSON.parse(body);
    return Number(j.usage?.completion_tokens || 0);
  } catch {
    return 0;
  }
}
