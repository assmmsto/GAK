// server/index.ts — Express server + WebSocket
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { loadConfig, maskKey } from './config.js';
import { EventDB } from './db.js';
import { noteStoreWriteFailure } from './db.js';
import { Router } from './router.js';
import { readProvidersYaml, writeProvidersYaml, testConnection, fetchModels, validateId } from './provider-manager.js';
import { probeModel, MAX_MODEL_NAME_LEN, resolveProbeVerdict, isKeyLayerAttempt, shouldTryNextKey, selectStaleProbeCandidates } from './probe.js';
import type { ProbeResult } from './probe.js';
import { securityHeaders, rateLimit, sanitizeErrorMessage, timingSafeEqualStrings, isProxiedRequest } from './security.js';
import { loadCatalog, catalogEntry, deriveEnvName, maskImportLine, parseImportText } from './services/catalog.js';
import { upsertEnvVar } from './services/env-store.js';
import { guardBaseUrl } from './services/url-guard.js';
import { SwrCache } from './services/models-cache.js';
import { AgentScheduler } from './agents/scheduler.js';
import { KeySyncEngine } from './agents/key-sync.js';
import { RotationAgent } from './agents/rotation.js';
import {
  callerKeyOf, anthropicToOpenAIMessages, anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI, openAIMessageToAnthropicBlocks
} from './routes/anthropic.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { request } from 'undici';
import { clientKeyHash } from './db.js';

const config = loadConfig();
const db = new EventDB();
const router = new Router(config, db);

// ===== الوكلاء: إشراف ذاتي التشغيل =====
// كل وكيل يستقبل اعتماداته صراحةً (لا حالة مشتركة خفية)، والمشرف وحده يملك التوقيت.
const AGENTS_ENABLED = process.env.AGENTS_ENABLED !== '0';
const numOr = (v: string | undefined, fallback: number) => (Number(v) > 0 ? Number(v) : fallback);
// +100ms لكل دورة: يمنع اصطدام دورتين على الدقيقة نفسها (بطء ترتيب عشوائي)
const SYNC_INTERVAL_MS = numOr(process.env.AGENT_SYNC_INTERVAL_MS, 5 * 60_000);
const ROTATION_INTERVAL_MS = numOr(process.env.AGENT_ROTATION_INTERVAL_MS, 60_100);
const HEALTH_INTERVAL_MS = numOr(process.env.AGENT_HEALTH_INTERVAL_MS, 60_100);
const DRIFT_INTERVAL_MS = numOr(process.env.AGENT_DRIFT_INTERVAL_MS, 60_100);
const scheduler = new AgentScheduler(numOr(process.env.AGENT_TICK_MS, 15_000));
const keySync = new KeySyncEngine(db, router, (e) => broadcast(e));
const rotation = new RotationAgent(db, router, (e) => broadcast(e));
const startTime = Date.now();

// ===== إعدادات الشبكة والأمان =====
// افتراضياً نسمع على localhost فقط. للفتح على الشبكة صراحةً: HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
// حماية اختيارية لمسارات الإدارة — مطفأة ما لم يُضبط ADMIN_TOKEN.
// لكنها **إلزامية** عند الفتح على الشبكة: تُفرض في الفحص أدناه.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// هل العنوان غير محلي؟ (كل ما ليس loopback يُعتبر مكشوفاً للشبكة)
const IS_NETWORK_EXPOSED = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
if (IS_NETWORK_EXPOSED && !ADMIN_TOKEN) {
  console.error('');
  console.error('✖ رُفض الإقلاع: HOST غير محلي و ADMIN_TOKEN غير مضبوط.');
  console.error('');
  console.error(`  HOST=${HOST} يجعل الخادم مرئياً لكل جهاز على الشبكة.`);
  console.error('  ومسارات /api تسمح بقراءة المفاتيح وحذف المزودات.');
  console.error('');
  console.error('  شغّل هكذا:');
  console.error(`    HOST=${HOST} ADMIN_TOKEN=سرّ_قوي npm start`);
  console.error('');
  process.exit(1);
}
// نشر خلف بروكسي على 127.0.0.1 لا يُكشف بفحص HOST — تحذير إقلاع صريح
// حتى لا يكون الافتراض الافتراضي الوحيد صمتاً. المسار يُغلق فعلياً عند أول طلب.
if (!ADMIN_TOKEN && !IS_NETWORK_EXPOSED) {
  console.warn('⚠ ADMIN_TOKEN غير مضبوط. التشغيل المحلي المباشر آمن، لكن إن كنت');
  console.warn('  تنشر الخادم خلف بروكسي (nginx/caddy) فستُغلق /api تلقائياً عند أول طلب عبره.');
  console.warn('  للنشر العام: ADMIN_TOKEN=… ثم افتح اللوحة مرة بـ ?token=…');
}
// أصول CORS المسموحة (مفصولة بفواصل) — الافتراضي: تطوير محلي فقط
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3001,http://127.0.0.1:3001')
  .split(',').map(s => s.trim()).filter(Boolean);
// حدود المعدل: قابلة للضبط بلا تعديل كود — لأن «الحد المناسب» يختلف بين
// مستخدم يشغّل وكيل برمجة (مهلة عالية) وآخر يجرب نموذجاً يدوياً.
const RATE_V1_PER_MIN = Number(process.env.RATE_LIMIT_V1_PER_MIN) > 0 ? Number(process.env.RATE_LIMIT_V1_PER_MIN) : 300;
const RATE_PROBE_PER_MIN = Number(process.env.RATE_LIMIT_PROBE_PER_MIN) > 0 ? Number(process.env.RATE_LIMIT_PROBE_PER_MIN) : 60;


const app = express();
// الوثوق بوكسي واحد أمام الخادم (nginx/caddy) — بدونه يكون req.ip هو عنوان
// البروكسي لكل العملاء فيتشاركون دلوّ حدّ المعدل الواحد: مهاجم واحد يُغرق
// الجميع بـ429. مضبوط بTRUST_PROXY صراحةً حتى لا يكون افتراضاً صامتاً.
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY && TRUST_PROXY !== '0') {
  // "1" = وثوق بقفزة واحدة؛ أو قائمة قفزات/عناوين بصيغة express
  app.set('trust proxy', TRUST_PROXY === '1' ? 1 : TRUST_PROXY);
}
app.use(cors({
  origin(origin, cb) {
    // بلا origin = نفس الأصل أو أداة سطر أوامر → نسمح
    if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  }
}));
app.use(express.json({ limit: '2mb' }));

// ===== ترويسات أمنية على كل رد =====
// كانت في security.ts لكنها غير موصولة إطلاقاً (كود ميت) — الفرق بين ملف
// أمان موجود وملف أمان يعمل.
app.use(securityHeaders);

// ===== حدّ المعدل =====
// /v1: كل طلب يستهلك حصة مزود حقيقية — نسمح بسخاء لأن الوكلاء يرسلون تباعاً سريعاً.
// /api/probe: كل طلب يُطلق عشرات المحادثات على المزود (حتى 25 ثانية لكل نموذج)
//   → الشدّ هنا يحمي الحصة والشبكة من ضغطة زر مزدوجة أو حلقة واجهة.
app.use('/v1', rateLimit({ windowMs: 60_000, max: RATE_V1_PER_MIN, message: 'تجاوزت حد الطلبات على /v1 — أعد المحاولة بعد قليل.' }));
app.use('/api/probe', rateLimit({ windowMs: 60_000, max: RATE_PROBE_PER_MIN, message: 'تجاوزت حد طلبات الفحص — انتظر دقيقة قبل فحص آخر.' }));

// ===== حماية مسارات الإدارة =====
// التوكن يُحفظ لدى المتصفح **HttpOnly cookie** (غير مقروء من JS — تحصين ضد
// سرقة التوكن عبر XSS)، ويُضبط بمرة واحدة عبر POST /api/auth. الترويسة
// X-Admin-Token تبقى مقبولة للأدوات وسطر الأوامر.
const ADMIN_COOKIE = 'gw_admin';

