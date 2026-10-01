// server/security.ts — أدوات أمنية مشتركة: تعقيم الأخطاء + ترويسات + حد المعدل
// القاعدة: لا يُعاد نص خام من مزود/شبكة/استثناء إلى العميل أو السجل قبل تعقيمه.
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
];

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
export function securityHeaders(_req: any, res: any, next: () => void) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
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
    // مفتاح الحصة: IP + (أول 8 أحرف من مفتاح البوابة إن وُجد) — حتى لا
    // يحجب مهاجمٌ بلا مفتاح مستخدماً شرعياً يشاركه نفس IP/NAT.
    const ip = (req.ip || req.socket?.remoteAddress || 'unknown') as string;
    const auth = String(req.headers.authorization || req.headers['x-api-key'] || '');
    const fp = auth.length > 8 ? ':' + auth.slice(-8) : '';
    const key = ip + fp;
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

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * يتحقق من عنوان مزود قبل استخدامه في أي طلب.
 * @param opts.allowPrivate اسمح بعناوين RFC1918 (خادم استنتاج على شبكتك المحلية).
 *   ملاحظة: 169.254.x محجوب دائماً — لا يفتحه هذا الخيار.
 */
export function validateBaseUrl(raw: unknown, opts: { allowPrivate?: boolean } = {}): UrlCheck {
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
  return { ok: true, url: u.toString() };
}

