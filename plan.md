# ghost-bridge 新增 4 项能力实施方案

## Context

ghost-bridge 当前已经具备观察和基础交互能力，但还缺少 4 类高价值能力：

1. 等待条件成立后再继续操作
2. 读取和修改页面存储
3. 捕获 WebSocket 消息帧
4. 对请求做拦截 / Mock

本方案目标不是一次性把功能铺满，而是先定义一版可稳定交付、与现有架构兼容的实现范围。

---

## 现有约束

### 架构约束

- MCP server 侧通过 `askChrome()` 向 Chrome 扩展发送命令，扩展返回结果
- Chrome 扩展是单实例，可能同时服务多个 MCP client
- 扩展端当前调试对象始终是“当前激活 tab”
- `ensureAttached()` 在切换 tab 时会 detach 旧 tab，再 attach 新 tab，并重置部分本地状态

### 设计原则

- 先做与当前“单扩展、当前激活 tab”模型兼容的能力
- 不引入 session 级隔离时，不做会影响其他 MCP client 的强副作用全局能力
- 工具返回结构优先稳定、可预测，不追求一次覆盖所有 CDP 边角能力
- 有明显歧义的语义先收窄，不在 v1 里做“看起来完整、实际不稳定”的支持

---

## 修改文件

| 文件 | 改动 |
|------|------|
| `src/server.js` | 新增 7 个 MCP tool 注册 + handler |
| `extension/background.js` | 新增 7 个 command handler + 新状态变量 + CDP 事件监听 |
| `extension/bg-network.js` | 可选：补充网络摘要辅助函数 |
| `extension/bg-dom.js` | 无改动 |

---

## 能力 1：等待机制 (`wait_for`)

**工具**: `wait_for`  
**命令**: `waitFor` → `handleWaitFor()`

### v1 支持范围

- `element_appear`
- `element_disappear`
- `js_expression`
- `network_idle`

### v1 明确不做

- `navigation`

原因：当前扩展没有完整的页面生命周期状态管理，只靠 `window.location.href` 无法稳定覆盖 SPA、同 URL reload、`history.replaceState` 等情况。

### 设计思路

- 等待循环在扩展内部执行，避免 server 与扩展之间高频往返
- 轮询基于 `Runtime.evaluate`
- 默认轮询间隔 200ms，默认超时 10000ms，最大超时 30000ms
- server 侧调用超时设为 `userTimeout + 5000`

### 输入参数

```json
{
  "condition": "element_appear | element_disappear | network_idle | js_expression",
  "selector": "CSS 选择器",
  "expression": "JS 表达式",
  "timeout": 10000,
  "pollInterval": 200,
  "networkIdleMs": 500,
  "resourceTypes": ["XHR", "Fetch"]
}
```

### 返回值

```json
{
  "satisfied": true,
  "condition": "network_idle",
  "elapsedMs": 1234,
  "reason": "matched"
}
```

超时返回：

```json
{
  "satisfied": false,
  "condition": "element_appear",
  "elapsedMs": 10000,
  "reason": "timeout"
}
```

### `network_idle` 语义

- v1 默认只统计 `XHR` 和 `Fetch`
- 判断条件：
  - 当前 `requestMap` 中不存在指定类型的 pending 请求
  - 距离最近一次匹配请求完成时间 >= `networkIdleMs`
- 明确不把 `WebSocket`、长连接、图片、脚本资源默认计入 idle 判断

### 新增状态变量

```javascript
let lastTrackedRequestFinishedAt = 0
```

### 关键实现

- `element_appear/disappear`: `Runtime.evaluate` 执行 `!!document.querySelector(selector)`
- `js_expression`: `Runtime.evaluate` 执行表达式，外层 try/catch，结果按 truthy/falsy 判定
- `network_idle`: 扫描 `requestMap` 中指定 `resourceTypes` 的 pending 请求，并结合 `lastTrackedRequestFinishedAt` 判断

### 清理

- 无额外清理要求
- `lastTrackedRequestFinishedAt` 在切 tab 和 debugger detach 时重置为 `0`

---

