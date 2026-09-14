/**
 * 动态模型目录 (v2: 实时优先)
 *
 * 真实链路 (已从 genie 代码验证):
 *   useCBModels.fetchModels
 *     ├─ modelId   = ChatModeController.getModelRecord(chatMode)  // 用户当前选择的模型, 非拉取
 *     └─ rawModels = ChatModeController.getDefaultModels(chatMode)
 *                      = productViewService.getAgents()  (各 agent 的 models id 名单)
 *                      + productViewService.getModels()  (全量模型记录)
 *                      按 agent 名单过滤 (+ vendor=user / tags 含 custom 的自定义模型)
 *   而 ProductViewService 背后是 Extension Host 经 RPC 拿到的 product 配置,
 *   其 HTTP 源头就是: GET {endpoint}/v3/config  (需 User-Agent: CodeBuddyIDE/x.y.z)
 *
 * 所以本模块:
 *   1. 优先实时拉 {base}/v3/config, 复刻 getDefaultModels 过滤逻辑 (TTL 缓存)
 *   2. 失败回退: webview chunk 静态解析 -> models-extracted.json 快照 -> 最小内置表
 *
 * 对外 id 规则:
 *   - 裸 model 名 (gpt-5.4), 重复时首个胜出
 *   - "providerId:model" / "provider/model" 限定名精确指定 (实时源无 providerId, 用 vendor 代替)
 *
 * 环境变量:
 *   MODELS_SOURCE=auto | <chunk文件/目录> | off(跳过静态解析)
 *   MODELS_LIVE=1 | 0            (是否拉实时配置, 默认 1)
 *   MODELS_CHAT_MODE=craft       (按哪个 agent 的名单过滤, 默认 craft)
 *   MODELS_TTL_MS=600000         (实时缓存, 默认 10 分钟)
 *   MODELS_INCLUDE_DEPRECATED / MODELS_INCLUDE_DISABLED=false | true
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_WEBVIEWS_DIR = 'D:/Apps/CodeBuddy CN/resources/app/extensions/genie/out/webviews';
const SNAPSHOT = path.join(__dirname, '..', 'data', 'models-extracted.json');
const APP_PACKAGE = 'D:/Apps/CodeBuddy CN/resources/app/package.json';

const MINIMAL = [
  { providerId: 'tencent-coding', model: 'hunyuan-2.0-instruct', displayName: 'Tencent HY 2.0 Instruct' },
  { providerId: 'tencent-coding', model: 'tc-code-latest', displayName: 'Auto' },
];

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(APP_PACKAGE, 'utf8')).version || '1.106.1';
  } catch { return '1.106.1'; }
}

function authHeaders() {
  const token = process.env.COPILOT_TOKEN || '';
  let extra = {};
  try { extra = JSON.parse(process.env.COPILOT_HEADERS || '{}'); } catch {}
  return {
    'Content-Type': 'application/json',
    'Authorization': token ? `Bearer ${token}` : '',
    'User-Agent': `CodeBuddyIDE/${appVersion()}`,
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
}

function configBase() {
  const ep = (process.env.COPILOT_ENDPOINT || 'https://copilot.tencent.com/v2').replace(/\/$/, '');
  return ep.replace(/\/v2$/, '');
}

// ---- 实时拉取: 复刻 getDefaultModels(chatMode) ----
async function fetchLiveModels() {
  const chatMode = (process.env.MODELS_CHAT_MODE || 'craft').trim() || 'craft';
  const url = configBase() + '/v3/config';
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`live config HTTP ${r.status}`);
  const j = await r.json();
  const d = j.data || j;
  const agents = Array.isArray(d.agents) ? d.agents : [];
  const models = Array.isArray(d.models) ? d.models : [];
  if (!models.length) throw new Error('live config 无 models 字段');

  // agent 名单 (先找 chatMode, 找不到回退 craft, 再没有则不过滤)
  let agent = agents.find(a => a.name === chatMode) || agents.find(a => a.name === 'craft');
  const allowIds = agent && Array.isArray(agent.models) ? agent.models : null;

  const includeDisabled = (process.env.MODELS_INCLUDE_DISABLED || 'false') === 'true';
  const out = [];
  for (const m of models) {
    if (!m || !m.id) continue;
    const inList = !allowIds || allowIds.includes(m.id);
    const isCustom = m.vendor === 'user' || (Array.isArray(m.tags) && m.tags.includes('custom'));
    if (!inList && !isCustom) continue;
    if (m.disabled && !includeDisabled) continue;
    out.push(normalizeLiveModel(m));
  }
  return {
    models: out,
    source: `live:/v3/config(mode=${chatMode},agent=${agent ? agent.name : 'none'})`,
    agents: agents.map(a => a.name),
  };
}

// ---- 静态解析 (回退): webview chunk ----
// vendor 单字母是后端内部计费渠道码, 无解码表, 禁止原样透出 (界面上就是乱码)。
// 规则: 有意义的词 (tencent/user) 保留; 否则按模型 id 前缀推断厂商, 兜底 codebuddy。
function resolveOwner(m) {
  const v = m.vendor;
  if (typeof v === 'string' && v.length > 1) return v;
  const id = (m.id || m.model || '').toLowerCase();
  if (/^(hy\d|hunyuan)/.test(id)) return 'hunyuan';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('glm-')) return 'glm';
  if (id.startsWith('kimi-')) return 'kimi';
  if (id.startsWith('minimax-')) return 'minimax';
  if (/^(codewise|nes-)/.test(id)) return 'codebuddy-builtin';
  return 'codebuddy';
}

// 把 /v3/config 的原始模型记录规整化: 去 iconUrl(data URI Blob), 保留全部描述性字段
function normalizeLiveModel(m) {
  return {
    providerId: resolveOwner(m),
    model: m.id,
    displayName: m.name || m.id,
    descriptionZh: m.descriptionZh || '',
    descriptionEn: m.descriptionEn || '',
    credits: m.credits || '',
    supportsTools: !!m.supportsToolCall,
    supportsImages: !!m.supportsImages,
    supportsReasoning: !!m.supportsReasoning,
    recommended: !!m.isDefault,
    disabled: !!m.disabled,
    temperature: m.temperature,
    top_p: m.top_p,
    reasoning: m.reasoning || null,
    relatedModels: m.relatedModels || null,
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
    maxAllowedSize: m.maxAllowedSize,
    tags: Array.isArray(m.tags) ? m.tags : [],
    vendor: m.vendor,
    status: m.disabled ? 'disabled' : '',
  };
}

function parseChunkModels(src) {
  const re = /\{providerId:"([^"]+)",model:"([^"]+)",displayName:"([^"]*)"(.*?)\}/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const tail = m[4] || '';
    const flag = (k) => tail.includes(k + ':!0');
    const status = (tail.match(/status:"([^"]*)"/) || [])[1] || '';
    out.push({
      providerId: m[1], model: m[2], displayName: m[3],
      supportsTools: flag('supportsTools'), supportsImages: flag('supportsImages'),
      supportsReasoning: flag('supportsReasoning'), recommended: flag('recommended'),
      status,
    });
  }
  return out;
}

function findMainChunk(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => /^main\..*\.chunk\.js$/.test(f))
    .map(f => ({ full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].full : null;
}

function loadStaticModels() {
  const src = (process.env.MODELS_SOURCE || 'auto').trim();
  const includeDeprecated = (process.env.MODELS_INCLUDE_DEPRECATED || 'false') === 'true';
  let raw = [], sourceDesc = '';
  if (src !== 'off') {
    try {
      let chunkFile = null;
      if (src && src !== 'auto') {
        const st = fs.existsSync(src) ? fs.statSync(src) : null;
        chunkFile = st && st.isDirectory() ? findMainChunk(src) : src;
      } else {
        chunkFile = findMainChunk(DEFAULT_WEBVIEWS_DIR);
      }
      if (chunkFile && fs.existsSync(chunkFile)) {
        const parsed = parseChunkModels(fs.readFileSync(chunkFile, 'utf8'));
        if (parsed.length) { raw = parsed; sourceDesc = `chunk:${path.basename(chunkFile)}`; }
      }
    } catch (e) { console.warn('[models] chunk 解析失败:', e.message); }
  }
  if (!raw.length && fs.existsSync(SNAPSHOT)) {
    try { raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); sourceDesc = 'snapshot:models-extracted.json'; }
    catch (e) { console.warn('[models] 快照读取失败:', e.message); }
  }
  if (!raw.length) { raw = MINIMAL; sourceDesc = 'builtin-minimal'; }
  if (!includeDeprecated) raw = raw.filter(m => !/deprecated/i.test(m.status || ''));
  return { raw, sourceDesc };
}

// ---- 目录构建 ----
let _cache = null; // { catalog, expiresAt }

function buildFromEntries(entries, source, rawCount) {
  const byId = new Map();
  const byQualified = new Map();
  for (const m of entries) {
    const q = `${m.providerId}:${m.model}`;
    if (!byQualified.has(q)) byQualified.set(q, m);
    if (!byId.has(m.model)) byId.set(m.model, m);
  }
  const toItem = ([id, m]) => ({
    id, object: 'model', created: Math.floor(Date.now() / 1000),
    owned_by: m.providerId, display_name: m.displayName,
    description_zh: m.descriptionZh || undefined,
    description_en: m.descriptionEn || undefined,
    credits: m.credits || undefined,
    supports_tools: !!m.supportsTools, supports_images: !!m.supportsImages,
    supports_reasoning: !!m.supportsReasoning, recommended: !!m.recommended,
    temperature: m.temperature, top_p: m.top_p,
    reasoning: m.reasoning || undefined,
    related_models: m.relatedModels || undefined,
    max_input_tokens: m.maxInputTokens, max_output_tokens: m.maxOutputTokens,
    tags: m.tags && m.tags.length ? m.tags : undefined,
    ...(m.disabled ? { disabled: true } : {}),
  });
  const list = [...byId.entries()].map(toItem);
  for (const [q, m] of byQualified.entries()) {
    if (byId.has(q)) continue;
    list.push({ ...toItem([q, m]), display_name: `${m.displayName} (${m.providerId})` });
  }
  return {
    source, rawCount, list,
    resolve(requested) {
      if (!requested) return null;
      if (byId.has(requested)) { const m = byId.get(requested); return { providerId: m.providerId, model: m.model, entry: m }; }
      if (byQualified.has(requested)) { const m = byQualified.get(requested); return { providerId: m.providerId, model: m.model, entry: m }; }
      const alt = requested.replace('/', ':');
      if (byQualified.has(alt)) { const m = byQualified.get(alt); return { providerId: m.providerId, model: m.model, entry: m }; }
      return null;
    },
  };
}

async function loadCatalogAsync() {
  const ttl = parseInt(process.env.MODELS_TTL_MS || '600000', 10);
  if (_cache && Date.now() < _cache.expiresAt) return _cache.catalog;

  const liveEnabled = (process.env.MODELS_LIVE || '1') !== '0';
  if (liveEnabled && process.env.COPILOT_TOKEN) {
    try {
      const live = await fetchLiveModels();
      const catalog = buildFromEntries(live.models, live.source, live.models.length);
      console.log(`[models] 来源=${catalog.source} 原始=${live.models.length} 去重=${catalog.list.length}`);
      _cache = { catalog, expiresAt: Date.now() + ttl };
      return catalog;
    } catch (e) {
      console.warn('[models] 实时拉取失败, 回退静态:', e.message);
    }
  } else if (liveEnabled) {
    console.warn('[models] 未设置 COPILOT_TOKEN, 跳过实时拉取, 用静态表');
  }

  const { raw, sourceDesc } = loadStaticModels();
  const catalog = buildFromEntries(raw, sourceDesc, raw.length);
  console.log(`[models] 来源=${catalog.source} 原始=${raw.length} 去重=${catalog.list.length}`);
  _cache = { catalog, expiresAt: Date.now() + Math.min(ttl, 60000) };
  return catalog;
}

// 同步入口: 首次用静态表顶住, 后台自动升级为实时表
let _syncCatalog = null;
function getCatalog() {
  if (!_syncCatalog) {
    const { raw, sourceDesc } = loadStaticModels();
    _syncCatalog = buildFromEntries(raw, sourceDesc, raw.length);
    console.log(`[models] 同步初值 来源=${sourceDesc} 去重=${_syncCatalog.list.length}`);
    if ((process.env.MODELS_LIVE || '1') !== '0' && process.env.COPILOT_TOKEN) {
      loadCatalogAsync().then(c => { syncInto(_syncCatalog, c); }).catch(() => {});
    }
  }
  return _syncCatalog;
}

function syncInto(dst, src) {
  if (!dst) return src;
  dst.list = src.list;
  dst.source = src.source;
  dst.rawCount = src.rawCount;
  dst.resolve = src.resolve;
  return dst;
}

async function refreshCatalog() {
  _cache = null;
  const c = await loadCatalogAsync();
  _syncCatalog = syncInto(_syncCatalog, c);
  return _syncCatalog;
}

module.exports = { getCatalog, refreshCatalog, loadCatalogAsync, buildFromEntries, parseChunkModels, normalizeLiveModel, resolveOwner };
