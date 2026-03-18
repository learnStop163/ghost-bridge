// popup.js - Ghost Bridge 弹窗逻辑

const dotWrapper = document.getElementById('dotWrapper')
const statusCard = document.getElementById('statusCard')
const statusText = document.getElementById('statusText')
const detailContainer = document.getElementById('detailContainer')
const portVal = document.getElementById('portVal')
const tabRow = document.getElementById('tabRow')
const tabVal = document.getElementById('tabVal')
const errorRow = document.getElementById('errorRow')
const errorVal = document.getElementById('errorVal')
const errorList = document.getElementById('errorList')
const headerGhost = document.getElementById('headerGhost')

const connectBtn = document.getElementById('connectBtn')
const disconnectBtn = document.getElementById('disconnectBtn')
const scanInfo = document.getElementById('scanInfo')

let lastStableStatus = null
let pendingStatus = null
let statusChangeTimer = null
const STATUS_DEBOUNCE_MS = 300

const STATUS_MAP = {
  connected: {
    statusClass: 'connected',
    text: 'ON / Attached',
  },
  connecting: {
    statusClass: 'connecting',
    text: 'Scanning...',
  },
  verifying: {
    statusClass: 'connecting',
    text: 'Verifying Auth...',
  },
  scanning: {
    statusClass: 'connecting',
    text: 'Searching...',
  },
  not_found: {
    statusClass: 'disconnected',
    text: 'Not Found',
  },
  disconnected: {
    statusClass: 'disconnected',
    text: 'Disconnected',
  },
  error: {
    statusClass: 'error',
    text: 'Connection Error',
  },
}

function renderUI(state) {
  const { status, port, enabled, currentPort, basePort, connectionError, errorCount, recentErrors, tabTitle } = state
  const config = STATUS_MAP[status] || STATUS_MAP.disconnected

  // Update classes for color & animations
  dotWrapper.className = `status-dot-wrapper ${config.statusClass}`
  
  // Update Ghost & Body Animation State
  if (config.statusClass === 'connected') {
    headerGhost.className = 'ghost-wrapper ghost-connected'
    document.body.className = 'connected-state'
  } else if (config.statusClass === 'connecting') {
    headerGhost.className = 'ghost-wrapper ghost-connecting'
    document.body.className = 'connecting-state'
  } else if (config.statusClass === 'error') {
    headerGhost.className = 'ghost-wrapper ghost-error'
    document.body.className = 'error-state'
  } else {
    headerGhost.className = 'ghost-wrapper ghost-disconnected'
    document.body.className = 'disconnected-state'
  }

  // Animate text change
  if (statusText.textContent !== config.text) {
    statusText.style.opacity = '0'
    setTimeout(() => {
      statusText.textContent = config.text
      statusText.style.opacity = '1'
    }, 150)
  }

  // Update Detail Container
  if (status === 'connected' && port) {
    portVal.textContent = port
    portVal.className = 'detail-value highlight'
    
    if (tabTitle) {
      tabRow.classList.remove('hidden')
      tabVal.textContent = tabTitle
      tabVal.title = tabTitle
    } else {
      tabRow.classList.add('hidden')
    }

    errorRow.classList.remove('hidden')
    errorVal.textContent = errorCount || 0
    errorVal.className = errorCount > 0 ? 'detail-value warning' : 'detail-value'
    
    // Render error list
    if (recentErrors && recentErrors.length > 0) {
      errorList.innerHTML = recentErrors.map(err => {
        const text = err.text ? err.text.substring(0, 100) : 'Unknown Error'
        const file = err.url ? err.url.split('/').pop() : 'inline'
        const loc = err.line ? `${file}:${err.line}` : file
        return `
          <div class="error-item" title="${err.text || ''}">
            <div class="err-msg">${text}${err.text && err.text.length > 100 ? '...' : ''}</div>
            <div class="err-loc">${loc}</div>
          </div>
        `
      }).join('')
    } else {
      errorList.innerHTML = '<div class="error-item" style="text-align:center;color:#64748b;border:none;">No recent errors recorded.</div>'
      errorList.classList.add('collapsed')
    }
    
    detailContainer.classList.remove('collapsed')
  } else if ((status === 'connecting' || status === 'verifying' || status === 'scanning') && currentPort) {
    portVal.textContent = `Connecting: ${currentPort}`
    portVal.className = 'detail-value highlight'
    tabRow.classList.add('hidden')
    errorRow.classList.add('hidden')
    detailContainer.classList.remove('collapsed')
  } else if (status === 'disconnected') {
    detailContainer.classList.add('collapsed')
  } else if (status === 'not_found') {
    portVal.textContent = 'Launch Claude Code'
    portVal.className = 'detail-value warning'
    tabRow.classList.add('hidden')
    errorRow.classList.add('hidden')
    detailContainer.classList.remove('collapsed')
  } else if (status === 'error') {
    portVal.textContent = `Port ${currentPort || basePort || '-'} blocked`
    portVal.className = 'detail-value warning'
    tabRow.classList.add('hidden')
    errorRow.classList.add('hidden')
    detailContainer.classList.remove('collapsed')
  } else {
    detailContainer.classList.add('collapsed')
  }

  // Button States
  if (status === 'connecting' || status === 'scanning' || status === 'verifying') {
    connectBtn.textContent = 'Connecting...'
    connectBtn.disabled = true
  } else {
    connectBtn.textContent = enabled ? 'Reconnect' : 'Connect'
    connectBtn.disabled = false
  }

  // Scan info text
  if (status === 'error' && connectionError) {
    scanInfo.textContent = connectionError
    scanInfo.classList.remove('collapsed')
  } else if (status === 'not_found' && basePort) {
    scanInfo.textContent = `Port ${basePort} unavailable. Is your MCP server running on this port?`
    scanInfo.classList.remove('collapsed')
  } else {
    scanInfo.classList.add('collapsed')
  }
}

