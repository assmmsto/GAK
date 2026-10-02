// server/agents/scheduler.ts — مشرف الوكلاء: دورة واحدة تُشغّل كل مهمّة مستحقّة.
//
// ثلاث قواعد غير قابلة للتفاوض:
//  1) **لا تداخل**: مهمّة قيد التنفيذ لا تُشغَّل ثانية (وإلا تكدّست دورات بطيئة).
//  2) **لا ابتلاع**: خطأ أي مهمّة يُلتقط ويُسجَّل بحالته وسببه — لا يوقف غيره.
//  3) **مؤقّتات غير حاجبة**: unref حتى لا يمنع إيقاف العملية بين الحزم (Ctrl+C).
import { sanitizeErrorMessage } from '../security.js';

export interface TaskOutcome {
  ok: boolean;
  detail?: any;
  error?: string;
}

export interface TaskDef {
  name: string;
  /** الفترة بالمللي ثانية */
  intervalMs: number;
  /** يُستدعى قبل التشغيل — إيقاف يدوي مؤقت بلا حذف المهمة من الجدول */
  enabled?: () => boolean;
  run: () => Promise<TaskOutcome>;
}

export interface TaskState {
  name: string;
  intervalMs: number;
  enabled: boolean;
  running: boolean;
  lastRun: number | null;
  lastMs: number | null;
  lastOk: boolean | null;
  lastError: string | null;
  runs: number;
  failures: number;
  /** مرات أُهملت بسبب جارية precedent (لا تداخل) */
  skipped: number;
  nextDueInMs: number | null;
}

export class AgentScheduler {
  private tasks = new Map<string, { def: TaskDef; state: TaskState; running: boolean; nextDue: number }>();
  private timer: any = null;
  private tickMs: number;
  private startedAt = 0;

  constructor(tickMs = 15_000) {
    this.tickMs = Math.max(1000, tickMs);
  }

  register(def: TaskDef): void {
    if (this.tasks.has(def.name)) return; // تسجيل مزدوج = خطأ برمجي صامت
    this.tasks.set(def.name, {
      def,
      running: false,
      nextDue: Date.now() + Math.max(0, Math.min(def.intervalMs, 5000)), // أول تشغيل بعد الإقلاع مباشرةً
      state: {
        name: def.name, intervalMs: def.intervalMs, enabled: true, running: false,
        lastRun: null, lastMs: null, lastOk: null, lastError: null,
        runs: 0, failures: 0, skipped: 0, nextDueInMs: def.intervalMs
      }
    });
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** تشغيل يدوي لمهمّة واحدة (من الواجهة/الاختبار) — يحترم حارس التداخل. */
  async runNow(name: string): Promise<TaskOutcome & { skipped?: boolean }> {
    const entry = this.tasks.get(name);
    if (!entry) return { ok: false, error: `مهمّة غير معروفة: ${name}` };
    if (entry.running) return { ok: false, skipped: true, error: 'المهمّة قيد التنفيذ' };
    return this.invoke(entry);
  }

  private async invoke(entry: { def: TaskDef; state: TaskState; running: boolean; nextDue: number }): Promise<TaskOutcome> {
    entry.running = true;
    entry.state.running = true;
    const t0 = Date.now();
    try {
      const out = await entry.def.run();
      entry.state.lastOk = out.ok !== false;
      entry.state.lastError = out.ok === false ? sanitizeErrorMessage(out.error || 'فشل') : null;
      return out;
    } catch (e: any) {
      // الخطأ يُلتقط هنا ولا يخرج — وإلا أوقف دورة الوكلاء كلها
      const msg = sanitizeErrorMessage(e, 200);
      entry.state.lastOk = false;
      entry.state.lastError = msg;
      console.error(`[agent:${entry.def.name}] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      const took = Date.now() - t0;
      entry.running = false;
      entry.state.running = false;
      entry.state.lastRun = Date.now();
      entry.state.lastMs = took;
      entry.state.runs++;
      if (entry.state.lastOk === false) entry.state.failures++;
      entry.nextDue = Date.now() + entry.def.intervalMs;
      entry.state.nextDueInMs = Math.max(0, entry.nextDue - Date.now());
    }
  }

  /** دورة واحدة: يشغّل كل مهمّة حان وقتها. لا ترمي أبداً. */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const entry of this.tasks.values()) {
      const { def, state } = entry;
      const enabled = def.enabled ? !!def.enabled() : true;
      state.enabled = enabled;
      if (!enabled) continue;
      if (now < entry.nextDue) { state.nextDueInMs = entry.nextDue - now; continue; }
      if (entry.running) { state.skipped++; continue; }
      await this.invoke(entry);
    }
  }

  status(): {
    running: boolean; tickMs: number; uptimeMs: number;
    tasks: TaskState[];
  } {
    const now = Date.now();
    return {
      running: !!this.timer,
      tickMs: this.tickMs,
      uptimeMs: this.startedAt ? now - this.startedAt : 0,
      tasks: [...this.tasks.values()].map(e => ({
        ...e.state,
        running: e.running,
        nextDueInMs: Math.max(0, e.nextDue - now)
      }))
    };
  }
}