/** أصغر قارئ كوكيز — بلا اعتماد جديد لشيء يُقرأ بسطرين. */
function cookieValue(req: any, name: string): string {
  const raw = req.headers?.cookie;
  if (typeof raw !== 'string') return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** يضبط/يحذف كوكي الإدارة بأعلام آمنة (secure تلقائياً خلف https). */
function setAdminCookie(req: any, res: any, token: string | null) {
  const proto = (req.headers['x-forwarded-proto'] as string) || (req.secure ? 'https' : 'http');
  const flags = [
    `${ADMIN_COOKIE}=${token ? encodeURIComponent(token) : ''}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + (token ? 60 * 60 * 24 * 30 : 0)
  ];
  if (proto === 'https') flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

/** فشل-مغلق خلف بروكسي: الربط على 127.0.0.1 خلف nginx/caddy يجعل فحص HOST
 *  أعلاه يمرّ بلا إنذار بينما /api مكشوفة على الإنترنت — وتحديداً GET /api/keys
 *  كان يعيد مفاتيح البوابة كاملة. ترويسات البروكسي في الطلب هي الدليل؛ إن ظهرت
 *  وADMIN_TOKEN فارغ أُغلق /api (503) ما لم يصرّح المُشغِّل بخلافه صراحةً
 *  (ALLOW_UNAUTHENTICATED_API=1 لنشرٍ يحميه بروكسي بطبقة مصادقة خاصة به). */
const ALLOW_OPEN_API = process.env.ALLOW_UNAUTHENTICATED_API === '1';
app.use('/api', (req, res, next) => {
  if (ADMIN_TOKEN || ALLOW_OPEN_API) return next();
  if (!isProxiedRequest(req)) return next(); // تطوير محلي مباشر — الوضع القديم
  res.status(503).json({
    error: 'admin token required in production',
    hint: 'أنت تصل الخادم عبر بروكسي. اضبط ADMIN_TOKEN وافتح اللوحة بـ ?token=… أو اسمح صراحةً بـ ALLOW_UNAUTHENTICATED_API=1'
  });
});

// تبادل التوكن بكوكي HttpOnly — لا تُخزَّن قيمة سرية في JS إطلاقاً
app.post('/api/auth', (req, res) => {
  const token = (req.body?.token ?? req.headers['x-admin-token'] ?? '') as string;
  if (!ADMIN_TOKEN) return res.json({ ok: true, mode: 'no-token-required' });
  if (!token || !timingSafeEqualStrings(String(token), ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'invalid admin token' });
  }
  setAdminCookie(req, res, String(token));
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => {
  setAdminCookie(req, res, null);
  res.json({ ok: true });
});

if (ADMIN_TOKEN) {
  app.use('/api', (req, res, next) => {
    const token = cookieValue(req, ADMIN_COOKIE)
      || (req.headers['x-admin-token'] as string)
      || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    // مقارنة ثوابت زمنية — `===` يتوقف عند أول حرف مختلف فيقيس المهاجم البادئة
    if (token && timingSafeEqualStrings(token, ADMIN_TOKEN)) return next();
    res.status(401).json({ error: 'admin token required', hint: 'open the dashboard once with ?token=…' });
  });
}

// ===== أدوات مساعدة =====

// نعيد بناء مزود في الموجّه بعد تغيير بياناته (المفتاح يُقرأ من process.env الجديد)
function reloadProvider(entry: any) {
  router.removeProvider(entry.id);
  router.addProvider(entry);
}

// WebSocket for real-time updates
// /ws يبثّ حالة النظام (صحة، مزودات، فحوص) — بلا مصادقة كان أي زائر نشرٍ عام
// يربط ويقرأ البث بلا سقف على عدد الاتصالات (DoS رخيص). الآن: سقف عملاء،
// وإن ضُبط ADMIN_TOKEN فالترقية تتطلب التوكن (?token= أو ترويسة).
const WS_MAX_CLIENTS = Math.max(1, Number(process.env.WS_MAX_CLIENTS) || 50);
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const clients = new Set<any>();
wss.on('connection', (ws, req) => {
  // فحص Origin: WebSocket لا يخضع لـCORS، فأي صفحة يزورها المستخدم كانت
  // تستطيع الاتصال وقراءة بثّ الحالة (أسماء مزودات/نماذج/أخطاء — لا مفاتيح).
  // نقبل: بلا Origin (أدوات سطر أوامر) أو أصل مسموح في CORS_ORIGINS.
  const origin = req.headers.origin as string | undefined;
  if (origin && !CORS_ORIGINS.includes(origin)) {
    ws.close(4403, 'origin not allowed');
    return;
  }
  if (ADMIN_TOKEN) {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token')
      || cookieValue(req, ADMIN_COOKIE)
      || (req.headers['x-admin-token'] as string || '')
      || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token || !timingSafeEqualStrings(token, ADMIN_TOKEN)) {
      ws.close(4401, 'admin token required');
      return;
    }
  }
  if (clients.size >= WS_MAX_CLIENTS) {
    ws.close(1013, 'too many dashboard connections');
    return;
  }
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});
function broadcast(event: any) {
  const msg = JSON.stringify(event);
  for (const c of clients) {
    try { c.send(msg); } catch {}
  }
}

// ----- Unified API key (the one key for all providers) -----
const BEARER_PREFIX = 'Bearer ';
// null = غير معروف بعد (نجبر الطلبات إنها تستنى حتى يخلص الـ bootstrap)
let keysExistCache: boolean | null = null;
let keysCacheTs = 0;
let bootstrapDone: Promise<void>;

app.use('/v1', async (req, res, next) => {
  // استنى حتى يعرف النظام إذا في مفاتيح ولا لا
  try { await bootstrapDone; } catch {}
  const now = Date.now();
  if (keysCacheTs === 0 || now - keysCacheTs > 5000) {
    const keys = await db.listApiKeys();
    keysExistCache = keys.length > 0;
    keysCacheTs = now;
  }
  // **fail-closed**: غياب المفاتيح لا يعني «افتح». كان هنا باب مفتوح — حذف
  // كل مفاتيح البوابة كان يجعل /v1 متاحاً للجميع بلا مصادقة حتى إعادة التشغيل.
  // القفل يجب أن يقفل لا أن يفتح. 503 لا 401: الخطأ في إعداد الخادم لا العميل.
  if (keysExistCache === false) {
    return res.status(503).json({
      error: {
        message: 'No API key is configured on this gateway — generate one from the dashboard (Keys tab).',
        type: 'gateway_misconfigured'
      }
    });
  }
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith(BEARER_PREFIX) ? auth.slice(BEARER_PREFIX.length).trim() : '';
  // بعض العملاء (Anthropic SDK / Claude Code) يرسلون x-api-key بدل Authorization
  const xKey = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string).trim() : '';
  const raw = bearer || xKey;
  const ok = await db.checkApiKey(raw);
  if (!ok) {
    return res.status(401).json({ error: { message: 'Invalid API key. Generate one in the dashboard.', type: 'invalid_api_key' } });
  }
  // عداد الاستخدام + آخر استخدام يتحدثوا تلقائياً في checkApiKey
  next();
});

// ----- OpenAI-compatible API -----
app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body;
  if (!body.messages || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: { message: 'messages required' } });
  }
  // تحقق مبكر من صحة المدخلات: بلا هذا كان خطأ **عميل** (رسائل فارغة أو
  // max_tokens نصي) يُرسل للمزوّد ويعود 504 «All providers failed» المضللة —
  // فيعيد الوكيل البرمجي المحاولة على طلب لن ينجح أصلاً.
  if (body.messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages must not be empty', type: 'invalid_request_error' } });
  }
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 0)) {
    return res.status(400).json({ error: { message: 'max_tokens must be a non-negative integer', type: 'invalid_request_error' } });
  }
  if (body.temperature !== undefined && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature))) {
    return res.status(400).json({ error: { message: 'temperature must be a number', type: 'invalid_request_error' } });
  }
  // نسجل مفتاح المستخدم الجامع على الطلب ليظهر بالإحصائيات — بصمته لا نصه
  // (السجلات لا تحتفظ بمفتاح عميل خام إطلاقاً).
  const authHdr = (req.headers.authorization || '') as string;
  const rawCaller = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : null;
  const callerKey = rawCaller ? clientKeyHash(rawCaller) : null;
  const result = await router.chat(body, callerKey);
  if (!result.ok) {
    return res.status(result.status).json({ error: { message: result.error, attempts: result.attempts } });
  }
  if (body.stream && result.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Provider', result.providerId!);
    res.setHeader('X-Key-Id', result.keyId!);
    // أول chunk يحمل إشعار الاستبدال لو صار fallback
    if (result._substituted) {
      res.write(`data: ${JSON.stringify({ _substituted: result._substituted })}\n\n`);
    }
    // نتوقف عن السحب فوراً إذا أغلق العميل الاتصال (وإلا استمرّ استهلاك الرموز بلا فائدة)
    let aborted = false;
    const onClose = () => { aborted = true; };
    res.on('close', onClose);
    try {
      for await (const chunk of result.stream) {
        if (aborted) break;
        res.write(chunk);
      }
    } catch (e: any) {
      // البث قد ينقطع من المزوّد بعد إرسال الترويسات — لا نترك العميل معلّقاً
      console.error('[stream] interrupted:', e?.message || e);
    } finally {
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
    return;
  }
  res.setHeader('X-Provider', result.providerId!);
  res.setHeader('X-Key-Id', result.keyId!);
  if (result._substituted) res.setHeader('X-Model-Substituted', result._substituted.requested + ' -> ' + result._substituted.actual + ' (' + result._substituted.providerId + ')');
  res.json(result.data);
});

// ===== /v1/messages — صيغة Anthropic (لتكامل Claude Code وأدواته) =====
// نحوّل الطلب إلى صيغة OpenAI، نمرّره على نفس الموجّه، ثم نُعيد الصيغة الأصلية.
// دوال التحويل نفسها في routes/anthropic.ts (نقية بلا حالة).
app.post('/v1/messages', async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages required' } });
  }
  const messages = anthropicToOpenAIMessages(body);
  const model = !body.model || body.model === 'auto' ? 'auto' : body.model;
  const wantStream = !!body.stream;
  const rawCallerKey = callerKeyOf(req);
  const callerKey = rawCallerKey ? clientKeyHash(rawCallerKey) : null;

  const result = await router.chat({
    model, messages, stream: wantStream,
    temperature: body.temperature, max_tokens: body.max_tokens,
    top_p: body.top_p, stop: body.stop_sequences,
    tools: anthropicToolsToOpenAI(body.tools),
    tool_choice: anthropicToolChoiceToOpenAI(body.tool_choice)
  }, callerKey);

  if (!result.ok) {
    // رمز صادق: نموذج غير موجود = 404 دائم (كما OpenAI/Anthropic) لا 502 —
    // عميل يعتمد على 404 لبديله كان لا يراه أبداً (خلل مثبت باختبار حي).
    const st = result.status === 404 ? 404 : 502;
    return res.status(st).json({ type: 'error', error: { type: 'api_error', message: result.error, attempts: result.attempts } });
  }

  const msgId = 'msg_' + Math.random().toString(36).slice(2, 14);

  // غير بثّي → رد واحد (مع دعم استدعاء الأدوات)
  if (!wantStream || !result.stream) {
    const msg = result.data?.choices?.[0]?.message || {};
    const { blocks, stopReason } = openAIMessageToAnthropicBlocks(msg);
    // ترويسات التوجيه نفسها التي يضبطها فرع البث — كانت غائبة هنا فيختفي
    // مصدر الردّ عن المشغّلين (خلل اتساق مثبت).
    if (result.providerId) res.setHeader('X-Provider', result.providerId);
    if (result.keyId) res.setHeader('X-Key-Id', result.keyId);
    return res.json({
      id: msgId, type: 'message', role: 'assistant', model: result.model || model,
      content: blocks,
      stop_reason: stopReason, stop_sequence: null,
      usage: {
        input_tokens: result.data?.usage?.prompt_tokens ?? 0,
        output_tokens: result.data?.usage?.completion_tokens ?? 0
      }
    });
  }

  // بثّي → تحويل حزم OpenAI إلى أحداث Anthropic
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (result.providerId) res.setHeader('X-Provider', result.providerId);
  const send = (event: string, data: any) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model: result.model || model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

  let outTokens = 0;
  let inTokens = 0;
  let buf = '';
  let stopReason = 'end_turn';
  // نُجمّع استدعاءات الأدوات ونُرسلها ككتل tool_use عند نهاية البث
  const toolAcc: Record<number, { id?: string; name?: string; args: string }> = {};
  try {
    for await (const chunk of result.stream) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      buf += text;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta;
          if (typeof delta?.content === 'string' && delta.content) {
            send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = Number(tc?.index ?? 0);
              toolAcc[i] = toolAcc[i] || { args: '' };
              if (tc?.id) toolAcc[i].id = tc.id;
              if (tc?.function?.name) toolAcc[i].name = tc.function.name;
              if (tc?.function?.arguments) toolAcc[i].args += tc.function.arguments;
            }
          }
          if (j.usage?.completion_tokens) outTokens = j.usage.completion_tokens;
          // كانت input_tokens تبقى 0 دائماً في البث — والمعلومة موجودة في حزمة
          // usage النهائية؛ Claude Code يقرؤها للمحاسبة (خلل مثبت باختبار حي).
          if (j.usage?.prompt_tokens) inTokens = j.usage.prompt_tokens;
          if (j.choices?.[0]?.finish_reason === 'length') stopReason = 'max_tokens';
        } catch { /* سطر غير مكتمل */ }
      }
    }
  } catch { /* انقطع البث */ }

  send('content_block_stop', { type: 'content_block_stop', index: 0 });

  const toolKeys = Object.keys(toolAcc);
  let blockIdx = 1;
  for (const k of toolKeys) {
    const t = toolAcc[Number(k)];
    let input: any = {};
    try { input = JSON.parse(t.args || '{}'); } catch { input = {}; }
    send('content_block_start', {
      type: 'content_block_start', index: blockIdx,
      content_block: {
        type: 'tool_use',
        id: t.id || ('toolu_' + Math.random().toString(36).slice(2, 14)),
        name: t.name || 'tool',
        input
      }
    });
    send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
    blockIdx++;
  }

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: toolKeys.length ? 'tool_use' : stopReason, stop_sequence: null },
    usage: { input_tokens: inTokens, output_tokens: outTokens }
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
});

// ===== /v1/embeddings — تمرير مباشر لأول مزود يدعمه =====
app.post('/v1/embeddings', async (req, res) => {
  const body = req.body || {};
  if (!body.model || body.input === undefined) {
    return res.status(400).json({ error: { message: 'model and input required' } });
  }
  const rawEmbKey = callerKeyOf(req) || 'k1';
  const callerKey = rawEmbKey === 'k1' ? 'k1' : clientKeyHash(rawEmbKey);
  const errors: any[] = [];
  for (const pid of router.reachableProviderIds()) {
    const entry = router.getProvider(pid);
    if (!entry) continue;
    for (const slot of router.availableKeySlots(entry)) {
      const out = await slot.client.embeddings({ model: body.model, input: body.input });
      if (out.ok) {
        if (out.data?.usage) await db.logUsage(pid, callerKey, body.model, out.data.usage);
        await db.logEvent('embeddings.success', { provider: pid, keyId: callerKey, model: body.model, status: 'success' });
        res.setHeader('X-Provider', pid);
        return res.json(out.data);
      }
      errors.push({ providerId: pid, status: out.status, error: out.error?.slice(0, 150) });
      if (out.status === 429) {
        slot.status = 'quota_exhausted';
        slot.blockedUntil = Date.now() + 300_000;
        if (slot.id) db.updateProviderKey(slot.id, { status: 'quota_exhausted', blockMs: 300_000 }).catch((e) => noteStoreWriteFailure('updateProviderKey:embeddings-429', e));
        continue; // جرّب مفتاحاً آخر لنفس المزود
      }
      if (out.status === 401 || out.status === 403) {
        slot.status = 'auth_error';
        if (slot.id) db.updateProviderKey(slot.id, { status: 'auth_error' }).catch((e) => noteStoreWriteFailure('updateProviderKey:embeddings-401', e));
        continue; // مفتاح خاطئ → جرّب مفتاحاً آخر
      }
      break; // خطأ على مستوى المزود → انتقل للتالي
    }
  }
  await db.logEvent('embeddings.failed', { status: 'error', model: body.model, error: JSON.stringify(errors).slice(0, 300) });
  res.status(502).json({
    error: { message: 'No provider served this embedding model', attempts: errors.slice(0, 5) }
  });
});

// نماذج المزودات المتاحة — تُجلب بالتوازي ونتخطى المعطّلة والتي بلا مفتاح.
// قبل الإصلاح كان الطلب يمرّ على كل المزودات تباعاً (حتى الميتة) فيستغرق 12-15 ثانية.
async function collectModels() {
  const ids = router.reachableProviderIds();
  return Promise.all(ids.map(async (id) => {
    const entry = router.getProvider(id);
    if (!entry) return { id, entry: undefined, models: [] as Array<{ id: string }> };
    // نجرّب كل مفتاح للمزود — مفتاح ميت لا يجب أن يُخفي نماذجه
    const models = await router.listProviderModels(id).catch(() => [] as Array<{ id: string }>);
    return { id, entry, models };
  }));
}

// ===== ذاكرة stale-while-revalidate لقوائم النماذج (S3+SWR) =====
// المشكلة المقاسة: `/v1/models` = 3037ms و`/api/drift` = 2006ms لأن كل طلب
// كان يضرب 15 مزوّداً على /models — وأول طلب بعد كل TTL كان ينتظر ~3 ثوانٍ.
// الحل: SWR — بعد انتهاء TTL نُعيد النسخة القديمة **فوراً** ونُحدّث في
// الخلفية برحلة واحدة مهما تعدّد الطالبون. الفشل الخلفي لا يكسر الطلب.
// (تُبنى الذاكرة هنا حصراً: `collectModels` دالة معلنة أعلاه — أي بناء قبلها
//  كان يستخدمها قبل تعريفها، فتُبنى خاملة وتُضرب الشبكة في كل طلب.)
const MODELS_CACHE_TTL_MS = Number(process.env.MODELS_CACHE_TTL_MS) > 0
  ? Number(process.env.MODELS_CACHE_TTL_MS)
  : 60_000;
const modelsCache = new SwrCache(collectModels, MODELS_CACHE_TTL_MS);

/** يُبطل الذاكرة عند أي تغيير في المزوّدات أو المفاتيح (مصدر الحقيقة يتغيّر). */
function invalidateModelsCache(): void { modelsCache.invalidate(); }

async function collectModelsCached(): Promise<{ data: Awaited<ReturnType<typeof collectModels>>; cached: boolean; stale: boolean }> {
  const { data, cached, stale } = await modelsCache.get();
  return { data, cached, stale };
}

async function countAvailableModels(): Promise<number> {
  const { data: lists } = await collectModelsCached();
  return lists.reduce((sum, { id, models }) => {
    const rejected = router.rejectedModels(id);
    return sum + models.filter((m: any) => !rejected.has(m.id)).length;
  }, 0);
}

app.get('/v1/models', async (_req, res) => {
  const all: any[] = [];
  const hidden: { provider: string; model: string; reason: string }[] = [];
  // نُعلن auto كنموذج صريح حتى يظهر في قوائم اختيار النماذج في كل أداة متوافقة
  all.push({
    id: 'auto', object: 'model', created: Math.floor(Date.now() / 1000),
    owned_by: 'gateway', _provider: 'gateway', _tier: 0, _upstream_id: 'auto',
    _note: 'router picks the best available model'
  });
  const { data: modelLists, cached, stale } = await collectModelsCached();
  for (const { id, entry, models } of modelLists) {
    // نطّلع النماذج المرفوضة (من الفحص) عشان ما نعرضها
    const rejected = router.rejectedModels(id);
    for (const m of models) {
      if (rejected.has(m.id)) {
        hidden.push({ provider: id, model: m.id, reason: 'rejected by probe' });
        continue;
      }
      all.push({
        id: `${id}/${m.id}`, object: 'model',
        created: Math.floor(Date.now() / 1000), owned_by: id,
        _provider: id, _tier: entry?.provider.tier, _upstream_id: m.id
      });
    }
  }
  res.json({
    object: 'list', data: all,
    _meta: {
      total: all.length, hidden: hidden.length, hiddenList: hidden.slice(0, 50),
      cache: cached ? (stale ? 'stale' : 'hit') : 'miss', cacheTtlMs: MODELS_CACHE_TTL_MS
    }
  });
});

// ----- Unified API key management (CRUD) -----
// القائمة تعيد بصمة كل مفتاح (key_hint) — النص الكامل لا يخرج من القاعدة
// (تُخزَّن hash). المفتاح الكامل يُعرض مرة واحدة عند الإنشاء/إعادة التوليد فقط.
app.get('/api/keys', async (req, res) => {
  res.json({ keys: await db.listApiKeys(), baseUrl: getPublicBaseUrl(req) });
});

// إحصائيات مفتاح محدد (الرموز + النماذج + رسم الحياة)
app.get('/api/keys/:id/stats', async (req, res) => {
  try {
    await db.ready; // ننتظر انتهاء الهجرة قبل أي استعلام مباشر
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    // إجمالي الرموز لكل نموذج
    const byModel = await db.client.execute({
      sql: `SELECT model, COUNT(*) as requests, COALESCE(SUM(total_tokens),0) as tokens,
                   COALESCE(SUM(prompt_tokens),0) as prompt, COALESCE(SUM(completion_tokens),0) as completion
            FROM usage WHERE key_id = (SELECT key FROM api_keys WHERE id = ?)
            GROUP BY model ORDER BY tokens DESC LIMIT 12`,
      args: [id]
    });
    // متوسط زمن الاستجابة لكل نموذج (من events)
    // ملاحظة: الموجّه يسجّل النوع 'chat.success' وليس 'chat' — الخطأ السابق جعل المتوسط دائماً 0
    const byLatency = await db.client.execute({
      sql: `SELECT model, COALESCE(ROUND(AVG(latency_ms),0),0) as avg_ms, COUNT(*) as n
            FROM events WHERE type = 'chat.success'
            AND key_id = (SELECT key FROM api_keys WHERE id = ?)
            GROUP BY model`,
      args: [id]
    });
    // سلسلة زمنية: آخر 48 نقطة (كانت تُرجع الأقدم) ثم نُرتّبها تصاعدياً للعرض
    const series = await db.client.execute({
      sql: `SELECT * FROM (
              SELECT (ts/3600000)*3600000 as bucket, COUNT(*) as n,
                     COALESCE(SUM(total_tokens),0) as tokens
              FROM usage WHERE key_id = (SELECT key FROM api_keys WHERE id = ?)
              GROUP BY bucket ORDER BY bucket DESC LIMIT 48
            ) ORDER BY bucket ASC`,
      args: [id]
    });
    res.json({
      models: (byModel.rows as any[]).map(r => ({
        model: r.model, requests: Number(r.requests), tokens: Number(r.tokens),
        prompt: Number(r.prompt), completion: Number(r.completion),
        avgMs: Number((byLatency.rows as any[]).find(l => l.model === r.model)?.avg_ms ?? 0)
      })),
      series: (series.rows as any[]).map(r => ({ ts: Number(r.bucket), n: Number(r.n), tokens: Number(r.tokens) }))
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/keys', async (req, res) => {
  const { name } = req.body || {};
  // تحقق نوعي صارم: اسم كائن/رقم كان يمرّ إلى SQLite فيرمي رفضاً غير ملتقط
  // وتعلّق الطلب (وقبل شبكة الأمان: يُسقط العملية — نفس صنف عطل /api/logs).
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }
  const k = await db.createApiKey(name.trim());
  keysExistCache = true; keysCacheTs = Date.now();
  await db.logEvent('key.created', { status: 'success', meta: { name: k.name } });
  res.json(k);
});

app.delete('/api/keys/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  await db.deleteApiKey(id);
  const keys = await db.listApiKeys();
  keysExistCache = keys.length > 0; keysCacheTs = Date.now();
  await db.logEvent('key.deleted', { status: 'success', meta: { id } });
  res.json({ ok: true });
});

// إعادة توليد المفتاح (نفس الاسم + قيمة جديدة)
app.post('/api/keys/:id/regenerate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const keys = await db.listApiKeys();
    const old = keys.find(k => k.id === id);
    if (!old) return res.status(404).json({ error: 'key not found' });
    await db.deleteApiKey(id);
    const fresh = await db.createApiKey(old.name as string);
    keysExistCache = true; keysCacheTs = Date.now();
    await db.logEvent('key.regenerated', { status: 'success', meta: { id, name: old.name } });
    res.json(fresh);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// يولّد مفتاح تلقائي أول ما يدخل المستخدم (auto bootstrap)
async function ensureBootstrapKey() {
  await db.ready; // تأكد إنو الجداول اتنشأت قبل ما نسأل عن المفاتيح
  const keys = await db.listApiKeys();
  if (keys.length === 0) {
    const k = await db.createApiKey('default');
    // مرة واحدة فقط: المفتاح يُخزَّن hash في القاعدة فلا يُعرض لاحقاً — هذه
    // اللحظة هي الوحيدة لمحارفه الكاملة (نفس سلوك مزودات API الحقيقية).
    console.log(`🔑 Unified API key generated (احفظه الآن — لن يُعرض مجدداً): ${k.key}`);
  }
  keysExistCache = true;
  keysCacheTs = Date.now();
}
bootstrapDone = ensureBootstrapKey().catch((e: any) => console.error('bootstrap key failed:', e.message));
// نحمّل النماذج المرفوضة من الفحوصات السابقة (لا تتجرّب من جديد بعد كل restart)
router.loadProbeRejections().catch((e: any) => console.error('load probe rejections failed:', e.message));
// نحمّل مفاتيح المزودات من قاعدة البيانات (مع هجرة مفتاح البيئة) وإعدادات توفير الرموز
router.loadSettings().catch((e: any) => console.error('load settings failed:', e.message));

// ===== التفعيل التلقائي للمزودات =====
// ينتظر انتهاء تحميل المفاتيح (وإلا فُحصت المزودات قبل أن تُبنى مفاتيحها فبقيت مطفأة).
// القاعدة: مزود بمفتاح صالح + نماذج + غير معطوب → يُفعَّل تلقائياً.
// كان 18 من 20 مزوداً مطفأين يدوياً في providers.yaml، فبدت المنصّة «بلا مزود صالح»
// رغم وجود مفاتيح تعمل فعلاً — وهذا أصل عطل "لا شيء يعمل".
const keysLoaded = router.loadProviderKeys().catch((e: any) => {
  console.error('load provider keys failed:', e.message);
});
keysLoaded.then(() => {
  const { enabled, skipped } = router.reconcileAutoEnable();
  if (enabled.length) {
    // نُثبّت القرار في providers.yaml وإلا عاد الإطفاء بعد كل restart
    try {
      const yaml = readProvidersYaml();
      let changed = false;
      for (const pid of enabled) {
        const i = yaml.providers.findIndex((p: any) => p.id === pid);
        if (i !== -1 && yaml.providers[i].enabled !== true) {
          yaml.providers[i] = { ...yaml.providers[i], enabled: true };
          changed = true;
        }
      }
      if (changed) writeProvidersYaml(yaml);
    } catch (e: any) {
      console.warn('⚠ لم يُكتب providers.yaml:', e?.message || e);
    }
    console.log(`⚡ فُعِّل تلقائياً ${enabled.length} مزوداً بمفتاح صالح: ${enabled.join(', ')}`);
    broadcast({ type: 'providers-auto-enabled', providers: enabled });
  }
  const noKey = skipped.filter(s => s.reason === 'بلا مفتاح صالح').length;
  if (noKey) console.log(`   (${noKey} مزوداً بلا مفتاح صالح — أضف مفتاحاً ليُفعَّل تلقائياً)`);
}).catch((e: any) => console.error('auto-enable failed:', e?.message || e));

// ===== الفحص التلقائي للنماذج التي ممكن تكون عادت =====
// أربع فئات تُعاد دورياً:
//   rate_limited / slow → مؤقتة بطبيعتها، قد تتجدد الحصة أو يرجع السيرفر
//   rejected / provider_auth → بعد 6 ساعات (PROBE_REJECTED_STALE_MS) — قد يكون
//                              المزود أضاف النموذج أو أصلح المفتاح
//   ok → بعد 24 ساعة (OK_STALE_MS) — نجاح قديم ليس ضماناً: نموذج "يعمل" منذ
//        36 يوماً في القاعدة ردّ "not offered" عند أول محادثة حقيقية. كل حكم
//        له صلاحية، والجدولة والسقف في selectStaleProbeCandidates (probe.ts).
// إصلاح لاحق: نستخدم probeWithKeys لا probeModel، فمزود بمفاتيح متعددة
// كان يُفحص بمفتاحه الأساسي وحده وقد يحكم عليه خطأً.
const AUTO_PROBE_INTERVAL_MS = 60 * 60 * 1000; // ساعة
scheduler.register({
  name: 'auto-probe',
  intervalMs: AUTO_PROBE_INTERVAL_MS,
  run: async () => {
  try {
    const all = await db.getProbes();
    const now = Date.now();
    const candidate = selectStaleProbeCandidates(all as any[], now);
    if (!candidate.length) return { ok: true, detail: { candidates: 0 } };
    console.log(`[auto-probe] يعيد فحص ${candidate.length} نموذج (مؤقتة أو منتهية الصلاحية أو ok قديم)`);
    let recovered = 0;
    for (const r of candidate) {
      const entry = router.getProvider(r.provider);
      if (!entry || entry.enabled === false) continue;
      if (!entry.provider.apiKey && !entry.provider.keyless) continue;
      const out = await probeWithKeys(r.provider, r.model);
      await db.upsertProbe(out.provider, out.model, out.status, out.latencyMs, out.error);
      router.noteProbe(out.provider, out.model, out.status);
      if (out.status === 'ok') recovered++;
    }
    if (recovered > 0) {
      await db.logEvent('auto.probe', { status: 'success', latencyMs: Date.now(), meta: { recovered, total: candidate.length } });
      console.log(`[auto-probe] انتعش ${recovered} من ${candidate.length}`);
    }
  } catch (e: any) {
    console.error('[auto-probe] failed:', e.message);
    // نعيد الفشل للمشرف (تسجيل + لوحة حالة) بدل ابتلاعه هنا
    return { ok: false, error: e?.message || 'auto-probe failed' };
  }
  return { ok: true };
  }
});

// ===== عنوان البوابة العام كما يراه العميل =====
// كان يُبنى دائماً http://localhost:PORT — خطأ في أي نشر بعيد: اللوحة تعرض
// للمستخدم رابطاً لا يعمل. نبني من ترويسات الطلب (مع مراعاة البروكسي) بدل
// تخمين أعمى، ونسقط للافتراضي فقط حين لا تصلنا ترويسات.
function getPublicBaseUrl(req?: any): string {
  const port = process.env.PORT || 3001;
  const host = (req?.headers?.['x-forwarded-host'] as string) || (req?.headers?.host as string) || '';
  if (host) {
    const proto = (req?.headers?.['x-forwarded-proto'] as string)?.split(',')[0]?.trim()
      || (req?.secure ? 'https' : (process.env.PUBLIC_PROTO || 'http'));
    return `${proto}://${host}`;
  }
  const h = HOST === '127.0.0.1' ? 'localhost' : HOST;
  return `http://${h}:${port}`;
}

// ----- Admin API -----
// ===== متتبع التغييرات (drift detection) =====
// يحفظ snapshot لكل فحص — الواجهة تطلب "ما الذي تغيّر؟" وتمرر sinceTs
let lastSnapshot: { ts: number; models: number; upProviders: number; authErrors: string[] } = {
  ts: 0, models: 0, upProviders: 0, authErrors: []
};
async function captureDriftSnapshot() {
  try {
    const snap = router.snapshot();
    const up = snap.filter(p => p.status === 'up').length;
    const authErrors = snap.filter(p => p.status === 'auth_error').map(p => p.id);
    lastSnapshot = { ts: Date.now(), models: await countAvailableModels(), upProviders: up, authErrors };
  } catch {}
}
scheduler.register({
  name: 'drift',
  intervalMs: DRIFT_INTERVAL_MS,
  run: async () => { await captureDriftSnapshot(); return { ok: true }; }
});

app.get('/api/status', async (_req, res) => {
  const since = Date.now() - 86400000;
  res.json({
    uptime: Math.floor((Date.now() - startTime) / 1000),
    startTime,
    providers: router.snapshot(),
    stats: await db.getStats(since),
    usage: await db.getUsageByProvider(since),
    drift: lastSnapshot
  });
});

// ===== مقارنة snapshot — يكشف ما تغيّر بين فحصين =====
app.get('/api/drift', async (req, res) => {
  const sinceMs = Number(req.query.sinceMs) || 0;
  const providers = router.snapshot();
  // snapshot حالي — العدّ بالتوازي على المزودات المتاحة فقط
  const modelsNow = await countAvailableModels();
  const upNow = providers.filter(p => p.status === 'up').length;
  const authNow = providers.filter(p => p.status === 'auth_error').map(p => p.id);
  // مقارنة (لو ما في sinceMs → نرجع الحالة الحالية بس)
  if (!sinceMs) {
    return res.json({ sinceMs: 0, current: { models: modelsNow, up: upNow, auth: authNow } });
  }
  const prev = lastSnapshot; // مبني من آخر فحص (أو أول لقطة)
  const modelsDelta = modelsNow - prev.models;
  const upDelta = upNow - prev.upProviders;
  const newAuth = authNow.filter(id => !prev.authErrors.includes(id));
  const resolvedAuth = prev.authErrors.filter(id => !authNow.includes(id));
  res.json({
    sinceMs: prev.ts,
    current: { models: modelsNow, up: upNow, auth: authNow },
    previous: { models: prev.models, up: prev.upProviders, auth: prev.authErrors, ts: prev.ts },
    deltas: { models: modelsDelta, up: upDelta },
    newAuthErrors: newAuth,
    resolvedAuth
  });
});

app.get('/api/providers', (_req, res) => res.json({ providers: router.snapshot() }));

// ===== /api/health — حالة كل مفتاح في جدول واحد =====
// لماذا: `KeysModal` يفتح مزوداً بمزود، فسؤال "أي مفتاح ميت؟" كان يتطلب
// فتح كل مزود على حدة. هذا المسار يعطي الصورة الكاملة في طلب واحد، مرتّبة
// بالأخطر أولاً (ميت ← رصيد فارغ ← لم يُختبر ← يعمل).
app.get('/api/health', async (_req, res) => {
  try {
    await db.ready;
    const now = Date.now();
    const rows = await db.listProviderKeys();

    // ندمج نتيجة فحص النماذج لكل مزود: كم نموذجاً يعمل فعلاً
    const probeStats = new Map<string, { ok: number; rejected: number; total: number }>();
    for (const p of router.snapshot()) {
      probeStats.set(p.id, { ok: 0, rejected: 0, total: 0 });
    }
    const pr = await db.client.execute({
      sql: `SELECT provider, status, COUNT(*) AS n FROM model_probe GROUP BY provider, status`,
      args: []
    });
    for (const row of pr.rows as any[]) {
      const cur = probeStats.get(row.provider) || { ok: 0, rejected: 0, total: 0 };
      cur.total += Number(row.n);
      if (row.status === 'ok') cur.ok = Number(row.n);
      if (row.status === 'rejected') cur.rejected = Number(row.n);
      probeStats.set(row.provider, cur);
    }

    const providerStatus = new Map(router.snapshot().map(p => [p.id, p.status]));

    const keys = rows.map((k: any) => {
      const blockedUntil = k.blocked_until ?? null;
      const blockedNow = !!blockedUntil && blockedUntil > now;
      const ps = probeStats.get(k.provider);
      // خطأ مخزَّن من قاعدة (قد يكون عمره أسابيع) يُعرض معقّماً — نص خام
      // من مزود قد يحمل HTML كاملاً أو مفتاحاً منعكساً (رأيناه في الصفوف القديمة).
      // فارغ يبقى فارغاً (null) — لا «Unknown error» مصطنعة على المفتاح السليم.
      const lastError = k.last_error ? sanitizeErrorMessage(k.last_error, 200) : null;
      let status = k.status || 'unknown';

      // استنتاج الحالة من نص الخطأ: انتهاء `blocked_until` يُصفّر `status` إلى
      // unknown بينما `last_error` يبقى محفوظاً. بلا هذا يعرض الجدول مفتاحاً
      // رصيده فارغ على أنه "لم يُختبر" — فيُطلب بلا داعٍ.
      if (status === 'unknown' && lastError) {
        if (/\b429\b|quota|exceeded your current quota|insufficient|balance|credit/i.test(lastError)) {
          status = 'quota_exhausted';
        } else if (/\b40[13]\b|invalid api key|unauthorized|authentication_error|forbidden/i.test(lastError)) {
          status = 'auth_error';
        }
      }

      return {
        id: k.id,
        provider: k.provider,
        providerStatus: providerStatus.get(k.provider) || 'unknown',
        label: k.label || null,
        // لا نعيد المفتاح كاملاً أبداً — قناع فقط
        masked: maskKey(k.key),
        enabled: !!k.enabled,
        status,
        // نُبقي الحالة المخزّنة كما هي حتى يعرف المستخدم مصدر القراءة
        storedStatus: k.status || 'unknown',
        statusInferred: status !== (k.status || 'unknown'),
        blocked: blockedNow,
        blockedUntil,
        retryInMs: blockedUntil ? Math.max(0, blockedUntil - now) : null,
        requests: Number(k.requests || 0),
        lastUsed: k.last_used ?? null,
        lastError,
        modelsOk: ps?.ok || 0,
        modelsRejected: ps?.rejected || 0,
        modelsTotal: ps?.total || 0
      };
    });

    // ترتيب بالأخطر أولاً — ما يهم المستخدم أن يراه أولاً
    const severity: Record<string, number> = {
      auth_error: 0, quota_exhausted: 1, unknown: 2, ok: 3
    };
    keys.sort((a: any, b: any) => {
      if (a.enabled !== b.enabled) return a.enabled ? 1 : -1;
      const s = (severity[a.status] ?? 9) - (severity[b.status] ?? 9);
      if (s !== 0) return s;
      return b.requests - a.requests;
    });

    const counts = {
      total: keys.length,
      auth_error: keys.filter((k: any) => k.status === 'auth_error').length,
      quota_exhausted: keys.filter((k: any) => k.status === 'quota_exhausted').length,
      unknown: keys.filter((k: any) => k.status === 'unknown').length,
      ok: keys.filter((k: any) => k.status === 'ok').length,
      enabled: keys.filter((k: any) => k.enabled).length
    };

    res.json({ generatedAt: now, counts, keys });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'health query failed' });
  }
});

