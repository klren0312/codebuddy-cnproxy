// 生成 pi 的 codebuddy provider 配置, 合并进 ~/.pi/agent/models.json (保留原有 providers)
// 用法: npm run gen:pi-models [--dry-run]
// 来源: models-live-catalog.json (实时) + .env (PROXY_API_KEY)
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.resolve(__dirname, '..');
function loadEnv() {
  for (const line of fs.readFileSync(path.join(DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const CHAT_AGENTS = new Set(['craft', 'ask', 'plan', 'chat', 'agent']);
const catalog = JSON.parse(fs.readFileSync(path.join(DIR, 'models-live-catalog.json'), 'utf8'));

// 只收录聊天类 agent 可用的模型 (排除代码补全/图像等专用模型, 排除 provider: 限定名, 上游只认裸 id)
const chatModels = catalog.data.filter((m) => !m.disabled && !m.id.includes(':') && (m.agents || []).some((a) => CHAT_AGENTS.has(a)));
const models = chatModels.map((m) => ({
  id: m.id,
  name: `${m.display_name || m.id} (CodeBuddy)`,
  reasoning: false, // 上游 thinking 内置, pi 不控制 effort (避免 developer role / reasoning_effort 不兼容)
  input: m.supports_images ? ['text', 'image'] : ['text'],
  contextWindow: m.max_input_tokens || 128000,
  maxTokens: m.max_output_tokens || 16384,
}));
// hunyuan-2.0-instruct 不在实时名单但实测可用, 手动补上
if (!models.some((m) => m.id === 'hunyuan-2.0-instruct')) {
  models.push({
    id: 'hunyuan-2.0-instruct', name: 'Hunyuan 2.0 Instruct (CodeBuddy)',
    reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 64000,
  });
}

const provider = {
  codebuddy: {
    name: 'CodeBuddy (本地反代)',
    baseUrl: 'http://localhost:3000/v1',
    api: 'openai-completions',
    apiKey: process.env.PROXY_API_KEY || 'codebuddy-proxy-key',
    compat: {
      supportsDeveloperRole: false, // 上游不认 developer role, 用 system
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
    },
    models,
  },
};

const target = path.join(os.homedir(), '.pi', 'agent', 'models.json');
const cur = JSON.parse(fs.readFileSync(target, 'utf8'));
cur.providers = cur.providers || {};
cur.providers.codebuddy = provider.codebuddy;

if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify(provider, null, 2).slice(0, 2000));
  console.log(`...共 ${models.length} 个模型`);
  process.exit(0);
}
if (!fs.existsSync(target + '.bak')) {
  fs.copyFileSync(target, target + '.bak');
  console.log('已备份: ' + target + '.bak');
}
fs.writeFileSync(target, JSON.stringify(cur, null, 2));
console.log(`已写入 ${models.length} 个模型 -> ${target} [provider: codebuddy]`);
console.log('模型: ' + models.map((m) => m.id).join(', '));
