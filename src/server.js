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
import { spawn } from "child_process"
import { fileURLToPath } from "url"
import { GHOST_BRIDGE_VERSION } from "../lib/version.js"

const BASE_PORT = Number(process.env.GHOST_BRIDGE_PORT || 33333)
const DEFAULT_WS_TOKEN = "ghost-bridge-local"
const WS_TOKEN = process.env.GHOST_BRIDGE_TOKEN || DEFAULT_WS_TOKEN
const RESPONSE_TIMEOUT = 8000
const DEFAULT_EVAL_OUTPUT_LENGTH = 8000
const MAX_EVAL_OUTPUT_LENGTH = 50000
const PORT_INFO_FILE = process.env.GHOST_BRIDGE_PORT_INFO || path.join(os.tmpdir(), "ghost-bridge-port.json")
const SERVER_STARTED_AT = new Date().toISOString()
const SERVER_ENTRY_PATH = fileURLToPath(import.meta.url)
// daemon 模式：常驻 WebSocket 服务进程（detached 启动，生命周期独立于任何 MCP 会话，
// 只有 ghost-bridge stop 或系统重启才会让它退出）
const IS_DAEMON = process.env.GHOST_BRIDGE_DAEMON === "1"

let chromeConnection = null   // Chrome 扩展的连接（daemon 持有）
let activeConnection = null   // 当前用于发送请求的连接（daemon 用 chromeConnection，会话进程用到 daemon 的连接）
let actualPort = BASE_PORT
let isMainInstance = false    // 是否持有 WebSocket 服务器（仅 daemon 为 true）
const pendingRequests = new Map()
const mcpClients = new Set()  // 连接到 daemon 的其他 MCP 会话进程
let mcpClientSeq = 0          // MCP 客户端 clientId 序号（c1、c2…），进程生命周期内不复用
const LOCAL_CLIENT_ID = "local" // daemon 本地请求的 clientId

const DAEMON_LOG_FILE = path.join(os.homedir(), ".ghost-bridge", "daemon.log")

function appendDaemonLog(line) {
  try {
    fs.mkdirSync(path.dirname(DAEMON_LOG_FILE), { recursive: true })
    try {
      const st = fs.statSync(DAEMON_LOG_FILE)
      // 简单轮转：超 2MB 保留后半，避免无限增长
      if (st.size > 2 * 1024 * 1024) {
        const tail = fs.readFileSync(DAEMON_LOG_FILE).slice(-512 * 1024)
        fs.writeFileSync(DAEMON_LOG_FILE, tail)
      }
    } catch {}
    fs.appendFileSync(DAEMON_LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function log(msg) {
  const line = `[ghost-bridge] ${msg}`
  console.error(line)
  // daemon 以 detached + stdio ignore 运行，stderr 无人接收；日志落盘便于事后排查（如 daemon 静默退出）
  if (IS_DAEMON) appendDaemonLog(line)
}

function buildIdentityPayload() {
  return {
    type: "identity",
    service: "ghost-bridge",
    token: WS_TOKEN,
    pid: process.pid,
    port: actualPort,
    version: GHOST_BRIDGE_VERSION,
    serverPath: SERVER_ENTRY_PATH,
    startedAt: SERVER_STARTED_AT,
    capabilities: ["heartbeat"],
  }
}

function getServiceMismatch(probe) {
  if (!probe || probe.service !== "ghost-bridge") return null
  if (!probe.version) return "旧服务缺少版本元数据"
  if (probe.version !== GHOST_BRIDGE_VERSION) {
    return `版本不一致（旧: ${probe.version}, 新: ${GHOST_BRIDGE_VERSION}）`
  }
  if (!probe.serverPath) return "旧服务缺少路径元数据"
  if (path.resolve(probe.serverPath) !== path.resolve(SERVER_ENTRY_PATH)) {
    return `路径不一致（旧: ${probe.serverPath}, 新: ${SERVER_ENTRY_PATH}）`
  }
  return null
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
 * 主动探测端口上的服务身份
 */
function probeExistingService(port) {
  return new Promise((resolve) => {
    const url = new URL(`ws://localhost:${port}`)
    url.searchParams.set("role", "probe")

    const ws = new WebSocket(url.toString())
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
          ws.close()
        }
      } catch {}
      resolve(result)
    }

    const timeout = setTimeout(() => {
      finish(null)
    }, 2000)

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === "identity" && msg.service === "ghost-bridge") {
          finish(msg)
        }
      } catch {}
    })
    ws.on("error", () => {
      finish(null)
    })
    ws.on("close", () => {
      finish(null)
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPortAvailable(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) {
      return true
    }
    await sleep(100)
  }
  return isPortAvailable(port)
}

/**
 * 停止旧实例，让新实例接管固定端口
 */
