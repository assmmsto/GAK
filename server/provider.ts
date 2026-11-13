// server/provider.ts — OpenAI-compatible provider client
import { request } from 'undici';

export class OpenAIProvider {
  keyless = false; // مزود مجاني بدون مفتاح (pollinations)
  constructor(
    public id: string,
    public name: string,
    public baseUrl: string,
    public apiKey: string | undefined,
    public tier: number = 2,
    public format: 'openai' | 'anthropic' = 'openai',
    public headers: Record<string, string> = {}
  ) {
    // المزودات المجانية اللي بتشتغل بدون مفتاح
    this.keyless = !this.apiKey && (this.id === 'pollinations');
  }

  private buildHeaders(extra?: Record<string, string>) {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...this.headers,
      ...(extra || {})
    };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; statusCode?: number; error?: string }> {
    const t0 = Date.now();
    try {
      const { statusCode, body } = await request(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        headersTimeout: 5000,
        bodyTimeout: 5000
      });
      await body.dump();
      return { ok: statusCode < 400, latencyMs: Date.now() - t0, statusCode };
    } catch (e: any) {
      return { ok: false, latencyMs: Date.now() - t0, error: e.message };
    }
  }

  async listModels(): Promise<Array<{ id: string; owned_by?: string }>> {
    try {
      const { statusCode, body } = await request(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        headersTimeout: 8000,
        bodyTimeout: 8000
      });
      if (statusCode >= 400) { await body.dump(); return []; }
      const data = await body.json() as any;
      const list = data.data || data.models || [];
      // بعض المزودات (Google) ترجّع المعرّف ببادئة "models/" فتصبح المعرّفات
      // المكشوفة "google-ai/models/gemini-..." — نزيل البادئة لأن المزود يقبل الاسم المجرّد
      return list.map((m: any) => ({
        ...m,
        id: String(m.id ?? m.name ?? '').replace(/^models\//, '')
      }));
    } catch { return []; }
  }

  async embeddings(opts: { model: string; input: any }): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
    try {
      const { statusCode, body } = await request(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ model: opts.model, input: opts.input }),
        headersTimeout: 60000,
        bodyTimeout: 60000
      });
      if (statusCode >= 400) {
        return { ok: false, status: statusCode, error: (await body.text()).slice(0, 1000) };
      }
      return { ok: true, status: statusCode, data: await body.json() };
    } catch (e: any) {
      return { ok: false, status: 0, error: e.message };
    }
  }

  async chat(opts: {
    model: string;
    messages: any[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stop?: any;
    tools?: any;
    tool_choice?: any;
    response_format?: any;
    seed?: number;
    n?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    user?: string;
  }): Promise<{
    ok: boolean;
    status: number;
    data?: any;
    stream?: any;
    headers?: any;
    usage?: any;
    error?: string;
  }> {
    const payload: any = {
      model: opts.model,
      messages: opts.messages,
      stream: opts.stream || false
    };
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    if (opts.max_tokens !== undefined) payload.max_tokens = opts.max_tokens;
    if (opts.top_p !== undefined) payload.top_p = opts.top_p;
    if (opts.stop !== undefined) payload.stop = opts.stop;
    // مهم لوكلاء البرمجة: كانت هذه الحقول تُحذف بصمت فيفقد النموذج قدرة استدعاء الأدوات
    if (opts.tools !== undefined) payload.tools = opts.tools;
    if (opts.tool_choice !== undefined) payload.tool_choice = opts.tool_choice;
    if (opts.response_format !== undefined) payload.response_format = opts.response_format;
    if (opts.seed !== undefined) payload.seed = opts.seed;
    if (opts.n !== undefined) payload.n = opts.n;
    if (opts.frequency_penalty !== undefined) payload.frequency_penalty = opts.frequency_penalty;
    if (opts.presence_penalty !== undefined) payload.presence_penalty = opts.presence_penalty;
    if (opts.user !== undefined) payload.user = opts.user;
    // نطلب usage مع البث حتى نحتسب استهلاك وكلاء البرمجة (كان غير مرئي تماماً)
    if (opts.stream) payload.stream_options = { include_usage: true };

    const url = `${this.baseUrl}/chat/completions`;

    try {
      const send = (p: any) => request(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(p),
        headersTimeout: 60000,
        bodyTimeout: 60000
      });

      let res = await send(payload);

      if (opts.stream) {
        if (res.statusCode < 400) {
          return { ok: true, status: res.statusCode, stream: res.body, headers: res.headers };
        }
        const errText = await res.body.text().catch(() => '');
        // بعض المزودات لا تعرف stream_options → نعيد المحاولة بدونها بدل إسقاط البث
        if (res.statusCode === 400 && payload.stream_options) {
          delete payload.stream_options;
          res = await send(payload);
          if (res.statusCode < 400) {
            return { ok: true, status: res.statusCode, stream: res.body, headers: res.headers };
          }
          const err2 = await res.body.text().catch(() => '');
          return { ok: false, status: res.statusCode, error: err2.slice(0, 1000) };
        }
        return { ok: false, status: res.statusCode, error: errText.slice(0, 1000) };
      }

      if (res.statusCode >= 400) {
        const errText = await res.body.text();
        return { ok: false, status: res.statusCode, error: errText.slice(0, 1000) };
      }

      const data = await res.body.json() as any;
      return { ok: true, status: res.statusCode, data, usage: data.usage, headers: res.headers };
    } catch (e: any) {
      return { ok: false, status: 0, error: e.message };
    }
  }
}
