import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { WebSocketServer, WebSocket } from "ws"
import beautify from "js-beautify"
import crypto from "crypto"
import net from "net"
import fs from "fs"
import os from "os"
import path from "path"
import { GHOST_BRIDGE_VERSION } from "../lib/version.js"

const BASE_PORT = Number(process.env.GHOST_BRIDGE_PORT || 33333)
// 使用当月1号0点的时间戳作为 token，确保同月内的服务器和插件自动匹配
function getMonthlyToken() {
  const now = new Date()
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  return String(firstDayOfMonth.getTime())
}
const WS_TOKEN = process.env.GHOST_BRIDGE_TOKEN || getMonthlyToken()
const RESPONSE_TIMEOUT = 8000
const PORT_INFO_FILE = path.join(os.tmpdir(), "ghost-bridge-port.json")

let chromeConnection = null   // Chrome 扩展的连接
let activeConnection = null   // 当前用于发送请求的连接（主实例用 chromeConnection，非主实例用到主实例的连接）
let actualPort = BASE_PORT
let isMainInstance = false    // 是否是主实例（启动了 WebSocket 服务器）
const pendingRequests = new Map()
const mcpClients = new Set()  // 连接到主实例的其他 MCP 客户端

function log(msg) {
  console.error(`[ghost-bridge] ${msg}`)
}

/**
 * 检查进程是否存在
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 检查是否已有服务在运行
 */
function getExistingService() {
  try {
    if (!fs.existsSync(PORT_INFO_FILE)) return null
    const info = JSON.parse(fs.readFileSync(PORT_INFO_FILE, "utf-8"))
    if (!info.pid || !info.port) return null
    if (info.port !== BASE_PORT) {
      fs.unlinkSync(PORT_INFO_FILE)
      return null
    }
    // 检查进程是否还在运行
    if (!isProcessRunning(info.pid)) {
      log(`旧服务 PID ${info.pid} 已不存在，清理旧信息`)
      fs.unlinkSync(PORT_INFO_FILE)
      return null
    }
    return info
  } catch {
    return null
  }
}

/**
 * 验证现有服务是否是 ghost-bridge
 */
function verifyExistingService(port) {
  return new Promise((resolve) => {
    const url = new URL(`ws://localhost:${port}`)
    if (WS_TOKEN) url.searchParams.set("token", WS_TOKEN)

    const ws = new WebSocket(url.toString())
    const timeout = setTimeout(() => {
      ws.close()
      resolve(false)
    }, 2000)

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === "identity" && msg.service === "ghost-bridge") {
          clearTimeout(timeout)
          ws.close()
          resolve(true)
        }
      } catch {}
    })
    ws.on("error", () => {
      clearTimeout(timeout)
      resolve(false)
    })
    ws.on("close", () => {
      clearTimeout(timeout)
    })
  })
}

/**
 * 检测端口是否可用
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close()
      resolve(true)
    })
    server.listen(port)
  })
}

/**
 * 寻找可用端口并启动 WebSocket 服务器
 */
async function startWebSocketServer() {
  const available = await isPortAvailable(BASE_PORT)
  if (!available) {
    throw new Error(`固定端口 ${BASE_PORT} 不可用，请释放该端口或通过 GHOST_BRIDGE_PORT 指定其他端口`)
  }

  actualPort = BASE_PORT
  const wss = new WebSocketServer({ port: BASE_PORT })
  log(`🚀 WebSocket 服务已启动，端口 ${BASE_PORT}${WS_TOKEN ? "（启用 token 校验）" : ""}`)
  return wss
}

/**
 * 初始化 WebSocket 服务（单例模式）
 */
