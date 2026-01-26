# Ghost Bridge（Claude MCP 无重启调试桥）

> 目标：在日常 Chrome 内零启动参数附加 DevTools，面向线上压缩代码（无 sourcemap）快速定位。

## 目录结构
- `server.js`：MCP server，通过 stdio 被 Claude CLI 拉起，与扩展用 WebSocket 通信
- `extension/`：Chrome MV3 扩展，使用 `chrome.debugger` 附加当前激活标签

## 快速使用（本地）
1. （可选）一键安装
   ```bash
   chmod +x install.sh
   ./install.sh
   ```
   > 已包含依赖安装 + Claude MCP 注册

2. 手动安装（如不使用脚本）
   - 安装依赖
   ```bash
   cd ghost-bridge
   npm install
   ```

3. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”，选择“加载已解压的扩展程序”，指向 `ghost-bridge/extension`
4. 将工具注册到 Claude CLI（示例，脚本已做）
   ```bash
   claude mcp add ghost-bridge -- node /绝对路径/ghost-bridge/server.js
   ```
   或者在 Claude 的 MCP 配置中手动添加：
   ```json
   "ghost-bridge": {
     "command": "node",
     "args": [
       "/绝对路径/ghost-bridge/server.js"
     ]
   }
   ```
5. 点击扩展图标切换为 ON（默认 OFF）
6. 保持 Chrome 打开，终端运行 `claude`，直接调用工具，例如：
   - `get_last_error`：拿最近异常 / console / 网络失败
   - `get_script_source`：按 URL 片段抓压缩脚本并返回定位片段（可 beautify）
   - `find_by_string`：在脚本内搜索字符串，返回上下文
   - `coverage_snapshot`：抓一次执行覆盖率，排前 20 热脚本
   - `list_network_requests`：列出捕获的网络请求，支持过滤
   - `get_network_detail`：获取请求详情，包括响应体

## 默认配置
- 端口：`3301`（`server.js` / `extension/background.js`）
- token：`1`（仅用于本机 WS 校验，如需修改请保持两端一致）

## 工具说明

### 基础调试工具
- **get_last_error**：汇总最近异常/console/网络报错，附带行列与脚本标识
- **get_script_source**：支持 `scriptUrlContains`、`line`、`column`，返回源码片段（无 sourcemap 仍可用）
- **coverage_snapshot**：默认 1.5s，输出调用次数最高的脚本
- **find_by_string**：在脚本源码里按关键词搜索，返回上下文 200 字符窗口
- **symbolic_hints**：采集资源列表、全局变量 key、localStorage key、UA 与 URL
- **eval_script**：只读表达式执行；谨慎使用，避免改写页面状态

### 🆕 网络请求分析工具
- **list_network_requests**：列出捕获的网络请求
  - 支持按 URL 关键词过滤（`filter`）
  - 支持按请求方法过滤（`method`: GET/POST/PUT/DELETE）
  - 支持按状态过滤（`status`: success/error/failed/pending）
  - 支持按资源类型过滤（`resourceType`: XHR/Fetch/Script/Image）
  - 返回：URL、方法、状态码、耗时、大小等摘要信息

- **get_network_detail**：获取单个请求的详细信息
  - 请求头和响应头
  - 请求方法、状态码、MIME 类型
  - 耗时分析（timing）
  - 可选获取响应体（`includeBody: true`）

- **clear_network_requests**：清空已捕获的网络请求记录

## 设计取舍
- 不依赖 `--remote-debugging-port`，完全通过扩展获取 CDP，满足"零重启"
- 默认 `autoDetach=false` 保持附加，便于持续捕获异常和网络请求；可通过图标 OFF 立即解除调试
- 无 sourcemap 时通过片段截取、字符串搜索与覆盖率提供线索
- 网络请求完整记录，支持查看请求/响应详情和响应体

## 已知限制
- 扩展 service worker 可能被挂起，已内置 1s 重连策略；若长时间无流量需重新唤醒
- 若目标页面自带 DevTools 打开，`chrome.debugger.attach` 可能失败，请关闭后重试
- 大体积单行 bundle beautify 可能耗时，server 端对超长源码会只截取片段