## 能力 2：存储访问 (`get_storage` / `set_storage`)

**工具**: `get_storage`, `set_storage`  
**命令**: `getStorage` → `handleGetStorage()`，`setStorage` → `handleSetStorage()`

### v1 支持范围

- `cookies`
- `localStorage`
- `sessionStorage`

### 语义约束

- `localStorage/sessionStorage` 只针对当前主 frame 所在 origin
- `cookies` 使用 CDP `Network.getCookies` / `Network.setCookie` / `Network.deleteCookies`
- cookie 读取按“当前页面 URL 可见 cookie”返回，不做全浏览器 cookie 管理器

### 输入参数

`get_storage`

```json
{
  "type": "cookies | localStorage | sessionStorage",
  "filter": "名称过滤",
  "limit": 50
}
```

`set_storage`

```json
{
  "type": "cookies | localStorage | sessionStorage",
  "action": "set | delete",
  "name": "键名",
  "value": "值",
  "cookieOptions": {
    "domain": "...",
    "path": "/",
    "secure": true,
    "httpOnly": false,
    "sameSite": "Lax",
    "expires": 1234567890
  }
}
```

### 返回值

```json
{
  "type": "localStorage",
  "count": 2,
  "url": "https://example.com/page",
  "items": [
    { "name": "token", "value": "xxx" },
    { "name": "theme", "value": "dark" }
  ]
}
```

写操作返回：

```json
{
  "ok": true,
  "type": "cookies",
  "action": "set",
  "name": "sid"
}
```

### 关键实现

- Cookie 值返回最多 500 字符
- Storage 值返回最多 2000 字符
- `get_storage` 先取 key 列表，再批量取值
- `set_storage(delete)` 对不存在键也返回 `ok: true`

### 清理

- 无新增全局状态

---

## 能力 3：WebSocket 消息捕获 (`list_ws_frames`)

**工具**: `list_ws_frames`  
**命令**: `listWsFrames` → `handleListWsFrames()`

### v1 支持范围

- 捕获当前已 attach target 中可见的 WebSocket 帧
- 支持按 `requestId`、方向、文本过滤查询

### v1 不承诺

- 不承诺完整覆盖所有子 target、worker、跨进程 iframe 中的 WebSocket
- 不做二进制帧解码，仅保留字符串或截断后的 payload 摘要

### 设计思路

- 监听 CDP `Network.webSocketCreated`
- 监听 `Network.webSocketFrameSent` / `Network.webSocketFrameReceived` / `Network.webSocketFrameError`
- 用 `requestId` 聚合连接和帧
- 与现有 `Network.enable` 兼容，不新增 domain

### 新增状态变量

```javascript
let wsConnectionMap = new Map() // requestId -> { url, createdAt, closedAt, frames: [] }
const MAX_WS_CONNECTIONS = 50
const MAX_WS_FRAMES_PER_CONNECTION = 100
const MAX_WS_FRAME_LENGTH = 10000
```

### 输入参数

```json
{
  "requestId": "可选，指定连接",
  "direction": "sent | received | all",
  "filter": "内容过滤",
  "limit": 50
}
```

### 返回值

```json
{
  "connections": 2,
  "totalFrames": 42,
  "connectionSummary": {
    "reqId1": {
      "url": "wss://example.com/ws",
      "totalFrames": 30,
      "sent": 15,
      "received": 15
    }
  },
  "frames": [
    {
      "requestId": "reqId1",
      "direction": "received",
      "opcode": 1,
      "payload": "{\"ok\":true}",
      "timestamp": 1710000000000
    }
  ]
}
```

### 关键实现

- `webSocketCreated` 时初始化连接元数据
- `webSocketFrameSent/Received` 时写入帧
- payload 超长时截断
- 每连接超过 100 帧时丢弃最旧帧
- 连接数超过上限时，优先清理最旧且已关闭的连接

### 清理

- tab 切换时重置 `wsConnectionMap`
- debugger detach 时重置 `wsConnectionMap`

---

## 能力 4：请求拦截 / Mock (`add_intercept` / `remove_intercept` / `list_intercepts`)

