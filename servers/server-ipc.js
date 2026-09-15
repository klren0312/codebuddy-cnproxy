/**
 * CodeBuddy OpenAI 兼容代理 - IPC 版
 *
 * 经本地进程 IPC (stdio JSON-RPC) 驱动一个 ACP agent,
 * 把 OpenAI Chat Completions 翻译成 session/prompt, 再把
 * session/update 事件流翻译回 SSE / ChatCompletion。
 *
 * 用法:
 *   1. 在 .env 填写 ACP_COMMAND (支持 ACP 协议的本地 agent 启动命令)
 *      例: ACP_COMMAND="your-agent --acp"
 *   2. npm run start:ipc
 *   3. OpenAI SDK 指到 http://localhost:3000/v1 (默认 PROXY_API_KEY)
 *
 * 环境变量 (.env):
 *   ACP_COMMAND / ACP_ARGS / ACP_CWD
 *   WORKSPACE_ROOT=...      默认会话目录 (不填则 agent 用它自己的默认目录)
 *                             同时是本侧 fs/terminal 的强制执行根 (默认本进程 cwd)
 *   ALLOW_WRITE_OUTSIDE=0   是否允许写根目录之外
 *   PERMISSION_POLICY=allow|deny   权限请求策略 (默认 allow)
 *   MODELS_CHAT_MODE=craft  /v1/models 按哪个 agent 名单过滤 (实时表时有效)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { ACPClient } = require('../lib/acp-client');
const { getCatalog } = require('../lib/models');

const CONFIG = {
  PORT: process.env.PROXY_PORT || 3000,
  HOST: process.env.PROXY_HOST || '0.0.0.0',
  API_KEY: process.env.PROXY_API_KEY || 'codebuddy-proxy-key',
};
const catalog = getCatalog();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`));
  next();
});
const auth = (req, res, next) => {
  const h = req.headers.authorization;
  if (!h || h.slice(7) !== CONFIG.API_KEY) {
    return res.status(401).json({ error: { message: 'API Key 无效', type: 'authentication_error' } });
  }
  next();
};

// ---------- ACP 单例 + 会话表 ----------
const acp = new ACPClient();
let acpReady = null;
async function ensureACP() {
  if (!acpReady) acpReady = acp.start().catch((e) => { acpReady = null; throw e; });
  return acpReady;
}
// sessionId(proxy) -> { id, model, messages, acpSessionId, cwd }
const sessions = new Map();
function getSession(id) { return sessions.get(id); }
function createSession(model, cwd) {
  const s = { id: uuidv4(), model, messages: [], createdAt: Date.now(), acpSessionId: null, cwd: cwd || null };
  sessions.set(s.id, s);
  return s;
}
// 新建 ACP 会话时用动态 cwd (请求带的 session_cwd), 不带则回退静态 WORKSPACE_ROOT。
// 校验: 必须是已存在的绝对目录, 否则 400 (避免 agent 在不存在的目录上起会话)。
function resolveSessionCwd(reqCwd) {
  if (!reqCwd) return null;
  if (!path.isAbsolute(reqCwd)) {
    const e = new Error('session_cwd 必须是绝对路径');
    e.statusCode = 400;
    throw e;
  }
  let st = null;
  try { st = fs.statSync(reqCwd); } catch {}
  if (!st || !st.isDirectory()) {
    const e = new Error('session_cwd 目录不存在: ' + reqCwd);
    e.statusCode = 400;
    throw e;
  }
  return path.resolve(reqCwd);
}
async function ensureAcpSession(s) {
  if (s.acpSessionId) return s.acpSessionId;
  const r = await acp.newSession(s.cwd ? { cwd: s.cwd } : {});
  s.acpSessionId = r.sessionId;
  if (s.cwd) console.log(`[ipc] 会话 ${s.id} 工作区=${s.cwd}`);
  return s.acpSessionId;
}

// ---------- OpenAI <-> ACP 格式 ----------
function openaiToPrompt(messages) {
  const prompt = [];
  for (const m of messages) {
    if (m.role === 'system') prompt.push({ type: 'text', text: `[系统提示]\n${m.content}\n[/系统提示]` });
    else if (m.role === 'user') prompt.push({ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    else if (m.role === 'assistant' && m.content) prompt.push({ type: 'text', text: `[历史助手回复]\n${m.content}` });
    else if (m.role === 'tool' && m.content) prompt.push({ type: 'text', text: `[工具结果]\n${m.content}` });
  }
  return prompt;
}

function sseChunk(model, delta, finish) {
  return {
    id: 'chatcmpl-' + uuidv4().replace(/-/g, ''),
    object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  };
}

// 把 session/update 通知翻译成 OpenAI delta; 返回 { event, text } (text 用于非流式拼接)
function translateUpdate(update, model) {
  const kind = update.sessionUpdate;
  if (kind === 'agent_message_chunk' && update.content && update.content.type === 'text') {
    return { event: sseChunk(model, { content: update.content.text }), text: update.content.text };
  }
  if (kind === 'tool_call') {
    const tc = {
      index: 0, id: update.toolCallId || ('call-' + Date.now()),
      type: 'function',
      function: { name: update.title || update.kind || 'tool', arguments: JSON.stringify(update.rawInput || {}) },
    };
    return { event: sseChunk(model, { tool_calls: [tc] }), text: '', toolCall: tc };
  }
  if (kind === 'tool_call_update' && Array.isArray(update.content)) {
    // 工具输出文本也并入正文, 方便非流式阅读
    const texts = update.content
      .map((c) => {
        if (c.type === 'content' && c.content && typeof c.content.text === 'string') return c.content.text;
        if (c.type === 'diff') return `\n[diff ${c.path || ''}]\n${c.newText || ''}`;
        return '';
      })
      .join('');
    if (texts) return { event: sseChunk(model, { content: texts }), text: texts };
  }
  return null;
}

// ---------- 端点 ----------
app.get('/health', (req, res) => res.json({
  status: 'ok', service: 'CodeBuddy OpenAI Proxy (IPC)', version: '1.0.0',
  acpCommand: acp.command || null, acpStarted: acp.started,
  uptime: process.uptime(), timestamp: Date.now(),
}));
app.get('/', (req, res) => res.json({
  service: 'CodeBuddy OpenAI 兼容代理服务 (IPC 版)', version: '1.0.0',
  endpoints: { models: 'GET /v1/models', chat_completions: 'POST /v1/chat/completions', health: 'GET /health' },
}));
app.get('/v1/models', auth, (req, res) => res.json({ object: 'list', data: catalog.list }));
app.get('/v1/models/refresh', auth, async (req, res) => {
  try {
    const fresh = await require('../lib/models').refreshCatalog();
    catalog.list = fresh.list;
    return res.json({ object: 'list', data: catalog.list, source: fresh.source });
  } catch (e) {
    return res.status(502).json({ error: { message: '刷新失败: ' + e.message, type: 'upstream_error' } });
  }
});

app.post('/v1/chat/completions', auth, async (req, res) => {
  try {
    await ensureACP();
  } catch (e) {
    return res.status(502).json({ error: { message: e.message, type: 'server_error' } });
  }
  try {
    const { messages, stream = false, model: reqModel, session_id, session_cwd } = req.body;
    if (!messages || !messages.length) {
      return res.status(400).json({ error: { message: 'messages 不能为空', type: 'invalid_request_error' } });
    }
    let cwd = null;
    try { cwd = resolveSessionCwd(session_cwd); }
    catch (e) {
      return res.status(e.statusCode || 400).json({ error: { message: e.message, type: 'invalid_request_error' } });
    }
    let sid = session_id;
    if (!sid || !getSession(sid)) sid = createSession(reqModel || 'auto', cwd).id;
    const s = getSession(sid);
    const model = reqModel || s.model || 'auto';
    const acpSessionId = await ensureAcpSession(s);
    // 尽力切换模型 (agent 不支持就忽略, 不阻断)
    const resolved = catalog.resolve(model);
    if (resolved) await acp.setModel(acpSessionId, resolved.model);

    const prompt = openaiToPrompt(messages);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      let full = '';
      const off = acp.onUpdate((params) => {
        if (!params || params.sessionId !== acpSessionId || params.__notification) return;
        const t = params.update ? translateUpdate(params.update, model) : null;
        if (!t) return;
        if (t.text) full += t.text;
        res.write(`data: ${JSON.stringify(t.event)}\n\n`);
      });
      try {
        await acp.prompt({ sessionId: acpSessionId, prompt });
      } catch (e) {
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'server_error' } })}\n\n`);
      } finally { off(); }
      res.write(`data: ${JSON.stringify(sseChunk(model, {}, 'stop'))}\n\n`);
      res.write('data: [DONE]\n\n');
      s.messages.push(...messages, { role: 'assistant', content: full });
      return res.end();
    }

    // 非流式: 收集完整内容
    let full = '';
    const toolCalls = [];
    let finish = 'stop';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('请求超时')); }, acp.timeoutMs);
      const off = acp.onUpdate((params) => {
        if (!params || params.sessionId !== acpSessionId) return;
        const t = params.update ? translateUpdate(params.update, model) : null;
        if (t) {
          if (t.text) full += t.text;
          if (t.toolCall) { toolCalls.push(t.toolCall); finish = 'tool_calls'; }
        }
      });
      acp.prompt({ sessionId: acpSessionId, prompt })
        .then(() => { clearTimeout(timer); off(); resolve(); })
        .catch((e) => { clearTimeout(timer); off(); reject(e); });
    });
    const message = { role: 'assistant', content: full };
    if (toolCalls.length) message.tool_calls = toolCalls;
    s.messages.push(...messages, message);
    return res.json({
      id: 'chatcmpl-' + uuidv4().replace(/-/g, ''),
      object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: {
        prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
        completion_tokens: Math.ceil(full.length / 4),
        total_tokens: Math.ceil((JSON.stringify(messages).length + full.length) / 4),
      },
      session_id: sid,
    });
  } catch (e) {
    console.error('[ipc-proxy]', e.message);
    if (!res.headersSent) res.status(500).json({ error: { message: e.message, type: 'server_error' } });
    else res.end();
  }
});

app.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`
CodeBuddy OpenAI 兼容代理 (IPC 版)
  监听: http://${CONFIG.HOST}:${CONFIG.PORT}
  ACP 命令: ${acp.command ? acp.command + ' ' + acp.args.join(' ') : '❌ 未设置 ACP_COMMAND'}
  工作区: ${acp.root} (写越界: ${acp.allowOutside ? '允许' : '禁止'})
  权限策略: ${acp.permissionPolicy}
  模型目录: ${catalog.list.length} 个 (来源=${catalog.source})
  用法: Authorization: Bearer ${CONFIG.API_KEY}
  `);
});

process.on('SIGINT', async () => { await acp.close(); process.exit(0); });
process.on('SIGTERM', async () => { await acp.close(); process.exit(0); });