async function stopExistingService(pid, port, reason = "需要由新实例接管") {
  if (!pid || pid === process.pid) {
    return false
  }

  log(`检测到旧实例需要替换：${reason}，准备停止旧实例 (PID: ${pid})`)

  try {
    process.kill(pid, "SIGTERM")
  } catch (e) {
    if (e.code === "ESRCH") {
      log(`旧实例 PID ${pid} 已不存在`)
      return true
    }
    throw e
  }

  const released = await waitForPortAvailable(port, 5000)
  if (!released) {
    throw new Error(`旧实例 (PID: ${pid}) 未在预期时间内释放端口 ${port}`)
  }

  if (fs.existsSync(PORT_INFO_FILE)) {
    try {
      const info = JSON.parse(fs.readFileSync(PORT_INFO_FILE, "utf-8"))
      if (info.pid === pid) {
        fs.unlinkSync(PORT_INFO_FILE)
      }
    } catch {}
  }

  log(`✅ 旧实例已退出，端口 ${port} 可由新实例接管`)
  return true
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
 * 启动 WebSocket 服务器（race-safe：监听成功 resolve，EADDRINUSE 等错误 reject）
 * 并发拉起的多个 daemon 竞争同一端口时，输掉的一方通过 reject 走"已有服务"分支退出
 */
function startWebSocketServer(port) {
  return new Promise((resolve, reject) => {
    let settled = false
    const wss = new WebSocketServer({ port }, () => {
      if (settled) return
      settled = true
      wss.removeListener("error", onError)
      resolve(wss)
    })
    const onError = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
    wss.on("error", onError)
  })
}

/**
 * daemon：获取固定端口（必要时接管旧服务）
 * 返回 { wss } 表示绑定成功；返回 { alreadyRunning: true } 表示已有等价服务在跑（本进程应退出）；
 * 端口被外部进程占用且无法接管时抛错
 */
async function acquirePortForDaemon() {
  // 检查端口信息文件指向的服务
  const existing = getExistingService()
  if (existing) {
    log(`检测到现有服务 (PID: ${existing.pid}, 端口: ${existing.port})，验证中...`)
    const probe = await probeExistingService(existing.port)
    if (probe?.service === "ghost-bridge") {
      if (probe.token === WS_TOKEN) {
        const mismatch = getServiceMismatch(probe)
        if (!mismatch) {
          actualPort = existing.port
          log(`✅ 已有常驻服务在运行，无需重复启动`)
          return { alreadyRunning: true }
        }
        await stopExistingService(Number(probe.pid) || existing.pid, existing.port, mismatch)
      } else {
        await stopExistingService(Number(probe.pid) || existing.pid, existing.port, "token 不一致")
      }
    } else {
      log(`❌ 现有服务验证失败，准备接管...`)
      try { fs.unlinkSync(PORT_INFO_FILE) } catch {}
    }
  }

  if (!(await isPortAvailable(BASE_PORT))) {
    const probe = await probeExistingService(BASE_PORT)
    if (probe?.service === "ghost-bridge") {
      if (probe.token === WS_TOKEN) {
        const mismatch = getServiceMismatch(probe)
        if (!mismatch) {
          actualPort = BASE_PORT
          log(`✅ 固定端口上已有常驻服务在运行，无需重复启动`)
          return { alreadyRunning: true }
        }
        await stopExistingService(Number(probe.pid), BASE_PORT, mismatch)
      } else {
        await stopExistingService(Number(probe.pid), BASE_PORT, "token 不一致")
      }
    }

    if (!(await isPortAvailable(BASE_PORT))) {
      throw new Error(`固定端口 ${BASE_PORT} 已被其他进程占用，请释放该端口或通过 GHOST_BRIDGE_PORT 指定其他端口`)
    }
  }

  let wss
  try {
    wss = await startWebSocketServer(BASE_PORT)
  } catch (err) {
    // 绑定失败的典型原因是并发启动的 daemon 抢先绑定了端口：确认是等价服务就直接让位
    const probe = await probeExistingService(BASE_PORT)
    if (probe?.service === "ghost-bridge" && probe.token === WS_TOKEN && !getServiceMismatch(probe)) {
      actualPort = BASE_PORT
      log(`✅ 另一个常驻服务已抢先启动，本进程退出`)
      return { alreadyRunning: true }
    }
    throw err
  }

  log(`🚀 WebSocket 服务已启动，端口 ${BASE_PORT}${WS_TOKEN ? "（启用 token 校验）" : ""}`)
  actualPort = BASE_PORT
  isMainInstance = true
  return { wss }
}

/**
 * daemon 入口：获取端口并写入端口信息文件，返回 WebSocket 服务器实例；
 * 已有等价服务或无法绑定时直接退出
 */
async function runDaemon() {
  let acquired
  try {
    acquired = await acquirePortForDaemon()
  } catch (e) {
    log(`❌ daemon 启动失败：${e.message}`)
    process.exit(1)
  }
  if (acquired.alreadyRunning) {
    process.exit(0)
  }

  // 写入端口信息
  fs.writeFileSync(
    PORT_INFO_FILE,
    JSON.stringify({
      port: actualPort,
      wsUrl: `ws://localhost:${actualPort}`,
      pid: process.pid,
      version: GHOST_BRIDGE_VERSION,
      serverPath: SERVER_ENTRY_PATH,
      startedAt: SERVER_STARTED_AT
    }, null, 2)
  )
  log(`📝 端口信息已写入: ${PORT_INFO_FILE}`)
  return acquired.wss
}

/**
 * 会话进程：确保常驻 daemon 在运行（没有就 detached 拉起一个），成功返回 true
 * 探测失败/不匹配时也走拉起流程，由 daemon 内部完成对旧服务的接管
 */
async function ensureDaemonRunning() {
  const existing = getExistingService()
  if (existing) {
    const probe = await probeExistingService(existing.port)
    if (probe?.service === "ghost-bridge" && probe.token === WS_TOKEN && !getServiceMismatch(probe)) {
      actualPort = Number(probe.port) || existing.port
      return true
    }
  } else {
    // 端口信息文件丢失但服务可能还在，直接探测固定端口
    const probe = await probeExistingService(BASE_PORT)
    if (probe?.service === "ghost-bridge" && probe.token === WS_TOKEN && !getServiceMismatch(probe)) {
      actualPort = BASE_PORT
      return true
    }
  }
  return spawnDaemonAndWait()
}

/**
 * 会话进程：detached 拉起 daemon 并等待其就绪
 * daemon 与当前会话进程无父子依赖（unref + stdio ignore），
 * 会话退出后 daemon 继续存活，避免 WebSocket 服务跟着会话陪葬
 */
async function spawnDaemonAndWait(timeoutMs = 15000) {
  log("🛠 常驻服务未运行，正在启动 daemon...")
  const child = spawn(process.execPath, [SERVER_ENTRY_PATH], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, GHOST_BRIDGE_DAEMON: "1" },
  })
  child.unref()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await probeExistingService(BASE_PORT)
    if (probe?.service === "ghost-bridge" && probe.token === WS_TOKEN && !getServiceMismatch(probe)) {
      actualPort = Number(probe.port) || BASE_PORT
      log(`✅ daemon 已就绪 (PID: ${probe.pid}, 端口: ${actualPort})`)
      return true
    }
    await sleep(250)
  }
  log(`❌ daemon 未能在 ${timeoutMs}ms 内就绪，稍后将重试`)
  return false
}