// ===== صدق حالة المزود مقابل قدرته الحقيقية على المحادثة =====
// ping يطلب GET /models — وهي قائمة لا تستهلك حصة، فتنجح حتى بمفاتيح
// منتهية الحصة أو محجوبة. وسم مزود كهذا "up" يعني «متصل ثم تفشل محادثته»
// — وهو جوهر الشكوى. القاعدة: up تعني: يوجد مفتاح واحد على الأقل قابل للاستخدام.
function truthfulPingStatus(e: any, ping: { ok: boolean; statusCode?: number }): string {
  const badAuth = ping.statusCode === 401 || ping.statusCode === 403;
  if (!ping.ok) return badAuth ? 'auth_error' : 'down';
  if (!router.availableKeySlots(e).length) {
    // لا مفتاح متاح: إن كان السبب مفاتيح مرفوضة → auth_error، وإلا حصة/عزل
    const anyAuth = Array.isArray(e.keys) && e.keys.some((k: any) => k.status === 'auth_error');
    return anyAuth ? 'auth_error' : 'quota_exhausted';
  }
  return 'up';
}

app.post('/api/test', async (req, res) => {
  const { providerId } = req.body || {};
  if (providerId) {
    const e = router.getProvider(providerId);
    if (!e) return res.status(404).json({ error: 'Not found' });
    const ping = await e.provider.ping();
    const st = truthfulPingStatus(e, ping);
    router.setStatus(providerId, st, ping.error, ping.ok ? undefined : 60_000);
    await db.logEvent(ping.ok ? 'health.ok' : 'health.fail', { provider: providerId, status: ping.ok ? 'ok' : 'error', latencyMs: ping.latencyMs, error: ping.error });
    broadcast({ type: 'health', providerId, status: st });
    return res.json(ping);
  }
  const results = [];
  for (const id of router.getProviderIds()) {
    const e = router.getProvider(id)!;
    const ping = await e.provider.ping();
    const st = truthfulPingStatus(e, ping);
    router.setStatus(id, st, ping.error, ping.ok ? undefined : 60_000);
    await db.logEvent(ping.ok ? 'health.ok' : 'health.fail', { provider: id, status: ping.ok ? 'ok' : 'error', latencyMs: ping.latencyMs, error: ping.error });
    results.push({ providerId: id, ...ping });
  }
  broadcast({ type: 'health-all' });
  res.json({ results });
});