async function initWebSocketService() {
  // 检查是否已有服务在运行
  const existing = getExistingService()
  if (existing) {
    log(`检测到现有服务 (PID: ${existing.pid}, 端口: ${existing.port})，验证中...`)
    const valid = await verifyExistingService(existing.port)
    if (valid) {
      actualPort = existing.port
      isMainInstance = false
      log(`✅ 复用现有服务，端口 ${actualPort}`)
      return null // 不启动新的 WebSocket 服务器
    } else {
      log(`❌ 现有服务验证失败，启动新服务...`)
      try { fs.unlinkSync(PORT_INFO_FILE) } catch {}
    }
  }

  if (!(await isPortAvailable(BASE_PORT))) {
    const valid = await verifyExistingService(BASE_PORT)
    if (valid) {
      actualPort = BASE_PORT
      isMainInstance = false
      log(`✅ 复用固定端口上的现有服务，端口 ${actualPort}`)
      return null
    }
    throw new Error(`固定端口 ${BASE_PORT} 已被其他进程占用，请释放该端口或通过 GHOST_BRIDGE_PORT 指定其他端口`)
  }

  // 启动新的 WebSocket 服务器
  const wss = await startWebSocketServer()
  isMainInstance = true

  // 写入端口信息
  fs.writeFileSync(
    PORT_INFO_FILE,
    JSON.stringify({
      port: actualPort,
      wsUrl: `ws://localhost:${actualPort}`,
      pid: process.pid,
      startedAt: new Date().toISOString()
    }, null, 2)
  )
  log(`📝 端口信息已写入: ${PORT_INFO_FILE}`)

  return wss
}

const wss = await initWebSocketService()

// 如果是主实例，设置 WebSocket 服务器的连接处理
if (wss) {
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", "http://localhost")
    const token = url.searchParams.get("token") || ""
    const role = url.searchParams.get("role") || ""

    if (WS_TOKEN && token !== WS_TOKEN) {
      log(`拒绝连接：token 不匹配 (收到: ${token}, 期望: ${WS_TOKEN})`)
      ws.close(1008, "Bad token")
      return
    }
    log(`连接验证通过 (token: ${token})`)

    if (role === "mcp-client") {
      // 其他 MCP 实例的连接
      log("📡 MCP 客户端已连接")
      mcpClients.add(ws)
      ws.send(JSON.stringify({ type: "identity", service: "ghost-bridge", token: WS_TOKEN }))

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString())

          // 内部命令：查询主实例状态
          if (msg.command === "_getMainStatus") {
            ws.send(JSON.stringify({
              id: msg.id,
              result: {
                chromeConnected: !!chromeConnection,
                mcpClientsCount: mcpClients.size,
                port: actualPort
              }
            }))
            return
          }

          // MCP 客户端的请求需要转发到 Chrome
          if (!chromeConnection) {
            if (msg.id) {
              ws.send(JSON.stringify({ id: msg.id, error: "Chrome 未连接" }))
            }
            return
          }
          // 记录请求来源，以便响应时转发回去
          if (msg.id) {
            pendingRequests.set(msg.id, { source: ws })
          }
          chromeConnection.send(data)
        } catch {}
      })

      ws.on("close", () => {
        log("📡 MCP 客户端已断开")
        mcpClients.delete(ws)
      })
    } else {
      // Chrome 扩展的连接
      // 如果已有旧的 Chrome 连接，先关闭它
      if (chromeConnection && chromeConnection !== ws && chromeConnection.readyState === WebSocket.OPEN) {
        log("🔄 关闭旧的 Chrome 连接，切换到新连接")
        try {
          chromeConnection.close(1000, "Replaced by new connection")
        } catch (e) {
          log(`关闭旧连接失败: ${e.message}`)
        }
      }
      log("🌐 Chrome 扩展已连接")
      chromeConnection = ws
      activeConnection = ws
      ws.send(JSON.stringify({ type: "identity", service: "ghost-bridge", token: WS_TOKEN }))

      ws.on("message", (data) => {
        // 检查是否需要转发响应到 MCP 客户端
        try {
          const msg = JSON.parse(data.toString())
          if (msg.id && pendingRequests.has(msg.id)) {
            const pending = pendingRequests.get(msg.id)
            // 区分：来自其他 MCP 客户端的请求 vs 本地请求
            if (pending.source && pending.source.readyState === WebSocket.OPEN) {
              // 来自其他 MCP 客户端，转发响应
              pendingRequests.delete(msg.id)
              pending.source.send(data)
              return
            }
            // 本地请求，直接处理（不要在这里删除）
          }
        } catch {}
        // 本地处理
        handleIncoming(data)
      })

      ws.on("close", () => {
        log("🌐 Chrome 连接已关闭")
        chromeConnection = null
        activeConnection = null
        failAllPending("Chrome 连接断开")
      })
    }
  })
} else {
  // 非主实例：作为客户端连接到主实例
  log(`📡 作为客户端连接到主实例 (端口 ${actualPort})...`)
  connectToMainInstance()
}