const wss = IS_DAEMON ? await runDaemon() : null

// 协议层心跳定时器：主动 ping 所有连接，超时未响应的视为死连接并踢除
let wsPingInterval = null
const WS_PING_INTERVAL_MS = 30000

// daemon：设置 WebSocket 服务器的连接处理
if (wss) {
  wss.on("connection", (ws, req) => {
    // 标记连接活性，配合下方 ping 定时器检测半开死连接（系统休眠唤醒后常见）
    ws.isAlive = true
    ws.on("pong", () => {
      ws.isAlive = true
    })

    const url = new URL(req.url || "/", "http://localhost")
    const token = url.searchParams.get("token") || ""
    const role = url.searchParams.get("role") || ""

    if (role === "probe") {
      ws.send(JSON.stringify(buildIdentityPayload()))
      ws.close(1000, "Probe complete")
      return
    }

    if (WS_TOKEN && token !== WS_TOKEN) {
      log(`拒绝连接：token 不匹配 (收到: ${token}, 期望: ${WS_TOKEN})`)
      ws.close(1008, "Bad token")
      return
    }
    log(`连接验证通过 (token: ${token})`)

    if (role === "mcp-client") {
      // 其他 MCP 实例的连接：分配 clientId，其 pin/bind 的 target 命名空间在扩展端按它隔离
      const clientId = `c${++mcpClientSeq}`
      ws.ghostClientId = clientId
      log(`📡 MCP 客户端已连接 (${clientId})`)
      mcpClients.add(ws)
      ws.send(JSON.stringify(buildIdentityPayload()))

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
                port: actualPort,
                version: GHOST_BRIDGE_VERSION,
                serverPath: SERVER_ENTRY_PATH,
                pid: process.pid,
                startedAt: SERVER_STARTED_AT,
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
          if (msg.id) {
            // 改写为 "clientId:原id" 复合 id：不同 MCP 客户端的 id 序列（多为小整数）互不冲突，
            // 响应回来时按前缀路由回来源并还原原 id
            const wireId = `${clientId}:${msg.id}`
            pendingRequests.set(wireId, { source: ws, originalId: msg.id })
            chromeConnection.send(JSON.stringify({
              id: wireId,
              command: msg.command,
              params: msg.params,
              clientId,
              ...(WS_TOKEN ? { token: WS_TOKEN } : {}),
            }))
          } else {
            chromeConnection.send(data)
          }
        } catch {}
      })

      ws.on("close", () => {
        log(`📡 MCP 客户端已断开 (${ws.ghostClientId})`)
        mcpClients.delete(ws)
        // 通知扩展清理该会话的 target 命名空间（连接可能已不在，失败忽略）
        askChrome("_clientDisconnected", { clientId: ws.ghostClientId }, { timeoutMs: 3000 }).catch(() => {})
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
      ws.send(JSON.stringify(buildIdentityPayload()))

      ws.on("message", (data) => {
        // 检查是否需要转发响应到 MCP 客户端
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === "heartbeat") {
            ws.send(JSON.stringify({ type: "heartbeat_ack", ts: msg.ts || Date.now() }))
            return
          }
          if (msg.id && pendingRequests.has(msg.id)) {
            const pending = pendingRequests.get(msg.id)
            // 区分：来自其他 MCP 客户端的请求 vs 本地请求
            if (pending.source) {
              pendingRequests.delete(msg.id)
              // 还原为该客户端的原始 id 后转发
              if (pending.source.readyState === WebSocket.OPEN) {
                pending.source.send(JSON.stringify({ ...msg, id: pending.originalId }))
              }
              return
            }
            // 本地请求，直接处理（不要在这里删除）
          }
        } catch {}
        // 本地处理
        handleIncoming(data)
      })

      ws.on("close", (code, reason) => {
        const reasonText = reason ? reason.toString() : ""
        log(`🌐 Chrome 连接已关闭 (code=${code}${reasonText ? ` reason="${reasonText}"` : ""})`)
        if (chromeConnection !== ws) {
          log("忽略旧 Chrome 连接的关闭事件")
          return
        }
        chromeConnection = null
        if (activeConnection === ws) {
          activeConnection = null
        }
        failAllPending("Chrome 连接断开")
      })

      ws.on("error", (err) => {
        log(`🌐 Chrome 连接错误: ${err.message}`)
      })
    }
  })

  // 每 30 秒 ping 一次所有连接；连续一轮未回 pong 即 terminate，
  // 立即触发 close 事件清理 chromeConnection，客户端随之快速重连
  wsPingInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        log("🌐 心跳超时，主动断开死连接")
        client.terminate()
        continue
      }
      client.isAlive = false
      try {
        client.ping()
      } catch {}
    }
  }, WS_PING_INTERVAL_MS)
} else {
  // 会话进程：确保常驻 daemon 在运行（必要时拉起），然后作为客户端连接
  const ready = await ensureDaemonRunning()
  if (!ready) log("⚠️ 常驻服务暂时不可用，将保持后台重试并自动拉起")
  log(`📡 作为客户端连接到常驻服务 (端口: ${actualPort})...`)
  connectToMainInstance()
}