app.get('/api/logs', async (req, res) => {
  // `?limit=abc` كان يمرّر NaN إلى LIMIT فيرمي @libsql RangeError غير ملتقطاً
  // **يُسقط العملية كاملة** (P0 — أُعيد إنتاجه مرتين). التحقق هنا إلزامي.
  const raw = Number.parseInt(String(req.query.limit ?? '100'), 10);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 500) : 100;
  res.json({ events: await db.getRecentEvents(limit) });
});

// ===== استخدام الرموز (يقرأه تبويب Usage) =====
app.get('/api/usage', async (_req, res) => {
  const since = Date.now() - 86400000;
  const rows = await db.getUsageByProvider(since) as any[];
  res.json({
    usage: rows.map(r => ({ provider: r.provider, requests: Number(r.requests), tokens: Number(r.tokens) || 0 }))
  });
});

// ===== فحص النماذج (probe) =====
// كل فحص يُحدّث جدول model_probe + قائمة الحجب الفورية في الموجّه

// فحص نموذج مع تجربة كل مفاتيح المزود.
//
// القاعدة الحاكمة: خطأ المصادقة (401/403) هو خطأ على مستوى **المفتاح**، لا النموذج.
// فحص واحد بمفتاح واحد معطّل كان يوسم النموذج «مرفوض» — وقد وسم فعلاً ١١٢ نموذجاً
// لمزود واحد بسبب مفتاح واحد. الآن `probeModel` ترجع 'provider_auth' منفصلة،
// و'provider_auth' **لا تُكتب كنموذج مرفوض** ولا تُحجب من التوجيه إطلاقاً.
//
// حكم الطبقة (مفتاح ↔ نموذج) انتقل إلى probe.ts: وحدة نقية تُختبر بلا إقلاع الخادم.
// كان معرَّفاً هنا رغم أنه أخطر حكم في النظام — ولهذا كان لا بد من اختباره مباشرةً.

