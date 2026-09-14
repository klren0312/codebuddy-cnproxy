# AGENTS.md — codebuddy-cnproxy

把 CodeBuddy 的 AI 能力转成 OpenAI 兼容接口 (`/v1/chat/completions`, `/v1/models`, SSE) 与 ACP 服务端，供 pi / Zed / OpenAI SDK 调用。

## 目录结构

```
servers/  server-copilot.js  云端网关直连 (已验证, 主力)
          server-ipc.js      本地 ACP agent 驱动 (stdio IPC)
          acp-server.js      ACP 服务端 (给 Zed agent_servers 用)
lib/      acp-client.js      ACP JSON-RPC 客户端 (fs/terminal/permission)
          models.js          动态模型目录 (实时优先, 静态回退)
tools/    gen-pi-models.js   生成 pi 的 codebuddy provider 配置
          patch-token-log.js token 抓取补丁 (本地调试, 用完 --restore)
data/     models-live-*.json 实时快照 / models-extracted.json 静态兜底
docs/     CONNECT_REAL_BACKEND.md 接线文档
```

## 常用命令

```bash
npm install
npm start              # 网关版 (server-copilot.js)
npm run start:ipc      # IPC 版 (需 ACP_COMMAND)
npm test               # 全文件 node --check
npm run gen:pi-models  # 刷新 ~/.pi/agent/models.json 的 codebuddy provider
npm run patch:token    # 打 token 补丁 / patch:token-restore 还原
```

## 配置 (.env, 不进仓库)

`PROXY_PORT/HOST/API_KEY`、`COPILOT_TOKEN/ENDPOINT/MODEL/HEADERS`、
`MODELS_LIVE/CHAT_MODE/TTL_MS/SOURCE`、`ACP_COMMAND/ARGS/CWD/WORKSPACE_ROOT/ALLOW_WRITE_OUTSIDE/PERMISSION_POLICY`、
`CODEBUDDY_EXT_INDEX/TOKEN_DUMP_LOG`。详见 `.env.example`。

## 关键约束 (逆向得来, 别踩坑)

1. **上游只接受流式**: `POST {ENDPOINT}/chat/completions` 必须 `stream:true`, 否则报 `11101`。非流式需求由代理侧消费 SSE 再拼装 (见 `server-copilot.js` 的 `collectStreamAsCompletion`)。
2. **模型按账号授权**: 无权限报 `11102`。可用名单以实时 `GET {base}/v3/config` 的 agents.models 为准, 不要相信静态表。
3. **调配置接口必须带 UA**: `User-Agent: CodeBuddyIDE/<version>` (版本号从 CodeBuddy 的 `package.json` 取), 否则 `/v3/config` 报 `check ua` 400。
4. **vendor 单字母码** (`f/j/e`) 是后端内部计费渠道, 无解码表, **禁止原样透出** (`lib/models.js` 的 `resolveOwner` 按模型前缀推断, 兜底 `codebuddy`)。
5. **ACP 方法名**: agent 侧 `initialize/authenticate/session/new|load|prompt|cancel|set_model|set_mode`, client 侧 `fs/read_text_file|write_text_file`, `terminal/*`, `session/request_permission`, 通知 `session/update` (`agent_message_chunk/tool_call/tool_call_update`)。
6. **改 `tools/patch-token-log.js` 相关逻辑前先读 `docs/CONNECT_REAL_BACKEND.md`**; 补丁类脚本禁止合入常驻逻辑, 调试完必须可还原。

## 提交规范

- 不提交 `.env` / `token-dump.log` / `node_modules` (已有 `.gitignore`)。
- 提交前跑 `npm test`, 并 grep 确认无 `eyJ`/`sk-` 明文密钥。
- 跨目录改引用后, 同步改 `package.json` scripts 与 README。
