// src/lib/utils.ts — دوال مشتركة للواجهة (مصدر الحقيقة الوحيد لتنسيق الزمن والأرقام)

/**
 * «مضى 5 د» — الصيغة العربية الوحيدة لعرض الزمن النسبي.
 * كانت هناك ثلاث نسخ متباعدة (إنجليزية، «قبل …»، وبلا بادئة)؛ هذه تحلّ محلها.
 */
export function timeAgo(ts?: number | null): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `مضى ${s} ث`;
  if (s < 3600) return `مضى ${Math.floor(s / 60)} د`;
  if (s < 86400) return `مضى ${Math.floor(s / 3600)} س`;
  return `مضى ${Math.floor(s / 86400)} ي`;
}

export function formatUptime(seconds: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h} س ${m} د`;
  if (m > 0) return `${m} د ${s} ث`;
  return `${s} ث`;
}

export function formatNumber(n?: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function cn(...args: (string | false | null | undefined)[]): string {
  return args.filter(Boolean).join(' ');
}