const RECONNECT_INTERVAL = 3000   // 与常驻服务的重连间隔 (ms)
const DAEMON_CHECK_EVERY = 5      // 连续失败每 N 次检查并尝试重新拉起 daemon
let consecutiveFailures = 0

/**
 * 会话进程：作为 MCP 客户端连接到常驻 daemon
 * 连不上时不退出——保持重连，并周期性尝试重新拉起 daemon。
 * 这样 daemon 意外挂掉后，任何一个存活会话都能让服务自动恢复
 * （扩展端本来就在无限重试，会随即连上）
 */
function connectToMainInstance() {
  const url = new URL(`ws://localhost:${actualPort}`)
  url.searchParams.set("token", WS_TOKEN)
  url.searchParams.set("role", "mcp-client") // 标识为 MCP 客户端

  const ws = new WebSocket(url.toString())

  ws.on("open", () => {
    log(`✅ 已连接到常驻服务 (端口: ${actualPort})`)
    consecutiveFailures = 0
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
    log("⚠️ 与常驻服务的连接已断开")
    activeConnection = null
    failAllPending("与常驻服务的连接已断开")

    consecutiveFailures++
    const attempt = consecutiveFailures
    const needDaemonCheck = attempt % DAEMON_CHECK_EVERY === 0

    setTimeout(async () => {
      if (activeConnection) return
      if (needDaemonCheck) {
        log(`🔄 连续 ${attempt} 次未连上常驻服务，检查并尝试拉起...`)
        await ensureDaemonRunning()
      }
      if (activeConnection) return
      log(`🔄 尝试重新连接到常驻服务 (第 ${attempt} 次)...`)
      connectToMainInstance()
    }, RECONNECT_INTERVAL)
  })

  ws.on("error", (err) => {
    log(`❌ 连接常驻服务失败: ${err.message}`)
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
  if (!activeConnection) throw new Error("未连接到常驻服务")
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
  if (!activeConnection) {
    throw new Error(
      IS_DAEMON
        ? "Chrome 未连接，请确认浏览器开启且扩展已启用"
        : "ghost-bridge 常驻服务未连接，请稍后重试（可用 ghost-bridge status 检查）"
    )
  }
  const id = crypto.randomUUID()
  const payload = { id, command, params, clientId: LOCAL_CLIENT_ID }
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

// 递归剔除 null / 空串 / 空数组 / 空对象字段——这类噪声在工具输出里占比不小且无信息量
function compact(value) {
  if (Array.isArray(value)) {
    const cleaned = value.map(compact).filter((v) => v !== undefined)
    return cleaned.length ? cleaned : undefined
  }
  if (value && typeof value === "object") {
    const cleaned = {}
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v)
      if (c !== undefined) cleaned[k] = c
    }
    return Object.keys(cleaned).length ? cleaned : undefined
  }
  if (value === null || value === "") return undefined
  return value
}

// 所有工具输出的统一出口：compact 后再序列化
function out(data) {
  return jsonText(compact(data))
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

// eval_script 可以返回任意页面对象。统一限制序列化后的文本长度，避免一次意外的
// DOM / bundle 返回污染后续所有模型请求；保留首尾便于判断内容类型与结束状态。
function boundedOut(data, maxLength = DEFAULT_EVAL_OUTPUT_LENGTH) {
  const text = out(data) ?? "undefined"
  const limit = clampNumber(maxLength, DEFAULT_EVAL_OUTPUT_LENGTH, 200, MAX_EVAL_OUTPUT_LENGTH)
  if (text.length <= limit) return text

  const markerBudget = 100
  const headLength = Math.max(100, Math.floor((limit - markerBudget) * 0.8))
  const tailLength = Math.max(50, limit - markerBudget - headLength)
  const omitted = Math.max(0, text.length - headLength - tailLength)
  return out({
    truncated: true,
    originalLength: text.length,
    content: `${text.slice(0, headLength)}\n... [已省略 ${omitted} 个字符] ...\n${text.slice(-tailLength)}`,
    hint: "需要更多结果时请收窄返回字段；不要通过连续轮询分片获取大对象",
  })
}

// 元数据里的 URL 常带超长 query（跟踪参数、回调地址等），输出前统一截断
function truncateUrl(url, maxLen = 200) {
  if (typeof url !== "string" || url.length <= maxLen) return url
  return url.slice(0, maxLen) + "…"
}

// list_tabs 输出瘦身：URL 截断、去掉与 tabs[] 重复的 targetTab/viewingTab 对象、丢弃 windowId
function shrinkListTabs(res, { fullUrl } = {}) {
  if (!res || !Array.isArray(res.tabs)) return res
  const trimTab = (t) => {
    if (!t) return t
    const item = { id: t.id, index: t.index, active: t.active, title: t.title, url: t.url }
    if (!fullUrl && typeof item.url === "string" && item.url.length > 200) {
      item.url = item.url.slice(0, 200) + "…"
      item.urlTruncated = true
    }
    return item
  }
  const result = {
    clientId: res.clientId,
    targetMode: res.targetMode,
    focusedTabId: res.focusedTabId,
    pinnedTabId: res.pinnedTabId,
    attachedTabIds: res.attachedTabIds,
    targetTabId: res.targetTab?.id,
    viewingTabId: res.viewingTab?.id,
    targetError: res.targetError,
    targets: (res.targets || []).map((tg) => ({
      owner: tg.owner,
      name: tg.name,
      tabId: tg.tabId,
      attached: tg.attached,
      errorCount: tg.errorCount,
      networkCount: tg.networkCount,
    })),
    tabs: res.tabs.map(trimTab),
  }
  if (!fullUrl) result.note = "URL 超 200 字符已截断，需要完整链接传 fullUrl:true；bind_tab 匹配仍基于真实 URL"
  return result
}

const TARGET_ARG = {
  type: "string",
  description: "命名目标（bind_tab 绑定；缺省用聚焦/锁定页，按会话隔离）",
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
        "页面分析入口：一次返回元数据、结构计数和少量可直接操作的元素 ref，通常无需再调用 get_interactive_snapshot。detail:true 返回完整结构。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          selector: {
            type: "string",
            description: "CSS 选择器，限定分析范围",
          },
          includeInteractive: {
            type: "boolean",
            description: "是否统计可交互元素，默认 true",
          },
          maxElements: {
            type: "number",
            description: "返回可交互元素上限，默认 20",
          },
          includeElements: {
            type: "boolean",
            description: "紧凑模式是否附带可操作元素，默认 true",
          },
          detail: {
            type: "boolean",
            description: "默认 false 只返回紧凑 summary；true 返回全量 page 与 interactive",
          },
        },
      },
    },
    {
      name: "get_server_info",
      description: "服务器状态：WebSocket 端口、Chrome 连接与会话数。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_tabs",
      description: "列出标签页与当前目标模式。URL 超长自动截断，fullUrl:true 输出完整。",
      inputSchema: {
        type: "object",
        properties: {
          fullUrl: {
            type: "boolean",
            description: "默认 false（超 200 字符截断）；true 输出完整 URL",
          },
        },
      },
    },
    {
      name: "bind_tab",
      description: "按 tabId/URL 片段/标题片段把标签页绑定为命名 target（如 cases、app）。命名空间按会话隔离。",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "target 名称，如 cases/app（字母数字下划线连字符）" },
          tabId: { type: "number", description: "标签页 ID，优先使用" },
          urlContains: { type: "string", description: "URL 片段匹配" },
          titleContains: { type: "string", description: "标题片段匹配" },
        },
        required: ["name"],
      },
    },
    {
      name: "unbind_tab",
      description: "解绑命名 target；无其他引用时释放对应调试会话。",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "要解绑的 target 名称" },
        },
        required: ["name"],
      },
    },
    {
      name: "list_targets",
      description: "查看已绑定 targets 与默认目标状态。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_target_tab",
      description: "查看当前操作目标（focused 跟随聚焦页 / pinned 锁定）。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "pin_current_tab",
      description: "锁定当前聚焦标签页为操作目标，切换标签不影响。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "pin_tab",
      description: "按 tabId/URL/标题锁定标签页。pin 状态按会话隔离。",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "标签页 ID，优先使用" },
          urlContains: { type: "string", description: "URL 片段匹配" },
          titleContains: { type: "string", description: "标题片段匹配" },
        },
      },
    },
    {
      name: "unpin_tab",
      description: "解除锁定，恢复跟随聚焦页。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_last_error",
      description: "最近控制台/异常/网络错误。severity 默认 error，可传 info/warn/all。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          severity: {
            type: "string",
            enum: ["error", "warn", "info", "all"],
            description: "日志级别过滤，默认 error",
          },
          limit: {
            type: "number",
            description: "返回条数，默认 20，最大 100",
          },
        },
      },
    },
    {
      name: "get_script_source",
      description: "抓取脚本源码片段，支持 URL 筛选与 beautify。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
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
      description: "采集一次执行覆盖率，列出最活跃的脚本/函数。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          durationMs: { type: "number", description: "默认 1500ms" },
        },
      },
    },
    {
      name: "find_by_string",
      description: "在页面脚本内按字符串搜索，返回匹配上下文。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          query: { type: "string" },
          scriptUrlContains: { type: "string" },
          maxMatches: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "symbolic_hints",
      description: "收集页面资源、全局符号与 UA/URL 线索，推断版本与模块归属。",
      inputSchema: { type: "object", properties: { target: TARGET_ARG } },
    },
    {
      name: "eval_script",
      description: "在目标页执行 JS。高成本工具：同一目标的读取/操作应合并进一次 code；异步代码直接返回 Promise，本工具默认等待完成，禁止写 window 临时变量后再次轮询。结果默认最多 8000 字符。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          code: { type: "string", description: "JS 表达式；异步示例：(async()=>await fetch(...).then(r=>r.json()))()" },
          awaitPromise: { type: "boolean", description: "等待 Promise 完成，默认 true" },
          timeoutMs: { type: "number", description: "Promise 等待上限，默认 10000，最大 30000" },
          maxOutputLength: { type: "number", description: "序列化结果字符上限，默认 8000，最大 50000" },
        },
        required: ["code"],
      },
    },
    {
      name: "page_request",
      description: "使用当前页面登录态发起 fetch 并等待响应，一次返回结果；页面接口调用优先用它，避免 eval_script 发起请求后再轮询。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          url: { type: "string", description: "相对或绝对 HTTP(S) URL" },
          method: { type: "string", description: "默认 GET" },
          headers: { type: "object", description: "请求头" },
          body: { description: "字符串或 JSON 对象；对象会自动 JSON.stringify" },
          responseType: { type: "string", enum: ["auto", "json", "text"], description: "默认 auto" },
          timeoutMs: { type: "number", description: "默认 10000，最大 30000" },
          maxOutputLength: { type: "number", description: "响应内容字符上限，默认 8000，最大 50000" },
        },
        required: ["url"],
      },
    },
    {
      name: "list_network_requests",
      description: "列出捕获的网络请求，支持 URL/方法/状态/类型过滤；超长 URL 自动摘要。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          filter: { type: "string", description: "URL 关键词过滤" },
          method: { type: "string" },
          status: { type: "string", description: "success/error/failed/pending" },
          resourceType: { type: "string" },
          limit: { type: "number" },
          priorityMode: {
            type: "string",
            enum: ["debug", "api", "recent"],
            description: "排序：debug 排障优先（默认）/api 接口优先/recent 时间倒序",
          },
        },
      },
    },
    {
      name: "get_network_detail",
      description: "单个请求详情：请求/响应头与可选响应体；超长 URL 自动摘要。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          requestId: { type: "string", description: "来自 list_network_requests" },
          includeBody: { type: "boolean", description: "默认 false" },
        },
        required: ["requestId"],
      },
    },
    {
      name: "clear_network_requests",
      description: "清空网络请求捕获记录。",
      inputSchema: { type: "object", properties: { target: TARGET_ARG } },
    },
    {
      name: "perf_metrics",
      description: "性能指标：引擎指标、Web Vitals、资源加载摘要。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          includeTimings: { type: "boolean", description: "默认 true" },
          includeResources: { type: "boolean", description: "默认 true" },
        },
      },
    },
    {
      name: "capture_screenshot",
      description: "截取目标标签页截图。默认 JPEG(80)；文字/细线/透明背景细节用 png；整页用 fullPage。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          format: {
            type: "string",
            enum: ["png", "jpeg"],
            description: "默认 jpeg；高保真文字用 png"
          },
          quality: {
            type: "number",
            description: "JPEG 质量 0-100，默认 80（长截图 70）"
          },
          fullPage: {
            type: "boolean",
            description: "整页长截图（含滚动区域），默认 false"
          },
          clip: {
            type: "object",
            description: "截取区域 {x,y,width,height}（像素）",
          },
        },
      },
    },
    {
      name: "get_page_content",
      description: "提取页面文本/HTML/结构化数据，比截图轻量。text 模式递归收集同源 iframe 文本（适合文档类页面）。默认上限 8000 字符；不够时调大 maxLength 或用 offset 翻页、selector 收窄。不反映 CSS。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          mode: {
            type: "string",
            enum: ["text", "html", "structured"],
            description: "text 纯文本（默认）/html 片段/structured 结构化数据",
          },
          selector: {
            type: "string",
            description: "CSS 选择器限定范围，如 'main'、'#content'",
          },
          maxLength: {
            type: "number",
            description: "本次返回上限（字符），默认 8000；text/html 有效",
          },
          offset: {
            type: "number",
            description: "从第 N 字符开始取（text/html 分页翻页用）",
          },
          includeMetadata: {
            type: "boolean",
            description: "附带 title/url/description，默认 true",
          },
        },
      },
    },
    {
      name: "get_interactive_snapshot",
      description: "扫描可见可交互元素，返回带 ref 的精简列表供 dispatch_action 使用（先快照后操作）。默认 30 个，需要更多传 maxElements 或用 selector 收窄。支持 Shadow DOM。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          selector: {
            type: "string",
            description: "CSS 选择器限定扫描范围",
          },
          includeText: {
            type: "boolean",
            description: "包含元素文本/占位符，默认 true",
          },
          maxElements: {
            type: "number",
            description: "返回元素上限，默认 30",
          },
        },
      },
    },
    {
      name: "dispatch_action",
      description: "执行单个或一批交互动作。可用快照 ref 或 CSS selector 定位；优先用 actions 批量完成连续填写/点击，snapshotAfter:true 可在同一次调用返回操作后元素，减少模型往返。",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET_ARG,
          ref: {
            type: "string",
            description: "元素 ref，如 'e1'（来自 get_interactive_snapshot）",
          },
          selector: {
            type: "string",
            description: "CSS 选择器；已知选择器时可替代 ref，省去前置快照",
          },
          action: {
            type: "string",
            enum: ["click", "fill", "press", "scroll", "select", "hover", "focus"],
          },
          value: {
            type: "string",
            description: "fill 的文本 / select 的 option value",
          },
          key: {
            type: "string",
            description: "press 按键，默认 'Enter'",
          },
          deltaX: {
            type: "number",
            description: "水平滚动量，默认 0",
          },
          deltaY: {
            type: "number",
            description: "垂直滚动量，默认 300（正数向下）",
          },
          waitMs: {
            type: "number",
            description: "操作后等待 ms，默认 500，最大 3000",
          },
          actions: {
            type: "array",
            maxItems: 20,
            description: "顺序执行的动作，最多 20 个；每项支持 ref/selector、action、value/key、deltaX/deltaY、waitMs",
            items: {
              type: "object",
              properties: {
                ref: { type: "string" },
                selector: { type: "string" },
                action: { type: "string", enum: ["click", "fill", "press", "scroll", "select", "hover", "focus"] },
                value: { type: "string" },
                key: { type: "string" },
                deltaX: { type: "number" },
                deltaY: { type: "number" },
                waitMs: { type: "number" },
              },
              required: ["action"],
            },
          },
          stopOnError: {
            type: "boolean",
            description: "批量动作失败时立即停止，默认 true",
          },
          snapshotAfter: {
            type: "boolean",
            description: "在最后一个动作后返回新的交互快照，默认 false",
          },
          snapshotSelector: {
            type: "string",
            description: "限制操作后快照范围",
          },
          snapshotMaxElements: {
            type: "number",
            description: "操作后快照元素上限，默认 20",
          },
        },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments || {}
  try {
    if (name === "inspect_page") {
      const { target, selector, includeInteractive = true, maxElements = 20, includeElements = true, detail = false } = args
      const snapshot = await askChrome("inspectPageSnapshot", {
        target,
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

      const summary = {
        title: page?.metadata?.title,
        url: truncateUrl(page?.metadata?.url),
        description: page?.metadata?.description,
        links,
        buttons,
        forms,
        interactiveCount,
      }

      const elements = includeElements && Array.isArray(interactive?.elements)
        ? interactive.elements
        : undefined

      // 紧凑模式保留少量可操作 ref，避免为了点击再做一次快照；detail:true 才附带完整页面结构
      return {
        content: [
          {
            type: "text",
            text: out(
              detail
                ? {
                    summary,
                    page,
                    interactive,
                    nextStepHint:
                      "视觉用 capture_screenshot；点击/输入用 get_interactive_snapshot + dispatch_action；请求/性能用 list_network_requests / perf_metrics。",
                  }
                : {
                    summary,
                    interactive: elements
                      ? { viewport: interactive?.viewport, elements }
                      : undefined,
                    nextStepHint:
                      "可直接用 interactive.elements 的 ref 调 dispatch_action；连续动作放进 actions，操作后需继续定位时传 snapshotAfter:true。",
                  }
            ),
          },
        ],
      }
    }

    if (name === "get_server_info") {
      let chromeOk, clientsCount, mainStatus

      if (isMainInstance) {
        chromeOk = !!chromeConnection
        clientsCount = mcpClients.size
        mainStatus = {
          pid: process.pid,
          version: GHOST_BRIDGE_VERSION,
          serverPath: SERVER_ENTRY_PATH,
          startedAt: SERVER_STARTED_AT,
        }
      } else {
        // 非主实例：查询主实例的状态
        try {
          mainStatus = await askMainInstance("_getMainStatus")
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
            text: out({
              service: "ghost-bridge",
              version: GHOST_BRIDGE_VERSION,
              role: isMainInstance ? "daemon (常驻 WebSocket 服务)" : "会话客户端 (连接常驻服务)",
              wsPort: actualPort,
              wsUrl: `ws://localhost:${actualPort}`,
              pid: process.pid,
              serverPath: SERVER_ENTRY_PATH,
              mainPid: mainStatus?.pid,
              mainVersion: mainStatus?.version,
              mainServerPath: mainStatus?.serverPath,
              mainStartedAt: mainStatus?.startedAt,
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

    if (name === "list_tabs") {
      const res = await askChrome("listTabs")
      return { content: [{ type: "text", text: out(shrinkListTabs(res, args)) }] }
    }

    if (name === "bind_tab") {
      const { name: targetName, tabId, urlContains, titleContains } = args
      const res = await askChrome("bindTab", { name: targetName, tabId, urlContains, titleContains }, { timeoutMs: 10000 })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "unbind_tab") {
      const { name: targetName } = args
      const res = await askChrome("unbindTab", { name: targetName }, { timeoutMs: 10000 })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "list_targets") {
      const res = await askChrome("listTargets")
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "get_target_tab") {
      const res = await askChrome("getTargetTab")
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "pin_current_tab") {
      const res = await askChrome("pinCurrentTab", {}, { timeoutMs: 10000 })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "pin_tab") {
      const { tabId, urlContains, titleContains } = args
      const res = await askChrome("pinTab", { tabId, urlContains, titleContains }, { timeoutMs: 10000 })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "unpin_tab") {
      const res = await askChrome("unpinTab", {}, { timeoutMs: 10000 })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "get_last_error") {
      const { target, severity = "error", limit = 20 } = args
      const data = await askChrome("getLastError", { target, severity, limit })
      return { content: [{ type: "text", text: out(data) }] }
    }

    if (name === "get_script_source") {
      const {
        target,
        scriptUrlContains,
        line,
        column,
        beautify: wantBeautify = true,
        contextLines = 20,
      } = args
      const res = await askChrome("getScriptSource", {
        scriptUrlContains,
        target,
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
            text: out({
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
      const { target } = args
      const durationMs = args.durationMs || 1500
      const res = await askChrome("coverageSnapshot", { target, durationMs }, { timeoutMs: durationMs + 4000 })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "find_by_string") {
      const { target, query, scriptUrlContains, maxMatches = 5 } = args
      const res = await askChrome("findByString", { target, query, scriptUrlContains, maxMatches })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "symbolic_hints") {
      const res = await askChrome("symbolicHints", { target: args.target })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "eval_script") {
      const timeoutMs = clampNumber(args.timeoutMs, 10000, 100, 30000)
      const res = await askChrome("eval", {
        target: args.target,
        code: args.code,
        awaitPromise: args.awaitPromise !== false,
        timeoutMs,
      }, { timeoutMs: timeoutMs + 3000 })
      return { content: [{ type: "text", text: boundedOut(res, args.maxOutputLength) }] }
    }

    if (name === "page_request") {
      const timeoutMs = clampNumber(args.timeoutMs, 10000, 100, 30000)
      const maxOutputLength = clampNumber(args.maxOutputLength, DEFAULT_EVAL_OUTPUT_LENGTH, 200, MAX_EVAL_OUTPUT_LENGTH)
      const res = await askChrome("pageRequest", {
        target: args.target,
        url: args.url,
        method: args.method,
        headers: args.headers,
        body: args.body,
        responseType: args.responseType,
        timeoutMs,
        maxOutputLength,
      }, { timeoutMs: timeoutMs + 3000 })
      return { content: [{ type: "text", text: boundedOut(res, maxOutputLength) }] }
    }

    if (name === "list_network_requests") {
      const { target, filter, method, status, resourceType, limit, priorityMode = "debug" } = args
      const res = await askChrome("listNetworkRequests", { target, filter, method, status, resourceType, limit, priorityMode })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "get_network_detail") {
      const { target, requestId, includeBody } = args
      const res = await askChrome("getNetworkDetail", { target, requestId, includeBody })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "clear_network_requests") {
      const res = await askChrome("clearNetworkRequests", { target: args.target })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "perf_metrics") {
      const { target, includeTimings, includeResources } = args
      const res = await askChrome("perfMetrics", { target, includeTimings, includeResources })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "capture_screenshot") {
      const { target, format, quality, fullPage, clip } = args
      // 截图可能需要更长时间（特别是完整页面截图）
      const res = await askChrome("captureScreenshot", { target, format, quality, fullPage, clip }, { timeoutMs: 15000 })
      
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
        text: out(metadata),
      })
      
      return { content: contents }
    }

    if (name === "get_page_content") {
      const { target, mode = "text", selector, maxLength = 8000, offset = 0, includeMetadata = true } = args

      const validModes = ["text", "html", "structured"]
      if (mode && !validModes.includes(mode)) {
        return {
          content: [{
            type: "text",
            text: `Error: 无效的 mode "${mode}"，可选值: ${validModes.join(", ")}`
          }]
        }
      }

      // offset 分页（text）：直接在页面内精确切片。
      // 不走 getPageContent 是因为扩展端对超长文本采用"保留首尾"策略，会破坏 offset 语义
      if (offset > 0 && mode === "text") {
        const selectorExpr = selector
          ? `(document.querySelector(${JSON.stringify(selector)}) || document.body)`
          : "document.body"
        const code = `(function(){try{function ct(el){var t=el.innerText||el.textContent||"";try{var fs=el.querySelectorAll("iframe");for(var i=0;i<fs.length;i++){try{var d=fs[i].contentDocument;if(d&&d.body)t+="\\n\\n"+ct(d.body);}catch(e){}}}catch(e){}return t;}var text=ct(${selectorExpr});var start=${offset};var end=${offset + maxLength};return {content:text.slice(start,end),offset:start,totalLength:text.length,hasMore:text.length>end};}catch(e){return {error:e.message}}})()`
        const res = await askChrome("eval", { target, code })
        return { content: [{ type: "text", text: out(res) }] }
      }

      // offset 分页（html）：扩展端 html 截断是前缀切片，多取 offset+maxLength 后服务端再切
      if (offset > 0 && mode === "html") {
        const res = await askChrome("getPageContent", { target, mode, selector, maxLength: offset + maxLength, includeMetadata: false })
        if (typeof res?.content === "string") {
          res.content = res.content.slice(offset, offset + maxLength)
          res.offset = offset
          res.hasMore = (res.contentLength || 0) > offset + maxLength
        }
        return { content: [{ type: "text", text: out(res) }] }
      }

      const res = await askChrome("getPageContent", { target, mode, selector, maxLength, includeMetadata })
      if (typeof res?.metadata?.url === "string" && res.metadata.url.length > 200) {
        res.metadata.url = truncateUrl(res.metadata.url)
        res.metadata.urlTruncated = true
      }
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "get_interactive_snapshot") {
      const { target, selector, includeText, maxElements } = args
      const res = await askChrome("getInteractiveSnapshot", { target, selector, includeText, maxElements: maxElements ?? 30 })
      return { content: [{ type: "text", text: out(res) }] }
    }

    if (name === "dispatch_action") {
      const steps = Array.isArray(args.actions) ? args.actions : [args]
      if (!steps.length || steps.length > 20) throw new Error("actions 数量必须在 1-20 之间")
      const totalWaitMs = steps.reduce((sum, step) => sum + clampNumber(step.waitMs, 500, 0, 3000), 0)
      const timeoutMs = Math.min(45000, 10000 + totalWaitMs)
      const res = await askChrome("dispatchAction", args, { timeoutMs })
      return { content: [{ type: "text", text: out(res) }] }
    }

    return { content: [{ type: "text", text: `未知工具：${name}` }] }
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }] }
  }
})

// stdio MCP 服务与孤儿检测只属于会话进程；
// daemon 以 detached + stdio:'ignore' 运行，stdin 是 /dev/null（立即 EOF）、父进程随即退出，
// 挂上这些检测会让 daemon 启动即自杀
if (!IS_DAEMON) {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  log(`✅ MCP server 已启动 | 角色: 会话客户端 | 常驻服务端口: ${actualPort} | PID: ${process.pid} | PPID: ${process.ppid}`)
  log(`💡 使用 get_server_info 工具查看详细状态`)

  // ========== 会话进程孤儿检测与自动退出 ==========
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
} else {
  log(`✅ ghost-bridge daemon 已启动 | 端口: ${actualPort} | PID: ${process.pid}`)
  log(`📄 端口信息文件: ${PORT_INFO_FILE}`)
  log(`💡 停止服务: ghost-bridge stop`)
}

// ========== 进程退出清理 ==========
function cleanup() {
  log("🧹 正在清理...")

  // daemon 退出时删除端口信息文件
  if (IS_DAEMON) {
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
    if (wsPingInterval) {
      clearInterval(wsPingInterval)
      wsPingInterval = null
    }
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
  if (IS_DAEMON) {
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
