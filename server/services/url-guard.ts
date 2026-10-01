// server/services/url-guard.ts — حماية عناوين المزودات (مضاد SSRF).
// كل مسار يستقبل baseUrl من المستخدم يمُرّ من هنا. بدونها يستطيع أي مدخل
// جعل الخادم يطلب خدمة داخلية (بيانات وصفية سحابية، SSH محلي، شبكة داخلية).
import { validateBaseUrl } from '../security.js';

const ALLOW_PRIVATE_HOSTS = process.env.ALLOW_PRIVATE_HOSTS === '1';

export function guardBaseUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  return validateBaseUrl(raw, { allowPrivate: ALLOW_PRIVATE_HOSTS });
}
