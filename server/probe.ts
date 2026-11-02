// server/probe.ts — محرك فحص النماذج: يفرز اللي يشتغل عن اللي مرفوض
// منهج مأخوذ من OmniRoute modelTestRunner: probe حقيقي (شات صغير) + تصنيف دقيق للخطأ
import { request } from 'undici';
import { sanitizeErrorMessage } from './security.js';

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

/**
 * أقصى طول لاسم النموذج (S9).
 * لماذا: الاسم يصل من المستخدم (حدّ HTTP) أو من القاعدة (auto-probe) ويُرسل
 * للمزود كما هو — بلا حدّ يصبح حقناً لطلب خارجي ضخم. 128 يكفي أطول الأسماء
 * الحقيقية (كـ meta/llama-3.1-405b-instruct) بهامش مريح.
 */
export const MAX_MODEL_NAME_LEN = 128;

// ===== صلاحية أحكام الفحص (جدولة إعادة الفحص) =====
// كل حكم فحص له صلاحية — حتى "ok". نموذج نجح قبل 36 يوماً قد مات منذ أسابيع
// واللوحة تعرضه يعمل والمحادثة تفشل (قِيسَ فعلاً: 147 صف ok قديم، أحدها ردّ
// "model not offered" والأخران "needs paid plan"). القاعدة: القديم يُعاد فحصه
// بأي حالة، بسقف دفاعي حتى لا تُغرق الدورة الساعية المزودات.
export const PROBE_REJECTED_STALE_MS = 6 * 60 * 60 * 1000;   // rejected/provider_auth
export const OK_STALE_MS = 24 * 60 * 60 * 1000;               // ok أقدم من يوم يُعاد
export const OK_STALE_CAP = 25;                               // أقصى ok تُفحص في الدورة

export interface ProbeRowLike {
  provider: string;
  model: string;
  status: string;
  checked_at?: number | null;
}

/**
 * يختار صفوف الفحص المستحقّة لإعادة الفحص في الدورة القادمة.
 * المؤقّتة (rate_limited/slow) كلها، والنهائية القديمة (rejected/provider_auth)
 * بعد 6 ساعات، و"ok" بعد 24 ساعة — الأقدم أولاً وبسقف 25 لكل دورة.
 * دالة نقية تُختبر بلا إقلاع خادم (tests/stale-probe.check.tsx).
 */
export function selectStaleProbeCandidates(
  rows: ProbeRowLike[],
  now: number = Date.now(),
  opts: { rejectedStaleMs?: number; okStaleMs?: number; cap?: number } = {}
): ProbeRowLike[] {
  const rejectedStaleMs = opts.rejectedStaleMs ?? PROBE_REJECTED_STALE_MS;
  const okStaleMs = opts.okStaleMs ?? OK_STALE_MS;
  const cap = Math.max(1, opts.cap ?? OK_STALE_CAP);

  const due: ProbeRowLike[] = [];
  const okStale: ProbeRowLike[] = [];
  for (const r of rows) {
    const age = now - Number(r.checked_at || 0);
    if (r.status === 'rate_limited' || r.status === 'slow') { due.push(r); continue; }
    if ((r.status === 'rejected' || r.status === 'provider_auth') && age > rejectedStaleMs) { due.push(r); continue; }
    if (r.status === 'ok' && age > okStaleMs) okStale.push(r);
  }
  // السقف يشمل الفئات كلها: rejected بلا سقف كان يستطيع دفع دورة واحدة إلى
  // قرع مزود واحد لساعات (كل فحص حتى 25ث) — نأخذ الأقدم أولاً لكل فئة.
  due.sort((a, b) => Number(a.checked_at || 0) - Number(b.checked_at || 0));
  okStale.sort((a, b) => Number(a.checked_at || 0) - Number(b.checked_at || 0));
  return [...due.slice(0, cap * 4), ...okStale.slice(0, cap)];
}

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
  // S9: حارس الطول في أعمق نقطة — كل مسارات الفحص تمرّ هنا (يدوي، دفعات،
  // شامل، إعادة المرفوض، auto-probe). نرفض `rejected/format` (ليس نموذج
  // محادثة صالحاً) بدل إرسال الاسم الضخم للمزود. يُفحص قبل كل شيء حتى قبل
  // فحص المفتاح — اسم غير صالح لا يستحق أي عمل.
  if (!model || model.length > MAX_MODEL_NAME_LEN) {
    return {
      provider: providerId, model: String(model || '').slice(0, 80),
      status: 'rejected', latencyMs: 0, reason: 'format',
      error: !model
        ? 'model name required'
        : `model name too long (${model.length} > ${MAX_MODEL_NAME_LEN})`
    };
  }
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

    // نصوص الأخطاء القادمة من المزود تُخزَّن وتُعرض — تمرّ من التعقيم دائماً
    // (المزود قد يُضمّن المفتاح المرسل في رسالة الخطأ).
    const safeMsg = (body: string, fallback: string) =>
      sanitizeErrorMessage(extractMsg(body) || fallback, 200);

    // أخطاء المصادقة — المفتاح غلط أو ما عنده صلاحية.
    // مهم: هذا خطأ على مستوى المفتاح لا النموذج، فلا يجوز وسم النموذج مرفوضاً.
    // التصنيف المنفصل يمنع حجب مئات النماذج بسبب مفتاح واحد معطّل.
    if (res.statusCode === 401 || res.statusCode === 403) {
      const errText = await readBody(res);
      return {
        provider: providerId, model, status: 'provider_auth', latencyMs,
        reason: 'auth',
        error: safeMsg(errText, `auth failed (${res.statusCode})`)
      };
    }

    // النموذج غير موجود / انتهت صلاحيته
    if (res.statusCode === 404 || res.statusCode === 410) {
      const errText = await readBody(res);
      return {
        provider: providerId, model, status: 'rejected', latencyMs,
        reason: 'not_found',
        error: safeMsg(errText, 'model not found or retired')
      };
    }

    // أخطاء السيرفر — نعتبرها "بطيء/غير متاح" مو رفض دائم
    if (res.statusCode >= 500) {
      const errText = await readBody(res);
      return {
        provider: providerId, model, status: 'slow', latencyMs,
        reason: 'server',
        error: safeMsg(errText, `server error ${res.statusCode}`)
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
        error: safeMsg(errText, `model rejected the chat request (HTTP ${res.statusCode})`)
      };
    }

    // أي شي ثاني
    const errText = await readBody(res);
    return {
      provider: providerId, model, status: 'rejected', latencyMs,
      reason: 'unknown',
      error: safeMsg(errText, `HTTP ${res.statusCode}`)
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
      error: sanitizeErrorMessage(e?.message || String(e), 200)
    };
  }
}

