// Offscreen document 用于维持 WebSocket 长连接
// 不受 MV3 service worker 暂停的影响

let ws = null
let reconnectTimer = null
let heartbeatTimer = null
let manualDisconnect = false  // 用户主动断开标志，防止 onclose 触发重连
let connectionGeneration = 0
let config = {
  basePort: 33333,
  token: '',
}

const HEARTBEAT_INTERVAL_MS = 15000
const HEARTBEAT_TIMEOUT_MS = 45000
const DEFAULT_TOKEN = 'ghost-bridge-local'

function log(msg) {
  console.log(`[ghost-bridge offscreen] ${msg}`)
  // 转发日志到 service worker
  chrome.runtime.sendMessage({ type: 'log', msg }).catch(() => {})
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function clearHeartbeatTimer() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function isCurrentConnection(generation, socket) {
  return generation === connectionGeneration && socket === ws
}

function scheduleReconnect(generation, delay) {
  if (generation !== connectionGeneration) return
  clearReconnectTimer()
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!manualDisconnect && generation === connectionGeneration) connect()
  }, delay)
}

function closeCurrentSocket() {
  clearHeartbeatTimer()
  if (!ws) return
  try {
    ws.close()
  } catch {}
  ws = null
}

function describeCloseEvent(event) {
  const reason = event.reason ? ` reason="${event.reason}"` : ''
  return `code=${event.code}${reason} clean=${event.wasClean}`
}

function describeReadyState(socket) {
  const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']
  return states[socket.readyState] || String(socket.readyState)
}

function startHeartbeat(generation, socket, port, requireAck) {
  clearHeartbeatTimer()
  let lastAckAt = Date.now()

  heartbeatTimer = setInterval(() => {
    if (!isCurrentConnection(generation, socket) || socket.readyState !== WebSocket.OPEN) {
      clearHeartbeatTimer()
      return
    }

    const now = Date.now()
    if (requireAck && now - lastAckAt > HEARTBEAT_TIMEOUT_MS) {
      log(`端口 ${port} 心跳超时，关闭连接后重连...`)
      try {
        socket.close(4000, 'Heartbeat timeout')
      } catch {}
      return
    }

    try {
      socket.send(JSON.stringify({ type: 'heartbeat', token: config.token, ts: now }))
    } catch (e) {
      log(`端口 ${port} 心跳发送失败：${e.message}`)
      try {
        socket.close(4001, 'Heartbeat send failed')
      } catch {}
    }
  }, HEARTBEAT_INTERVAL_MS)

  return () => {
    lastAckAt = Date.now()
  }
}

