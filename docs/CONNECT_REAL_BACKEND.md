# 连接真实 CodeBuddy 后端指南

## 概述

本文档说明如何将 OpenAI 兼容代理服务连接到真实的 CodeBuddy 后端。

## 连接方式对比

| 方式 | 适用场景 | 复杂度 | 性能 |
|------|----------|--------|------|
| **VS Code 扩展宿主** | 在 VS Code 扩展中运行 | 中 | 高 |
| **Electron IPC** | 在 Electron 渲染进程中运行 | 中 | 高 |
| **WebSocket 代理** | 独立进程/远程连接 | 低 | 中 |
| **直接模块导入** | 直接加载 main.js | 高 | 最高 |

---

## 方式一: VS Code 扩展宿主 (推荐)

### 原理

在 VS Code 扩展宿主进程中运行代理，通过 `acquireVsCodeApi()` 获取 VS Code API，
然后通过扩展 API 与 CodeBuddy 扩展通信。

### 实现步骤

#### 1. 创建 VS Code 扩展包装器

```javascript
// extension.js - VS Code 扩展入口
const vscode = require('vscode');
const { VSCodeExtensionConnector } = require('./connectors');

let connector = null;

function activate(context) {
  console.log('CodeBuddy Proxy 扩展已激活');
  
  // 获取 VS Code API
  const vscodeApi = acquireVsCodeApi ? acquireVsCodeApi() : vscode;
  
  // 创建连接器
  connector = new VSCodeExtensionConnector(vscodeApi);
  
  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('codebuddy-proxy.start', async () => {
      const connected = await connector.connect();
      if (connected) {
        vscode.window.showInformationMessage('已连接到 CodeBuddy 后端');
      } else {
        vscode.window.showErrorMessage('连接失败');
      }
    })
  );
}

function deactivate() {
  connector?.disconnect();
}

module.exports = { activate, deactivate };
```

#### 2. 配置 package.json

```json
{
  "name": "codebuddy-proxy",
  "displayName": "CodeBuddy OpenAI Proxy",
  "version": "1.0.0",
  "engines": { "vscode": "^1.80.0" },
  "activationEvents": ["onCommand:codebuddy-proxy.start"],
  "main": "./extension.js",
  "contributes": {
    "commands": [
      {
        "command": "codebuddy-proxy.start",
        "title": "Start CodeBuddy Proxy"
      }
    ],
    "configuration": {
      "title": "CodeBuddy Proxy",
      "properties": {
        "codebuddyProxy.port": {
          "type": "number",
          "default": 3000,
          "description": "代理服务器端口"
        },
        "codebuddyProxy.apiKey": {
          "type": "string",
          "default": "codebuddy-proxy-key",
          "description": "API Key"
        }
      }
    }
  }
}
```

#### 3. 启动命令

```bash
# 在 VS Code 中按 Ctrl+Shift+P
# 输入: "Start CodeBuddy Proxy"
```

---

## 方式二: Electron IPC

### 原理

在 Electron 渲染进程中使用 `ipcRenderer` 与主进程通信，
主进程通过 `ipcMain` 将请求转发到 CodeBuddy 后端。

### 实现步骤

#### 1. 主进程 (main.js)

```javascript
const { app, BrowserWindow, ipcMain } = require('electron');
const { CodeBuddyBackend } = require('./codebuddy-backend');

const backend = new CodeBuddyBackend();

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  win.loadFile('index.html');
}

// 处理来自渲染进程的 IPC 请求
ipcMain.on('codebuddy:request', async (event, { requestId, method, params }) => {
  try {
    const result = await backend.callMethod(method, params);
    event.sender.send('codebuddy:response', { requestId, data: result });
  } catch (error) {
    event.sender.send('codebuddy:response', { requestId, error: error.message });
  }
});

// 转发后端事件到渲染进程
backend.on('event', (event) => {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('codebuddy:event', event);
  });
});

app.whenReady().then(createWindow);
```

#### 2. 渲染进程 (renderer.js)

```javascript
const { ipcRenderer } = require('electron');
const { ElectronIPCConnector } = require('./connectors');

const connector = new ElectronIPCConnector();

// 连接
await connector.connect();

// 发送消息
const response = await connector.sendMessage({
  sessionId: 'session-id',
  prompt: [{ type: 'text', content: '你好' }]
});
```

#### 3. 启动命令

```bash
# 设置环境变量
set CODEBUDDY_BACKEND=electron

# 启动代理
node server-production.js
```

---

## 方式三: WebSocket 代理

### 原理

创建一个独立的 WebSocket 代理服务，作为 OpenAI 代理和 CodeBuddy 后端之间的桥梁。

### 实现步骤

#### 1. 创建 WebSocket 桥接服务

```javascript
// ws-bridge.js
const WebSocket = require('ws');
const { MockAgentProvider } = require('./main.js'); // 从 main.js 提取

const wss = new WebSocket.Server({ port: 3001 });
const provider = new MockAgentProvider();

wss.on('connection', (ws) => {
  console.log('WebSocket 客户端已连接');

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      const { requestId, method, params } = message;

      let result;
      switch (method) {
        case 'sendMessage':
          result = await provider.sendMessage(params);
          break;
        case 'newSession':
          result = await provider.newSession(params);
          break;
        case 'loadSession':
          result = await provider.loadSession(params);
          break;
        case 'getAllSessions':
          result = provider.getAllSessions();
          break;
        default:
          throw new Error(`未知方法: ${method}`);
      }

      ws.send(JSON.stringify({ requestId, data: result }));
    } catch (error) {
      ws.send(JSON.stringify({ requestId, error: error.message }));
    }
  });
});

console.log('WebSocket 桥接服务运行在 ws://localhost:3001');
```

