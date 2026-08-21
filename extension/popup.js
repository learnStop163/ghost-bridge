// popup.js - Ghost Bridge 弹窗逻辑

const dotWrapper = document.getElementById('dotWrapper')
const statusCard = document.getElementById('statusCard')
const statusText = document.getElementById('statusText')
const detailContainer = document.getElementById('detailContainer')
const portVal = document.getElementById('portVal')
const tabRow = document.getElementById('tabRow')
const tabVal = document.getElementById('tabVal')
const viewingRow = document.getElementById('viewingRow')
const viewingVal = document.getElementById('viewingVal')
const headerGhost = document.getElementById('headerGhost')

const targetBtn = document.getElementById('targetBtn')
const targetBtnText = document.getElementById('targetBtnText')
const targetIcon = document.getElementById('targetIcon')
const connectBtn = document.getElementById('connectBtn')
const disconnectBtn = document.getElementById('disconnectBtn')
const scanInfo = document.getElementById('scanInfo')

let lastStableStatus = null
let pendingStatus = null
let statusChangeTimer = null
let latestState = null
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
  latestState = state
  const {
    status,
    port,
    enabled,
    currentPort,
    basePort,
    connectionError,
    targetMode = 'focused',
    targetTab,
    viewingTab,
    tabTitle,
  } = state
  const isPinned = targetMode === 'pinned'
  const config = STATUS_MAP[status] || STATUS_MAP.disconnected
  const statusLabel = status === 'connected'
    ? isPinned ? 'ON / Pinned' : 'ON / Following'
    : config.text

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
  if (statusText.textContent !== statusLabel) {
    statusText.style.opacity = '0'
    setTimeout(() => {
      statusText.textContent = statusLabel
      statusText.style.opacity = '1'
    }, 150)
  }

  // Update Detail Container
  if (status === 'connected' && port) {
    portVal.textContent = port
    portVal.className = 'detail-value highlight'
    
    const targetTitle = targetTab?.title || tabTitle
    if (targetTitle) {
      tabRow.classList.remove('hidden')
      tabVal.textContent = targetTitle
      tabVal.title = targetTab?.url || targetTitle
    } else {
      tabRow.classList.add('hidden')
    }

    if (isPinned && viewingTab && targetTab && viewingTab.id !== targetTab.id) {
      viewingRow.classList.remove('hidden')
      viewingVal.textContent = viewingTab.title || 'Untitled'
      viewingVal.title = viewingTab.url || viewingTab.title || ''
    } else {
      viewingRow.classList.add('hidden')
    }
    
    detailContainer.classList.remove('collapsed')
  } else if ((status === 'connecting' || status === 'verifying' || status === 'scanning') && currentPort) {
    portVal.textContent = `Connecting: ${currentPort}`
    portVal.className = 'detail-value highlight'
    tabRow.classList.add('hidden')
    viewingRow.classList.add('hidden')
    detailContainer.classList.remove('collapsed')
  } else if (status === 'disconnected') {
    detailContainer.classList.add('collapsed')
  } else if (status === 'not_found') {
    portVal.textContent = 'No Bridge'
    portVal.className = 'detail-value warning'
    tabRow.classList.add('hidden')
    viewingRow.classList.add('hidden')
    detailContainer.classList.remove('collapsed')
  } else if (status === 'error') {
    portVal.textContent = `Port ${currentPort || basePort || '-'} blocked`
    portVal.className = 'detail-value warning'
    tabRow.classList.add('hidden')
    viewingRow.classList.add('hidden')
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

  targetBtn.classList.toggle('pinned', isPinned)
  targetBtnText.textContent = isPinned ? 'Locked' : 'Pin'
  targetIcon.textContent = isPinned ? '●' : '○'
  targetBtn.title = isPinned
    ? 'Unpin target tab and follow the focused tab'
    : 'Pin current tab as the Ghost Bridge target'
  targetBtn.setAttribute('aria-label', targetBtn.title)
  targetBtn.disabled = status !== 'connected' || !port

  // Scan info text
  if (status === 'error' && connectionError) {
    scanInfo.textContent = connectionError
    scanInfo.classList.remove('collapsed')
  } else if (status === 'connected' && state.targetError) {
    scanInfo.textContent = state.targetError
    scanInfo.classList.remove('collapsed')
  } else if (status === 'not_found' && basePort) {
    scanInfo.textContent = connectionError || `No ghost-bridge WebSocket service was found on port ${basePort}. Start a configured MCP client, then reconnect.`
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

targetBtn.addEventListener('click', async () => {
  try {
    const isPinned = latestState?.targetMode === 'pinned'
    targetBtnText.textContent = isPinned ? 'Unlocking' : 'Pinning'
    targetBtn.disabled = true
    const response = await chrome.runtime.sendMessage({
      type: isPinned ? 'unpinTab' : 'pinCurrentTab',
    })
    if (response && !response.ok) {
      scanInfo.textContent = response.error || 'Target action failed'
      scanInfo.classList.remove('collapsed')
    }
  } catch (e) {
    console.error('Target action failed:', e)
    scanInfo.textContent = e.message
    scanInfo.classList.remove('collapsed')
  } finally {
    setTimeout(fetchStatus, 100)
  }
})

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
