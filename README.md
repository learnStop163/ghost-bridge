# Ghost Bridge（Claude MCP 无重启调试桥）

> 目标：在日常 Chrome 内零启动参数附加 DevTools，面向线上压缩代码（无 sourcemap）快速定位。

## 目录结构
- `server.js`：MCP server，通过 stdio 被 Claude CLI 拉起，与扩展用 WebSocket 通信
- `extension/`：Chrome MV3 扩展，使用 `chrome.debugger` 附加当前激活标签

## 快速使用（本地）
1. 安装依赖
   ```bash
   cd ghost-bridge
   npm install
   ```

2. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”，选择“加载已解压的扩展程序”，指向 `ghost-bridge/extension`
3. 将工具注册到 Claude CLI（示例）
   ```bash
   claude mcp add ghost-bridge -- node /绝对路径/ghost-bridge/server.js
   ```
4. 保持 Chrome 打开，终端运行 `claude`，直接调用工具，例如：
   - `get_last_error`：拿最近异常 / console / 网络失败
   - `get_script_source`：按 URL 片段抓压缩脚本并返回定位片段（可 beautify）
   - `find_by_string`：在脚本内搜索字符串，返回上下文
   - `coverage_snapshot`：抓一次执行覆盖率，排前 20 热脚本

## 工具说明
- **get_last_error**：汇总最近异常/console/网络报错，附带行列与脚本标识
- **get_script_source**：支持 `scriptUrlContains`、`line`、`column`，返回源码片段（无 sourcemap 仍可用）
- **coverage_snapshot**：默认 1.5s，输出调用次数最高的脚本
- **find_by_string**：在脚本源码里按关键词搜索，返回上下文 200 字符窗口
- **symbolic_hints**：采集资源列表、全局变量 key、localStorage key、UA 与 URL
- **eval_script**：只读表达式执行；谨慎使用，避免改写页面状态

## 设计取舍
- 不依赖 `--remote-debugging-port`，完全通过扩展获取 CDP，满足“零重启”
- 默认 `autoDetach=true`，每次命令后释放调试器，降低性能影响；如需连续操作可改为 false
- 无 sourcemap 时通过片段截取、字符串搜索与覆盖率提供线索；若可访问 sourcemap，可在 server 端追加符号化逻辑

## 已知限制
- 扩展 service worker 可能被挂起，已内置 1s 重连策略；若长时间无流量需重新唤醒
- 若目标页面自带 DevTools 打开，`chrome.debugger.attach` 可能失败，请关闭后重试
- 大体积单行 bundle beautify 可能耗时，server 端对超长源码会只截取片段
