// server/services/signup-url.ts — رابط «احصل على مفتاح» لمزوّد.
//
// لماذا دالة نقية منفصلة: بطاقة المزوّد ونافذة المفاتيح تحتاجان رابطاً واحداً
// متسقاً، وبعض المزوّدات تُضاف بلا `signupUrl` (إضافة مخصّصة أو استيراد).
// الاشتقاق من `baseUrl` يغطّي الباقي بلا طلب شبكة ولا حالة مخزَّنة.
//
// القاعدة: النطاق وحده، بلا `api.` ولا `www.` ولا مسار — لأن `baseUrl` هو عنوان
// الـAPI (`https://api.x.com/v1`) لا موقع التسجيل (`https://x.com`).

/** استثناءات صريحة: نطاق الـAPI لا يدلّ على موقع التسجيل. */
const EXPLICIT: Record<string, string> = {
  tokenharbor: 'https://tokenharbor.ai/dashboard'
};

export function deriveSignupUrl(baseUrl: string | undefined | null, id?: string): string | null {
  if (id && EXPLICIT[id]) return EXPLICIT[id];
  const raw = String(baseUrl || '').trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  let host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^api\./, '');
  // `integrate.api.nvidia.com` ونظائره: نحتفظ بالباقي بعد إزالة api. اليسرى فقط
  if (!host || host.includes('localhost') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  return `https://${host}`;
}