/**
 * هل نحتاج تجربة **المفتاح التالي** بعد هذه النتيجة؟
 * القاعدة: الخطأ على مستوى المفتاح (مصادقة) لا على مستوى النموذج ⇒ المفتاح التالي
 * قد ينجح. أي جواب آخر نهائي: النموذج سليم أو ميت أو محجوب، وتكراره بلا فائدة.
 * (النسخة السابقة كان فيها فرعان متضادّان يخرجان دائماً ⇒ الحلقة ميتة، خل S4.)
 */

async function probeWithKeys(pid: string, model: string): Promise<ProbeResult> {
  const entry = router.getProvider(pid)!;
  const slots = router.availableKeySlots(entry);
  if (!slots.length) {
    return probeModel(pid, entry.provider.baseUrl, undefined, model, entry.provider.keyless);
  }
  const attempts: Array<{ slot: any; out: ProbeResult }> = [];
  for (const slot of slots) {
    const out = await probeModel(pid, entry.provider.baseUrl, slot.key || undefined, model, entry.provider.keyless);
    attempts.push({ slot, out });

    if (shouldTryNextKey(out)) continue; // مفتاح معطّل ⇒ جرّب التالي (هذا هو التدوير)
    break;                                // أي جواب آخر نهائي: النموذج سليم/ميت/محجوب
  }

  // S5: الحكم يُحسب **مرة واحدة** في probe.ts ويُستخدم في النتيجة النهائية، لا في
  // قرار التكرار فقط. كان 404 الذي نصّه عن المصادقة يُعالَج كخطأ مفتاح للتكرار ثم
  // تُعاد نتيجته 'rejected' ⇒ يُحجب نموذج سليم ويُكتب صف رفض رغم أن السبب مفتاح.
  const last = resolveProbeVerdict(attempts.map((a) => a.out));

  // خطأ مصادقة صريح: نوسم المفاتيح فقط، ونُخبر عن المزود، ولا نمسّ النموذج.
  // هذا هو الإصلاح الجوهري — كان يُرجَع 'rejected' فيُحجب النموذج ظلماً.
  if (last.status === 'provider_auth') {
    for (const a of attempts) {
      // نوسم المفاتيح المعطوبة فقط — النموذج لا يُمسّ
      if (isKeyLayerAttempt(a.out) && a.slot) {
        a.slot.status = 'auth_error';
        if (a.slot.id) {
          db.updateProviderKey(a.slot.id, { status: 'auth_error', error: a.out.error }).catch((e) => noteStoreWriteFailure('updateProviderKey:probe-auth', e));
        }
      }
    }
    return {
      ...last,
      error: last.error || 'provider authentication failed — check this provider\'s keys'
    };
  }

  return last;
}

// نتائج الفحص + الملخّص
app.get('/api/probe/results', async (req, res) => {
  const provider = req.query.provider as string | undefined;
  const [probes, summaryRows] = await Promise.all([db.getProbes(provider), db.getProbeSummary()]);
  // نهيّئ كل الحالات المعروفة بصفر حتى لا يختفي أي عدّاد من الواجهة.
  // (كانت provider_auth غائبة هنا فتُعرض دائماً صفراً رغم وجود صفوف فعلية.)
  const summary: Record<string, number> = { ok: 0, rejected: 0, provider_auth: 0, rate_limited: 0, slow: 0, no_key: 0 };
  for (const r of summaryRows as any[]) {
    if (r.status in summary) summary[r.status] = Number(r.n);
    else summary[r.status] = Number(r.n); // حالة جديدة غير متوقعة → تُضاف بدل أن تُهمل
  }
  res.json({ probes, summary, total: probes.length });
});

// فحص نموذج واحد (طلب chat حقيقي صغير)
// ملاحظة: معرّف النموذج قد يحتوي '/' (مثل meta/llama-3.1-8b) → نلتقط كل ما بعد /model/
// ===== فحص مفتاح واحد بالاسم — يعمل حتى لو المزود غير مُعرَّف في providers.yaml =====
// لماذا: جدول الحالة يعرض مفاتيح لمزودات غير مفعّلة (مفتاح محفوظ، المزود حُذف من
// YAML). زر "افحص" عليها كان يرجّع 404 لأن المسارات كلها تمرّ على router.getProvider.
app.post('/api/health/:keyId/probe', async (req, res) => {
  const keyId = Number(req.params.keyId);
  if (!Number.isFinite(keyId)) return res.status(400).json({ error: 'invalid key id' });
  try {
    await db.ready;
    const rows = (await db.listProviderKeys()) as any[];
    const row = rows.find(r => Number(r.id) === keyId);
    if (!row) return res.status(404).json({ error: 'key not found' });

    // المزود من YAML إن وُجد، وإلا نستنتج رابطه من الكتالوج
    const entry = router.getProvider(row.provider);
    const cat = catalogEntry(row.provider);
    const baseUrl = entry?.provider?.baseUrl || cat?.baseUrl;
    if (!baseUrl) {
      return res.status(422).json({
        error: `لا يمكن فحص "${row.provider}" — المزود غير مفعّل ولا يوجد رابط في الكتالوج. فعّله من تبويب Providers أولاً.`
      });
    }

    // نطلب أول نموذج متاح من قائمة المزود، وننزل لأصغر نموذج
    const listed = await router.listProviderModels(row.provider).catch(() => [] as Array<{ id: string }>);
    const rejected = router.rejectedModels(row.provider);
    const model = (listed.find(m => !rejected.has(m.id))?.id) || (listed[0]?.id) || 'auto';
    if (!model) {
      return res.status(422).json({ error: `لا نماذج متاحة لـ "${row.provider}"` });
    }

    const out = await probeModel(row.provider, baseUrl, row.key || undefined, model, entry?.provider?.keyless);
    await db.upsertProbe(out.provider, out.model, out.status, out.latencyMs, out.error);
    router.noteProbe(out.provider, out.model, out.status);

    // النتيجة تُحدّث حالة **المفتاح** لا المزود — الفحص يجيب عن هذا المفتاح بالذات
    if (out.status === 'provider_auth') {
      await db.updateProviderKey(keyId, { status: 'auth_error', error: out.error });
    } else if (out.status === 'rate_limited' && /quota permanently|exhausted|insufficient/i.test(out.error || '')) {
      await db.updateProviderKey(keyId, { status: 'quota_exhausted', error: out.error });
    } else if (out.status === 'ok' || out.status === 'slow') {
      await db.updateProviderKey(keyId, { status: 'ok', error: null });
      // الفحص الناجح = محادثة حقيقية بهذا المفتاح → يُحسب استخداماً: يملأ «آخر
      // استخدام» ويزيل «غير مؤكَّد» — وإلا بقي المفتاح المُثبَت مشبوهاً بعد الإثبات.
      await db.touchProviderKey(keyId);
    } else if (out.status === 'rejected') {
      await db.updateProviderKey(keyId, { status: 'ok', error: null }); // النموذج ميت لا المفتاح
      // المفتاح أصّاد (الرفض من مستوى النموذج) — استخدام حقيقي بنفس المنطق أعلاه
      await db.touchProviderKey(keyId);
    }

    await db.logEvent('health.probe', {
      provider: row.provider, keyId, model: out.model,
      status: out.status === 'ok' ? 'success' : 'error',
      latencyMs: out.latencyMs, error: out.error
    });
    broadcast({ type: 'health-probe', keyId, status: out.status });
    res.json({ ...out, keyId, model });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'probe failed' });
  }
});

app.post('/api/probe/:providerId/model/*', async (req, res) => {
  const { providerId } = req.params;
  const model = decodeURIComponent((req.params as any)[0] || '');
  if (!model) return res.status(400).json({ error: 'model required' });
  const entry = router.getProvider(providerId);
  if (!entry) return res.status(404).json({ error: `provider "${providerId}" not found` });
  const out = await probeWithKeys(providerId, model);
  await db.upsertProbe(out.provider, out.model, out.status, out.latencyMs, out.error);
  router.noteProbe(out.provider, out.model, out.status);
  await db.logEvent('probe.one', { provider: providerId, model, status: out.status === 'ok' ? 'success' : 'error', latencyMs: out.latencyMs, error: out.error });
  broadcast({ type: 'probe', providerId, model, status: out.status });
  res.json(out);
});

// فحص كل نماذج مزود واحد (دفعات متوازية من 5)
app.post('/api/probe/:providerId/all', async (req, res) => {
  const { providerId } = req.params;
  const cap = Math.min(Number(req.query.cap) || 50, 200);
  const entry = router.getProvider(providerId);
  if (!entry) return res.status(404).json({ error: `provider "${providerId}" not found` });
  if (!entry.provider.apiKey && !entry.provider.keyless) {
    return res.status(400).json({ error: 'provider has no API key — add one first' });
  }
  let models = (await router.listProviderModels(providerId)).map((m: any) => m.id);
  if (!models.length) return res.json({ provider: providerId, tested: 0, ok: 0, results: [], note: 'provider returned no models' });
  models = models.slice(0, cap);
  const results: ProbeResult[] = [];
  const BATCH = 5;
  for (let i = 0; i < models.length; i += BATCH) {
    // S7: كل نموذج يُفحص عبر **كل** مفاتيح المزود (نفس مسار /everything وauto-probe).
    // كان يستخدم مفتاحاً واحداً، فمزود بعشرة مفاتيح يُحكم عليه بأولها — إهدار حصة
    // ونتيجة rate_limited كاذبة، وسلوك يختلف بين زرّين في نفس الشاشة.
    const batch = await Promise.all(models.slice(i, i + BATCH).map((m: string) =>
      probeWithKeys(providerId, m)
    ));
    for (const out of batch) {
      await db.upsertProbe(out.provider, out.model, out.status, out.latencyMs, out.error);
      router.noteProbe(out.provider, out.model, out.status);
      results.push(out);
    }
  }
  const ok = results.filter(r => r.status === 'ok').length;
  await db.logEvent('probe.bulk', { provider: providerId, status: 'success', meta: { tested: results.length, ok } });
  broadcast({ type: 'probe-bulk', providerId });
  res.json({ provider: providerId, tested: results.length, ok, results });
});

