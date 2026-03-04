# Ghost Bridge

> 零重启 Chrome 调试桥 —— 通过 MCP 让 AI 直接访问浏览器 DevTools 能力，面向线上压缩代码（无 sourcemap）快速定位问题。

## ✨ 特性

- 🔌 **零配置附加** — 不依赖 `--remote-debugging-port`，通过 Chrome 扩展直接获取 CDP
- 🔍 **无 sourcemap 调试** — 片段截取、字符串搜索、覆盖率分析，在压缩代码中定位问题
- 🌐 **网络请求分析** — 完整记录请求/响应，支持多维度过滤和响应体查看
- 📸 **页面截图与内容提取** — 视觉分析 + 结构化数据提取
- 📊 **性能诊断** — JS 堆内存、DOM 规模、Layout 开销、Web Vitals、资源加载分析
- 🔄 **多实例支持** — 自动单例管理，多个 MCP 客户端共享同一 Chrome 连接

## 快速开始

### 1. 安装与初始化

```bash
# 全局安装
npm install -g ghost-bridge

# 自动配置 Claude MCP 并准备扩展
ghost-bridge init
```

### 2. 加载 Chrome 扩展

1. 打开 Chrome，访问 `chrome://extensions`
2. 开启右上角的 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择目录：`~/.ghost-bridge/extension`

> 💡 运行 `ghost-bridge extension --open` 可直接打开该目录

### 3. 连接并使用

1. 点击浏览器工具栏中的 Ghost Bridge 图标
2. 点击 **连接**，等待状态变为 ✅ 已连接
3. 打开 Claude Desktop 或 Claude CLI，即可使用所有调试工具

## CLI 命令

| 命令 | 说明 |
|------|------|
| `ghost-bridge init` | 配置 MCP 并复制扩展文件 |
| `ghost-bridge status` | 检查配置状态 |
| `ghost-bridge extension` | 显示扩展安装路径（`--open` 打开目录） |
| `ghost-bridge start` | 手动启动 MCP 服务（通常不需要） |

## 工具一览

### 🔍 基础调试

| 工具 | 说明 |
|------|------|
| `get_server_info` | 获取服务器状态（端口、连接状态、角色） |
| `get_last_error` | 汇总最近的异常 / console 错误 / 网络报错，附行列与脚本标识 |
| `get_script_source` | 抓取目标脚本源码，支持按 URL 片段筛选、指定行列定位、beautify |
| `coverage_snapshot` | 启动执行覆盖率采集（默认 1.5s），返回最活跃的脚本列表 |
| `find_by_string` | 在页面脚本源码中按关键词搜索，返回 200 字符上下文窗口 |
| `symbolic_hints` | 采集资源列表、全局变量 key、localStorage key、UA 与 URL |
| `eval_script` | 在页面执行 JS 表达式（谨慎使用） |

### � 网络请求分析

| 工具 | 说明 |
|------|------|
| `list_network_requests` | 列出捕获的网络请求，支持按 URL / 方法 / 状态 / 资源类型过滤 |
| `get_network_detail` | 获取单个请求的详细信息（请求头、响应头、timing），可选获取响应体 |
| `clear_network_requests` | 清空已捕获的网络请求记录 |

### 📸 页面内容

| 工具 | 说明 |
|------|------|
| `capture_screenshot` | 截取页面截图（支持完整长截图、指定区域、JPEG/PNG 格式） |
| `get_page_content` | 提取页面内容：纯文本 / HTML / 结构化数据（标题、链接、按钮、表单） |

### 📊 性能分析

| 工具 | 说明 |
|------|------|
| `perf_metrics` | 获取页面性能指标，包含三层数据：|

**`perf_metrics` 返回的数据：**

- **引擎级指标** — JS 堆内存（使用量/总量/占比）、DOM 节点数、事件监听器数、Layout 重排次数与耗时、脚本执行时间
- **Web Vitals** — Navigation Timing 各阶段（DNS / TTFB / DOM Interactive / Load）、FP、FCP、Long Tasks 统计
- **资源加载摘要** — 按类型分组统计（count / size / avgDuration）、最慢资源识别

## 配置

| 项目 | 默认值 | 说明 |
|------|--------|------|
| 端口 | `33333` | WebSocket 服务端口，自动递增寻找可用端口 |
| Token | 当月自动生成 | 本机 WS 校验，基于当月 1 号时间戳 |
| 自动 Detach | `false` | 保持附加，便于持续捕获异常和网络请求 |

环境变量：

- `GHOST_BRIDGE_PORT` — 自定义基础端口
- `GHOST_BRIDGE_TOKEN` — 自定义 token

## 架构

```
┌──────────────┐     stdio      ┌──────────────┐    WebSocket    ┌──────────────┐
│  Claude CLI  │ ◄────────────► │  MCP Server  │ ◄──────────────►│Chrome Extension│
│  / Desktop   │                │ (server.js)  │                 │(background.js)│
└──────────────┘                └──────────────┘                 └──────┬───────┘
                                                                       │ CDP
                                                                 ┌─────▼──────┐
                                                                 │  浏览器页面  │
                                                                 └────────────┘
```

- **MCP Server** — 通过 stdio 被 Claude 拉起，与扩展通过 WebSocket 通信
- **Chrome Extension (MV3)** — 使用 `chrome.debugger` API 附加页面，Offscreen Document 维持 WebSocket 长连接
- **单例模式** — 多个 MCP 客户端自动协调，首个实例为主服务，后续实例作为客户端连接

## 已知限制

- 扩展 Service Worker 可能被挂起，已内置重连策略；若长时间无流量需重新唤醒
- 若目标页面已打开 DevTools，`chrome.debugger.attach` 可能失败，请关闭后重试
- 大体积单行 bundle beautify 可能耗时，服务端对超长源码会截取片段
- 跨月时 token 会自动更新，扩展和服务端需在同月内启动

## License

MIT
