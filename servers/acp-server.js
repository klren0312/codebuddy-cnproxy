/**
 * ACP 服务端 (给 Zed / 任何 ACP 客户端用)
 *
 * 角色: 我们是 Agent, Zed 是 Client。Zed 通过 stdio 拉起本进程 (JSON-RPC 2.0):
 *   initialize / authenticate / session/new / session/prompt / session/cancel ...
 * 本进程把 prompt 转成 OpenAI Chat Completions 发往 copilot 网关 (流式),
 * 文本增量实时以 session/update (agent_message_chunk) 推给 Zed;
 * 上游返回 tool_calls 时在本地 WORKSPACE (取 session/new 的 cwd) 真实执行
 * (read_file / write_file / execute_command / list_files), 并以
 * tool_call / tool_call_update 通知 Zed 展示, 结果回填继续循环 (最多 25 轮)。
 *
 * Zed settings.json:
 *   { "agent_servers": { "CodeBuddy": {
 *       "type": "custom",
 *       "command": "node",
 *       "args": ["<repo>/servers/acp-server.js"],
 *       "env": {}
 *   } } }
 * 本文件自己读同目录 .env (COPILOT_TOKEN / COPILOT_ENDPOINT / COPILOT_HEADERS / COPILOT_MODEL),
 * 所以 env 可留空。Windows 路径含空格没关系, args 是数组逐个传参。
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true }); // quiet: dotenv 17 默认往 stdout 打 injected env, 会污染 ACP 流
// ACP stdio 传输必须是 NDJSON: stdout 只允许单行 JSON, 日志走 stderr。
// lib/models.js 里有 console.log/warn (默认写 stdout), 在此进程内全部重定向到 stderr,
// 否则 Zed 解析到非 ACP 行就一直 loading。
const _toErr = (...a) => process.stderr.write(a.map((x) => String(x)).join(' ') + '\n');
console.log = _toErr; console.warn = _toErr; console.info = _toErr; console.debug = _toErr;
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getCatalog } = require('../lib/models');

const catalog = getCatalog();
const ENDPOINT = (process.env.COPILOT_ENDPOINT || 'https://copilot.tencent.com/v2').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.COPILOT_MODEL || 'hy3';
const MAX_TURNS = 25;

function buildHeaders() {
  if (!process.env.COPILOT_TOKEN) throw new Error('未设置 COPILOT_TOKEN (.env)');
  let extra = {};
  try { extra = JSON.parse(process.env.COPILOT_HEADERS || '{}'); } catch {}
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.COPILOT_TOKEN}`,
    'User-Agent': 'CodeBuddyIDE/1.106.1',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
}

// ---------- JSON-RPC stdio (NDJSON) ----------
// 规范: stdio 下消息按行分隔 (\n), stdout 禁止出现非 ACP 内容。
// 之前这里发的是 LSP 式 Content-Length 帧, Zed 解析不到才一直 loading。
// 接收侧保留 Content-Length 兼容 (自家的 lib/acp-client.js 发的是那种帧), 双向都能对上。
let buf = Buffer.alloc(0);
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function sendResult(id, result) { send({ jsonrpc: '2.0', id, result: result ?? {} }); }
function sendError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
const log = (...a) => process.stderr.write('[acp-server] ' + a.join(' ') + '\n');

process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const headEnd = buf.indexOf('\r\n\r\n');
    if (headEnd >= 0) {
      const m = buf.slice(0, headEnd).toString('utf8').match(/Content-Length:\s*(\d+)/i);
      if (m) {
        const len = parseInt(m[1], 10);
        if (buf.length < headEnd + 4 + len) return;
        handleRaw(buf.slice(headEnd + 4, headEnd + 4 + len).toString('utf8'));
        buf = buf.slice(headEnd + 4 + len);
        continue;
      }
    }
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl).toString('utf8').trim();
    buf = buf.slice(nl + 1);
    if (line) handleRaw(line);
  }
});
function handleRaw(text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { log('JSON 解析失败:', e.message); return; }
  if (Array.isArray(msg)) { for (const m of msg) { if (m && m.method) handleOne(m); } return; }
  if (!msg || !msg.method) return;
  handleOne(msg);
}
function handleOne(msg) {
  dispatch(msg.method, msg.params || {}, msg.id).then(
    (r) => { if (msg.id !== undefined && r !== undefined) sendResult(msg.id, r); },
    (e) => {
      if (msg.id === undefined) return;
      if (e && e.code === -32601) sendError(msg.id, -32601, e.message);
      else sendError(msg.id, -32603, String((e && e.message) || e));
    }
  );
}

// ---------- 会话表 ----------
const sessions = new Map(); // sessionId -> { cwd, model, abort }
function sess(id) {
  if (!sessions.has(id)) sessions.set(id, { cwd: process.cwd(), model: DEFAULT_MODEL, abort: null });
  return sessions.get(id);
}

// ---------- 本地工具 (在 session cwd 下执行) ----------
function safeJoin(root, p) {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('拒绝越界路径: ' + p);
  return abs;
}
const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: '读取工作区文件内容', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入/创建工作区文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'list_files', description: '列出目录', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'execute_command', description: '执行 shell 命令(120s超时)', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
];
async function execTool(root, name, args) {
  if (name === 'read_file') return await fs.promises.readFile(safeJoin(root, args.path), 'utf8');
  if (name === 'write_file') {
    const f = safeJoin(root, args.path);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    await fs.promises.writeFile(f, args.content ?? '', 'utf8');
    return `已写入 ${args.path} (${(args.content ?? '').length} 字符)`;
  }
  if (name === 'list_files') {
    const d = safeJoin(root, args.path || '.');
    return (await fs.promises.readdir(d)).join('\n');
  }
  if (name === 'execute_command') {
    return await new Promise((resolve) => {
      execFile(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        process.platform === 'win32' ? ['/c', args.command] : ['-c', args.command],
        { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => resolve((stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '') + (err ? `\n[exit] ${err.message}` : '')));
    });
  }
  throw new Error('未知工具: ' + name);
}

// ---------- 上游流式调用 ----------
async function chatStream(model, messages, signal, onDelta) {
  // onDelta(delta) 其中 delta={content?, tool_calls?[], finish_reason?}
  const r = await fetch(`${ENDPOINT}/chat/completions`, {
    method: 'POST', headers: buildHeaders(),
    body: JSON.stringify({ model, messages, stream: true, tools: TOOLS }),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`上游 ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let b = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      b += decoder.decode(value, { stream: true });
      const evs = b.split('\n\n');
      b = evs.pop() || '';
      for (const ev of evs) {
        for (const line of ev.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const p = t.slice(5).trim();
          if (!p || p === '[DONE]') continue;
          let e;
          try { e = JSON.parse(p); } catch { continue; }
          const ch = e.choices && e.choices[0];
          if (!ch) continue;
          const d = ch.delta || {};
          const out = {};
          if (typeof d.content === 'string' && d.content) out.content = d.content;
          if (Array.isArray(d.tool_calls) && d.tool_calls.length) out.tool_calls = d.tool_calls;
          if (ch.finish_reason) out.finish_reason = ch.finish_reason;
          if (Object.keys(out).length) onDelta(out);
        }
      }
    }
  } finally { reader.releaseLock(); }
}

// ---------- ACP 方法 ----------
async function dispatch(method, params, id) {
  switch (method) {
    case 'initialize': {
      // 版本协商: 只实现 v1; 客户端要 1 就回 1, 要更高就回我们支持的最高版 (1),
      // 客户端不支持会主动断开并提示, 比回一个假版本号然后全程异常要好。
      const want = params.protocolVersion ?? 1;
      return {
        protocolVersion: Math.min(want, 1),
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: { name: 'codebuddy-proxy', title: 'CodeBuddy', version: '1.0.0' },
      };
    }
    case 'authenticate':
    case 'auth/login': return {};
    case 'session/new': {
      const s = sess(`sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      s.cwd = params.cwd || process.cwd();
      return { sessionId: [...sessions.entries()].find(([, v]) => v === s)[0] };
    }
    case 'session/load': {
      if (params.sessionId) sess(params.sessionId);
      if (params.cwd) sess(params.sessionId).cwd = params.cwd;
      return {};
    }
    case 'session/resume': {
      // 不回放历史, 直接恢复上下文继续
      if (params.sessionId) sess(params.sessionId);
      if (params.cwd) sess(params.sessionId).cwd = params.cwd;
      return {};
    }
    case 'session/list': return { sessions: [] };
    case 'session/close': {
      const s = sessions.get(params.sessionId);
      if (s && s.abort) s.abort.abort();
      sessions.delete(params.sessionId);
      return {};
    }
    case 'session/set_model': {
      const s = sess(params.sessionId);
      const r = catalog.resolve(params.model);
      s.model = r ? r.model : params.model;
      return {};
    }
    case 'session/set_mode':
    case 'session/set_config_option': return {};
    case 'session/cancel': {
      const s = sessions.get(params.sessionId);
      if (s && s.abort) s.abort.abort();
      return {};
    }
    case 'session/prompt': return handlePrompt(params);
    default:
      throw Object.assign(new Error('Method not found: ' + method), { code: -32601 });
  }
}

function promptToMessages(prompt) {
  const texts = [];
  for (const b of prompt || []) {
    if (b.type === 'text' && b.text) texts.push(b.text);
    else if (b.type === 'resource' && b.resource) texts.push(`[嵌入资源 ${b.resource.uri || ''}]\n${(b.resource.text || '').slice(0, 8000)}`);
    else if (b.type === 'resource_link') texts.push(`[资源链接] ${b.name || b.uri}: ${b.uri}`);
    else texts.push(`[${b.type || '未知内容块'}]`);
  }
  return [{ role: 'user', content: texts.join('\n\n') }];
}

async function handlePrompt(params) {
  const { sessionId } = params;
  const s = sess(sessionId);
  const ctl = new AbortController();
  s.abort = ctl;
  const messages = promptToMessages(params.prompt);
  const upd = (u) => notify('session/update', { sessionId, update: u });
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (ctl.signal.aborted) return { stopReason: 'cancelled' };
      const calls = {}; // index -> {id,name,args}
      let finish = null;
      await chatStream(s.model, messages, ctl.signal, (d) => {
        if (d.content) upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: d.content } });
        for (const tc of d.tool_calls || []) {
          const i = tc.index ?? 0;
          calls[i] = calls[i] || { id: '', name: '', args: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function) {
            if (tc.function.name) calls[i].name += tc.function.name;
            if (typeof tc.function.arguments === 'string') calls[i].args += tc.function.arguments;
          }
        }
        if (d.finish_reason) finish = d.finish_reason;
      });
      const list = Object.values(calls).filter((c) => c.id || c.name);
      if (!list.length) return { stopReason: finish === 'cancelled' ? 'cancelled' : 'end_turn' };
      // 有工具调用: 通知 Zed + 本地执行 + 回填
      messages.push({ role: 'assistant', content: '', tool_calls: list.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) });
      for (const c of list) {
        const toolCallId = c.id || `call-${Date.now()}`;
        upd({ sessionUpdate: 'tool_call', toolCallId, title: c.name, kind: 'other', status: 'pending' });
        let result;
        try {
          let args = {};
          try { args = JSON.parse(c.args || '{}'); } catch {}
          result = await execTool(s.cwd, c.name, args);
          upd({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: String(result).slice(0, 4000) } }] });
        } catch (e) {
          result = `工具执行失败: ${e.message}`;
          upd({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: result } }] });
        }
        messages.push({ role: 'tool', tool_call_id: toolCallId, content: String(result).slice(0, 8000) });
      }
    }
    return { stopReason: 'max_turn_requests' };
  } catch (e) {
    if (e.name === 'AbortError' || /abort/i.test(e.message)) return { stopReason: 'cancelled' };
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n[代理错误] ${e.message}` } } });
    return { stopReason: 'end_turn' };
  } finally { s.abort = null; }
}

log(`ACP server就绪 model=${DEFAULT_MODEL} endpoint=${ENDPOINT}`);
