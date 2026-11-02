// server/security.ts — أدوات أمنية مشتركة: تعقيم الأخطاء + ترويسات + حد المعدل
// القاعدة: لا يُعاد نص خام من مزود/شبكة/استثناء إلى العميل أو السجل قبل تعقيمه.
import { timingSafeEqual } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

const SENSITIVE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,          // OpenAI / DeepSeek / generic
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g,    // OpenRouter
  /sk-ant-[A-Za-z0-9_-]{8,}/g,      // Anthropic
  /gsk_[A-Za-z0-9]{8,}/g,           // Groq
  /AIza[A-Za-z0-9_-]{8,}/g,         // Google
  /xai-[A-Za-z0-9]{8,}/g,           // xAI
  /pplx-[A-Za-z0-9]{8,}/g,          // Perplexity
  /nvapi-[A-Za-z0-9_-]{8,}/g,       // NVIDIA
  /hf_[A-Za-z0-9]{8,}/g,            // HuggingFace
  /cpk_[A-Za-z0-9]{8,}/g,           // Chutes
  /fn_[A-Za-z0-9]{8,}/g,            // Fireworks
  /apx_[A-Za-z0-9]{8,}/g,           // Aphmix
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /api[_-]?key\s*[:=]\s*['\"]?[^'\"\s,}]{8,}/gi,
  // مفاتيح البوابة نفسها (مولَّدة هنا أو بادئة نشر مخصصة) — لو انعكست في
  // رسالة مزود أو استثناء يجب ألّا تصل العميل أو السجل.
  /\bgw_[A-Za-z0-9]{20,}\b/g,
  /\bdahl_[A-Za-z0-9_-]{20,}\b/g,
];

/**
 * مقارنة ثوابت زمنية لنصّين سريّين. لماذا: `a === b` يتوقف عند أول حرف
 * مختلف فيسمح بقياس البادئة عبر الفروق الزمنية. الأطوال المختلفة تخرج
 * مبكراً (لا يقارن نصان بطولين مختلفين أصلاً) — وهذا مقبول: طول التوكن
 * ليس سرّاً وبالتأكيد لا يفتح تخمينه.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** هل الطلب وصل عبر وسيط عكسي (reverse proxy)؟ */
// لماذا يهم: الحماية على /api تُقيَّم من ربط HOST، لكن نشراً شائعاً يربط الخادم
// على 127.0.0.1 ويكشفه بروكسي للإنترنت — فيتخطى فحص HOST بالكامل. الترويسات
// التي يضيفها البروكسي هي الدليل الوحيد المتاح داخل الطلب.
export function isProxiedRequest(req: { headers?: Record<string, unknown> }): boolean {
  const h = req?.headers || {};
  return ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip']
    .some(k => h[k] !== undefined && h[k] !== '');
}

/**
 * يعقّم أي نص قبل إعادته للعميل أو تخزينه في السجلات.
 * لماذا: المزودات تُضمّن أحياناً المفتاح المرسل في رسالة الخطأ
 * (invalid key `sk-...`)، وإعادته خاماً تسرّبه للواجهة والسجلات.
 */
