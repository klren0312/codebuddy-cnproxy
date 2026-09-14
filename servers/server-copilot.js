/**
 * CodeBuddy 真实后端直连代理
 *
 * 原理 (已从 genie/out/extension/index.js 验证):
 * - AI 网关默认: https://copilot.tencent.com/v2
 * - 内部 Pulse 模型用 OpenAI 兼容协议: POST {baseUrl}/chat/completions
 * - 鉴权: Authorization: Bearer <accessToken> + X-User-Id / X-Enterprise-Id 等
 * - token 来自 CodeBuddy 登录态 (AuthenticationManager.currentSessionSubject)
 *
 * 用法:
 *   1. 抓包或从日志拿到你的 accessToken 和相关头 (见 CONNECT_REAL_BACKEND.md)
 *   2. set COPILOT_TOKEN=eyJ... && set COPILOT_ENDPOINT=https://copilot.tencent.com/v2
 *   3. npm start
 *   4. 用 OpenAI SDK 指到 http://localhost:3000/v1 即可
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const { getCatalog } = require('../lib/models');
const catalog = getCatalog();

const CONFIG = {
  PORT: process.env.PROXY_PORT || 3000,
  HOST: process.env.PROXY_HOST || '0.0.0.0',
  API_KEY: process.env.PROXY_API_KEY || 'codebuddy-proxy-key',
  ENDPOINT: (process.env.COPILOT_ENDPOINT || 'https://copilot.tencent.com/v2').replace(/\/$/, ''),
  TOKEN: process.env.COPILOT_TOKEN || '',
  MODEL: process.env.COPILOT_MODEL || 'pulse-beta',
  // 可选透传头 (从抓包复制): JSON 字符串
  // e.g. {"X-User-Id":"123","X-Enterprise-Id":"abc","X-Domain":"...","X-Product":"...","X-IDE-Name":"..."}
  EXTRA_HEADERS: (() => { try { return JSON.parse(process.env.COPILOT_HEADERS || '{}'); } catch { return {}; } })(),
};

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

function buildHeaders() {
  if (!CONFIG.TOKEN) throw new Error('未设置 COPILOT_TOKEN (CodeBuddy 登录 accessToken)');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${CONFIG.TOKEN}`,
    ...CONFIG.EXTRA_HEADERS,
  };
}

// 上游仅支持流式: 非流式请求也用 stream=true 上游调用, 在此拼成完整响应
async function collectStreamAsCompletion(upstream, wanted) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  const toolCalls = {};
  let finishReason = "stop";
  let usage = null;
  let upstreamId = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() || "";
      for (const ev of events) {
        for (const line of ev.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.id && !upstreamId) upstreamId = evt.id;
          if (evt.usage) usage = evt.usage;
          const ch = evt.choices && evt.choices[0];
          if (!ch) continue;
          const d = ch.delta || ch.message || {};
          if (typeof d.content === "string") content += d.content;
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              const i = tc.index ?? 0;
              toolCalls[i] = toolCalls[i] || { index: i, id: "", type: "function", function: { name: "", arguments: "" } };
              if (tc.id) toolCalls[i].id = tc.id;
              if (tc.type) toolCalls[i].type = tc.type;
              if (tc.function) {
                if (tc.function.name) toolCalls[i].function.name += tc.function.name;
                if (typeof tc.function.arguments === "string") toolCalls[i].function.arguments += tc.function.arguments;
              }
            }
          }
          if (ch.finish_reason) finishReason = ch.finish_reason;
        }
      }
    }
  } finally { reader.releaseLock(); }
  const message = { role: "assistant", content };
  const tcs = Object.values(toolCalls);
  if (tcs.length) { message.tool_calls = tcs; if (finishReason === "stop") finishReason = "tool_calls"; }
  const promptTokens = Math.ceil(JSON.stringify(upstreamId || wanted).length / 4);
  return {
    id: upstreamId || ("chatcmpl-" + Date.now()),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: wanted,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage || { prompt_tokens: promptTokens, completion_tokens: Math.ceil(content.length / 4), total_tokens: promptTokens + Math.ceil(content.length / 4) },
  };
}
app.get('/health', (req, res) => res.json({ status: 'ok', endpoint: CONFIG.ENDPOINT, model: CONFIG.MODEL, hasToken: !!CONFIG.TOKEN }));

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
    const { messages, stream = false, temperature, max_tokens, tools, tool_choice, model: reqModel } = req.body;
    if (!messages?.length) return res.status(400).json({ error: { message: 'messages 不能为空', type: 'invalid_request_error' } });

    // 动态模型解析: 裸名 (gpt-5.4) / 限定名 (openai:gpt-5.4), 未知则透传, 缺省 COPILOT_MODEL
    const wanted = reqModel || CONFIG.MODEL;
    const resolved = catalog.resolve(wanted);
    const upstreamModel = resolved ? resolved.model : wanted;
    if (!resolved) console.warn('[copilot-proxy] 未知模型 ' + wanted + ', 直接透传上游');
    const upstreamBody = { model: upstreamModel, messages, stream: true }; // 上游仅支持流式
    if (temperature !== undefined) upstreamBody.temperature = temperature;
    if (max_tokens !== undefined) upstreamBody.max_tokens = max_tokens;
    if (tools) upstreamBody.tools = tools;
    if (tool_choice) upstreamBody.tool_choice = tool_choice;

    const upstream = await fetch(`${CONFIG.ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(upstreamBody),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return res.status(upstream.status || 502).json({ error: { message: `上游错误 ${upstream.status}: ${text.slice(0, 500)}`, type: 'upstream_error' } });
    }
    if (!stream) {
      // 客户端要非流式: 消费上游 SSE 后拼成完整 ChatCompletion 返回
      const completed = await collectStreamAsCompletion(upstream, wanted);
      completed.session_id = undefined;
      return res.json(completed);
    }

    // 流式: 直接透传 SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally { reader.releaseLock(); }
    res.end();
  } catch (e) {
    console.error('[copilot-proxy]', e.message);
    if (!res.headersSent) res.status(500).json({ error: { message: e.message, type: 'server_error' } });
    else res.end();
  }
});

app.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`
CodeBuddy 真实后端直连代理
  监听: http://${CONFIG.HOST}:${CONFIG.PORT}
  上游: ${CONFIG.ENDPOINT}/chat/completions
  默认模型: ${CONFIG.MODEL}
  模型目录: ${catalog.list.length} 个 (来源=${catalog.source})
  Token: ${CONFIG.TOKEN ? '已设置 (' + CONFIG.TOKEN.slice(0, 8) + '...)' : '❌ 未设置 COPILOT_TOKEN'}
  用法: Authorization: Bearer ${CONFIG.API_KEY}
  `);
});