function updateUI(state) {
  const newStatus = state.status

  if (lastStableStatus === null || newStatus === lastStableStatus) {
    lastStableStatus = newStatus
    pendingStatus = null
    if (statusChangeTimer) {
      clearTimeout(statusChangeTimer)
      statusChangeTimer = null
    }
    renderUI(state)
    return
  }

  if (lastStableStatus === 'connected' && newStatus !== 'connected') {
    if (pendingStatus !== newStatus) {
      pendingStatus = newStatus
      if (statusChangeTimer) clearTimeout(statusChangeTimer)
      statusChangeTimer = setTimeout(() => {
        lastStableStatus = pendingStatus
        pendingStatus = null
        statusChangeTimer = null
        renderUI(state)
      }, STATUS_DEBOUNCE_MS)
    }
    return
  }

  lastStableStatus = newStatus
  pendingStatus = null
  if (statusChangeTimer) {
    clearTimeout(statusChangeTimer)
    statusChangeTimer = null
  }
  renderUI(state)
}

async function fetchStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getStatus' })
    if (response) {
      updateUI(response)
    }
  } catch (e) {
    console.error('Fetch status failed:', e)
  }
}

connectBtn.addEventListener('click', async () => {
  try {
    // Add visual click feedback
    connectBtn.textContent = 'Connecting...'
    connectBtn.disabled = true
    await chrome.runtime.sendMessage({ type: 'connect' })
    setTimeout(fetchStatus, 150)
  } catch (e) {
    console.error('Connect failed:', e)
  }
})

disconnectBtn.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'disconnect' })
    setTimeout(fetchStatus, 50)
  } catch (e) {
    console.error('Disconnect failed:', e)
  }
})

fetchStatus()

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'statusUpdate') {
    updateUI(message.state)
  }
})

// Error List Toggle Logic
errorRow.addEventListener('click', () => {
  if (errorList.classList.contains('collapsed')) {
    errorList.classList.remove('collapsed')
  } else {
    errorList.classList.add('collapsed')
  }
})