export function sanitizeErrorMessage(input: unknown, maxLen = 300): string {
  let s: string;
  if (input == null) return 'Unknown error';
  if (typeof input === 'string') s = input;
  else if (input instanceof Error) s = input.message || String(input);
  else { try { s = JSON.stringify(input); } catch { s = String(input); } }
  // أزل أكواد ANSI / أسطر زائدة — رسالة سطر واحد قابلة للعرض
  s = s.replace(/\u001b\[[0-9;]*m/g, '').replace(/[\r\n]+/g, ' ').trim();
  for (const re of SENSITIVE_PATTERNS) {
    re.lastIndex = 0;
    s = s.replace(re, '[REDACTED]');
  }
  if (!s) return 'Unknown error';
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

// ===== ترويسات أمنية خفيفة (بدون اعتماد helmet) =====
// CSP بلا 'unsafe-inline'/'unsafe-eval': بناء dist/ يبني سكربت ملفاً خارجياً
// واحداً بلا inline (تحقق قبل القرار) — أي إضافة inline في الواجهة تكسر CSP.
const CSP = "default-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function securityHeaders(_req: any, res: any, next: () => void) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  // لا نكشف خادمنا: أخفِ X-Powered-By الافتراضي
  res.removeHeader('X-Powered-By');
  next();
}

// ===== حدّ معدل بسيط في الذاكرة (نافذة منزلقة) =====
// لماذا بلا مكتبة: المشروع محلي (عملية واحدة) ولا نريد اعتماداً جديداً
// لشيء يُكتب بعشرين سطراً. إن وُزّع على عدة عمليات لاحقاً يُستبدل بـ Redis.
interface Bucket { count: number; resetAt: number; }

export function rateLimit(opts: { windowMs: number; max: number; message?: string }) {
  const buckets = new Map<string, Bucket>();
  const WINDOW = Math.max(1000, opts.windowMs);
  const MAX = Math.max(1, opts.max);
  // تنظيف دوري حتى لا تنمو الخريطة بلا حد (بصمات IP قديمة)
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, WINDOW).unref?.();
  if (sweep && typeof (sweep as any).unref === 'function') (sweep as any).unref();

  return (req: any, res: any, next: () => void) => {
    // مفتاح الحصة: **عنوان IP فقط**.
    // لماذا لا نضمّ بصمة من الترويسات؟ أي بُعد يتحكّم فيه المهاجم يفتح له دلاء
    // لا نهائية — حتى التجزئة: تغيير محرف واحد = دلو جديد. كان الكود يقتطع آخر
    // 8 محارف من Authorization ⇒ حدّ المعدل كان يُتجاوز بلا حدّ.
    // الثمن المقبول: مستخدمو NAT يتقاسمون حصةً واحدة. وهو أفضل من حدّ غير فعّال.
    const ip = (req.ip || req.socket?.remoteAddress || 'unknown') as string;
    const key = ip;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + WINDOW }; buckets.set(key, b); }
    b.count++;
    res.setHeader('X-RateLimit-Limit', String(MAX));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, MAX - b.count)));
    if (b.count > MAX) {
      return res.status(429).json({ error: { message: opts.message || 'Too many requests, slow down.', type: 'rate_limited' } });
    }
    next();
  };
}

// ===== التحقق من عنوان المزود (مضاد SSRF) =====
// لماذا: عنوان المزود يأتي من المستخدم، والخادم يطلبه نيابةً عنه. بلا تحقق
// يستطيع أي مُدخل أن يجعل الخادم يقرأ خدمة داخلية (169.254.169.254 = بيانات
// وصفية سحابية، 127.0.0.1:22 = SSH محلي) ويكشف النتيجة من فرق الزمن أو الرسالة.
// القرار: نفحص العنوان قبل أي طلب، مرة واحدة عند الحدود.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

export function isLoopbackHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(h) || h.endsWith('.localhost');
}

/** هل المضيف داخلي/خاص؟ يغطي IPv4 الخاص + IPv6 (loopback/ULA/link-local) + أسماء داخلية. */
export function isPrivateHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if ([a, b, Number(v4[3]), Number(v4[4])].some(n => n > 255)) return false;
    if (a === 10) return true;                                  // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;            // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                     // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                      // link-local + metadata
    if (a === 127 || a === 0) return true;                        // loopback / this-network
    return false;
  }
  if (h.includes(':')) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return h === 'metadata.google.internal' || h.endsWith('.internal');
}

/**
 * فحص عنوان واحد (مثلاً ناتج حل DNS) بنفس قواعد الحارس: 169.254 محجوب
 * دائماً، والخاصات تتبع allowPrivate. نقية بلا شبكة — يجرّبها الاختبار مباشرةً.
 * @returns سبب الرفض، أو null إن قُبل.
 */
