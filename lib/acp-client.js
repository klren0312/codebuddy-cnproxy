/**
 * ACP JSON-RPC 客户端 (stdio/IPC 传输)
 *
 * 对应 CodeBuddy genie 扩展里的 ACP 方法表:
 *   Agent 侧: authenticate / initialize / session/new / session/load / session/prompt /
 *             session/cancel / session/set_mode / session/set_model / session/list ...
 *   Client 侧(本文件实现): fs/read_text_file / fs/write_text_file /
 *             terminal/create|output|wait_for_exit|kill|release /
 *             session/request_permission / session/update(通知)
 *
 * 传输: 子进程 stdio, LSP 式 Content-Length 帧, 兼容纯 NDJSON 行。
 *
 * 环境变量:
 *   ACP_COMMAND=...        Agent 启动命令 (必填, 例: 先用支持 ACP 的本地 agent)
 *   ACP_ARGS=...           启动参数, 空格分隔
 *   ACP_CWD=...            Agent 工作目录 (默认进程 cwd)
 *   WORKSPACE_ROOT=...     fs/terminal 根目录, 写操作限制在此内 (默认 cwd)
 *   ALLOW_WRITE_OUTSIDE=1  允许写根目录之外 (默认 0 禁止)
 *   PERMISSION_POLICY=allow|deny   权限请求策略 (默认 allow, headless 下 ask 等同 deny)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class ACPClient {
  constructor(opts = {}) {
    this.command = opts.command || process.env.ACP_COMMAND || '';
    this.args = opts.args ?? (process.env.ACP_ARGS ? process.env.ACP_ARGS.split(' ').filter(Boolean) : []);
    this.agentCwd = opts.cwd || process.env.ACP_CWD || process.cwd();
    // 本地 fs/terminal 强制执行仍需一个根 (默认本进程 cwd)
    this.root = path.resolve(opts.root || process.env.WORKSPACE_ROOT || process.cwd());
    // 转发给 agent 的会话 cwd 只在显式指定时才发, 否则省略该字段,
    // 让 agent 用它自己的默认目录 (见 newSession)
    const explicit = opts.root ?? process.env.WORKSPACE_ROOT ?? null;
    this.explicitCwd = explicit ? path.resolve(explicit) : null;
    this.allowOutside = (process.env.ALLOW_WRITE_OUTSIDE || '0') === '1';
    this.permissionPolicy = (process.env.PERMISSION_POLICY || 'allow').toLowerCase();
    this.timeoutMs = opts.timeoutMs || parseInt(process.env.ACP_REQUEST_TIMEOUT || '300000', 10);
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.updateHandlers = new Set();
    this.requestHandlers = new Map();
    this.terminals = new Map(); // terminalId -> { proc, output, exited, exitCode }
    this.termSeq = 0;
    this.started = false;
    this._registerBuiltinHandlers();
  }

  // ---------- 生命周期 ----------

  _assertCommand() {
    if (!this.command) {
      throw new Error(
        '未设置 ACP_COMMAND。请安装一个支持 ACP 协议的本地 agent, 然后例如:\n' +
        '  ACP_COMMAND="your-agent --acp" node server-ipc.js\n' +
        '或在 .env 里填写 ACP_COMMAND / ACP_ARGS。'
      );
    }
  }

  async start() {
    if (this.started) return;
    this._assertCommand();
    // Windows 下 npm 全局安装的 CLI 都是 .cmd 垫片 (claude/codex/opencode),
    // 不带 shell 直接 spawn 会 ENOENT, 所以 win32 统一走 shell。
    // 失败时给出 which 提示, 而不是裸 ENOENT 崩进程。
    const spawnOpts = { cwd: this.agentCwd, stdio: ['pipe', 'pipe', 'pipe'] };
    if (process.platform === 'win32') spawnOpts.shell = true;
    try {
      this.proc = spawn(this.command, this.args, spawnOpts);
    } catch (e) {
      throw new Error(`无法启动 ACP agent "${this.command}": ${e.message} (确认已安装且在 PATH 中, Windows 下 npm 全局包需 shell 支持)`);
    }
    this.proc.on('error', (e) => {
      console.error(`[acp] 启动失败 "${this.command} ${this.args.join(' ')}": ${e.message}`);
      console.error(`[acp] 请确认该命令存在 (where ${this.command}) 且支持 ACP 模式; 切回内置自闭环可用: ACP_COMMAND=node / ACP_ARGS=<repo>/servers/acp-server.js`);
    });
    this.proc.stdout.on('data', (c) => this._onData(c));
    this.proc.stderr.on('data', (c) => console.error('[acp:stderr] ' + String(c).slice(0, 500)));
    this.proc.on('exit', (code, sig) => {
      console.error(`[acp] agent 退出 code=${code} sig=${sig}`);
      this.started = false;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('agent 已退出')); }
      this.pending.clear();
    });
    this.started = true;
    // 握手 (字段缺失就容错, 不同 agent 实现松紧不一)
    try { await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } }, 15000); }
    catch (e) { console.warn('[acp] initialize 失败, 继续尝试:', e.message); }
    try { await this.request('authenticate', {}, 15000); } catch { /* 无需认证的 agent 直接过 */ }
    console.log(`[acp] 已连接: ${this.command} ${this.args.join(' ')}`);
  }

  async close() {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('client 关闭')); }
    this.pending.clear();
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    this.started = false;
  }

  // ---------- JSON-RPC 帧 ----------

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      // 优先 LSP 式 Content-Length 帧
      const headEnd = this.buf.indexOf('\r\n\r\n');
      if (headEnd >= 0) {
        const head = this.buf.slice(0, headEnd).toString('utf8');
        const m = head.match(/Content-Length:\s*(\d+)/i);
        if (m) {
          const len = parseInt(m[1], 10);
          if (this.buf.length < headEnd + 4 + len) return; // 等更多数据
          const body = this.buf.slice(headEnd + 4, headEnd + 4 + len).toString('utf8');
          this.buf = this.buf.slice(headEnd + 4 + len);
          this._handleMessage(body);
          continue;
        }
      }
      // 回退 NDJSON: 按行解析
      const nl = this.buf.indexOf('\n');
      if (nl < 0) return;
      const line = this.buf.slice(0, nl).toString('utf8').trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this._handleMessage(line);
    }
  }

  _send(obj) {
    // ACP 规范 stdio 传输必须是 NDJSON (单行 JSON + \n, stdout 禁止其它内容)。
    // JSON.stringify 会转义字符串内的换行, 输出天然单行。接收侧保留双兼容
    // (自家 acp-server 历史上发 Content-Length 帧), 见 _onData。
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params = {}, timeoutMs) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP 请求超时: ${method}`));
      }, timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _handleMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    // 响应
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`ACP 错误 ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    // 对端请求
    if (msg.method && msg.id !== undefined) {
      this._dispatchClientRequest(msg.method, msg.params || {})
        .then((result) => this._send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }))
        .catch((e) => this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } }));
      return;
    }
    // 对端通知: session/update 原样投递, 其它 extNotification 带标记透传 (避免重复处理)
    if (msg.method) {
      if (msg.method === 'session/update') {
        this.updateHandlers.forEach((cb) => { try { cb(msg.params); } catch (e) { console.error(e); } });
      } else {
        this.updateHandlers.forEach((cb) => { try { cb({ __notification: msg.method, ...(msg.params || {}) }); } catch {} });
      }
    }
  }

  onUpdate(cb) {
    this.updateHandlers.add(cb);
    return () => this.updateHandlers.delete(cb);
  }

  async _dispatchClientRequest(method, params) {
    const h = this.requestHandlers.get(method);
    if (!h) {
      // 未实现的 terminal  variations 等: 返回空, 让 agent 继续 (部分 agent 可容忍)
      if (method.startsWith('terminal/') || method.startsWith('fs/')) {
        throw new Error(`未实现的客户端方法: ${method}`);
      }
      return {};
    }
    return h(params);
  }

  // ---------- Client 侧方法实现 ----------

  _safePath(p) {
    const abs = path.resolve(this.root, p);
    if (!this.allowOutside) {
      const rel = path.relative(this.root, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`拒绝越界路径: ${p}`);
    }
    return abs;
  }

  _registerBuiltinHandlers() {
    this.requestHandlers.set('fs/read_text_file', async (p) => {
      const file = this._safePath(p.path || p.filePath || '');
      const content = await fs.promises.readFile(file, 'utf8');
      return { content };
    });
    this.requestHandlers.set('fs/write_text_file', async (p) => {
      const file = this._safePath(p.path || p.filePath || '');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, p.content ?? '', 'utf8');
      return {};
    });
    this.requestHandlers.set('terminal/create', async (p) => {
      const id = `term-${++this.termSeq}`;
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const child = spawn(p.command || shell, p.args || [], {
        cwd: p.cwd ? this._safePath(p.cwd) : this.root,
        env: { ...process.env, ...(p.env || {}) },
        shell: !p.command,
      });
      const t = { proc: child, output: '', exited: false, exitCode: null };
      this.terminals.set(id, t);
      child.stdout.on('data', (c) => { t.output += String(c); });
      child.stderr.on('data', (c) => { t.output += String(c); });
      child.on('exit', (code) => { t.exited = true; t.exitCode = code; });
      // 如果带了 command 且非交互: 写完即等退出由 wait_for_exit 处理
      return { terminalId: id };
    });
    this.requestHandlers.set('terminal/output', async (p) => {
      const t = this.terminals.get(p.terminalId);
      if (!t) throw new Error('未知 terminal: ' + p.terminalId);
      const out = t.output;
      t.output = '';
      return { output: out, truncated: false, exited: t.exited };
    });
    this.requestHandlers.set('terminal/wait_for_exit', async (p) => {
      const t = this.terminals.get(p.terminalId);
      if (!t) throw new Error('未知 terminal: ' + p.terminalId);
      const timeout = p.timeoutMs ?? 120000;
      const t0 = Date.now();
      while (!t.exited && Date.now() - t0 < timeout) await new Promise((r) => setTimeout(r, 200));
      return { exitCode: t.exitCode, output: t.output };
    });
    this.requestHandlers.set('terminal/kill', async (p) => {
      const t = this.terminals.get(p.terminalId);
      if (t) { try { t.proc.kill(); } catch {} }
      return {};
    });
    this.requestHandlers.set('terminal/release', async (p) => {
      const t = this.terminals.get(p.terminalId);
      if (t) { try { t.proc.kill(); } catch {} this.terminals.delete(p.terminalId); }
      return {};
    });
    this.requestHandlers.set('session/request_permission', async (p) => {
      const options = p.options || [];
      console.log(`[acp] 权限请求 tool=${JSON.stringify((p.toolCall || {}).title || p.toolCall)} options=${options.map((o) => o.optionId).join(',')}`);
      if (this.permissionPolicy === 'deny') {
        const reject = options.find((o) => /reject|deny|cancel/i.test(o.optionId || '')) || options[0];
        return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
      }
      const allow = options.find((o) => /allow/i.test(o.optionId || '')) || options[0];
      if (!allow) return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    });
  }

  // ---------- Agent 侧便捷方法 ----------

  async newSession(params = {}) {
    // cwd 缺省时不发该字段: agent 用自己的默认执行目录
    // (acp-server 侧是 params.cwd || 其进程 cwd)。优先级: 请求 session_cwd > WORKSPACE_ROOT。
    const p = { mcpServers: params.mcpServers || [] };
    const cwd = params.cwd || this.explicitCwd;
    if (cwd) p.cwd = cwd;
    const r = await this.request('session/new', p);
    return r.sessionId ? r : { sessionId: r.sessionId || r.id };
  }

  async loadSession(params) { return this.request('session/load', params); }
  async setModel(sessionId, model) {
    try { return await this.request('session/set_model', { sessionId, model }); }
    catch (e) { console.warn('[acp] set_model 忽略:', e.message); return {}; }
  }
  async setMode(sessionId, mode) {
    try { return await this.request('session/set_mode', { sessionId, mode }); }
    catch (e) { console.warn('[acp] set_mode 忽略:', e.message); return {}; }
  }
  async cancel(sessionId) { this.notify('session/cancel', { sessionId }); }
  async prompt(params) { return this.request('session/prompt', params, this.timeoutMs); }
}

module.exports = { ACPClient };
