// popup.js - Ghost Bridge 弹窗逻辑

const statusDot = document.getElementById('statusDot')
const statusText = document.getElementById('statusText')
const statusDetail = document.getElementById('statusDetail')
const connectBtn = document.getElementById('connectBtn')
const disconnectBtn = document.getElementById('disconnectBtn')
const scanInfo = document.getElementById('scanInfo')

// 状态映射
const STATUS_MAP = {
  connected: {
    dotClass: 'connected',
    text: '✅ 已连接',
  },
  connecting: {
    dotClass: 'connecting',
    text: '🔍 正在扫描...',
  },
  verifying: {
    dotClass: 'connecting',
    text: '🔐 验证身份...',
  },
  scanning: {
    dotClass: 'connecting',
    text: '📡 搜索服务...',
  },
  not_found: {
    dotClass: 'disconnected',
    text: '🔴 未找到服务',
  },
  disconnected: {
    dotClass: 'disconnected',
    text: '未连接',
  },
  error: {
    dotClass: 'error',
    text: '连接失败',
  },
}

// 更新 UI 状态
function updateUI(state) {
  const { status, port, scanRound, enabled, currentPort, basePort } = state
  const config = STATUS_MAP[status] || STATUS_MAP.disconnected

  statusDot.className = `status-dot ${config.dotClass}`
  statusText.textContent = config.text

  // 状态详情
  if (status === 'connected' && port) {
    statusDetail.textContent = `端口 ${port} · WebSocket 已建立`
  } else if ((status === 'connecting' || status === 'verifying' || status === 'scanning') && currentPort) {
    const roundText = scanRound > 0 ? `（第 ${scanRound + 1} 轮）` : ''
    statusDetail.textContent = `正在扫描 ${basePort}-${basePort + 9}${roundText}`
  } else if (status === 'not_found') {
    statusDetail.textContent = '请确保 Claude Code 已启动'
  } else {
    statusDetail.textContent = ''
  }

  // 按钮状态
  connectBtn.textContent = enabled ? '重新连接' : '连接'
  connectBtn.disabled = false

  // 扫描轮次提示
  if ((status === 'connecting' || status === 'scanning') && scanRound > 2) {
    scanInfo.textContent = `已扫描 ${scanRound} 轮，请确保 Claude Code 已启动`
    scanInfo.style.color = '#ff9f0a'
  } else {
    scanInfo.textContent = ''
  }
}

// 从 background 获取状态
async function fetchStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getStatus' })
    if (response) {
      updateUI(response)
    }
  } catch (e) {
    console.error('获取状态失败:', e)
  }
}

// 启用连接（自动扫描端口）
connectBtn.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'connect' })
    setTimeout(fetchStatus, 100)
  } catch (e) {
    console.error('连接失败:', e)
  }
})

// 断开连接
disconnectBtn.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'disconnect' })
    setTimeout(fetchStatus, 100)
  } catch (e) {
    console.error('断开失败:', e)
  }
})

// 初始加载
fetchStatus()

// 定时刷新状态（500ms）
setInterval(fetchStatus, 500)