// فحص شامل لكل المزودات المفعّلة (مكلف — بحد أقصى للنماذج لكل مزود)
app.post('/api/probe/everything', async (req, res) => {
  const cap = Math.min(Number(req.query.cap) || 8, 50);
  const results: ProbeResult[] = [];
  let providers = 0;
  for (const id of router.getProviderIds()) {
    const entry = router.getProvider(id);
    if (!entry || entry.enabled === false) continue;
    if (!entry.provider.apiKey && !entry.provider.keyless) continue;
    const models = (await router.listProviderModels(id)).map((m: any) => m.id).slice(0, cap);
    if (!models.length) continue;
    providers++;
    for (const m of models) {
      const out = await probeWithKeys(id, m);
      await db.upsertProbe(out.provider, out.model, out.status, out.latencyMs, out.error);
      router.noteProbe(out.provider, out.model, out.status);
      results.push(out);
    }
  }
  const ok = results.filter(r => r.status === 'ok').length;
  await db.logEvent('probe.bulk', { status: 'success', meta: { tested: results.length, ok, providers } });
  broadcast({ type: 'probe-bulk' });
  res.json({ tested: results.length, ok, providers, results });
});

// إعادة فحص المرفوض فقط (الحصص ممكن تتجدد أو السيرفر يرجع)
// ملاحظة: 'provider_auth' تُعاد فحصها أيضاً — بعد إصلاح المفتاح يجب أن يتحرّر النموذج،
// وإلا بقي مئات النماذج معلَّقة على خطأ مفتاح أُصلح فعلاً.
app.post('/api/probe/retry-rejected', async (req, res) => {
  const provider = req.query.provider as string | undefined;
  const all = await db.getProbes(provider) as any[];
  const rejected = all.filter(r => r.status === 'rejected' || r.status === 'provider_auth');
  const results: ProbeResult[] = [];
  for (const r of rejected) {
    const entry = router.getProvider(r.provider);
    if (!entry || entry.enabled === false) continue;
    if (!entry.provider.apiKey && !entry.provider.keyless) continue;
    const out = await probeWithKeys(r.provider, r.model);
    await db.upsertProbe(out.provider, out.model, out.status, out.latencyMs, out.error);
    router.noteProbe(out.provider, out.model, out.status);
    results.push(out);
  }
  const recovered = results.filter(r => r.status === 'ok').length;
  if (results.length) {
    await db.logEvent('probe.retry', { status: 'success', meta: { tested: results.length, recovered } });
    broadcast({ type: 'probe-bulk' });
  }
  res.json({ tested: results.length, recovered, results });
});

// مسح نتائج الفحص (وإفراغ الحجب الفوري معها)
app.delete('/api/probe/results', async (req, res) => {
  const provider = req.query.provider as string | undefined;
  await db.clearProbes(provider);
  router.clearProbeRejections(provider);
  await db.logEvent('probe.cleared', { provider: provider || null, status: 'success' });
  broadcast({ type: 'probe-cleared', providerId: provider || null });
  res.json({ ok: true });
});

// ping: هل الرابط حي والمفتاح سليم
app.post('/api/probe/ping', async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  if (!baseUrl) return res.status(400).json({ error: 'baseUrl required' });
  const check = await guardBaseUrl(baseUrl);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const t0 = Date.now();
  try {
    const { statusCode, body } = await request(`${check.url.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { 'Accept': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      headersTimeout: 8000, bodyTimeout: 8000
    });
    await body.dump();
    res.json({
      ok: statusCode < 400,
      statusCode,
      latencyMs: Date.now() - t0,
      authValid: statusCode !== 401 && statusCode !== 403
    });
  } catch (e: any) {
    res.json({ ok: false, statusCode: 0, latencyMs: Date.now() - t0, authValid: false, error: e.message });
  }
});

// models: جلب قائمة النماذج من رابط + مفتاح مباشرة
app.post('/api/probe/models', async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  if (!baseUrl) return res.status(400).json({ error: 'baseUrl required' });
  const check = await guardBaseUrl(baseUrl);
  if (!check.ok) return res.status(400).json({ error: check.error });
  try {
    const models = await fetchModels(check.url, apiKey || undefined);
    res.json({ count: models.length, models });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});


// 6) اختبار نموذج باستخدام الرابط والمفتاح مباشرة (لا يحتاج providerId)
app.post('/api/probe/connect', async (req, res) => {
  const { baseUrl, apiKey, model } = req.body;
  if (!baseUrl || !model) return res.status(400).json({ error: 'baseUrl and model required' });
  // S9: نفس حارس الطول المستخدم في محرّك الفحص — هذا المسار كان يمرّر الاسم للمزوّد
  // كما هو بلا حدّ (حقن طلب خارجي ضخم).
  if (typeof model !== 'string' || model.length > MAX_MODEL_NAME_LEN) {
    return res.status(400).json({ error: `model name must be a string of at most ${MAX_MODEL_NAME_LEN} characters` });
  }
  const check = await guardBaseUrl(baseUrl);
  if (!check.ok) return res.status(400).json({ error: check.error });

  try {
    const startTime = Date.now();
    // undici imported at top of file
    const { statusCode, body } = await request(
      `${check.url.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1
        }),
        headersTimeout: 10000,
        bodyTimeout: 10000
      }
    );

    await body.dump();
    const latencyMs = Date.now() - startTime;
    const success = statusCode >= 200 && statusCode < 400;

    res.json({
      provider: 'temp',
      model,
      status: success ? 'ok' : 'rejected',
      latencyMs,
      error: success ? undefined : `HTTP ${statusCode}`
    });
  } catch (e: any) {
    res.json({
      provider: 'temp',
      model,
      status: 'rejected',
      latencyMs: 0,
      error: e.message || 'Connection failed'
    });
  }
});
// ----- Periodic health check -----
async function healthLoop() {
  for (const id of router.getProviderIds()) {
    const e = router.getProvider(id);
    if (!e) continue;
    // نتخطى المعطّلات والتي بلا مفتاح (المجاني بلا مفتاح زي pollinations يُفحص)
    // هذا يمنع آلاف أحداث health.fail التي كانت تُفسد إحصاءات الواجهة
    if (e.enabled === false) continue;
    if (!e.provider.apiKey && !e.provider.keyless) continue;
    try {
      const ping = await e.provider.ping();
      // نفس قاعدة الصدق: ping ناجح بمفاتيح ميتة للمحادثة لا يعني "up"
      const st = truthfulPingStatus(e, ping);
      router.setStatus(id, st, ping.error, ping.ok ? undefined : 60_000);
      await db.logEvent(ping.ok ? 'health.ok' : 'health.fail', { provider: id, status: ping.ok ? 'ok' : 'error', latencyMs: ping.latencyMs, error: ping.error });
    } catch (err: any) {
      const msg = sanitizeErrorMessage(err);
      router.setStatus(id, 'down', msg, 60_000);
      await db.logEvent('health.fail', { provider: id, status: 'error', error: msg });
    }
  }
  broadcast({ type: 'health-all' });
}
scheduler.register({
  name: 'health',
  intervalMs: HEALTH_INTERVAL_MS,
  run: async () => { await healthLoop(); return { ok: true }; }
});

// ===== مزامنة المفاتيح الهرمية (تلقائية) =====
scheduler.register({
  name: 'key-sync',
  intervalMs: SYNC_INTERVAL_MS,
  run: async () => {
    const report = await keySync.reconcile();
    const changed = report.counts.added + report.counts.reactivated +
      report.counts.authority + report.counts.withdrawn;
    return {
      ok: report.counts.error === 0,
      error: report.counts.error ? `${report.counts.error} خطأ في المصالحة` : undefined,
      detail: {
        changed, sources: report.sources.length, durationMs: report.durationMs,
        desired: report.desiredKeys, current: report.currentKeys
      }
    };
  }
});

// ===== التدوير: قواطع دائرة + عزل المزوّد بلا مفاتيح =====
scheduler.register({
  name: 'rotation',
  intervalMs: ROTATION_INTERVAL_MS,
  run: async () => {
    const report = await rotation.tick();
    return {
      ok: true,
      detail: { ...report.counts, isolated: report.isolatedProviders.length, durationMs: report.durationMs }
    };
  }
});

// ===== تنظيف السجلات (سياسة احتفاظ صريحة — القاعدة بلا سقف تنمو) =====
const RETENTION_INTERVAL_MS = numOr(process.env.AGENT_RETENTION_INTERVAL_MS, 6 * 60 * 60_000);
const EVENTS_RETENTION_DAYS = numOr(process.env.RETENTION_EVENTS_DAYS, 30);
const USAGE_RETENTION_DAYS = numOr(process.env.RETENTION_USAGE_DAYS, 90);
const ROTATIONS_KEEP = numOr(process.env.RETENTION_ROTATIONS_KEEP, 5000);
// المفتاح الذي لم يُستخدم هذا العدد من الأيام يُحذف تلقائياً (انظر db.prune).
const IDLE_KEY_DAYS = numOr(process.env.RETENTION_IDLE_KEY_DAYS, 30);
scheduler.register({
  name: 'retention',
  intervalMs: RETENTION_INTERVAL_MS,
  run: async () => {
    const r = await db.prune({
      eventsDays: EVENTS_RETENTION_DAYS, usageDays: USAGE_RETENTION_DAYS, rotationsKeep: ROTATIONS_KEEP,
      idleKeyDays: IDLE_KEY_DAYS
    });
    const removed = r.events + r.usage + r.rotations + r.probes + r.apiKeys;
    if (removed > 0) {
      await db.logEvent('agents.retention', {
        status: 'success',
        meta: { ...r, eventsDays: EVENTS_RETENTION_DAYS, usageDays: USAGE_RETENTION_DAYS }
      }).catch(() => {});
      // الحذف لا يقلّص الملف — VACUUM يعيد المساحة. بعد كل حذف فعلي فقط (لا كل دورة).
      await db.vacuum().catch(() => {});
    }
    return { ok: true, detail: { ...r, removed } };
  }
});

if (AGENTS_ENABLED) {
  scheduler.start();
  // تشغيل أولي فوري (كان موجوداً قبل الوكلاء لفحص الصحة) + مزامنة أولى
  void scheduler.runNow('health');
  void scheduler.runNow('key-sync');
} else {
  console.log('⏸ الوكلاء معطّلة (AGENTS_ENABLED=0) — الفحص اليدوي فقط');
}

const PORT = process.env.PORT || 3001;
server.listen(Number(PORT), HOST, () => {  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`📡 WebSocket on ws://${HOST}:${PORT}/ws`);
  console.log(`🔌 OpenAI API: http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`📊 ${router.getProviderIds().length} providers loaded`);
  if (IS_NETWORK_EXPOSED) {
    // لا يمكن الوصول هنا بلا ADMIN_TOKEN — الفحص أعلى الملف يمنع الإقلاع.
    // تبقى الرسالة للتذكير بأن /api محمي فعلاً في هذا الوضع.
    console.log(`🔒 مفتوح على الشبكة (${HOST}) — /api محمي بـADMIN_TOKEN`);
    console.log(`   افتح أول مرة هكذا: http://${HOST}:${PORT}/?token=<ADMIN_TOKEN>`);
  }
});

app.post('/api/providers/fetch-models', async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  if (!baseUrl) return res.status(400).json({ error: 'baseUrl required' });
  const check = await guardBaseUrl(baseUrl);
  if (!check.ok) return res.status(400).json({ error: check.error });
  try {
    const models = await fetchModels(check.url, apiKey || undefined);
    res.json({ count: models.length, models });
  } catch (e: any) {
    res.status(500).json({ error: sanitizeErrorMessage(e) });
  }
});

