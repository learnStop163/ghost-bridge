// Offscreen document 用于维持 WebSocket 长连接
// 不受 MV3 service worker 暂停的影响

let ws = null
let reconnectTimer = null
let manualDisconnect = false  // 用户主动断开标志，防止 onclose 触发重连
let config = {
  basePort: 33333,
  token: '',
}

function log(msg) {
  console.log(`[ghost-bridge offscreen] ${msg}`)
  // 转发日志到 service worker
  chrome.runtime.sendMessage({ type: 'log', msg }).catch(() => {})
}

const DEFAULT_TOKEN = 'ghost-bridge-local'

// 连接到服务器
function connect() {
  // 如果已手动断开，不再尝试连接
  if (manualDisconnect) return

  const port = config.basePort
  const url = new URL(`ws://localhost:${port}`)
  url.searchParams.set('token', config.token)
  log(`尝试连接固定端口 ${port}...`)
  chrome.runtime.sendMessage({
    type: 'status',
    status: 'connecting',
    currentPort: port,
  }).catch(() => {})

  ws = new WebSocket(url.toString())
  ws.binaryType = 'blob' // 明确设置

  const connectionTimeout = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }, 2000) // 增加到 2 秒

  let identityVerified = false
  let socketOpened = false
  let terminalErrorMessage = ''

  ws.onopen = () => {
    socketOpened = true
    clearTimeout(connectionTimeout)
    log(`WebSocket 已连接端口 ${port}，等待身份验证...`)
  }

  ws.onmessage = async (event) => {
    try {
      // 处理 Blob 类型的消息
      let data = event.data
      if (data instanceof Blob) {
        data = await data.text()
      }
      const msg = JSON.parse(data)

      if (msg.type === 'identity') {
        if (msg.service === 'ghost-bridge' && msg.token === config.token) {
          identityVerified = true
          log(`✅ 已连接到 ghost-bridge 服务 (端口 ${port})`)
          chrome.runtime.sendMessage({
            type: 'status',
            status: 'connected',
            port: port,
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
          ws.close()
        }
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

  ws.onclose = (event) => {
    clearTimeout(connectionTimeout)

    // 用户主动断开，不重连
    if (manualDisconnect) return

    if (!identityVerified) {
      if (terminalErrorMessage || socketOpened) {
        const errorMessage = terminalErrorMessage || `Port ${port} is occupied or responding with a non-ghost-bridge protocol.`
        log(`${errorMessage} 2秒后重试...`)
        chrome.runtime.sendMessage({
          type: 'status',
          status: 'error',
          currentPort: port,
          errorMessage,
        }).catch(() => {})
        reconnectTimer = setTimeout(() => connect(), 2000)
        return
      }
      log(`固定端口 ${port} 未发现可用服务，2秒后重试...`)
      chrome.runtime.sendMessage({ type: 'status', status: 'not_found', currentPort: port }).catch(() => {})
      reconnectTimer = setTimeout(() => connect(), 2000)
      return
    }

    // 连接断开，重试
    log(`端口 ${port} 连接断开，尝试重连...`)
    chrome.runtime.sendMessage({ type: 'status', status: 'disconnected' }).catch(() => {})
    reconnectTimer = setTimeout(() => connect(), 1000)
  }

  ws.onerror = () => {
    clearTimeout(connectionTimeout)
  }
}

// 发送消息到服务器
function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
    return true
  }
  return false
}

// 断开连接
function disconnect() {
  manualDisconnect = true  // 标记为手动断开，阻止 onclose 重连
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  log('已断开连接')
}

// 监听来自 service worker 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'connect') {
    config.basePort = message.basePort || 33333
    config.token = message.token || DEFAULT_TOKEN
    disconnect()
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
    })
    return true
  }

  return false
})

log('Offscreen document 已加载')