**工具**: `add_intercept`, `remove_intercept`, `list_intercepts`  
**命令**: `addIntercept`，`removeIntercept`，`listIntercepts`

### 实施策略

这项能力保留在方案中，但按 **Phase 2** 实现，不与前 3 项一起开发。

原因：

- 当前扩展是单实例，多 MCP client 共用同一个 Chrome 连接
- 拦截规则天然带副作用，会影响其他 client
- 当前 attach 目标是“当前激活 tab”，规则绑定语义如果不先定义清楚，后续行为不可预测

### Phase 2 前置约束

实现前必须先补齐以下 3 项设计：

1. **规则归属**
   - 规则是全局共享，还是绑定到某个 MCP client
   - 如果绑定 client，需要在 server 与 extension 间传递 owner 标识

2. **规则作用范围**
   - 规则绑定创建时 tab，还是绑定当前激活 tab
   - 切 tab 后规则是自动失效、自动迁移，还是拒绝继续工作

3. **规则冲突策略**
   - 多条规则同时匹配时按创建顺序、优先级，还是第一条命中
   - `modify_request` 与 `mock_response` 冲突时如何处理

### 预留接口

`add_intercept`

```json
{
  "id": "规则 ID，可选自动生成",
  "urlPattern": "/api/users",
  "resourceType": "XHR",
  "action": "modify_request | mock_response | block",
  "requestModifications": {
    "url": "替换 URL",
    "method": "PUT",
    "headers": { "Authorization": "Bearer xxx" },
    "removeHeaders": ["Cookie"],
    "postData": "{}"
  },
  "mockResponse": {
    "statusCode": 200,
    "contentType": "application/json",
    "headers": { "X-Custom": "value" },
    "body": "{\"ok\":true}"
  }
}
```

### Phase 2 推荐落地方式

- 扩展端新增：

```javascript
let interceptRules = []
let fetchEnabled = false
```

- 使用 `Fetch.enable` / `Fetch.disable`
- `Fetch.requestPaused` 中匹配第一条命中规则
- 所有失败路径 fallback 到 `Fetch.continueRequest`

### 当前阶段结论

- 文档保留接口草案
- 本轮开发不实现代码

---

## 工具清单

本轮实际开发的工具：

1. `wait_for`
2. `get_storage`
3. `set_storage`
4. `list_ws_frames`

仅注册接口、不实现能力的工具：

1. `add_intercept`
2. `remove_intercept`
3. `list_intercepts`

如果不希望暴露未实现接口，则这 3 个工具推迟到 Phase 2 再注册。

---

## 实现顺序

1. `wait_for`
2. `get_storage`
3. `set_storage`
4. `list_ws_frames`
5. `add/remove/list_intercepts` 另开阶段

---

## 验证方式

### 通用验证

1. 启动 MCP server：`node dist/cli.js start`
2. 用 MCP client 调用工具
3. 验证正常路径、超时、空数据、无效参数
4. 验证切换 tab 后状态被正确重置
5. 验证多 MCP client 转发场景下不互相污染

### `wait_for`

1. 等待已存在元素出现，应立即成功
2. 等待不存在元素出现，应在超时后返回 `timeout`
3. 页面存在 XHR 完成后，`network_idle` 应成功
4. 页面存在持续 pending 请求时，`network_idle` 不应误报成功

### `get_storage / set_storage`

1. 读写 localStorage
2. 读写 sessionStorage
3. 读写 cookie
4. 删除不存在键，返回成功

### `list_ws_frames`

1. 页面建立 WebSocket 后可以看到连接摘要
2. 收发文本帧后可按方向过滤
3. payload 超长时会被截断
4. 切 tab 后旧帧数据应清空

---

## 完成标准

达到以下条件才算交付：

1. 前 4 个工具在当前激活 tab 上可稳定工作
2. 所有新增状态在 tab 切换和 debugger detach 后都能正确清理
3. 多 MCP client 场景下，前 4 个工具无共享副作用问题
4. `intercept` 仅保留设计，不带着半成品代码进入主线