const MAX_RECONNECT_ATTEMPTS = 10  // 最大重连次数
const RECONNECT_INTERVAL = 3000    // 重连间隔 (ms)
let reconnectAttempts = 0
let wasEverConnected = false  // 是否曾经成功连接过

/**
 * 连接到主实例的 WebSocket 服务器
 */
function connectToMainInstance() {
  const url = new URL(`ws://localhost:${actualPort}`)
  url.searchParams.set("token", WS_TOKEN)
  url.searchParams.set("role", "mcp-client") // 标识为 MCP 客户端

  const ws = new WebSocket(url.toString())

  ws.on("open", () => {
    log(`✅ 已连接到主实例 (端口 ${actualPort})`)
    reconnectAttempts = 0  // 重置重连计数
    wasEverConnected = true
  })

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString())
      // 处理身份验证
      if (msg.type === "identity" && msg.service === "ghost-bridge") {
        activeConnection = ws
        log("🔗 身份验证成功，可以使用调试功能")
        return
      }
      // 处理响应
      handleIncoming(data)
    } catch {}
  })

  ws.on("close", () => {
    log("⚠️ 与主实例的连接已断开")
    activeConnection = null
    failAllPending("与主实例的连接已断开")

    // 尝试重连，但限制次数
    reconnectAttempts++
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log(`❌ 重连失败次数过多 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})，客户端进程退出`)
      process.exit(0)
    }

    setTimeout(() => {
      if (!activeConnection) {
        log(`🔄 尝试重新连接到主实例... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
        connectToMainInstance()
      }
    }, RECONNECT_INTERVAL)
  })

  ws.on("error", (err) => {
    log(`❌ 连接主实例失败: ${err.message}`)
    // 如果从未成功连接过，增加重连计数
    if (!wasEverConnected) {
      reconnectAttempts++
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log(`❌ 无法连接到主实例，客户端进程退出`)
        process.exit(0)
      }
    }
  })
}

function failAllPending(message) {
  pendingRequests.forEach((pending, id) => {
    if (pending.reject) {
      // 本地请求：{ resolve, reject, timer }
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    } else if (pending.source) {
      // MCP 客户端转发的请求：{ source: ws }，回传错误
      try {
        if (pending.source.readyState === WebSocket.OPEN) {
          pending.source.send(JSON.stringify({ id, error: message }))
        }
      } catch {}
    }
  })
  pendingRequests.clear()
}

function handleIncoming(data) {
  let payload
  try {
    payload = JSON.parse(data.toString())
  } catch {
    return
  }
  const { id, result, error } = payload
  if (!id || !pendingRequests.has(id)) return
  const { resolve, reject, timer } = pendingRequests.get(id)
  clearTimeout(timer)
  pendingRequests.delete(id)
  if (error) reject(new Error(error))
  else resolve(result)
}

/**
 * 向主实例发送内部命令（仅非主实例使用）
 */
async function askMainInstance(command, params = {}) {
  if (!activeConnection) throw new Error("未连接到主实例")
  const id = crypto.randomUUID()
  const payload = { id, command, params }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`查询主实例超时：${command}`))
    }, 3000)

    pendingRequests.set(id, { resolve, reject, timer })

    activeConnection.send(JSON.stringify(payload), (err) => {
      if (err) {
        clearTimeout(timer)
        pendingRequests.delete(id)
        reject(err)
      }
    })
  })
}

async function askChrome(command, params = {}, options = {}) {
  if (!activeConnection) throw new Error("Chrome 未连接，请确认浏览器开启且扩展已启用")
  const id = crypto.randomUUID()
  const payload = { id, command, params }
  if (WS_TOKEN) payload.token = WS_TOKEN
  const timeoutMs = options.timeoutMs || RESPONSE_TIMEOUT

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`请求超时(${timeoutMs}ms)：${command}`))
    }, timeoutMs)

    pendingRequests.set(id, { resolve, reject, timer })

    activeConnection.send(JSON.stringify(payload), (err) => {
      if (err) {
        clearTimeout(timer)
        pendingRequests.delete(id)
        reject(err)
      }
    })
  })
}

function jsonText(data) {
  return typeof data === "string" ? data : JSON.stringify(data)
}

function buildSnippet(source, line, column, { beautifyEnabled = true, contextLines = 20 } = {}) {
  const result = {}
  if (!source) {
    result.snippet = ""
    result.note = "无源码"
    return result
  }

  const lines = source.split(/\r?\n/)
  if (lines.length > 1 && line) {
    const start = Math.max(0, line - contextLines)
    const end = Math.min(lines.length, line + contextLines)
    const slice = lines.slice(start, end)
    result.snippet = slice
      .map((l, idx) => `${start + idx + 1}: ${l}`)
      .join("\n")
    result.note = `行号范围 ${start + 1}-${end}`
    result.truncated = start > 0 || end < lines.length
    return result
  }

  const col = column || 1
  const span = 800
  const start = Math.max(0, col - span / 2)
  const end = Math.min(source.length, start + span)
  let chunk = source.slice(start, end)
  if (beautifyEnabled && chunk.length < 200_000) {
    try {
      chunk = beautify(chunk, { indent_size: 2 })
      result.note = "已对截取片段 beautify"
    } catch {
      result.note = "beautify 失败，返回原始片段"
    }
  }
  result.snippet = chunk
  result.truncated = start > 0 || end < source.length
  result.note = result.note || "单行脚本截取片段"
  return result
}

const server = new Server(
  { name: "ghost-bridge", version: GHOST_BRIDGE_VERSION },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "inspect_page",
      description:
        "【页面分析入口】当用户要求分析当前页面/网站/网页、理解页面结构、快速查看当前标签内容时，优先使用此工具。" +
        "无需用户显式提到 ghost-bridge。" +
        "默认返回页面元数据、结构化内容摘要和可交互元素概览，适合作为后续截图、交互、网络排查前的第一步。",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS 选择器，限定分析范围。不指定则分析整个页面",
          },
          includeInteractive: {
            type: "boolean",
            description: "是否包含交互元素概览，默认 true",
          },
          maxElements: {
            type: "number",
            description: "交互元素概览的最大数量，默认 30",
          },
        },
      },
    },
    {
      name: "get_server_info",
      description: "获取 ghost-bridge 服务器状态，包括当前 WebSocket 端口、连接状态等",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_last_error",
      description: "获取当前标签最近的异常/报错堆栈与元数据（无 sourcemap 友好）。默认只返回 error 级别的最近 20 条。",
      inputSchema: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["error", "warn", "info", "all"],
            description: "日志级别过滤，默认 error",
          },
          limit: {
            type: "number",
            description: "返回条数限制，默认 20，最大 100",
          },
        },
      },
    },
    {
      name: "get_script_source",
      description:
        "抓取目标脚本源码（压缩版），返回定位片段与可选 beautify，支持按 URL 片段筛选",
      inputSchema: {
        type: "object",
        properties: {
          scriptUrlContains: { type: "string" },
          line: { type: "number" },
          column: { type: "number" },
          beautify: { type: "boolean" },
          contextLines: { type: "number" },
        },
      },
    },
    {
      name: "coverage_snapshot",
      description: "启动并采集一次执行覆盖率，返回最活跃的脚本/函数列表",
      inputSchema: {
        type: "object",
        properties: {
          durationMs: { type: "number", description: "默认 1500ms" },
        },
      },
    },
    {
      name: "find_by_string",
      description:
        "在当前页面脚本内按字符串搜索，返回匹配的上下文片段（用于压缩代码定位）",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          scriptUrlContains: { type: "string" },
          maxMatches: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "symbolic_hints",
      description:
        "收集页面的资源、全局符号与 UA/URL 线索，帮助推断版本与模块归属",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "eval_script",
      description: "在当前页面执行只读 JS 表达式（谨慎使用）",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    },
    {
      name: "list_network_requests",
      description:
        "列出捕获的网络请求，支持按 URL、方法、状态、类型过滤。默认按排障优先级排序：失败请求、进行中请求、XHR/Fetch 会优先展示。为避免上下文膨胀，data URL 和超长 URL 会自动摘要化。",
      inputSchema: {
        type: "object",
        properties: {
          filter: { type: "string", description: "URL 关键词过滤" },
          method: { type: "string", description: "请求方法：GET/POST/PUT/DELETE 等" },
          status: { type: "string", description: "状态：success/error/failed/pending" },
          resourceType: { type: "string", description: "资源类型：XHR/Fetch/Script/Image 等" },
          limit: { type: "number", description: "返回数量限制，默认 50" },
          priorityMode: {
            type: "string",
            enum: ["debug", "api", "recent"],
            description: "排序模式：debug=排障优先（默认），api=接口优先，recent=按时间倒序",
          },
        },
      },
    },
    {
      name: "get_network_detail",
      description:
        "获取单个网络请求的详细信息，包括请求头、响应头，可选获取响应体。为避免上下文膨胀，data URL 和超长 URL 会自动摘要化。",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", description: "请求 ID（从 list_network_requests 获取）" },
          includeBody: { type: "boolean", description: "是否包含响应体，默认 false" },
        },
        required: ["requestId"],
      },
    },
    {
      name: "clear_network_requests",
      description: "清空已捕获的网络请求记录",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "perf_metrics",
      description:
        "获取页面性能指标：包含引擎级指标（JS堆内存、DOM节点数、Layout次数、脚本执行时间）、" +
        "Web Vitals（FCP、TTFB、DOMContentLoaded、Long Tasks）和资源加载摘要。" +
        "用于诊断页面卡顿、内存占用过高、加载缓慢等性能问题。",
      inputSchema: {
        type: "object",
        properties: {
          includeTimings: {
            type: "boolean",
            description: "是否包含 Navigation Timing 和 Web Vitals，默认 true",
          },
          includeResources: {
            type: "boolean",
            description: "是否包含资源加载摘要（按类型统计、最慢资源），默认 true",
          },
        },
      },
    },
    {
      name: "capture_screenshot",
      description:
        "【推荐用于视觉分析】截取当前页面的截图，返回 base64 图片。" +
        "适用于：1) 查看页面实际视觉效果 2) 排查 UI/样式/布局/颜色问题 " +
        "3) 验证页面渲染 4) 分析元素位置和间距 5) 查看图片/图标等视觉内容。" +
        "当用户说“看看这个页面长什么样”“帮我分析界面/布局/样式”时，应优先使用此工具，" +
        "无需用户显式提到 ghost-bridge。" +
        "当需要看到页面「长什么样」时使用此工具。" +
        "默认优先使用更省传输的 JPEG：普通截图默认 quality 80，完整长截图默认 quality 70。" +
        "当需要检查文字清晰度、1px 细线、图标边缘、透明背景或像素级细节时，应优先使用 PNG。" +
        "如仅需文本/链接等信息，建议使用更快的 get_page_content。",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["png", "jpeg"],
            description: "图片格式。默认使用 jpeg；需要高保真文字、细线、透明背景时用 png"
          },
          quality: {
            type: "number",
            description: "JPEG 质量 (0-100)，仅当 format 为 jpeg 时有效。默认普通截图 80，完整长截图 70"
          },
          fullPage: {
            type: "boolean",
            description: "是否截取完整页面长截图（包括滚动区域），默认 false 只截取可见区域。用于查看整个页面内容时设为 true"
          },
          clip: {
            type: "object",
            description: "指定截取区域（像素）",
            properties: {
              x: { type: "number", description: "左上角 X 坐标" },
              y: { type: "number", description: "左上角 Y 坐标" },
              width: { type: "number", description: "宽度" },
              height: { type: "number", description: "高度" },
            },
          },
        },
      },
    },
    {
      name: "get_page_content",
      description:
        "【推荐用于快速获取页面内容】提取当前页面的文本、HTML 或结构化数据。" +
        "比 capture_screenshot 更快更轻量，适用于：" +
        "1) 获取页面文字内容 2) 提取链接/按钮/表单等元素 " +
        "3) 分析 DOM 结构 4) 获取页面元数据（title/description）。" +
        "当用户说“分析这个页面/网站”“看看页面里有什么内容”且不强调视觉效果时，优先使用此工具，" +
        "无需用户显式提到 ghost-bridge。" +
        "当需要文本信息而非视觉效果时，优先使用此工具。" +
        "注意：不支持 iframe 内容，不反映 CSS 样式。",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["text", "html", "structured"],
            description:
              "提取模式：text=纯文本（默认，最快）; html=HTML片段; structured=结构化数据（标题/链接/按钮/表单/图片）",
          },
          selector: {
            type: "string",
            description:
              "CSS 选择器，限定提取范围。如 'main'、'#content'、'.article'。不指定则提取整个 body",
          },
          maxLength: {
            type: "number",
            description: "最大返回长度（字符数），默认 50000。仅对 text/html 模式有效",
          },
          includeMetadata: {
            type: "boolean",
            description: "是否包含页面元数据（title/url/description），默认 true",
          },
        },
      },
    },
    {
      name: "get_interactive_snapshot",
      description:
        "【操作页面前必须先调用】扫描当前页面所有可见的可交互元素（按钮/链接/输入框/下拉框等），" +
        "返回带有 ref 短标识（如 e1, e2, e3）的精简列表，包含元素类型、文本和位置。" +
        "Token 极省（通常 < 1000 tokens），专为 AI 操作页面而设计。" +
        "当用户要求点击、输入、登录、提交表单、打开菜单等操作时，应主动使用此工具开始定位元素，" +
        "无需用户显式提到 ghost-bridge。" +
        "获取后可通过 dispatch_action 工具使用 ref 标识来点击、填写、按键等。" +
        "支持 Shadow DOM 穿透。\n" +
        "⚠️ 仅用于交互操作前的元素定位。如需排查 UI/CSS 布局问题，请使用 capture_screenshot 或 get_page_content。",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS 选择器，限定扫描范围。不指定则扫描整个页面",
          },
          includeText: {
            type: "boolean",
            description: "是否包含元素的文本/占位符等信息，默认 true",
          },
          maxElements: {
            type: "number",
            description: "最大返回元素数量，默认 100",
          },
        },
      },
    },
    {
      name: "dispatch_action",
      description:
        "【操作页面元素】对 get_interactive_snapshot 返回的元素执行动作。" +
        "通过 ref 标识（如 e1, e5）精准定位元素，使用 CDP 物理级模拟执行操作，" +
        "兼容所有前端框架（React/Vue/Angular），成功率极高。\n" +
        "当用户明确希望在页面上执行点击、输入、回车、滚动、选择等操作时，应结合 get_interactive_snapshot 主动使用此工具，" +
        "无需用户显式提到 ghost-bridge。\n" +
        "支持的动作：click（点击）、fill（填写输入框）、press（按键如 Enter）、" +
        "scroll（滚动）、select（下拉选择）、hover（悬停）、focus（聚焦）。\n" +
        "⚠️ 使用前必须先调用 get_interactive_snapshot 获取元素列表。" +
        "操作后建议用 capture_screenshot 或再次 get_interactive_snapshot 验证结果。",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: "目标元素的 ref 标识，如 'e1'、'e5'（从 get_interactive_snapshot 获取）",
          },
          action: {
            type: "string",
            enum: ["click", "fill", "press", "scroll", "select", "hover", "focus"],
            description: "要执行的动作类型",
          },
          value: {
            type: "string",
            description: "fill 时为要输入的文本；select 时为要选择的 option value；press 时为按键名（可选）",
          },
          key: {
            type: "string",
            description: "press 动作的按键名，如 'Enter'、'Escape'、'Tab'、'Backspace'。默认 'Enter'",
          },
          deltaX: {
            type: "number",
            description: "scroll 动作的水平滚动量（像素），默认 0",
          },
          deltaY: {
            type: "number",
            description: "scroll 动作的垂直滚动量（像素），默认 300（正数向下，负数向上）",
          },
          waitMs: {
            type: "number",
            description: "操作后等待页面响应的时间（毫秒），默认 500，最大 3000",
          },
        },
        required: ["ref", "action"],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments || {}
  try {
    if (name === "inspect_page") {
      const { selector, includeInteractive = true, maxElements = 30 } = args
      const snapshot = await askChrome("inspectPageSnapshot", {
        selector,
        includeInteractive,
        maxElements,
      })
      const page = snapshot?.page
      const interactive = snapshot?.interactive ?? null

      const links = page?.counts?.links
      const buttons = page?.counts?.buttons
      const forms = page?.counts?.forms
      const interactiveCount = Array.isArray(interactive?.elements)
        ? interactive.elements.length
        : Array.isArray(interactive)
          ? interactive.length
          : undefined

      return {
        content: [
          {
            type: "text",
            text: jsonText({
              summary: {
                title: page?.metadata?.title,
                url: page?.metadata?.url,
                description: page?.metadata?.description,
                links,
                buttons,
                forms,
                interactiveCount,
              },
              page,
              interactive,
              nextStepHint:
                "如果需要看视觉效果，继续用 capture_screenshot；如果需要点击或输入，继续用 dispatch_action；如果需要排查请求或性能，继续用 list_network_requests / perf_metrics。",
            }),
          },
        ],
      }
    }

    if (name === "get_server_info") {
      let chromeOk, clientsCount

      if (isMainInstance) {
        chromeOk = !!chromeConnection
        clientsCount = mcpClients.size
      } else {
        // 非主实例：查询主实例的状态
        try {
          const mainStatus = await askMainInstance("_getMainStatus")
          chromeOk = mainStatus.chromeConnected
          clientsCount = mainStatus.mcpClientsCount
        } catch {
          chromeOk = false
          clientsCount = "N/A"
        }
      }

      return {
        content: [
          {
            type: "text",
            text: jsonText({
              service: "ghost-bridge",
              version: GHOST_BRIDGE_VERSION,
              role: isMainInstance ? "主实例 (WebSocket Server)" : "客户端 (连接到主实例)",
              wsPort: actualPort,
              wsUrl: `ws://localhost:${actualPort}`,
              pid: process.pid,
              chromeConnected: chromeOk,
              mcpClientsCount: clientsCount,
              portInfoFile: PORT_INFO_FILE,
              note: chromeOk
                ? "✅ Chrome 扩展已连接，可以使用调试功能"
                : `❌ Chrome 扩展未连接，请在浏览器中启用 Ghost Bridge 扩展并连接到端口 ${actualPort}`,
            }),
          },
        ],
      }
    }

    if (name === "get_last_error") {
      const { severity = "error", limit = 20 } = args
      const data = await askChrome("getLastError", { severity, limit })
      return { content: [{ type: "text", text: jsonText(data) }] }
    }

    if (name === "get_script_source") {
      const {
        scriptUrlContains,
        line,
        column,
        beautify: wantBeautify = true,
        contextLines = 20,
      } = args
      const res = await askChrome("getScriptSource", {
        scriptUrlContains,
        line,
        column,
      })
      const snippet = buildSnippet(res?.source || "", res?.location?.line, res?.location?.column, {
        beautifyEnabled: wantBeautify,
        contextLines,
      })
      return {
        content: [
          {
            type: "text",
            text: jsonText({
              url: res?.url,
              scriptId: res?.scriptId,
              location: res?.location,
              note: res?.note,
              rawLength: (res?.source || "").length,
              snippet: snippet.snippet,
              snippetNote: snippet.note,
              truncated: snippet.truncated,
            }),
          },
        ],
      }
    }

    if (name === "coverage_snapshot") {
      const durationMs = args.durationMs || 1500
      const res = await askChrome("coverageSnapshot", { durationMs }, { timeoutMs: durationMs + 4000 })
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "find_by_string") {
      const { query, scriptUrlContains, maxMatches = 5 } = args
      const res = await askChrome("findByString", { query, scriptUrlContains, maxMatches })
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "symbolic_hints") {
      const res = await askChrome("symbolicHints")
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "eval_script") {
      const res = await askChrome("eval", { code: args.code })
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "list_network_requests") {
      const { filter, method, status, resourceType, limit, priorityMode = "debug" } = args
      const res = await askChrome("listNetworkRequests", { filter, method, status, resourceType, limit, priorityMode })
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "get_network_detail") {
      const { requestId, includeBody } = args
      const res = await askChrome("getNetworkDetail", { requestId, includeBody })
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "clear_network_requests") {
      const res = await askChrome("clearNetworkRequests")
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "perf_metrics") {
      const { includeTimings, includeResources } = args
      const res = await askChrome("perfMetrics", { includeTimings, includeResources })
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "capture_screenshot") {
      const { format, quality, fullPage, clip } = args
      // 截图可能需要更长时间（特别是完整页面截图）
      const res = await askChrome("captureScreenshot", { format, quality, fullPage, clip }, { timeoutMs: 15000 })
      
      // 返回图片内容（MCP 支持 image 类型）
      const contents = []
      
      // 添加图片数据
      if (res.imageData) {
        contents.push({
          type: "image",
          data: res.imageData,
          mimeType: res.format === "jpeg" ? "image/jpeg" : "image/png",
        })
      }
      
      // 添加元数据文本
      const metadata = {
        format: res.format,
        ...(res.quality !== undefined ? { quality: res.quality } : {}),
        fullPage: res.fullPage,
        width: res.width,
        height: res.height,
        ...(res.note ? { note: res.note } : {}),
      }
      contents.push({
        type: "text",
        text: jsonText(metadata),
      })
      
      return { content: contents }
    }

    if (name === "get_page_content") {
      const { mode = "text", selector, maxLength = 50000, includeMetadata = true } = args

      const validModes = ["text", "html", "structured"]
      if (mode && !validModes.includes(mode)) {
        return {
          content: [{
            type: "text",
            text: `Error: 无效的 mode "${mode}"，可选值: ${validModes.join(", ")}`
          }]
        }
      }

      const res = await askChrome("getPageContent", { mode, selector, maxLength, includeMetadata })
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "get_interactive_snapshot") {
      const { selector, includeText, maxElements } = args
      const res = await askChrome("getInteractiveSnapshot", { selector, includeText, maxElements })
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    if (name === "dispatch_action") {
      const { ref, action, value, key, deltaX, deltaY, waitMs } = args
      const res = await askChrome("dispatchAction", { ref, action, value, key, deltaX, deltaY, waitMs }, { timeoutMs: 10000 })
      return { content: [{ type: "text", text: jsonText(res) }] }
    }

    return { content: [{ type: "text", text: `未知工具：${name}` }] }
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

// 启动完成日志
const roleText = isMainInstance ? "主实例" : "客户端"
log(`✅ MCP server 已启动 | 角色: ${roleText} | 端口: ${actualPort} | PID: ${process.pid} | PPID: ${process.ppid}`)
log(`📄 端口信息文件: ${PORT_INFO_FILE}`)
log(`💡 使用 get_server_info 工具查看详细状态`)

// ========== 孤儿进程检测与自动退出 ==========
const PARENT_CHECK_INTERVAL = 5000  // 每 5 秒检查一次父进程
const parentPid = process.ppid

// 方法 1: 监听 stdin 关闭（父进程退出时 stdin 会关闭）
process.stdin.on("end", () => {
  log("⚠️ stdin 已关闭，父进程可能已退出，正在退出...")
  cleanup()
  process.exit(0)
})

process.stdin.on("close", () => {
  log("⚠️ stdin 已关闭，正在退出...")
  cleanup()
  process.exit(0)
})

// 方法 2: 定期检查父进程是否还存活
const parentCheckTimer = setInterval(() => {
  try {
    // process.kill(pid, 0) 不会杀死进程，只检查进程是否存在
    process.kill(parentPid, 0)
  } catch (e) {
    // 父进程不存在了
    log(`⚠️ 父进程 (PID: ${parentPid}) 已不存在，正在退出...`)
    clearInterval(parentCheckTimer)
    cleanup()
    process.exit(0)
  }
}, PARENT_CHECK_INTERVAL)

// 确保定时器不阻止进程退出
parentCheckTimer.unref()

// ========== 进程退出清理 ==========
function cleanup() {
  log("🧹 正在清理...")

  // 主实例退出时删除端口信息文件
  if (isMainInstance) {
    try {
      // 只有当文件中的 PID 是当前进程时才删除
      if (fs.existsSync(PORT_INFO_FILE)) {
        const info = JSON.parse(fs.readFileSync(PORT_INFO_FILE, "utf-8"))
        if (info.pid === process.pid) {
          fs.unlinkSync(PORT_INFO_FILE)
          log("📝 已删除端口信息文件")
        }
      }
    } catch (e) {
      log(`清理端口信息文件失败: ${e.message}`)
    }

    // 关闭 WebSocket 服务器
    if (wss) {
      wss.close(() => {
        log("🔌 WebSocket 服务器已关闭")
      })
    }
  }

  // 关闭所有连接
  if (activeConnection) {
    activeConnection.close()
  }
}

// 监听各种退出信号
process.on("SIGINT", () => {
  log("收到 SIGINT 信号")
  cleanup()
  process.exit(0)
})

process.on("SIGTERM", () => {
  log("收到 SIGTERM 信号")
  cleanup()
  process.exit(0)
})

process.on("exit", () => {
  // exit 事件中只能执行同步操作
  if (isMainInstance) {
    try {
      if (fs.existsSync(PORT_INFO_FILE)) {
        const info = JSON.parse(fs.readFileSync(PORT_INFO_FILE, "utf-8"))
        if (info.pid === process.pid) {
          fs.unlinkSync(PORT_INFO_FILE)
        }
      }
    } catch {}
  }
})

// 处理未捕获的异常
process.on("uncaughtException", (err) => {
  log(`未捕获的异常: ${err.message}`)
  cleanup()
  process.exit(1)
})