// ===== حكم الطبقة: هل الفشل على مستوى المفتاح أم النموذج؟ =====
// لماذا هنا: هذا الحكم كان مكتوباً داخل index.ts فلا يمكن اختباره بلا إقلاع الخادم
// الكامل، وهو أخطر حكم في النظام — خطأٌ فيه يحجب نماذج سليمة أو يعطّل مفتاحاً سليماً.

/** أي نصّ يدلّ على مشكلة مفتاح (يُستخدم لتجربة مفتاح آخر). */
export function looksKeyRelated(out: ProbeResult): boolean {
  if (out.reason === 'auth') return true;
  return /api key|unauthor|forbidden|invalid key|authentication|permission|not allowed/i.test(out.error || '');
}

/** نصّ لا يحتمل غيره: المشكلة في المفتاح مهما كان رمز الحالة. */
export function isDefinitelyKeyError(out: ProbeResult): boolean {
  if (out.reason === 'auth') return true;
  return /invalid api key|invalid_api_key|invalid apikey|incorrect api key|api key not valid|api key expired|key expired|authentication_error|unauthorized/i.test(out.error || '');
}

/**
 * هل نحتاج تجربة **المفتاح التالي** بعد هذه النتيجة؟
 * القاعدة: الخطأ على مستوى المفتاح لا النموذج ⇒ المفتاح التالي قد ينجح. أي جواب
 * آخر نهائي: النموذج سليم أو ميت أو محجوب، وتكراره بلا فائدة.
 */
export function shouldTryNextKey(out: ProbeResult): boolean {
  if (out.status === 'provider_auth') return true;
  // بعض المزوّدات تردّ 404 بنصّ عن المصادقة — نعامله كخطأ مفتاح لا كنموذج ميت
  return out.status === 'rejected' && looksKeyRelated(out);
}

/** هل هذه المحاولة نفسها خطأ مفتاح؟ (لوسم المفتاح المعطوب وحده) */
export function isKeyLayerAttempt(out: ProbeResult): boolean {
  return out.status === 'provider_auth' || (out.status === 'rejected' && isDefinitelyKeyError(out));
}

/**
 * الحكم النهائي بعد تجربة مفاتيح المزود — نقطة واحدة يستخدمها كل مسار فحص.
 * S5: كان 404 الذي نصّه عن المصادقة يُعالَج كخطأ مفتاح **للتكرار فقط**، ثم تُعاد
 * نتيجته 'rejected' ⇒ يُحجب نموذج سليم ويُكتب صف رفض رغم أن السبب مفتاح.
 * الآن الحكم الطبقي نفسه يُستخدم في النتيجة: خطأ المفتاح لا يمسّ النموذج.
 */
export function resolveProbeVerdict(attempts: ProbeResult[]): ProbeResult {
  const last = attempts[attempts.length - 1];
  if (!last) throw new Error('resolveProbeVerdict: attempts must not be empty');
  const keyLayer = last.status === 'provider_auth'
    || (last.status === 'rejected' && (isDefinitelyKeyError(last) || (attempts.length > 1 && looksKeyRelated(last))));
  if (!keyLayer) return last;
  return {
    ...last,
    status: 'provider_auth',
    reason: 'auth',
    error: last.status === 'provider_auth'
      ? (last.error || "provider authentication failed — check this provider's keys")
      : (last.error || 'provider rejected the key, not the model')
  };
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
