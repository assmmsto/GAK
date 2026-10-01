// server/routes/anthropic.ts — تحويل صيغة Anthropic ↔ OpenAI.
// لماذا ملف مستقل: كل هذه الدوال نقية (لا تلمس router ولا db)، ووجودها هنا
// يجعل مسارات /v1/messages في index.ts أقصر وحدودها أوضح.

export function callerKeyOf(req: any): string | null {
  const auth = (req.headers.authorization || '') as string;
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const xk = req.headers['x-api-key'];
  return typeof xk === 'string' && xk ? xk : null;
}

export function anthropicToOpenAIMessages(body: any): any[] {
  const out: any[] = [];
  if (typeof body.system === 'string' && body.system.trim()) out.push({ role: 'system', content: body.system });
  else if (Array.isArray(body.system)) {
    const txt = body.system.map((b: any) => (typeof b === 'string' ? b : b?.text || '')).join('\n').trim();
    if (txt) out.push({ role: 'system', content: txt });
  }
  for (const m of (body.messages || [])) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }];
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];
    for (const b of blocks) {
      if (typeof b === 'string') { textParts.push(b); continue; }
      if (b?.type === 'text') textParts.push(b.text || '');
      else if (b?.type === 'tool_use') {
        // استدعاء أداة من المساعد → tool_calls بصيغة OpenAI
        toolCalls.push({
          id: b.id, type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
        });
      } else if (b?.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x: any) => (typeof x === 'string' ? x : x?.text || '')).join('\n')
            : JSON.stringify(b.content ?? '');
        toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id, content: c });
      }
    }
    // نتائج الأدوات تُرسل كرسائل tool مستقلة
    if (toolResults.length) { out.push(...toolResults); continue; }
    const msg: any = { role, content: textParts.join('\n') };
    if (toolCalls.length) {
      msg.tool_calls = toolCalls;
      if (!msg.content) msg.content = null;
    }
    out.push(msg);
  }
  return out;
}

// أدوات Anthropic → أدوات OpenAI
export function anthropicToolsToOpenAI(tools: any): any[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t: any) => ({
    type: 'function',
    function: {
      name: t?.name,
      description: t?.description || '',
      parameters: t?.input_schema || { type: 'object', properties: {} }
    }
  }));
}

export function anthropicToolChoiceToOpenAI(tc: any): any {
  if (!tc || typeof tc !== 'object') return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

// رد OpenAI → كتل محتوى بصيغة Anthropic
export function openAIMessageToAnthropicBlocks(msg: any): { blocks: any[]; stopReason: string } {
  const blocks: any[] = [];
  const text = msg?.content;
  if (typeof text === 'string' && text) blocks.push({ type: 'text', text });
  else if (Array.isArray(text)) {
    const joined = text.map((p: any) => p?.text || '').join('');
    if (joined) blocks.push({ type: 'text', text: joined });
  }
  const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  for (const tc of calls) {
    let input: any = {};
    try { input = JSON.parse(tc?.function?.arguments || '{}'); } catch { input = {}; }
    blocks.push({
      type: 'tool_use',
      id: tc?.id || ('toolu_' + Math.random().toString(36).slice(2, 14)),
      name: tc?.function?.name || 'tool',
      input
    });
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '' });
  return { blocks, stopReason: calls.length ? 'tool_use' : 'end_turn' };
}