// 连接到服务器
function connect() {
  // 如果已手动断开，不再尝试连接
  if (manualDisconnect) return
  clearReconnectTimer()
  closeCurrentSocket()

  const port = config.basePort
  const generation = ++connectionGeneration
  const url = new URL(`ws://localhost:${port}`)
  url.searchParams.set('token', config.token)
  log(`尝试连接固定端口 ${port}...`)
  chrome.runtime.sendMessage({
    type: 'status',
    status: 'connecting',
    currentPort: port,
  }).catch(() => {})

  const socket = new WebSocket(url.toString())
  ws = socket
  socket.binaryType = 'blob' // 明确设置

  const connectionTimeout = setTimeout(() => {
    if (isCurrentConnection(generation, socket) && socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
  }, 2000) // 增加到 2 秒

  let identityVerified = false
  let socketOpened = false
  let terminalErrorMessage = ''
  let markHeartbeatAck = null

  socket.onopen = () => {
    if (!isCurrentConnection(generation, socket)) return
    socketOpened = true
    clearTimeout(connectionTimeout)
    log(`WebSocket 已连接端口 ${port}，等待身份验证...`)
  }

  socket.onmessage = async (event) => {
    try {
      if (!isCurrentConnection(generation, socket)) return
      // 处理 Blob 类型的消息
      let data = event.data
      if (data instanceof Blob) {
        data = await data.text()
      }
      if (!isCurrentConnection(generation, socket)) return
      const msg = JSON.parse(data)

      if (msg.type === 'identity') {
        if (msg.service === 'ghost-bridge' && msg.token === config.token) {
          identityVerified = true
          markHeartbeatAck = startHeartbeat(
            generation,
            socket,
            port,
            Array.isArray(msg.capabilities) && msg.capabilities.includes('heartbeat')
          )
          log(`✅ 已连接到 ghost-bridge 服务 (端口 ${port})`)
          chrome.runtime.sendMessage({
            type: 'status',
            status: 'connected',
            port: port,
            serverInfo: {
              version: msg.version,
              pid: msg.pid,
              port: msg.port,
              startedAt: msg.startedAt,
              serverPath: msg.serverPath,
            },
          }).catch(() => {})
        } else {
          terminalErrorMessage = msg.service === 'ghost-bridge'
            ? `Port ${port} is running ghost-bridge, but the token does not match.`
            : `Port ${port} is occupied by a non-matching service.`
          log('身份验证失败，将在固定端口上重试...')
          chrome.runtime.sendMessage({
            type: 'status',
            status: 'error',
            currentPort: port,
            errorMessage: terminalErrorMessage,
          }).catch(() => {})
          socket.close()
        }
        return
      }

      if (msg.type === 'heartbeat_ack') {
        if (markHeartbeatAck) markHeartbeatAck()
        if (pendingHealthCheck) resolveHealthCheck(true)
        return
      }

      // 转发命令到 service worker
      if (identityVerified && msg.id) {
        chrome.runtime.sendMessage({ type: 'command', data: msg }).catch(() => {})
      }
    } catch (e) {
      log(`解析消息失败：${e.message}`)
    }
  }

  socket.onclose = (event) => {
    if (!isCurrentConnection(generation, socket)) return
    clearTimeout(connectionTimeout)
    clearHeartbeatTimer()
    ws = null
    const closeInfo = describeCloseEvent(event)

    // 用户主动断开，不重连
    if (manualDisconnect) {
      log(`连接已按用户请求关闭 (${closeInfo})`)
      return
    }

    if (!identityVerified) {
      if (terminalErrorMessage || socketOpened) {
        const errorMessage = terminalErrorMessage || `Port ${port} is occupied or responding with a non-ghost-bridge protocol.`
        log(`${errorMessage} (${closeInfo}) 2秒后重试...`)
        chrome.runtime.sendMessage({
          type: 'status',
          status: 'error',
          currentPort: port,
          errorMessage,
        }).catch(() => {})
        scheduleReconnect(generation, 2000)
        return
      }
      log(`固定端口 ${port} 未发现可用服务，2秒后重试...`)
      chrome.runtime.sendMessage({
        type: 'status',
        status: 'not_found',
        currentPort: port,
        errorMessage: `No ghost-bridge WebSocket service was found on port ${port}.`,
      }).catch(() => {})
      scheduleReconnect(generation, 2000)
      return
    }

    // 连接断开，重试
    log(`端口 ${port} 连接断开 (${closeInfo})，尝试重连...`)
    chrome.runtime.sendMessage({
      type: 'status',
      status: 'disconnected',
      currentPort: port,
      errorMessage: `Connection closed: ${closeInfo}`,
    }).catch(() => {})
    scheduleReconnect(generation, 1000)
  }

  socket.onerror = () => {
    if (!isCurrentConnection(generation, socket)) return
    clearTimeout(connectionTimeout)
    log(`端口 ${port} WebSocket 错误，readyState=${describeReadyState(socket)}`)
  }
}

// 发送消息到服务器
function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data))
      return true
    } catch (e) {
      log(`发送消息到服务器失败：${e.message}`)
    }
  }
  return false
}

// ========== 唤醒探活 ==========
// 系统睡眠/锁屏唤醒后连接可能处于半开状态且 onclose 不会触发，
// 由 background 的 idle 钩子通知这里立即发一次心跳，短超时内无响应就主动重连
let pendingHealthCheck = null

function resolveHealthCheck(alive) {
  if (!pendingHealthCheck) return
  clearTimeout(pendingHealthCheck.timer)
  const resolve = pendingHealthCheck.resolve
  pendingHealthCheck = null
  resolve(alive)
}

function requestHealthCheck() {
  return new Promise((resolve) => {
    if (manualDisconnect) return resolve(false)
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log('唤醒探活：连接未打开，立即重连')
      connect()
      return resolve(false)
    }
    // 收敛上一次未完成的探活
    if (pendingHealthCheck) resolveHealthCheck(false)

    const timer = setTimeout(() => {
      log('唤醒探活：心跳无响应，判定为死连接，关闭后重连')
      resolveHealthCheck(false)
      try {
        ws.close(4002, 'Health check timeout')
      } catch {}
    }, 5000)
    pendingHealthCheck = { timer, resolve }

    try {
      ws.send(JSON.stringify({ type: 'heartbeat', token: config.token, ts: Date.now() }))
    } catch (e) {
      log(`唤醒探活：心跳发送失败 (${e.message})，立即重连`)
      resolveHealthCheck(false)
      connect()
    }
  })
}

// 断开连接
function disconnect() {
  manualDisconnect = true  // 标记为手动断开，阻止 onclose 重连
  connectionGeneration++
  clearReconnectTimer()
  closeCurrentSocket()
  log('已断开连接')
}

// 监听来自 service worker 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'connect') {
    config.basePort = message.basePort || 33333
    config.token = message.token || DEFAULT_TOKEN
    manualDisconnect = false  // 用户重新连接，清除断开标志
    connect()
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'disconnect') {
    disconnect()
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'send') {
    const ok = sendToServer(message.data)
    sendResponse({ ok })
    return true
  }

  if (message.type === 'getOffscreenStatus') {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
      readyState: ws ? describeReadyState(ws) : 'CLOSED',
      port: config.basePort,
    })
    return true
  }

  // 唤醒钩子触发的立即探活（background 的 chrome.idle 监听转发）
  if (message.type === 'healthCheck') {
    requestHealthCheck().then((alive) => {
      if (!alive) log('唤醒探活完成：连接已重建/重连中')
      sendResponse({ alive })
    })
    return true
  }

  return false
})

log('Offscreen document 已加载')