export function checkResolvedAddress(address: string, allowPrivate: boolean): string | null {
  const a = String(address ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (/^169\.254\./.test(a)) return 'عنوان 169.254.x محجوب (نطاق البيانات الوصفية السحابية)';
  if (isPrivateHost(a) && !allowPrivate) {
    return `عنوان داخلي (${a}) محجوب. لخادم على شبكتك المحلية اضبط ALLOW_PRIVATE_HOSTS=1`;
  }
  return null;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** مهلة حل DNS في الحارس: بلا حل ضمن المهلة يُرفض الرابط صراحةً (fail-closed). */
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * يتحقق من عنوان مزود قبل استخدامه في أي طلب.
 * @param opts.allowPrivate اسمح بعناوين RFC1918 (خادم استنتاج على شبكتك المحلية).
 *   ملاحظة: 169.254.x محجوب دائماً — لا يفتحه هذا الخيار.
 *
 * D-19 (تثبيت العنوان): حروف IP تُفحص كما هي، واسم المضيف يُحَل عبر DNS ثم
 * يُفحص كل عنوان محلول بـ checkResolvedAddress — حتى لا يعبر اسم عام يحل إلى
 * عنوان داخلي (DNS rebinding) حارس SSRF. فشل الحل أو تجاوز المهلة = رفض صريح.
 */
export async function validateBaseUrl(raw: unknown, opts: { allowPrivate?: boolean } = {}): Promise<UrlCheck> {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'رابط المزود مطلوب' };

  let u: URL;
  try { u = new URL(s); }
  catch { return { ok: false, error: `رابط غير صالح: ${s.slice(0, 60)}` }; }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `بروتوكول غير مدعوم (${u.protocol}) — استخدم https` };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'لا تُدرج بيانات اعتماد داخل الرابط — ضع المفتاح في حقل المفتاح' };
  }
  if (u.hash) return { ok: false, error: 'الرابط لا يقبل #fragment' };

  const loop = isLoopbackHost(u.hostname);
  // بيانات وصفية سحابية: محجوبة دائماً وبلا استثناء (لا يفتحها أي متغير بيئة)
  if (/^169\.254\./.test(u.hostname)) {
    return { ok: false, error: 'عنوان 169.254.x محجوب (نطاق البيانات الوصفية السحابية)' };
  }
  const priv = isPrivateHost(u.hostname);
  const privateAllowed = priv && !loop && opts.allowPrivate === true;
  // http مسموح لعنوان محلي (Ollama/LM Studio) أو لعنوان شبكة محلية مُصرَّح به
  // (خادم استنتاج على 192.168.x يخدم http عادةً) — كل ما سواه يجب أن يكون https
  if (u.protocol === 'http:' && !loop && !privateAllowed) {
    return { ok: false, error: 'http مسموح للعنوان المحلي فقط — استخدم https لغيره' };
  }
  if (loop) return { ok: true, url: u.toString() };

  if (priv && !privateAllowed) {
    return {
      ok: false,
      error: `عنوان داخلي (${u.hostname}) محجوب. لخادم على شبكتك المحلية اضبط ALLOW_PRIVATE_HOSTS=1`
    };
  }

  // D-19: اسم المضيف (وليس حرف IP) يُحَل عبر DNS ويُفحص كل عنوان محلول:
  // اسم عام يحل إلى 127.0.0.1 أو 192.168.x (DNS rebinding) لا يعبر الحارس.
  // حرفا IP لا يحتاجان حلّاً (فحصهما النصي أعلاه كافٍ)، والاسم الداخلي الذي
  // صُرّح له عبر allowPrivate يبقى ضمن سماح الشبكة المحلية الواسع.
  const bare = u.hostname.replace(/^\[|\]$/g, '');
  if (!priv && isIP(bare) === 0) {
    let resolved: { address: string }[];
    try {
      // dnsPromises.lookup لا يقبل signal — المهلة تُفرض بسباق صريح، والوعد
      // المعلّق يُترك بلا انتظار (أقصره 5 ثوانٍ فلا يتراكم).
      resolved = await Promise.race([
        dnsPromises.lookup(u.hostname, { all: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('dns timeout')), DNS_LOOKUP_TIMEOUT_MS).unref()
        ),
      ]);
    } catch {
      return { ok: false, error: `تعذّر حل ${u.hostname} (DNS) — العناوين التي لا تُحَلّ تُرفض` };
    }
    if (!resolved.length) {
      return { ok: false, error: `تعذّر حل ${u.hostname} (DNS) — لا عناوين` };
    }
    for (const { address } of resolved) {
      const why = checkResolvedAddress(address, opts.allowPrivate === true);
      if (why) return { ok: false, error: why };
    }
  }
  return { ok: true, url: u.toString() };
}

