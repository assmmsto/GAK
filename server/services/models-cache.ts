// server/services/models-cache.ts — ذاكرة stale-while-revalidate عامة.
//
// لماذا لا TTL بسيط: مع TTL بسيط، أول طلب بعد كل انتهاء ينتظر الجلب الكامل
// (هنا: ~3 ثوانٍ لضرب 15 مزوّداً) — زمن ذيل سيئ يصيب مستخدماً كل دقيقة.
// مع SWR: بعد انتهاء TTL نُعيد النسخة القديمة **فوراً** ونُحدّث في الخلفية
// **برحلة واحدة** مهما تعدّد الطالبون (single-flight) — فلا انتظار ولا عاصفة.
//
// ضمانات:
//   1) الفشل الخلفي لا يكسر الطلب — تبقى النسخة القديمة وتُؤجَّل المحاولة دورة كاملة.
//   2) الفشل والذاكرة فارغة يُرمى للطالب — لا نُعيد فراغاً بصمت.
//   3) `invalidate()` عند أي تغيير في مصدر الحقيقة — لا بيانات كاذبة.
export class SwrCache<T> {
  private current: { at: number; data: T } | null = null;
  private refreshPromise: Promise<T> | null = null;

  constructor(private loader: () => Promise<T>, private ttlMs: number) {}

  async get(): Promise<{ data: T; cached: boolean; stale: boolean }> {
    const now = Date.now();
    if (this.current && now - this.current.at < this.ttlMs) {
      return { data: this.current.data, cached: true, stale: false };
    }
    if (this.current) {
      // انتهى TTL: قَدِّم القديم فوراً وحَدِّث في الخلفية.
      // الخطأ سُجّل داخل refresh — الـcatch هنا فقط لمنع unhandled rejection.
      void this.refresh().catch(() => { /* سُجّل داخل refresh */ });
      return { data: this.current.data, cached: true, stale: true };
    }
    const data = await this.refresh();
    return { data, cached: false, stale: false };
  }

  /** يُبطل النسخة عند تغيّر مصدر الحقيقة (مزود/مفتاح/إعداد). */
  invalidate(): void {
    this.current = null;
  }

  /** رحلة واحدة مهما تعدّد الطالبون — من يأتي أثناء التحديث يلتحق به لا يكرّره. */
  private refresh(): Promise<T> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.loader().then((data) => {
        this.current = { at: Date.now(), data };
        return data;
      }).catch((err: any) => {
        if (this.current) {
          console.warn('[models-cache] background refresh failed:', err?.message || err);
          // لا عاصفة إعادة: أجّل المحاولة دورة TTL كاملة.
          this.current = { at: Date.now(), data: this.current.data };
          return this.current.data;
        }
        throw err; // بلا أي نسخة: ليفشل الطالب الأول بصوت عالٍ لا بصمت.
      }).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }
}
