# CodeBuddy OpenAI 兼容代理

把 CodeBuddy 的 AI 能力转成 OpenAI `Chat Completions` 接口（`/v1/chat/completions`、`/v1/models`，支持流式 SSE）。

## 两个版本

| 服务 | 后端 | 启动 |
|---|---|---|
| `server-copilot.js`（已验证） | 云端网关直连（需登录 token） | `npm start` |
| `server-ipc.js` | 本地 ACP agent（stdio IPC） | `npm run start:ipc` |

## 快速开始（网关版）

1. 安装依赖：`npm install`
2. 拿 token（`patch-token-log.js` 给 CodeBuddy 扩展打临时补丁，把 `Authorization` 打印到本地日志）：
   ```powershell
   npm run patch:token              # 打补丁（自动备份原文件为 .bak）
   ```
   完全退出 CodeBuddy 再重启 → 跟 AI 随便聊一句 → 打开 `token-dump.log`，复制 `accessToken=` 后面的值，填进 `.env` 的 `COPILOT_TOKEN`（`X-User-Id` 等有就填进 `COPILOT_HEADERS`）
   拿到后必须清理（补丁随 CodeBuddy 更新会失效，token 是你的登录态）：
   ```powershell
   npm run patch:token-restore      # 还原扩展文件
   del token-dump.log                 # 删除本地 token 记录
   ```
   再重启一次 CodeBuddy 即回到干净状态
3. 启动：`npm start`
4. 调用（OpenAI SDK 均可）：`baseURL=http://localhost:3000/v1`，`apiKey` 为 `.env` 里 `PROXY_API_KEY`，模型用 `/v1/models` 里列出的（如 `hunyuan-2.0-instruct`、`hy3`、`auto`）

token 过期（报 401）时重复上面的拿 token 流程即可。

## IPC 版

`.env` 填写 `ACP_COMMAND`（支持 ACP 的本地 agent 启动命令）、`WORKSPACE_ROOT`、`PERMISSION_POLICY` 后：

```
npm run start:ipc
```

## Zed 接入（ACP 服务端）

`acp-server.js` 就是一个 ACP agent：Zed 当 client 经 stdio 拉起它，`session/prompt` 转发 copilot 网关（流式回推），工具调用（读/写文件、列目录、执行命令）在会话目录本地真实执行。`Zed settings.json`：

```json
{
  "agent_servers": {
    "CodeBuddy": {
      "type": "custom",
      "command": "node",
      "args": ["<repo>/servers/acp-server.js"],
      "env": {}
    }
  }
}
```

`.env` 里 `COPILOT_TOKEN` 等配好即可（`env` 可留空），然后在 Zed Agent 面板切换到 CodeBuddy 开始新线程。`session/set_model` 切模型（`/v1/models` 名单里的 id 都行）。

## 文件说明

| 文件 | 说明 |
|---|---|
| `servers/` | `server-copilot.js`（网关直连）、`server-ipc.js`（本地 ACP）、`acp-server.js`（Zed 用 ACP 服务端） |
| `lib/` | `acp-client.js`（ACP 客户端）、`models.js`（动态模型目录） |
| `tools/` | `gen-pi-models.js`（生成 pi 配置）、`patch-token-log.js`（token 抓取补丁） |
| `data/` | `models-live-*.json`（实时快照）、`models-extracted.json`（静态兜底） |
| `docs/` | 接线文档 |
| `.env` / `.env.example` | 配置（`COPILOT_TOKEN` 等敏感值仅放本地 `.env`） |
| `CONNECT_REAL_BACKEND.md` | 真实后端接线文档 |
| `patch-token-log.js` | token 抓取补丁（`--restore` 还原） |

检查：`npm test`