// Test connection endpoint (required by Frontend)
app.post('/api/providers/test-connection', async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  if (!baseUrl) return res.status(400).json({ error: 'baseUrl required' });
  const check = await guardBaseUrl(baseUrl);
  if (!check.ok) return res.status(400).json({ ok: false, error: check.error });
  try {
    const result = await testConnection(check.url, apiKey || undefined);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: sanitizeErrorMessage(e) });
  }
});

// ===== الكتالوج الموحّد =====
app.get('/api/catalog', (_req, res) => {
  const c = loadCatalog();
  const existing = new Set(router.getProviderIds());
  res.json({
    providers: c.providers.map(p => ({ ...p, configured: existing.has(p.id) })),
    keyPatterns: c.keyPatterns,
    count: c.providers.length
  });
});

// ===== مفاتيح المزودات (متعددة لكل مزود مع تدوير) =====
app.get('/api/providers/:id/keys', (req, res) => {
  const id = req.params.id;
  const entry = router.getProvider(id);
  if (!entry) return res.status(404).json({ error: 'Provider not found' });
  res.json({ provider: id, keys: router.keyDetails(id), summary: router.keySummary(entry) });
});

// إضافة مفتاح أو عدة مفاتيح مرة واحدة
app.post('/api/providers/:id/keys', async (req, res) => {
  const id = req.params.id;
  const entry = router.getProvider(id);
  if (!entry) return res.status(404).json({ error: 'Provider not found' });
  const body = req.body || {};
  const incoming: string[] = Array.isArray(body.keys)
    ? body.keys.map((k: any) => String(k).trim()).filter(Boolean)
    : (typeof body.key === 'string' && body.key.trim() ? [body.key.trim()] : []);
  if (!incoming.length) return res.status(400).json({ error: 'key أو keys مطلوب' });
  try {
    let added = 0;
    let duplicates = 0;
    for (const k of incoming) {
      const row = await db.addProviderKey(id, k, body.label || null);
      if (row?.existed) duplicates++; else added++;
    }
    await router.reloadProviderKeys(id);
    invalidateModelsCache();
    await db.logEvent('provider_key.added', { provider: id, status: 'success', meta: { count: added, duplicates } });
    broadcast({ type: 'provider-keys', providerId: id });
    // duplicates: المفاتيح المكرّرة تُقبل بلا خطأ (تُعاد كـ«مفعّلة/غير محجوبة») لكن
    // لا يُدّعى إضافتها — كان الرد يقول added=N دائماً حتى لو لم يُدرج صف واحد.
    res.json({ ok: true, added, duplicates, keys: router.keyDetails(id), summary: router.keySummary(router.getProvider(id)) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// تعديل مفتاح: تعطيل/تفعيل · تسمية · استبدال القيمة · إعادة تفعيل بعد نفاد الحصة
app.patch('/api/providers/:id/keys/:keyId', async (req, res) => {
  const id = req.params.id;
  const keyId = parseInt(req.params.keyId, 10);
  if (!router.getProvider(id)) return res.status(404).json({ error: 'Provider not found' });
  if (!Number.isFinite(keyId)) return res.status(400).json({ error: 'invalid key id' });
  const body = req.body || {};
  // نوع خاطئ لـenabled كان يُتجاهل بصمت مع ok:true — العميل يظن أنه عطّل
  // ولم يحدث شيء (خلل مثبت؛ الأشقاء في /toggle يرفضون صراحة).
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  try {
    const rows = await db.listProviderKeys(id) as any[];
    if (!rows.find(r => r.id === keyId)) return res.status(404).json({ error: 'Key not found' });
    const patch: any = {};
    if (typeof body.label === 'string') patch.label = body.label;
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.key === 'string' && body.key.trim()) {
      patch.key = body.key.trim();
      patch.status = 'unknown';
      patch.error = null;
      patch.blockMs = null;
    }
    // إعادة تفعيل مفتاح منتهي الحصة يدوياً (قد تكون الحصة تجددت)
    if (body.reactivate) { patch.status = 'unknown'; patch.error = null; patch.blockMs = null; }
    await db.updateProviderKey(keyId, patch);
    await router.reloadProviderKeys(id);
    invalidateModelsCache();
    await db.logEvent('provider_key.updated', { provider: id, status: 'success', meta: { keyId } });
    broadcast({ type: 'provider-keys', providerId: id });
    res.json({ ok: true, keys: router.keyDetails(id), summary: router.keySummary(router.getProvider(id)) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/providers/:id/keys/:keyId', async (req, res) => {
  const id = req.params.id;
  const keyId = parseInt(req.params.keyId, 10);
  if (!router.getProvider(id)) return res.status(404).json({ error: 'Provider not found' });
  if (!Number.isFinite(keyId)) return res.status(400).json({ error: 'invalid key id' });
  try {
    // ملكية إلزامية: بلا هذا كان DELETE عبر مسار مزود مختلف يحذف مفتاح غيره
    // فعلاً (مثبت بإعادة إنتاج: مفتاح zz-own حُذف عبر مسار dahl بـ200).
    // ويغطي أيضاً مفتاحاً غير موجود (كان يعيد 200 كاذبة).
    const rows = await db.listProviderKeys(id) as any[];
    if (!rows.find(r => Number(r.id) === keyId)) return res.status(404).json({ error: 'Key not found' });
    await db.deleteProviderKey(keyId);
    await router.reloadProviderKeys(id);
    invalidateModelsCache();
    await db.logEvent('provider_key.deleted', { provider: id, status: 'success', meta: { keyId } });
    broadcast({ type: 'provider-keys', providerId: id });
    res.json({ ok: true, keys: router.keyDetails(id), summary: router.keySummary(router.getProvider(id)) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ===== الاستيراد الجماعي =====
// التحليل (parseImportText) والتقنيع (maskImportLine) في services/catalog.ts.
app.post('/api/providers/import', async (req, res) => {
  const body = req.body || {};
  const entries = Array.isArray(body.entries) ? body.entries : parseImportText(body.text || '', router.getProviderIds());
  if (!entries.length) return res.status(400).json({ error: 'لا يوجد شيء للاستيراد' });
  const dryRun = !!body.dryRun;
  const results: any[] = [];
  const yaml = readProvidersYaml();
  let yamlChanged = false;

  for (const e of entries) {
    const line = maskImportLine(e.raw);
    const key = String(e.key || '').trim();
    if (!key) { results.push({ raw: line, status: 'skipped', reason: 'مفتاح فارغ' }); continue; }
    const pid = e.provider ? String(e.provider).trim() : null;

    let addedProvider = false;
    if (pid && !router.getProvider(pid)) {
      const cat = catalogEntry(pid);
      if (!cat) {
        results.push({ raw: line, provider: pid, status: 'needs-url', reason: 'مزود غير معروف — أضف رابطه أولاً' });
        continue;
      }
      if (dryRun) {
        results.push({ raw: line, provider: pid, status: 'ready', reason: 'سيُضاف المزود من الكتالوج + المفتاح' });
        continue;
      }
      const newEntry: any = {
        id: cat.id, name: cat.name, baseUrl: cat.baseUrl,
        apiKeyEnv: cat.apiKeyEnv || deriveEnvName(cat.id), format: 'openai',
        tier: cat.tier ?? 4, enabled: true, models: 'auto', signupUrl: cat.signupUrl || null
      };
      yaml.providers.push(newEntry);
      yamlChanged = true;
      router.addProvider(newEntry);
      invalidateModelsCache();
      addedProvider = true;
    }
    if (!pid) {
      results.push({ raw: line, provider: null, status: 'needs-provider', reason: 'لم أتعرّف على المزوّد من شكل المفتاح — حدّده يدوياً' });
      continue;
    }
    if (dryRun) { results.push({ raw: line, provider: pid, status: 'ready' }); continue; }
    try {
      await db.addProviderKey(pid, key, null);
      const entry = router.getProvider(pid);
      if (entry && entry.enabled === false) {
        const idx = yaml.providers.findIndex((p: any) => p.id === pid);
        if (idx !== -1) { yaml.providers[idx] = { ...yaml.providers[idx], enabled: true }; yamlChanged = true; }
        router.toggleProvider(pid, true);
      }
      results.push({
        raw: line, provider: pid, status: 'ok',
        reason: addedProvider ? 'أُضيف المزود من الكتالوج + المفتاح' : undefined
      });
    } catch (err: any) {
      results.push({ raw: line, provider: pid, status: 'error', reason: sanitizeErrorMessage(err) });
    }
  }

  if (!dryRun && yamlChanged) writeProvidersYaml(yaml);
  if (!dryRun) {
    for (const pid of [...new Set(results.filter(r => r.status === 'ok').map(r => r.provider))]) {
      await router.reloadProviderKeys(pid as string);
      invalidateModelsCache();
    }
    await db.logEvent('providers.imported', {
      status: 'success',
      meta: { total: entries.length, ok: results.filter(r => r.status === 'ok').length }
    });
    broadcast({ type: 'providers-imported' });
  }
  res.json({
    dryRun, total: entries.length,
    imported: results.filter(r => r.status === 'ok').length,
    needsAttention: results.filter(r => ['needs-url', 'needs-provider', 'error'].includes(r.status)).length,
    results
  });
});

// ===== إعدادات توفير الرموز =====
app.get('/api/settings', (_req, res) => res.json({ settings: router.currentSettings() }));

app.patch('/api/settings', async (req, res) => {
  const body = req.body || {};
  try {
    router.applySettings(body);
    const cur = router.currentSettings();
    const persist: Record<string, string> = {};
    for (const [k, v] of Object.entries(cur)) {
      if (['cacheSize', 'cacheHits', 'cacheMisses'].includes(k)) continue;
      persist[k] = String(v);
    }
    await db.setSettings(persist);
    await db.logEvent('settings.updated', { status: 'success', meta: { changed: Object.keys(body) } });
    res.json({ ok: true, settings: router.currentSettings() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ===== إدارة المزودات =====

// إضافة مزود — المفتاح يُحفظ في .env (لا في YAML)
app.post('/api/providers/add', async (req, res) => {
  const { id, name, baseUrl, apiKey, tier, models } = req.body || {};
  if (!id || !name || !baseUrl) return res.status(400).json({ error: 'id, name, and baseUrl required' });
  if (!validateId(id)) return res.status(400).json({ error: 'id must match ^[a-z0-9-]{2,32}$' });
  // العنوان يأتي من المستخدم → يمر من فلتر SSRF قبل أي طلب أو حفظ
  const check = await guardBaseUrl(baseUrl);
  if (!check.ok) return res.status(400).json({ error: check.error });
  try {
    const yaml = readProvidersYaml();
    if (yaml.providers.find((p: any) => p.id === id)) {
      return res.status(409).json({ error: 'Provider already exists' });
    }
    const entry: any = {
      id, name, baseUrl: check.url.replace(/\/+$/, ''), format: 'openai',
      // تحقق نوعي: tier نصي كان يُخزَّن كما هو فيكسر مقارنات الترتيب (NaN)،
      // وmodels غير المصفوفة/auto يُخفي المزود من التفعل التلقائي (خلل مقروء بالسطر).
      tier: Number.isFinite(Number(tier)) && Number(tier) > 0 ? Number(tier) : 4,
      enabled: true,
      models: Array.isArray(models) || models === 'auto' ? models : 'auto'
    };
    // المفتاح يُخزَّن في قاعدة البيانات (يدعم عدة مفاتيح لكل مزود) — لا نكتبه في YAML
    // الاسم الحقيقي لمتغيّر البيئة من الكتالوج إن عُرِّف (مثال: google-ai → GEMINI_API_KEY) — وإلا يُشتق من المعرّف
    const catEntry = catalogEntry(id);
    entry.apiKeyEnv = catEntry?.apiKeyEnv || `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    // رابط تسجيل المفتاح من الكتالوج — الواجهة تعرضه زر "Get API key"
    if (catEntry?.signupUrl) entry.signupUrl = catEntry.signupUrl;
    yaml.providers.push(entry);
    writeProvidersYaml(yaml);
    router.addProvider(entry);
    invalidateModelsCache();
    if (apiKey) {
      await db.addProviderKey(id, String(apiKey).trim(), entry.apiKeyEnv);
    }
    // **مهم**: نُعيد بناء المفاتيح من القاعدة دائماً — لا فقط عند إرسال مفتاح.
    // بلا هذا كان مزود جديد بلا مفتاح يعرض «مفتاحاً وهمياً» (hasKey:true وصف
    // "بلا مفتاح" لا وجود له في القاعدة)، وكانت إعادة إضافة مزود محذوف تُخفي
    // مفاتيحه المستبقاة (خلل مثبت بإعادة إنتاج).
    await router.reloadProviderKeys(id);
    await db.logEvent('provider.added', { provider: id, status: 'success', meta: { hasKey: !!apiKey } });
    broadcast({ type: 'provider-added', providerId: id });
    const summary = router.keySummary(router.getProvider(id));
    res.json({ ok: true, provider: entry, hasKey: summary.total > 0, keys: summary });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// تفعيل/تعطيل مزود — يكتب في providers.yaml ويطبّق فوراً على الموجّه
app.post('/api/providers/:id/toggle', async (req, res) => {
  const id = req.params.id;
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
  try {
    const yaml = readProvidersYaml();
    const idx = yaml.providers.findIndex((p: any) => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Provider not found' });
    yaml.providers[idx] = { ...yaml.providers[idx], enabled };
    writeProvidersYaml(yaml);
    const applied = router.toggleProvider(id, enabled);
    invalidateModelsCache();
    await db.logEvent('provider.toggled', { provider: id, status: 'success', meta: { enabled } });
    broadcast({ type: 'provider-toggled', providerId: id, enabled });
    res.json({ ok: true, enabled, applied });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/providers/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const yaml = readProvidersYaml();
    const idx = yaml.providers.findIndex((p: any) => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Provider not found' });
    const body = req.body || {};
    const updated: any = { ...yaml.providers[idx] };
    if (body.name) updated.name = body.name;
    if (body.baseUrl) {
      // تعديل الرابط = مدخل مستخدم يصل لطبقة الشبكة → نفس فلتر الإضافة
      const check = await guardBaseUrl(body.baseUrl);
      if (!check.ok) return res.status(400).json({ error: check.error });
      updated.baseUrl = check.url.replace(/\/+$/, '');
    }
    if (body.tier) updated.tier = body.tier;
    if (Array.isArray(body.models)) updated.models = body.models;
    if (typeof body.enabled === 'boolean') updated.enabled = body.enabled;

    // ===== المفتاح: يعيش في قاعدة البيانات (متعدد لكل مزود) — لا يُكتب في YAML =====
    let keyAction: 'set' | 'cleared' | null = null;
    if (typeof body.apiKey === 'string') {
      const rows = await db.listProviderKeys(id) as any[];
      if (body.apiKey === '' || body.apiKey === '__clear__') {
        for (const r of rows) await db.deleteProviderKey(r.id);
        keyAction = 'cleared';
      } else if (rows.length) {
        // استبدال المفتاح الأساسي مع إعادة تفعيله (يُستخدم لتغيير مفتاح منتهي)
        await db.updateProviderKey(rows[0].id, { key: body.apiKey, status: 'unknown', error: null, blockMs: null });
        keyAction = 'set';
      } else {
        await db.addProviderKey(id, body.apiKey, updated.apiKeyEnv || deriveEnvName(id));
        keyAction = 'set';
      }
      updated.apiKeyEnv = updated.apiKeyEnv || deriveEnvName(id);
      delete updated.apiKey; // لا نخزّن المفتاح نصاً صريحاً في YAML
    }

    yaml.providers[idx] = updated;
    writeProvidersYaml(yaml);
    reloadProvider(updated);
    await router.reloadProviderKeys(id);
    invalidateModelsCache();
    await db.logEvent('provider.edited', { provider: id, status: 'success', meta: keyAction ? { keyAction } : undefined });
    broadcast({ type: 'provider-edited', providerId: id });
    const fresh = router.getProvider(id);
    const summary = router.keySummary(fresh);
    res.json({ ok: true, provider: updated, hasKey: summary.total > 0, keys: summary, keyAction });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// حذف مزود.
// S12: مفاتيحه في القاعدة **تبقى** افتراضياً (إعادة إضافته تستعيدها)، والحذف
// النهائي يتطلّب طلباً صريحاً `?purgeKeys=1`. قبل ذلك كانت الواجهة توعد بحذف
// المفاتيح بينما هي باقية بصمت ⇒ ادّعاء غير صحيح على سرّ.
app.delete('/api/providers/:id', async (req, res) => {
  const id = req.params.id;
  const purgeKeys = req.query.purgeKeys === '1' || req.query.purgeKeys === 'true';
  try {
    const yaml = readProvidersYaml();
    const target = yaml.providers.find((p: any) => p.id === id);
    const before = yaml.providers.length;
    yaml.providers = yaml.providers.filter((p: any) => p.id !== id);
    if (yaml.providers.length === before) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    writeProvidersYaml(yaml);
    // نحذف سطر متغيّر البيئة (لم يبق له معنى بلا مزود)
    if (target?.apiKeyEnv) upsertEnvVar(target.apiKeyEnv, null);
    const rows = await db.listProviderKeys(id) as any[];
    if (purgeKeys) {
      for (const row of rows) await db.deleteProviderKey(row.id);
    }
    router.removeProvider(id);
    invalidateModelsCache();
    await db.logEvent('provider.removed', {
      provider: id, status: 'success',
      meta: { keysRetained: purgeKeys ? 0 : rows.length, purged: purgeKeys }
    });
    broadcast({ type: 'provider-removed', providerId: id });
    res.json({
      ok: true, envVarRemoved: target?.apiKeyEnv || null,
      keysRetained: purgeKeys ? 0 : rows.length, purged: purgeKeys
    });
  } catch (e: any) {
    res.status(500).json({ error: sanitizeErrorMessage(e) });
  }
});

// ===== واجهة الوكلاء (إشراف ذاتي التشغيل) =====
// أمان: كلها تحت /api المحمي بـ ADMIN_TOKEN، ولا تُعيد أي قيمة سرّية —
// تقرير حالة فقط (معرّف المصدر، عدد المفاتيح، أخطاء معقّمة، بصمات).
app.get('/api/agents/status', async (_req, res) => {
  try {
    await db.ready;
    const [circuits, sources] = await Promise.all([rotation.inspect(), keySync.sourcesStatus()]);
    res.json({
      scheduler: scheduler.status(),
      rotation: {
        total: circuits.length,
        closed: circuits.filter(c => c.state === 'closed').length,
        open: circuits.filter(c => c.state === 'open').length,
        halfOpen: circuits.filter(c => c.state === 'half-open').length,
        needsResync: circuits.filter(c => c.needsResync).length
      },
      sources
    });
  } catch (e: any) {
    res.status(500).json({ error: sanitizeErrorMessage(e) });
  }
});

app.post('/api/agents/sync', async (_req, res) => {
  try {
    const report = await keySync.reconcile();
    res.json({
      ok: report.counts.error === 0,
      durationMs: report.durationMs,
      counts: report.counts,
      desiredKeys: report.desiredKeys,
      currentKeys: report.currentKeys,
      sources: report.sources,
      actions: report.actions.slice(0, 100)
    });
  } catch (e: any) {
    res.status(500).json({ error: sanitizeErrorMessage(e) });
  }
});

app.post('/api/agents/rotate', async (_req, res) => {
  try {
    const report = await rotation.tick();
    res.json({
      ok: true, durationMs: report.durationMs, counts: report.counts,
      isolatedProviders: report.isolatedProviders
    });
  } catch (e: any) {
    res.status(500).json({ error: sanitizeErrorMessage(e) });
  }
});

// دوائر المفاتيح بالتفصيل — بصمات فقط، بلا أي قيمة مفتاح
app.get('/api/agents/keys', async (_req, res) => {
  try {
    await db.ready;
    res.json({ keys: await rotation.inspect() });
  } catch (e: any) {
    res.status(500).json({ error: sanitizeErrorMessage(e) });
  }
});

// سجل التدقيق: من غيّر ماذا ومتى ولماذا (بلا أسرار)
app.get('/api/agents/audit', async (req, res) => {
  try {
    await db.ready;
    const provider = typeof req.query.provider === 'string' && req.query.provider ? req.query.provider : undefined;
    res.json({ rotations: await db.listRotations({ limit: Number(req.query.limit) || 50, provider }) });
  } catch (e: any) {
    res.status(500).json({ error: sanitizeErrorMessage(e) });
  }
});

// ===== تقديم واجهة البناء (dist) — يسمح بالنشر بعملية واحدة =====
const DIST_DIR = join(process.cwd(), 'dist');
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // أي مسار ليس API → نرجّع index.html ليتولّى الـ SPA التوجيه
  app.get(/^\/(?!api|v1|ws).*/, (_req, res) => res.sendFile(join(DIST_DIR, 'index.html')));
}

// ===== معالج أخطاء عام (آخر السلسلة) =====
// **خارج كتلة dist عمداً**: كان داخلها، فتوقّف عن العمل عند غياب dist/ فعاد
// Express لصفحة HTML فيها مسارات الملفات بدل JSON. تسجيلها: DECISIONS.md D-08.
// لماذا: بلا هذا، أي خطأ تحليل JSON أو خطأ غير ملتقط يُعيد صفحة HTML فيها
// مسار الملفات وقائمة استدعاءات (رأيناه فعلاً: `E:\ai-gateway-web\node_modules\…`).
// ذلك يكشف بنية السيرفر للعميل، وهو أسوأ من الخطأ نفسه. هنا نُعيد JSON نظيفاً
// ونسجّل الرسالة معقّمة — مع الحفاظ على الأكواد الصحيحة لكل حالة.
app.use((err: any, _req: any, res: any, next: any) => {
  if (res.headersSent) return next(err);
  const type = err?.type;
  if (type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({
      error: { message: 'JSON غير صالح في جسم الطلب', type: 'invalid_request_error' }
    });
  }
  if (type === 'entity.too.large') {
    return res.status(413).json({
      error: { message: 'جسم الطلب أكبر من الحد المسموح (2MB)', type: 'invalid_request_error' }
    });
  }
  const safe = sanitizeErrorMessage(err);
  console.error('[unhandled]', safe);
  res.status(500).json({ error: { message: 'خطأ داخلي في البوابة', type: 'internal_error' } });
});

// ===== إغلاق نظيف (SIGINT/SIGTERM) =====
// بلا هذا كان كل إيقاف يضيّع: عدّادات الاستخدام المعلّقة (5 ثوانٍ)، واتصالات
// القاعدة، والبثّات الجارية. نغلق الاستقبال أولاً (توقّف طلبات جديدة) ثم
// نفرّغ الكاشّات ونغلق القاعدة بسقف زمني قاسٍ حتى لا يعلّق الإيقاف.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — إغلاق نظيف…`);
  const force = setTimeout(() => { console.error('لم يكتمل الإغلاق في 10 ثوانٍ — خروج قسري'); process.exit(1); }, 10_000);
  if (typeof force.unref === 'function') force.unref();
  try {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([router.flushTouches(), db.flushApiTouches()]);
    await db.close().catch(() => {});
    console.log('✓ أُغلق الخادم والقاعدة والعدّادات أُفرغت');
  } catch (e: any) {
    console.error('خطأ أثناء الإغلاق:', e?.message || e);
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ===== شبكة أمان: رفض وعد غير ملتقط لا يُسقط البوابة =====
// الدرس المُثبَت: Express 4 لا يلتقط رمي معالجات async، وNode يُنهي العملية على
// أول unhandled rejection — فطلب واحد بمدخل غير متوقع كان يقتل الخادم كاملاً
// (وجدناه فعلاً: GET /api/logs?limit=abc). الجذر أُصلح (تحقق كامل في المسار)،
// وهذه شبكة تلتقط أي مسار مستقبلي لم يُفحص بعد: تسجيل صاخب + البقاء في الخدمة.
// العميل لا يشعر: طلبه سينتهي بانتهاء مهلة الاتصال، والبقية يعملون.
process.on('unhandledRejection', (reason: any) => {
  console.error('[unhandledRejection] رُفض وعد بلا معالجة — الخادم مستمر:',
    sanitizeErrorMessage(reason, 500));
});
