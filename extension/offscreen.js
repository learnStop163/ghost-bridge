// Offscreen document 用于维持 WebSocket 长连接
// 不受 MV3 service worker 暂停的影响

let ws = null
let reconnectTimer = null
let manualDisconnect = false  // 用户主动断开标志，防止 onclose 触发重连
let config = {
  basePort: 33333,
  token: '',
  maxPortRetries: 10,
}

function log(msg) {
  console.log(`[ghost-bridge offscreen] ${msg}`)
  // 转发日志到 service worker
  chrome.runtime.sendMessage({ type: 'log', msg }).catch(() => {})
}

function getMonthlyToken() {
  const now = new Date()
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  return String(firstDayOfMonth.getTime())
}

// 连接到服务器
function connect(portIndex = 0, isNewRound = false) {
  // 如果已手动断开，不再尝试连接
  if (manualDisconnect) return

  if (portIndex >= config.maxPortRetries) {
    log(`扫描完毕，未找到服务，2秒后重试...`)
    reconnectTimer = setTimeout(() => connect(0, true), 2000)
    chrome.runtime.sendMessage({ type: 'status', status: 'not_found' }).catch(() => {})
    return
  }

  const port = config.basePort + portIndex
  const url = new URL(`ws://localhost:${port}`)
  url.searchParams.set('token', config.token)

  if (portIndex === 0 && isNewRound) {
    log(`开始扫描端口 ${config.basePort}-${config.basePort + config.maxPortRetries - 1}`)
  }

  log(`尝试连接端口 ${port}...`)
  chrome.runtime.sendMessage({
    type: 'status',
    status: 'scanning',
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

  ws.onopen = () => {
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
          log(`身份验证失败，尝试下一个端口...`)
          ws.close()
          setTimeout(() => connect(portIndex + 1), 50)
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
      // 连接失败，尝试下一个端口
      setTimeout(() => connect(portIndex + 1), 50)
      return
    }

    // 连接断开，重试
    log('连接断开，尝试重连...')
    chrome.runtime.sendMessage({ type: 'status', status: 'disconnected' }).catch(() => {})
    reconnectTimer = setTimeout(() => connect(0, true), 1000)
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
    config.token = message.token || getMonthlyToken()
    config.maxPortRetries = message.maxPortRetries || 10
    disconnect()
    manualDisconnect = false  // 用户重新连接，清除断开标志
    connect(0, true)
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

  if (message.type === 'getStatus') {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
    })
    return true
  }

  return false
})

log('Offscreen document 已加载')
