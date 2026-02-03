import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { WebSocketServer } from "ws"
import beautify from "js-beautify"
import crypto from "crypto"
import net from "net"

const BASE_PORT = Number(process.env.GHOST_BRIDGE_PORT || 33333)
const MAX_PORT_RETRIES = 10
const WS_TOKEN = "1"
const RESPONSE_TIMEOUT = 8000

let activeConnection = null
let actualPort = BASE_PORT
const pendingRequests = new Map()

function log(msg) {
  console.error(`[ghost-bridge] ${msg}`)
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
  for (let i = 0; i < MAX_PORT_RETRIES; i++) {
    const port = BASE_PORT + i
    const available = await isPortAvailable(port)
    if (available) {
      actualPort = port
      const wss = new WebSocketServer({ port })
      if (port !== BASE_PORT) {
        log(`⚠️ 端口 ${BASE_PORT} 被占用，已切换到端口 ${port}`)
      }
      log(`等待 Chrome 扩展连接，端口 ${port}${WS_TOKEN ? "（启用 token 校验）" : ""}`)
      return wss
    } else {
      log(`端口 ${port} 被占用，尝试下一个...`)
    }
  }
  throw new Error(`无法找到可用端口（已尝试 ${BASE_PORT} - ${BASE_PORT + MAX_PORT_RETRIES - 1}）`)
}

const wss = await startWebSocketServer()

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", "http://localhost")
  const token = url.searchParams.get("token") || ""
  if (WS_TOKEN && token !== WS_TOKEN) {
    log("拒绝连接：token 不匹配")
    ws.close(1008, "Bad token")
    return
  }
  log("Chrome 扩展已连接")
  activeConnection = ws
  ws.on("message", handleIncoming)
  ws.on("close", () => {
    log("Chrome 连接已关闭")
    activeConnection = null
    failAllPending("Chrome 连接断开")
  })
})

function failAllPending(message) {
  pendingRequests.forEach(({ reject, timer }) => {
    clearTimeout(timer)
    reject(new Error(message))
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
  return typeof data === "string" ? data : JSON.stringify(data, null, 2)
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
  { name: "ghost-bridge", version: "0.1.0" },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_last_error",
      description: "获取当前标签最近的异常/报错堆栈与元数据（无 sourcemap 友好）",
      inputSchema: { type: "object", properties: {} },
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
        "列出捕获的网络请求，支持按 URL、方法、状态、类型过滤",
      inputSchema: {
        type: "object",
        properties: {
          filter: { type: "string", description: "URL 关键词过滤" },
          method: { type: "string", description: "请求方法：GET/POST/PUT/DELETE 等" },
          status: { type: "string", description: "状态：success/error/failed/pending" },
          resourceType: { type: "string", description: "资源类型：XHR/Fetch/Script/Image 等" },
          limit: { type: "number", description: "返回数量限制，默认 50" },
        },
      },
    },
    {
      name: "get_network_detail",
      description:
        "获取单个网络请求的详细信息，包括请求头、响应头，可选获取响应体",
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
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments || {}
  try {
    if (name === "get_last_error") {
      const data = await askChrome("getLastError")
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
      const { filter, method, status, resourceType, limit } = args
      const res = await askChrome("listNetworkRequests", { filter, method, status, resourceType, limit })
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

    return { content: [{ type: "text", text: `未知工具：${name}` }] }
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
log("MCP server 已启动")