#### 2. 启动命令

```bash
# 终端1: 启动 WebSocket 桥接
node ws-bridge.js

# 终端2: 启动 OpenAI 代理
set CODEBUDDY_BACKEND=websocket
set WS_URL=ws://localhost:3001
node server-production.js
```

---

## 方式四: 直接模块导入

### 原理

直接从 CodeBuddy 的 `main.js` 中提取 `MockAgentProvider` 类并实例化。

### 实现步骤

#### 1. 提取 Provider 类

```javascript
// extract-provider.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function extractProvider() {
  const mainPath = path.join(
    process.env.APPDATA,
    '../Local/Programs/CodeBuddy/resources/app/out/codebuddy/main.js'
  );
  
  const content = fs.readFileSync(mainPath, 'utf8');
  
  // 创建沙盒环境
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    global: {},
    require: (name) => {
      // 模拟必要的依赖
      const mocks = {
        'react': { createContext: () => ({}), Component: class {} },
        'electron': { ipcRenderer: { on: () => {}, send: () => {} } },
      };
      return mocks[name] || {};
    }
  };
  
  vm.createContext(sandbox);
  vm.runInContext(content, sandbox, { filename: 'main.js' });
  
  return sandbox.module.exports;
}

// 导出提取的类
const exports = extractProvider();
module.exports = {
  MockAgentProvider: exports.MockAgentProvider,
  CloudAgentProvider: exports.CloudAgentProvider,
  LocalAgentProvider: exports.LocalAgentProvider,
};
```

#### 2. 使用提取的 Provider

```javascript
const { MockAgentProvider } = require('./extract-provider');

const provider = new MockAgentProvider();

// 监听事件
provider.onSessionUpdate((event) => {
  console.log('事件:', event);
});

// 发送消息
await provider.sendMessage({
  sessionId: '1',
  prompt: [{ type: 'text', content: '你好' }]
});
```

---

## 配置 OpenAI 客户端

### Python (openai)

```python
from openai import OpenAI

openai = OpenAI(
    base_url='http://localhost:3000/v1',
    api_key='codebuddy-proxy-key'
)

response = openai.chat.completions.create(
    model='claude-sonnet-4',
    messages=[{'role': 'user', content': '你好'}]
)
print(response.choices[0].message.content)
```

### Node.js (openai)

```javascript
const OpenAI = require('openai');

const openai = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'codebuddy-proxy-key'
});

const response = await openai.chat.completions.create({
  model: 'claude-sonnet-4',
  messages: [{ role: 'user', content: '你好' }]
});
console.log(response.choices[0].message.content);
```

### VS Code Continue 配置

```json
{
  "models": [
    {
      "title": "CodeBuddy Claude",
      "provider": "openai",
      "model": "claude-sonnet-4",
      "apiBase": "http://localhost:3000/v1",
      "apiKey": "codebuddy-proxy-key"
    }
  ]
}
```

### Cline (Claude Dev) 配置

```json
{
  "apiBaseUrl": "http://localhost:3000/v1",
  "apiKey": "codebuddy-proxy-key",
  "modelId": "claude-sonnet-4"
}
```

---

## 故障排除

### 1. 连接失败

**症状**: 代理启动后显示 "连接失败，使用模拟后端"

**解决方案**:
- 检查 CodeBuddy 是否已启动
- 检查 VS Code 扩展是否已安装并激活
- 检查端口是否被占用

### 2. 请求超时

**症状**: 请求返回超时错误

**解决方案**:
- 增加 `REQUEST_TIMEOUT` 配置
- 检查网络连接
- 检查 CodeBuddy 后端是否正常响应

### 3. 流式输出中断

**症状**: 流式输出中途断开

**解决方案**:
- 检查 `X-Accel-Buffering: no` 响应头是否设置
- 检查代理服务器 (如 Nginx) 是否缓冲了响应
- 增加 `STREAM_CHUNK_DELAY` 配置

### 4. 认证失败

**症状**: 返回 401/403 错误

**解决方案**:
- 检查 `Authorization` 头格式是否正确
- 检查 API Key 是否匹配
- 检查环境变量 `PROXY_API_KEY` 是否设置

---

## 安全建议

1. **使用强 API Key**: 设置复杂的 `PROXY_API_KEY`
2. **限制访问**: 使用防火墙限制代理端口访问
3. **启用 HTTPS**: 在生产环境中使用 HTTPS
4. **日志脱敏**: 确保敏感信息在日志中脱敏
5. **速率限制**: 启用速率限制防止滥用

---

## 性能优化

1. **连接池**: 复用 ACP 连接
2. **缓存**: 缓存会话信息
3. **压缩**: 启用 gzip 压缩
4. **流式处理**: 使用流式响应减少内存占用
5. **并发控制**: 限制并发请求数量

---

*文档版本: 1.0.0*
*最后更新: 2025年*
