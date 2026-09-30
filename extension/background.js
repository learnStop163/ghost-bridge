importScripts('bg-network.js', 'bg-dom.js', 'bg-control.js', 'bg-runtime.js')

const DEFAULT_TOKEN = 'ghost-bridge-local'

const CONFIG = {
  basePort: 33333,
  token: DEFAULT_TOKEN,
  autoDetach: false,
  maxErrors: 100,
  maxStackFrames: 20,
  maxRequestsTracked: 200,
  maxRequestBodySize: 500000, // 提升至 500KB，容纳较大的 API 请求
}

let attachedTabId = null // Last touched attached tab, kept for popup/backward-compatible status.
let focusedTabId = null
const sessionsByTabId = new Map() // tabId -> per-tab debugger state

// 每个服务器侧 MCP 连接（会话）独立的 target 命名空间：
// pin 状态与 bind 的命名 target 互不可见，多 Agent / 同 Agent 多会话不会互相覆盖。
// 服务器在每条命令上带 clientId；不带时（本地会话）落到 'local' 桶
const clientSessions = new Map() // clientId -> { targetMode, pinnedTabId, namedTargets: Map }
const DEFAULT_CLIENT_ID = 'local'

function getClientSession(clientId) {
  const key = clientId || DEFAULT_CLIENT_ID
  let client = clientSessions.get(key)
  if (!client) {
    client = { targetMode: 'focused', pinnedTabId: null, namedTargets: new Map() }
    clientSessions.set(key, client)
  }
  return client
}

async function cleanupClientSession(clientId) {
  const client = clientSessions.get(clientId)
  if (!client) return
  clientSessions.delete(clientId)
  // 释放仅被该会话 pin/bind 且无其他会话引用、也非当前跟随页的调试 session
  const candidateTabIds = new Set([client.pinnedTabId, ...client.namedTargets.values()])
  for (const tabId of candidateTabIds) {
    if (tabId === null || tabId === undefined) continue
    if (isTabReferenced(tabId)) continue
    if (tabId === attachedTabId) continue
    const session = getSession(tabId, { create: false })
    if (session) {
      await detachSession(session)
      sessionsByTabId.delete(tabId)
    }
  }
  log(`已清理会话 "${clientId}" 的 target 命名空间`)
}

let state = { enabled: false, connected: false, port: null, currentPort: null, connectionStatus: 'disconnected', connectionError: '', serverInfo: null }

// 待处理的请求（等待 offscreen 响应）
const pendingRequests = new Map()

function createSession(tabId) {
  return {
    tabId,
    attached: false,
    scriptMap: new Map(),
    scriptSourceCache: new Map(),
    lastErrors: [],
    lastErrorLocation: null,
    requestMap: new Map(),
    networkRequests: [],
    lastNetworkActivityAt: Date.now(),
  }
}

function getSession(tabId, { create = true } = {}) {
  if (tabId === undefined || tabId === null) return null
  const numericTabId = Number(tabId)
  if (!Number.isInteger(numericTabId)) return null
  let session = sessionsByTabId.get(numericTabId)
  if (!session && create) {
    session = createSession(numericTabId)
    sessionsByTabId.set(numericTabId, session)
  }
  return session
}

function resetDebuggerState(session) {
  if (!session) return
  session.scriptMap = new Map()
  session.scriptSourceCache = new Map()
  session.networkRequests = []
  session.requestMap = new Map()
  // Target.setAutoAttach 报告的子 target（跨站 iframe/OOPIF、worker），targetId -> {type,url,title}
  session.childTargets = new Map()
  session.lastNetworkActivityAt = Date.now()
}

function setBadgeState(status) {
  const map = {
    connecting: { text: "…", color: "#999" },
    on: { text: "ON", color: "#00d2ff" },
    off: { text: "OFF", color: "#999" },
    err: { text: "ERR", color: "#ff3b30" },
    att: { text: "ATT", color: "#a252ff" },
  }
  const cfg = map[status] || map.off
  chrome.action.setBadgeText({ text: cfg.text })
  chrome.action.setBadgeBackgroundColor({ color: cfg.color })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(msg) {
  console.log(`[ghost-bridge] ${msg}`)
}

// ========== Offscreen Document 管理 ==========

let offscreenCreating = null

async function setupOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html')

  // 检查是否已存在
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  }).catch(() => [])

  if (existingContexts.length > 0) {
    return
  }

  // 防止并发创建
  if (offscreenCreating) {
    await offscreenCreating
    return
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],  // 使用 WORKERS 作为理由
    justification: 'Maintain WebSocket connection to ghost-bridge server'
  })

  await offscreenCreating
  offscreenCreating = null
  log('Offscreen document 已创建')
}

async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument()
    log('Offscreen document 已关闭')
  } catch {
    // 可能已关闭
  }
}

async function startBridgeConnection({ persist = false } = {}) {
  state.enabled = true
  state.connected = false
  state.port = null
  state.currentPort = CONFIG.basePort
  state.connectionStatus = 'connecting'
  state.connectionError = ''
  state.serverInfo = null
  setBadgeState('connecting')

  if (persist) {
    await chrome.storage.local.set({ bridgeEnabled: true, basePort: CONFIG.basePort })
  }

  await setupOffscreenDocument()
  await chrome.runtime.sendMessage({
    type: 'connect',
    basePort: CONFIG.basePort,
    token: CONFIG.token,
  }).catch(() => {})
  broadcastStatus()
}

async function stopBridgeConnection({ persist = false } = {}) {
  state.enabled = false
  state.connected = false
  state.port = null
  state.currentPort = null
  state.connectionStatus = 'disconnected'
  state.connectionError = ''
  state.serverInfo = null
  focusedTabId = null
  clientSessions.clear()
  setBadgeState('off')

  if (persist) {
    await chrome.storage.local.set({ bridgeEnabled: false })
  }

  await detachAllTargets().catch(() => {})
  await chrome.runtime.sendMessage({ type: 'disconnect' }).catch(() => {})
  await closeOffscreenDocument().catch(() => {})
  broadcastStatus()
}

async function restoreBridgeConnection() {
  try {
    const result = await chrome.storage.local.get(['basePort', 'bridgeEnabled'])
    if (result.basePort) {
      CONFIG.basePort = result.basePort
    }
    if (result.bridgeEnabled) {
      await startBridgeConnection()
    } else {
      setBadgeState('off')
    }
  } catch (e) {
    log(`恢复连接状态失败：${e.message}`)
    setBadgeState('off')
  }
}

// ========== Chrome Debugger 事件处理 ==========

chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = getSession(source.tabId, { create: false })
  if (!session) return
  if (!state.enabled) return

  // Target.setAutoAttach 的子 target 生命周期：跨站 iframe（OOPIF）是独立调试 target，
  // 页面内 contentDocument 因同源策略读不到，但它的 targetId 可以尝试直接 attach（跨域读取实验）。
  // 注意：事件里的 sessionId 无法用于 chrome.debugger 路由（API 不支持），只能收集 targetId
  if (method === "Target.attachedToTarget") {
    const info = params?.targetInfo || {}
    if (info.targetId) {
      session.childTargets ||= new Map()
      session.childTargets.set(info.targetId, { type: info.type, url: info.url || "", title: info.title || "" })
    }
    return
  }
  if (method === "Target.detachedFromTarget") {
    if (params?.targetId) session.childTargets?.delete(params.targetId)
    return
  }

  if (method === "Debugger.scriptParsed") {
    session.scriptMap.set(params.scriptId, { url: params.url || "(inline)" })
  }

  if (method === "Runtime.exceptionThrown") {
    const detail = params?.exceptionDetails || {}
    const topFrame = detail.stackTrace?.callFrames?.[0]
    const entry = {
      type: "exception",
      severity: "error",
      url: topFrame?.url || detail.url,
      line: topFrame?.lineNumber,
      column: topFrame?.columnNumber,
      text: detail.exception?.description || detail.text,
      scriptId: topFrame?.scriptId,
      stack: compactStack(detail.stackTrace),
      timestamp: Date.now(),
    }
    session.lastErrorLocation = {
      url: entry.url,
      line: entry.line,
      column: entry.column,
      scriptId: entry.scriptId,
    }
    pushError(session, entry)
  }

  if (method === "Log.entryAdded") {
    const entry = params?.entry || {}
    pushError(session, {
      type: entry.level || "log",
      severity: entry.level === "warning" ? "warn" : entry.level === "error" ? "error" : "info",
      url: entry.source || entry.url,
      line: entry.lineNumber,
      text: entry.text,
      stack: compactStack(entry.stackTrace),
      timestamp: Date.now(),
    })
  }

  if (method === "Runtime.consoleAPICalled") {
    const args = (params.args || []).map((a) => a.description || a.value).filter(Boolean)
    pushError(session, {
      type: params.type || "console",
      severity: params.type === "error" ? "error" : params.type === "warning" ? "warn" : "info",
      url: params.stackTrace?.callFrames?.[0]?.url,
      line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      text: args.join(" "),
      stack: compactStack(params.stackTrace),
      timestamp: Date.now(),
    })
  }

  // 网络事件处理
  if (method === "Network.requestWillBeSent") {
    session.lastNetworkActivityAt = Date.now()
    const req = params.request || {}
    const entry = {
      tabId: source.tabId,
      requestId: params.requestId,
      url: req.url,
      method: req.method || "GET",
      requestHeaders: req.headers || {},
      postData: req.postData,
      initiator: params.initiator?.type,
      resourceType: params.type,
      startTime: params.timestamp,
      timestamp: Date.now(),
      status: "pending",
    }
    session.requestMap.set(params.requestId, entry)
    trimPendingRequests(session)
  }

  if (method === "Network.responseReceived") {
    const res = params.response || {}
    const entry = session.requestMap.get(params.requestId)
    if (entry) {
      entry.status = res.status >= 400 ? "error" : "success"
      entry.statusCode = res.status
      entry.statusText = res.statusText
      entry.mimeType = res.mimeType
      entry.responseHeaders = res.headers || {}
      entry.protocol = res.protocol
      entry.remoteAddress = res.remoteIPAddress
      entry.fromCache = res.fromDiskCache || res.fromServiceWorker
      entry.timing = res.timing
      entry.encodedDataLength = params.encodedDataLength
      if (res.status >= 400) {
        pushError(session, {
          type: "network",
          severity: "error",
          url: res.url || entry.url,
          status: res.status,
          statusText: res.statusText,
          mimeType: res.mimeType,
          requestId: params.requestId,
          method: entry.method,
          timestamp: Date.now(),
        })
      }
    }
  }

  if (method === "Network.loadingFinished") {
    session.lastNetworkActivityAt = Date.now()
    const entry = session.requestMap.get(params.requestId)
    if (entry) {
      entry.endTime = params.timestamp
      entry.encodedDataLength = params.encodedDataLength
      entry.duration = entry.endTime && entry.startTime
        ? Math.round((entry.endTime - entry.startTime) * 1000)
        : null
      if (entry.status === "pending") entry.status = "success"
      pushNetworkRequest(session, entry)
      session.requestMap.delete(params.requestId)
    }
  }

  if (method === "Network.loadingFailed") {
    session.lastNetworkActivityAt = Date.now()
    const entry = session.requestMap.get(params.requestId)
    if (entry) {
      entry.status = "failed"
      entry.errorText = params.errorText
      entry.canceled = params.canceled
      entry.blockedReason = params.blockedReason
      pushError(session, {
        type: "network",
        severity: "error",
        url: entry.url,
        requestId: params.requestId,
        method: entry.method,
        text: params.errorText,
        timestamp: Date.now(),
      })
      pushNetworkRequest(session, entry)
      session.requestMap.delete(params.requestId)
    }
  }
})

function pushNetworkRequest(session, entry) {
  session.networkRequests.unshift(entry)
  trimNetworkRequests(session)
}

function trimNetworkRequests(session) {
  GhostBridgeNetwork.trimTrackedRequests(session.networkRequests, CONFIG.maxRequestsTracked)
}

function trimPendingRequests(session) {
  GhostBridgeNetwork.trimPendingRequestMap(session.requestMap, CONFIG.maxRequestsTracked * 2)
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const session = getSession(source.tabId, { create: false })
  if (source.tabId && session) {
    session.attached = false
    if (source.tabId === attachedTabId) attachedTabId = null
    resetDebuggerState(session)
    
    if (!state.enabled) return
    if (reason === "canceled_by_user") {
      log("调试被用户取消，已关闭")
      state.enabled = false
      state.connected = false
      setBadgeState("off")
      chrome.runtime.sendMessage({ type: 'disconnect' }).catch(() => {})
    } else {
      log(`调试已断开：${reason}`)
      if (state.connected) {
        setBadgeState("on")
      } else {
        setBadgeState("att")
      }
    }
  }
})

function pushError(session, entry) {
  session.lastErrors.unshift(entry)
  if (session.lastErrors.length > CONFIG.maxErrors) {
    const dropIdx = session.lastErrors
      .map((e, i) => ({ sev: e.severity || "info", i }))
      .reverse()
      .find((e) => e.sev !== "error")?.i
    if (dropIdx !== undefined) session.lastErrors.splice(dropIdx, 1)
    else session.lastErrors.pop()
  }
}

function compactStack(stackTrace) {
  const frames = stackTrace?.callFrames || []
  return frames.slice(0, CONFIG.maxStackFrames).map((f) => ({
    functionName: f.functionName || "",
    url: f.url || "(inline)",
    line: f.lineNumber,
    column: f.columnNumber,
  }))
}

// ========== Debugger 操作 ==========

function summarizeTab(tab) {
  if (!tab) return null
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: !!tab.active,
    title: tab.title || '',
    url: tab.url || '',
  }
}

async function getFocusedTabOrThrow() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab || tab.id === undefined) throw new Error("没有激活的标签页")
  return tab
}

async function getTabOrThrow(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("需要提供有效的 tabId")
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab || tab.id === undefined) throw new Error("标签页不可用")
    return tab
  } catch (e) {
    throw new Error(`标签页 ${tabId} 不可用：${e.message}`)
  }
}

function normalizeTargetName(name, field = 'target') {
  const value = String(name || '').trim()
  if (!value) throw new Error(`需要提供 ${field}`)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(`${field} 只能包含字母、数字、下划线和连字符，长度 1-64`)
  }
  return value
}

function getNamesForTab(tabId) {
  const names = []
  for (const client of clientSessions.values()) {
    for (const [name, boundTabId] of client.namedTargets.entries()) {
      if (boundTabId === tabId) names.push(name)
    }
  }
  return names
}

function isTabReferenced(tabId) {
  for (const client of clientSessions.values()) {
    if (client.pinnedTabId === tabId) return true
    for (const boundTabId of client.namedTargets.values()) {
      if (boundTabId === tabId) return true
    }
  }
  return false
}

async function findTabByParams(params = {}) {
  if (params.tabId !== undefined) {
    return getTabOrThrow(Number(params.tabId))
  }
  const urlContains = String(params.urlContains || '')
  const titleContains = String(params.titleContains || '')
  if (!urlContains && !titleContains) {
    throw new Error("需要提供 tabId、urlContains 或 titleContains")
  }

  const tabs = await chrome.tabs.query({})
  const matches = tabs.filter((tab) => {
    const urlOk = !urlContains || (tab.url || '').includes(urlContains)
    const titleOk = !titleContains || (tab.title || '').includes(titleContains)
    return tab.id !== undefined && urlOk && titleOk
  })
  if (matches.length === 0) throw new Error("没有找到匹配的标签页")

  matches.sort((a, b) => Number(b.active) - Number(a.active) || (a.windowId - b.windowId) || (a.index - b.index))
  return matches[0]
}

async function resolveTargetTab(params = {}) {
  const client = getClientSession(params.clientId)
  if (params.target !== undefined && params.target !== null && String(params.target).trim() !== '') {
    const targetName = normalizeTargetName(params.target)
    const tabId = client.namedTargets.get(targetName)
    if (tabId === undefined) throw new Error(`未绑定 target "${targetName}"，请先调用 bind_tab`)
    return getTabOrThrow(tabId)
  }
  if (params.tabId !== undefined) {
    return getTabOrThrow(Number(params.tabId))
  }
  if (client.targetMode === 'pinned') {
    if (client.pinnedTabId === null) throw new Error("锁定的标签页不可用，请重新 pin")
    return getTabOrThrow(client.pinnedTabId)
  }
  return getFocusedTabOrThrow()
}

// attach 互斥锁：防止并发调用 ensureAttached 导致重复 attach / 状态竞态
let _attachLock = Promise.resolve()

// Chrome 对冻结/丢弃/无响应标签页的 debugger 调用可能永不回调。
// 锁内的每次 debugger 操作都必须带超时，否则一次挂起会让锁永不释放，
// 所有会话的调试功能整体死锁（list_tabs 等非 debugger 命令不受影响）
const DBG_ATTACH_TIMEOUT_MS = 10000
const DBG_ENABLE_TIMEOUT_MS = 8000
const DBG_DETACH_TIMEOUT_MS = 5000

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)，标签页可能已被 Chrome 冻结或无响应`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

async function ensureAttachedSession(params = {}) {
  const started = performance.now()
  let _release
  const _prev = _attachLock
  _attachLock = new Promise(r => _release = r)
  await _prev
  if (params._timing) params._timing.lockMs = performance.now() - started
  const resolving = performance.now()
  try {
    if (!state.enabled) throw new Error("扩展已暂停，点击图标开启后再试")
    const tab = await resolveTargetTab(params)
    if (params._timing) params._timing.resolveMs = performance.now() - resolving
    const client = getClientSession(params.clientId)
    const isFocusedDefaultTarget = !params.target && params.tabId === undefined && client.targetMode === 'focused'
    if (isFocusedDefaultTarget && focusedTabId !== null && focusedTabId !== tab.id && !isTabReferenced(focusedTabId)) {
      const previousFocusedSession = getSession(focusedTabId, { create: false })
      await detachSession(previousFocusedSession)
      sessionsByTabId.delete(focusedTabId)
    }
    const session = getSession(tab.id)
    if (!session.attached) {
      try {
        await withTimeout(chrome.debugger.attach({ tabId: tab.id }, "1.3"), DBG_ATTACH_TIMEOUT_MS, `attach 标签页 ${tab.id}`)
        setBadgeState("on")
      } catch (e) {
        // 本扩展重复 attach 视为成功（幂等）：也覆盖超时放弃后迟到的 attach 成功等竞态；
        // 其余错误（如 DevTools 正在调试该标签页）照常抛出
        if (!/^already attached/i.test(String(e && e.message))) {
          if (attachedTabId === tab.id) attachedTabId = null
          if (state.connected) {
            setBadgeState("on")
          } else {
            setBadgeState("att")
          }
          throw e
        }
      }
      session.attached = true
      resetDebuggerState(session)
      try {
        await withTimeout((async () => {
          // These domains are independent. Enabling them in parallel removes several
          // debugger round-trip latencies from the first command on a tab.
          // Profiler is deliberately absent: not every browser exposes it over
          // chrome.debugger (some backends return -32601), and only coverage_snapshot
          // needs it, so it is enabled on demand there instead.
          await Promise.all([
            chrome.debugger.sendCommand({ tabId: session.tabId }, "Runtime.enable"),
            chrome.debugger.sendCommand({ tabId: session.tabId }, "Log.enable"),
            chrome.debugger.sendCommand({ tabId: session.tabId }, "Console.enable").catch(() => {}),
            chrome.debugger.sendCommand({ tabId: session.tabId }, "Debugger.enable"),
            chrome.debugger.sendCommand({ tabId: session.tabId }, "Network.enable").catch(() => {}),
          ])

          // Enable auto-attach to sub-targets (iframes, workers) for comprehensive capture
          await chrome.debugger.sendCommand({ tabId: session.tabId }, "Target.setAutoAttach", {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          }).catch(() => {})
        })(), DBG_ENABLE_TIMEOUT_MS, `初始化调试器会话 ${session.tabId}`)
      } catch (e) {
        // 初始化阶段挂起/失败：放弃该会话，避免后续命令打到半初始化的调试器上
        await detachSession(session)
        throw e
      }
    }
    attachedTabId = session.tabId
    if (isFocusedDefaultTarget) focusedTabId = session.tabId
    if (params._timing) params._timing.attachSessionMs = performance.now() - started
    return { target: { tabId: session.tabId }, session, tab }
  } finally {
    _release()
  }
}

async function ensureAttached(params = {}) {
  const attached = await ensureAttachedSession(params)
  return attached.target
}

async function detachSession(session) {
  if (!session) return
  try {
    if (session.attached) {
      await withTimeout(chrome.debugger.detach({ tabId: session.tabId }), DBG_DETACH_TIMEOUT_MS, `detach 标签页 ${session.tabId}`)
    }
  } catch (e) {
    log(`detach 失败：${e.message}`)
  } finally {
    session.attached = false
    if (attachedTabId === session.tabId) attachedTabId = null
    resetDebuggerState(session)
  }
}

async function maybeDetach(force = false) {
  if (force) {
    for (const session of sessionsByTabId.values()) {
      await detachSession(session)
    }
    return
  }
  if (CONFIG.autoDetach && attachedTabId !== null) {
    await detachSession(getSession(attachedTabId, { create: false }))
  }
}

async function detachAllTargets() {
  try {
    const targets = await chrome.debugger.getTargets()
    for (const t of targets) {
      if (!t.attached) continue
      try {
        if (t.tabId !== undefined) {
          await chrome.debugger.detach({ tabId: t.tabId })
        } else {
          await chrome.debugger.detach({ targetId: t.id })
        }
      } catch {}
    }
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (!tab.id) continue
      try {
        await chrome.debugger.detach({ tabId: tab.id })
      } catch {}
    }
  } catch {}
  attachedTabId = null
  focusedTabId = null
  sessionsByTabId.clear()
}

// ========== 命令处理 ==========

async function buildTargetInfo(clientId) {
  const client = getClientSession(clientId)
  const viewingTab = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then(([tab]) => tab || null)
    .catch(() => null)

  let targetTab = null
  let targetError = ''
  const targetTabId = client.targetMode === 'pinned' ? client.pinnedTabId : (viewingTab?.id ?? attachedTabId)

  if (targetTabId !== null && targetTabId !== undefined) {
    try {
      targetTab = await chrome.tabs.get(targetTabId)
    } catch (e) {
      targetError = e.message
    }
  } else if (client.targetMode === 'focused') {
    targetTab = viewingTab
  }

  return {
    clientId: clientId || DEFAULT_CLIENT_ID,
    targetMode: client.targetMode,
    pinnedTabId: client.pinnedTabId,
    focusedTabId,
    attachedTabId,
    attachedTabIds: [...sessionsByTabId.values()].filter((session) => session.attached).map((session) => session.tabId),
    targetTab: summarizeTab(targetTab),
    viewingTab: summarizeTab(viewingTab),
    targets: await summarizeNamedTargets(),
    targetError,
  }
}

function describeCommandTarget(params, session) {
  if (params?.target) return String(params.target)
  const names = getNamesForTab(session.tabId)
  if (names.length) return names[0]
  const client = getClientSession(params?.clientId)
  if (client.targetMode === 'pinned' && client.pinnedTabId === session.tabId) return 'pinned'
  return 'focused'
}

async function summarizeNamedTargets() {
  const results = []
  for (const [ownerId, client] of clientSessions.entries()) {
    for (const [name, tabId] of client.namedTargets.entries()) {
      const session = getSession(tabId, { create: false })
      try {
        const tab = await chrome.tabs.get(tabId)
        results.push({
          owner: ownerId,
          name,
          tabId,
          tab: summarizeTab(tab),
          attached: !!session?.attached,
          errorCount: session?.lastErrors.filter((e) => e.severity === 'error').length || 0,
          networkCount: (session?.networkRequests.length || 0) + (session?.requestMap.size || 0),
        })
      } catch (e) {
        results.push({ owner: ownerId, name, tabId, attached: false, error: e.message })
      }
    }
  }
  return results
}

async function handleListTabs(params = {}) {
  const tabs = await chrome.tabs.query({})
  const targetInfo = await buildTargetInfo(params.clientId)
  return {
    ...targetInfo,
    tabs: tabs
      .filter((tab) => tab.id !== undefined)
      .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index))
      .map(summarizeTab),
  }
}

async function handleListTargets(params = {}) {
  return buildTargetInfo(params.clientId)
}

async function bindTarget(name, tab, clientId) {
  const client = getClientSession(clientId)
  const previousTabId = client.namedTargets.get(name)
  client.namedTargets.set(name, tab.id)
  try {
    await ensureAttachedSession({ target: name, clientId })
  } catch (e) {
    if (previousTabId !== undefined) client.namedTargets.set(name, previousTabId)
    else client.namedTargets.delete(name)
    throw e
  }
  if (previousTabId !== undefined && previousTabId !== tab.id && !isTabReferenced(previousTabId)) {
    const previousSession = getSession(previousTabId, { create: false })
    await detachSession(previousSession)
    sessionsByTabId.delete(previousTabId)
  }
  broadcastStatus()
  return {
    bound: { name, tabId: tab.id, tab: summarizeTab(tab) },
    ...(await buildTargetInfo(clientId)),
  }
}

async function handleBindTab(params = {}) {
  const name = normalizeTargetName(params.name, 'name')
  const tab = await findTabByParams(params)
  return bindTarget(name, tab, params.clientId)
}

async function handleUnbindTab(params = {}) {
  const client = getClientSession(params.clientId)
  const name = normalizeTargetName(params.name || params.target, 'name')
  const tabId = client.namedTargets.get(name)
  if (tabId === undefined) throw new Error(`未绑定 target "${name}"`)
  client.namedTargets.delete(name)

  const session = getSession(tabId, { create: false })
  if (session && !isTabReferenced(tabId)) {
    await detachSession(session)
    sessionsByTabId.delete(tabId)
  }

  broadcastStatus()
  return {
    unbound: { name, tabId },
    ...(await buildTargetInfo(params.clientId)),
  }
}

async function pinTab(tab, clientId) {
  const client = getClientSession(clientId)
  const previousMode = client.targetMode
  const previousPinnedTabId = client.pinnedTabId
  client.targetMode = 'pinned'
  client.pinnedTabId = tab.id
  try {
    await ensureAttachedSession({ tabId: tab.id, clientId })
  } catch (e) {
    client.targetMode = previousMode
    client.pinnedTabId = previousPinnedTabId
    throw e
  }
  broadcastStatus()
  return buildTargetInfo(clientId)
}

async function handlePinCurrentTab(params = {}) {
  return pinTab(await getFocusedTabOrThrow(), params.clientId)
}

async function handlePinTab(params = {}) {
  return pinTab(await findTabByParams(params), params.clientId)
}

async function handleUnpinTab(params = {}) {
  const client = getClientSession(params.clientId)
  client.targetMode = 'focused'
  client.pinnedTabId = null
  if (state.enabled && state.connected) {
    await ensureAttached({ clientId: params.clientId })
  }
  broadcastStatus()
  return buildTargetInfo(params.clientId)
}

async function handleGetLastError(params = {}) {
  const { session } = await ensureAttachedSession(params)
  const severity = params.severity || "error"
  const limit = Math.max(1, Math.min(params.limit || 20, CONFIG.maxErrors))
  const allEvents = session.lastErrors.slice(0, CONFIG.maxErrors)
  const filteredEvents = severity === "all"
    ? allEvents
    : allEvents.filter((event) => (event.severity || "info") === severity)
  const counts = allEvents.reduce(
    (acc, e) => {
      acc.total++
      acc[e.severity || "info"] = (acc[e.severity || "info"] || 0) + 1
      return acc
    },
    { total: 0 }
  )
  const events = filteredEvents.slice(0, limit)
  return {
    lastErrorLocation: session.lastErrorLocation,
    summary: {
      count: events.length,
      cachedCount: allEvents.length,
      filteredCount: filteredEvents.length,
      requestedSeverity: severity,
      limit,
      severityCount: counts,
      lastTimestamp: filteredEvents[0]?.timestamp || allEvents[0]?.timestamp,
    },
    recent: events,
  }
}

async function pickScriptId(session, preferUrlContains) {
  if (preferUrlContains) {
    for (const [id, meta] of session.scriptMap.entries()) {
      if (meta.url && meta.url.includes(preferUrlContains)) return { id, url: meta.url }
    }
  }
  if (session.lastErrorLocation?.scriptId && session.scriptMap.has(session.lastErrorLocation.scriptId)) {
    const meta = session.scriptMap.get(session.lastErrorLocation.scriptId)
    return { id: session.lastErrorLocation.scriptId, url: meta.url }
  }
  const first = session.scriptMap.entries().next().value
  if (first) {
    return { id: first[0], url: first[1].url }
  }
  throw new Error("未找到可用脚本，确认页面已加载脚本")
}

async function handleGetScriptSource(params = {}) {
  const { target, session } = await ensureAttachedSession(params)
  const chosen = await pickScriptId(session, params.scriptUrlContains)
  const { scriptSource } = await chrome.debugger.sendCommand(target, "Debugger.getScriptSource", {
    scriptId: chosen.id,
  })
  session.scriptSourceCache.set(chosen.id, scriptSource)
  const location = {
    line: params.line ?? session.lastErrorLocation?.line ?? null,
    column: params.column ?? session.lastErrorLocation?.column ?? null,
  }
  return {
    url: chosen.url,
    scriptId: chosen.id,
    location,
    source: scriptSource,
    note: "若为单行压缩脚本，可结合 column 提取片段",
  }
}

async function handleCoverageSnapshot(params = {}) {
  const target = await ensureAttached(params)
  return GhostBridgeRuntime.collectCoverage({
    sendCommand: chrome.debugger.sendCommand.bind(chrome.debugger),
    target,
    durationMs: params.durationMs || 1500,
    sleep,
  })
}

function findContexts(source, query, maxMatches) {
  const lower = source.toLowerCase()
  const q = query.toLowerCase()
  const matches = []
  let idx = lower.indexOf(q)
  while (idx !== -1 && matches.length < maxMatches) {
    const start = Math.max(0, idx - 200)
    const end = Math.min(source.length, idx + q.length + 200)
    matches.push({ start, end, context: source.slice(start, end) })
    idx = lower.indexOf(q, idx + q.length)
  }
  return matches
}

async function handleFindByString(params = {}) {
  const { target, session } = await ensureAttachedSession(params)
  const query = params.query
  const maxMatches = params.maxMatches || 5
  const preferred = params.scriptUrlContains

  const results = []
  const entries = [...session.scriptMap.entries()]
  for (const [id, meta] of entries) {
    if (preferred && (!meta.url || !meta.url.includes(preferred))) continue
    if (!session.scriptSourceCache.has(id)) {
      const { scriptSource } = await chrome.debugger.sendCommand(target, "Debugger.getScriptSource", { scriptId: id })
      session.scriptSourceCache.set(id, scriptSource)
    }
    const source = session.scriptSourceCache.get(id)
    const matches = findContexts(source, query, maxMatches - results.length)
    if (matches.length) {
      results.push({ url: meta.url, scriptId: id, matches })
    }
    if (results.length >= maxMatches) break
  }

  return { query, results }
}

async function handleSymbolicHints(params = {}) {
  const target = await ensureAttached(params)
  const expression = `(function(){
    try {
      const resources = performance.getEntriesByType('resource').slice(-20).map(e => ({
        name: e.name, type: e.initiatorType || '', size: e.transferSize || 0
      }));
      const globals = Object.keys(window).filter(k => k.length < 30).slice(0, 60);
      const ls = Object.keys(localStorage || {}).slice(0, 20);
      return {
        location: window.location.href,
        ua: navigator.userAgent,
        resources, globals, localStorageKeys: ls
      };
    } catch (e) { return { error: e.message }; }
  })()`
  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })
  return result?.value
}

async function handleEval(params = {}) {
  const target = await ensureAttached(params)
  const timeoutMs = Math.min(30000, Math.max(100, Number(params.timeoutMs) || 10000))
  // Runtime.evaluate.timeout is enforced inside V8. The outer transport timeout is only
  // a safety margin for an unresponsive tab and no longer leaves normal timed-out code running.
  const executing = performance.now()
  try {
    return await GhostBridgeRuntime.evaluateScript({
    sendCommand: chrome.debugger.sendCommand.bind(chrome.debugger),
    target,
    code: params.code,
    awaitPromise: params.awaitPromise !== false,
    timeoutMs,
    withTimeout,
    })
  } finally {
    if (params._timing) params._timing.evaluateMs = performance.now() - executing
  }
}

async function handlePageRequest(params = {}) {
  const target = await ensureAttached(params)
  if (!params.url || typeof params.url !== 'string') throw new Error("page_request 需要提供 url")
  const timeoutMs = Math.min(30000, Math.max(100, Number(params.timeoutMs) || 10000))
  const maxOutputLength = Math.min(50000, Math.max(200, Number(params.maxOutputLength) || 8000))
  const method = String(params.method || 'GET').toUpperCase()
  const responseType = ['auto', 'json', 'text'].includes(params.responseType) ? params.responseType : 'auto'
  const headers = params.headers && typeof params.headers === 'object' ? { ...params.headers } : {}
  let body = params.body
  if (body !== undefined && body !== null && typeof body !== 'string') {
    body = JSON.stringify(body)
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json'
    }
  }

  const expression = `(async function() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ${timeoutMs});
    try {
      const url = new URL(${JSON.stringify(params.url)}, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('仅支持 HTTP(S) URL');
      }
      const response = await fetch(url.href, {
        method: ${JSON.stringify(method)},
        headers: ${JSON.stringify(headers)},
        body: ${body === undefined || body === null ? 'undefined' : JSON.stringify(String(body))},
        credentials: 'include',
        signal: controller.signal,
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type') || '';
      const truncated = text.length > ${maxOutputLength};
      const content = truncated ? text.slice(0, ${maxOutputLength}) : text;
      let data = content;
      if (!truncated && (${JSON.stringify(responseType)} === 'json' || (${JSON.stringify(responseType)} === 'auto' && contentType.includes('json')))) {
        try { data = JSON.parse(content); } catch (e) {
          if (${JSON.stringify(responseType)} === 'json') throw new Error('响应不是有效 JSON: ' + e.message);
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        contentType,
        originalLength: text.length,
        truncated,
        data,
      };
    } finally {
      clearTimeout(timer);
    }
  })()`

  const { result, exceptionDetails } = await withTimeout(
    chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: timeoutMs + 250,
    }),
    timeoutMs + 500,
    "page_request"
  )
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || "页面请求失败")
  }
  return result?.value
}

async function handleListNetworkRequests(params = {}) {
  const { session } = await ensureAttachedSession(params)
  const { filter, method, status, resourceType, limit = 50, priorityMode = 'debug' } = params

  let results = [...session.networkRequests]
  const pending = [...session.requestMap.values()].map(r => ({ ...r, status: "pending" }))
  results = [...pending, ...results]

  if (filter) {
    const lowerFilter = filter.toLowerCase()
    results = results.filter(r => r.url?.toLowerCase().includes(lowerFilter))
  }
  if (method) results = results.filter(r => r.method?.toUpperCase() === method.toUpperCase())
  if (status) results = results.filter(r => r.status === status)
  if (resourceType) {
    const lowerType = resourceType.toLowerCase()
    results = results.filter(r => r.resourceType?.toLowerCase() === lowerType)
  }

  results.sort((a, b) => GhostBridgeNetwork.compareNetworkEntries(a, b, priorityMode))
  results = results.slice(0, limit)

  return {
    total: session.networkRequests.length + session.requestMap.size,
    filtered: results.length,
    priorityMode,
    requests: results.map((entry) => GhostBridgeNetwork.buildNetworkRequestSummary(entry)),
  }
}

async function handleGetNetworkDetail(params = {}) {
  const { target, session } = await ensureAttachedSession(params)
  const { requestId, includeBody = false } = params
  if (!requestId) throw new Error("需要提供 requestId")

  let entry = session.requestMap.get(requestId)
  if (!entry) entry = session.networkRequests.find(r => r.requestId === requestId)
  if (!entry) throw new Error(`未找到请求: ${requestId}`)

  const urlMeta = GhostBridgeNetwork.summarizeNetworkUrl(entry.url)
  const result = {
    ...entry,
    url: urlMeta.displayUrl,
    ...(urlMeta.urlTruncated ? { urlTruncated: true, urlOriginalLength: urlMeta.urlOriginalLength } : {}),
    ...(urlMeta.urlScheme ? { urlScheme: urlMeta.urlScheme } : {}),
    ...(urlMeta.dataUrlMimeType ? { dataUrlMimeType: urlMeta.dataUrlMimeType } : {}),
  }

  if (urlMeta.urlTruncated) {
    result.urlNote = urlMeta.urlScheme === 'data'
      ? '为避免上下文膨胀，data URL 已摘要化展示。'
      : '为避免上下文膨胀，超长 URL 已摘要化展示。'
  }

  if (includeBody && entry.status !== "pending" && entry.status !== "failed") {
    try {
      const { body, base64Encoded } = await chrome.debugger.sendCommand(
        target, "Network.getResponseBody", { requestId }
      )
      if (base64Encoded) {
        result.bodyInfo = { type: "binary", base64Length: body.length, note: "二进制内容，已 base64 编码" }
        if (body.length < CONFIG.maxRequestBodySize) result.bodyBase64 = body
      } else {
        if (body.length > CONFIG.maxRequestBodySize) {
          result.body = body.slice(0, CONFIG.maxRequestBodySize)
          result.bodyTruncated = true
          result.bodyTotalLength = body.length
        } else {
          result.body = body
        }
      }
    } catch (e) {
      result.bodyError = e.message
    }
  }

  return result
}

async function handleClearNetworkRequests(params = {}) {
  const { session } = await ensureAttachedSession(params)
  const count = session.networkRequests.length
  session.networkRequests = []
  return { cleared: count }
}

async function handlePerfMetrics(params = {}) {
  const target = await ensureAttached(params)
  const { includeResources = true, includeTimings = true } = params

  // 1. CDP Performance.getMetrics — 底层引擎指标
  await chrome.debugger.sendCommand(target, "Performance.enable")
  const { metrics } = await chrome.debugger.sendCommand(target, "Performance.getMetrics")
  await chrome.debugger.sendCommand(target, "Performance.disable")

  // 整理为可读的分组
  const metricsMap = {}
  for (const m of metrics) {
    metricsMap[m.name] = m.value
  }

  const engineMetrics = {
    memory: {
      jsHeapUsedSize: formatBytes(metricsMap.JSHeapUsedSize),
      jsHeapTotalSize: formatBytes(metricsMap.JSHeapTotalSize),
      usagePercent: metricsMap.JSHeapTotalSize
        ? Math.round((metricsMap.JSHeapUsedSize / metricsMap.JSHeapTotalSize) * 100) + "%"
        : "N/A",
    },
    dom: {
      nodes: metricsMap.Nodes,
      documents: metricsMap.Documents,
      frames: metricsMap.Frames,
      jsEventListeners: metricsMap.JSEventListeners,
    },
    layout: {
      layoutCount: metricsMap.LayoutCount,
      recalcStyleCount: metricsMap.RecalcStyleCount,
      layoutDuration: roundMs(metricsMap.LayoutDuration),
      recalcStyleDuration: roundMs(metricsMap.RecalcStyleDuration),
    },
    tasks: {
      scriptDuration: roundMs(metricsMap.ScriptDuration),
      taskDuration: roundMs(metricsMap.TaskDuration),
      taskOtherDuration: roundMs(metricsMap.TaskOtherDuration),
    },
  }

  const result = { engineMetrics }

  // 2. Web Vitals + Navigation Timing（通过 Runtime.evaluate）
  if (includeTimings) {
    const expression = `(function() {
      try {
        const result = {};
        // Navigation Timing
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav) {
          result.navigation = {
            type: nav.type,
            redirectTime: Math.round(nav.redirectEnd - nav.redirectStart),
            dnsTime: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
            connectTime: Math.round(nav.connectEnd - nav.connectStart),
            ttfb: Math.round(nav.responseStart - nav.requestStart),
            responseTime: Math.round(nav.responseEnd - nav.responseStart),
            domInteractive: Math.round(nav.domInteractive),
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
            loadComplete: Math.round(nav.loadEventEnd),
            totalDuration: Math.round(nav.duration),
          };
        }
        // Paint Timing (FP, FCP)
        const paints = performance.getEntriesByType('paint');
        result.paint = {};
        for (const p of paints) {
          if (p.name === 'first-paint') result.paint.firstPaint = Math.round(p.startTime);
          if (p.name === 'first-contentful-paint') result.paint.firstContentfulPaint = Math.round(p.startTime);
        }
        // Long Tasks（如果有 PerformanceObserver 记录）
        try {
          const longTasks = performance.getEntriesByType('longtask');
          if (longTasks && longTasks.length > 0) {
            result.longTasks = {
              count: longTasks.length,
              totalDuration: Math.round(longTasks.reduce((s, t) => s + t.duration, 0)),
              longest: Math.round(Math.max(...longTasks.map(t => t.duration))),
            };
          }
        } catch(e) {}
        // 基本信息
        result.timing = {
          now: Math.round(performance.now()),
          timeOrigin: Math.round(performance.timeOrigin),
        };
        return result;
      } catch (e) { return { error: e.message }; }
    })()`
    const { result: evalResult } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    })
    if (evalResult?.value) {
      result.webVitals = evalResult.value
    }
  }

  // 3. 资源加载摘要
  if (includeResources) {
    const resExpression = `(function() {
      try {
        const entries = performance.getEntriesByType('resource');
        const byType = {};
        let totalSize = 0, totalDuration = 0, slowest = null;
        for (const e of entries) {
          const type = e.initiatorType || 'other';
          if (!byType[type]) byType[type] = { count: 0, totalSize: 0, totalDuration: 0 };
          byType[type].count++;
          byType[type].totalSize += e.transferSize || 0;
          byType[type].totalDuration += e.duration || 0;
          totalSize += e.transferSize || 0;
          totalDuration += e.duration || 0;
          if (!slowest || e.duration > slowest.duration) {
            slowest = { name: e.name.split('/').pop().split('?')[0] || e.name.slice(0, 60), duration: Math.round(e.duration), size: e.transferSize || 0, type };
          }
        }
        // 格式化 byType
        const summary = {};
        for (const [type, data] of Object.entries(byType)) {
          summary[type] = { count: data.count, totalSize: data.totalSize, avgDuration: Math.round(data.totalDuration / data.count) };
        }
        return { totalResources: entries.length, totalTransferSize: totalSize, summary, slowest };
      } catch (e) { return { error: e.message }; }
    })()`
    const { result: resResult } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: resExpression,
      returnByValue: true,
    })
    if (resResult?.value) {
      result.resources = resResult.value
    }
  }

  return result
}

function formatBytes(bytes) {
  if (bytes == null) return "N/A"
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  return (bytes / (1024 * 1024)).toFixed(1) + " MB"
}

function roundMs(seconds) {
  if (seconds == null) return "N/A"
  return Math.round(seconds * 1000) + "ms"
}

async function handleCaptureScreenshot(params = {}) {
  const target = await ensureAttached(params)
  const { format: requestedFormat, quality: requestedQuality, fullPage = false, clip } = params
  const format = requestedFormat || 'jpeg'
  const quality = format === 'jpeg'
    ? (requestedQuality ?? (fullPage ? 70 : 80))
    : undefined

  await chrome.debugger.sendCommand(target, 'Page.enable')

  let captureParams = {
    format,
    ...(format === 'jpeg' ? { quality } : {}),
  }

  if (clip) {
    captureParams.clip = { x: clip.x || 0, y: clip.y || 0, width: clip.width, height: clip.height, scale: clip.scale || 1 }
  } else if (fullPage) {
    const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(function() {
        return {
          width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth, document.body.offsetWidth, document.documentElement.offsetWidth, document.body.clientWidth, document.documentElement.clientWidth),
          height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight, document.documentElement.offsetHeight, document.body.clientHeight, document.documentElement.clientHeight)
        };
      })()`,
      returnByValue: true,
    })

    const pageSize = result?.value
    if (pageSize && pageSize.width && pageSize.height) {
      const maxWidth = Math.min(pageSize.width, 4096)
      const maxHeight = Math.min(pageSize.height, 16384)

      captureParams.clip = { x: 0, y: 0, width: maxWidth, height: maxHeight, scale: 1 }

      const { result: viewportResult } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `({ width: window.innerWidth, height: window.innerHeight })`,
        returnByValue: true,
      })
      const originalViewport = viewportResult?.value

      await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
        width: maxWidth, height: maxHeight, deviceScaleFactor: 1, mobile: false,
      })

      try {
        const { data } = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', captureParams)
        if (originalViewport) {
          await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
            width: originalViewport.width, height: originalViewport.height, deviceScaleFactor: 1, mobile: false,
          })
        }
        await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {})
        return {
          imageData: data, format, quality, fullPage: true, width: maxWidth, height: maxHeight,
          note: pageSize.height > maxHeight ? `页面高度 ${pageSize.height}px 超过限制，已截取前 ${maxHeight}px` : undefined,
        }
      } catch (e) {
        await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {})
        throw e
      }
    }
  }

  const { data } = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', captureParams)
  const { result: sizeResult } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `({ width: window.innerWidth, height: window.innerHeight })`,
    returnByValue: true,
  })

  return {
    imageData: data,
    format,
    quality,
    fullPage: false,
    width: sizeResult?.value?.width,
    height: sizeResult?.value?.height
  }
}

async function handleInspectPageSnapshot(params = {}) {
  const { target, session } = await ensureAttachedSession(params)
  const { selector, includeInteractive = true, maxElements = 30 } = params
  const textMaxLength = Math.min(3000, Math.max(1, Math.floor(Number(params.textMaxLength) || 1500)))
  const expression = GhostBridgeDom.buildInspectWithTextExpression({ selector, includeInteractive, maxElements,
    includeText: params.includeText === true, textMaxLength })

  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })

  if (result?.value?.error) throw new Error(result.value.error)
  const value = result?.value
  if (value) {
    value.target = describeCommandTarget(params, session)
    value.tabId = session.tabId
    if (value.text && !value.text.error) await tryMergeCrossOriginFrames(session, value.text, textMaxLength)
  }
  return value
}

// 跨域 iframe 读取：对 autoAttach 报告的 iframe 子 target 直接 attach + evaluate。
// 实测（CDP 1.3）：chrome.debugger 接受 OOPIF 子 target 的 targetId 附加，可读取
// 同源策略下 contentDocument 不可访问的跨域 iframe 文本。失败即置
// crossOriginUnsupported 并放弃，不影响主流程
async function tryMergeCrossOriginFrames(session, value, maxLength) {
  if (!value || !value.crossOriginSkipped) return
  return GhostBridgeRuntime.mergeFrames({
    value, maxLength,
    frames: [...(session.childTargets || new Map()).entries()].filter(([, info]) => info.type === 'iframe').slice(0, 5),
    read: async (targetId, budget) => {
      const child = { targetId }
      let abandoned = false
      const attaching = chrome.debugger.attach(child, '1.3')
      attaching.then(() => { if (abandoned) chrome.debugger.detach(child).catch(() => {}) }, () => {})
      try { await withTimeout(attaching, 2000, 'iframe attach') }
      catch (error) { abandoned = true; throw error }
      try {
        const { result, exceptionDetails } = await withTimeout(chrome.debugger.sendCommand(child, 'Runtime.evaluate', {
          expression: `(()=>{const t=(document.body?.innerText||'').trim();return {text:t.slice(0,${budget}),truncated:t.length>${budget}}})()`,
          returnByValue: true, timeout: 2000,
        }), 2500, 'iframe evaluate')
        if (exceptionDetails) throw new Error('iframe evaluation failed')
        return result?.value
      } finally {
        await withTimeout(chrome.debugger.detach(child), 1000, 'iframe detach').catch(() => {})
      }
    },
  })
}

async function handleGetPageContent(params = {}) {
  const { target, session } = await ensureAttachedSession(params)
  const { mode = "text", selector, maxLength = 50000, offset = 0, includeMetadata = true } = params
  const safeMaxLength = Math.min(50000, Math.max(1, Number(maxLength) || 8000))
  const safeOffset = Math.min(100000000, Math.max(0, Math.floor(Number(offset) || 0)))
  const expression = GhostBridgeDom.buildPageContentExpression({
    mode,
    selector,
    maxLength: safeMaxLength,
    offset: safeOffset,
    includeMetadata,
  })

  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })

  if (result?.value?.error) throw new Error(result.value.error)
  if (mode === "text") {
    await tryMergeCrossOriginFrames(session, result?.value, safeMaxLength)
  }
  return result?.value
}

// ========== DOM 交互：可交互元素快照 ==========

async function handleGetInteractiveSnapshot(params = {}) {
  const { target, session } = await ensureAttachedSession(params)
  const { selector, includeText = true, maxElements = 100 } = params
  const value = await evaluateInteractiveSnapshot(target, { selector, includeText, maxElements })
  if (value) {
    value.target = describeCommandTarget(params, session)
    value.tabId = session.tabId
  }
  return value
}

async function evaluateInteractiveSnapshot(target, { selector, includeText = true, maxElements = 100 } = {}) {
  const expression = GhostBridgeDom.buildInteractiveSnapshotExpression({ selector, includeText, maxElements })

  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })

  if (result?.value?.error) throw new Error(result.value.error)
  return result?.value
}

// ========== DOM 交互：动作分发器 ==========

async function handleDispatchAction(params = {}) {
  const anyNamedTargets = [...clientSessions.values()].some((client) => client.namedTargets.size > 0)
  if (anyNamedTargets && !params.target && params.tabId === undefined) {
    throw new Error("已绑定命名 target 时，dispatch_action 必须提供 target，避免跨页面误用 ref")
  }
  const { target, session } = await ensureAttachedSession(params)
  const isBatch = Array.isArray(params.actions)
  const actions = isBatch ? params.actions : [params]
  if (!actions.length || actions.length > 20) throw new Error("actions 数量必须在 1-20 之间")
  actions.forEach(validateDispatchStep)
  const timeoutMs = Math.min(60000, Math.max(1000, Number(params.timeoutMs) || 30000))
  const deadline = Date.now() + timeoutMs

  const batch = await GhostBridgeControl.runActionBatch(
    actions,
    async (step, index) => {
      ensureBeforeDeadline(deadline)
      return executeDispatchAction(target, session, step, index, deadline)
    },
    {
      stopOnError: params.stopOnError !== false,
      mapError: (error, index) => error.actionResult || { index, success: false, error: error.message },
    }
  )
  const results = batch.results

  let pageAfter
  try {
    pageAfter = await readPageState(target)
  } catch (error) {
    pageAfter = { error: error.message }
  }
  const response = isBatch
    ? {
        success: results.length === actions.length && results.every((item) => item.success),
        completed: results.filter((item) => item.success).length,
        total: actions.length,
        stopped: batch.stopped,
        timeoutMs,
        results,
        pageAfter,
      }
    : { ...results[0], pageAfter }

  if (params.snapshotAfter) {
    if (Date.now() < deadline) {
      try {
        response.snapshotAfter = await evaluateInteractiveSnapshot(target, {
          selector: params.snapshotSelector,
          includeText: true,
          maxElements: Math.min(100, Math.max(1, Number(params.snapshotMaxElements) || 20)),
        })
      } catch (error) {
        response.snapshotError = error.message
      }
    } else {
      response.snapshotSkipped = "批处理已到整体截止时间"
    }
  }

  return response
}

function batchTimeoutError(message = "批处理已到整体截止时间") {
  const error = new Error(message)
  error.batchTimeout = true
  return error
}

function ensureBeforeDeadline(deadline) {
  if (Date.now() >= deadline) throw batchTimeoutError()
}

async function sleepBeforeDeadline(ms, deadline) {
  if (ms <= 0) return
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw batchTimeoutError()
  await sleep(Math.min(ms, remaining))
  if (ms >= remaining || Date.now() >= deadline) throw batchTimeoutError()
}

async function evaluateDomValue(target, expression, options = {}) {
  const { result, exceptionDetails } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    ...options,
  })
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || "页面脚本执行失败")
  }
  if (result?.value?.error) {
    const error = new Error(result.value.error)
    error.diagnostics = result.value
    throw error
  }
  return result?.value
}

async function ensureLocatorRuntime(target) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const installed = await evaluateDomValue(target, "window.__ghostLocatorRuntime?.version === 1")
      if (!installed) {
        await evaluateDomValue(target, GhostBridgeDom.buildInstallLocatorRuntimeExpression())
      }
      return
    } catch (error) {
      lastError = error
      if (!isTransientPageError(error) || attempt === 1) throw error
      await sleep(50)
    }
  }
  throw lastError
}

function isTransientPageError(error) {
  return /context|navigat|frame|target closed|cannot find/i.test(String(error?.message || error))
}

function validateLocator(locator) {
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) throw new Error("locator 必须是对象")
  const fields = ['css', 'testId', 'role', 'name', 'label', 'placeholder', 'text']
  if (!fields.some((field) => locator[field] !== undefined && locator[field] !== '')) {
    throw new Error("locator 至少需要 css/testId/role/name/label/placeholder/text 之一")
  }
  if (locator.match && !['exact', 'contains'].includes(locator.match)) {
    throw new Error("locator.match 仅支持 exact 或 contains")
  }
  if (locator.nth !== undefined && (!Number.isInteger(locator.nth) || locator.nth < 0)) {
    throw new Error("locator.nth 必须是从 0 开始的整数")
  }
}

function validateWaitFor(waitFor, fallbackLocator) {
  if (!waitFor || typeof waitFor !== 'object') throw new Error("waitFor 必须是对象")
  const type = waitFor.type
  if (!['element', 'url', 'networkIdle', 'expression'].includes(type)) {
    throw new Error("waitFor.type 仅支持 element/url/networkIdle/expression")
  }
  if (type === 'element') {
    const state = waitFor.state || 'visible'
    if (!['visible', 'hidden', 'attached', 'detached', 'enabled'].includes(state)) {
      throw new Error("element waitFor.state 仅支持 visible/hidden/attached/detached/enabled")
    }
    if (!waitFor.locator && !fallbackLocator) {
      throw new Error("element waitFor 需要 locator，或复用当前动作的 locator")
    }
    validateLocator(waitFor.locator || fallbackLocator)
  } else if (type === 'url' && waitFor.equals === undefined && waitFor.contains === undefined) {
    throw new Error("url waitFor 需要 equals 或 contains")
  } else if (type === 'expression' && (!waitFor.expression || typeof waitFor.expression !== 'string')) {
    throw new Error("expression waitFor 需要 expression 字符串")
  }
}

async function waitForCondition(target, session, waitFor, fallbackLocator, deadline) {
  validateWaitFor(waitFor, fallbackLocator)
  const type = waitFor.type

  const timeoutMs = Math.min(30000, Math.max(100, Number(waitFor.timeoutMs) || 10000))
  const probe = async () => {
    try {
      if (type === 'element') {
        const state = waitFor.state || 'visible'
        const locator = waitFor.locator || fallbackLocator
        await ensureLocatorRuntime(target)
        const expression = GhostBridgeDom.buildLocatorProbeExpression({ locator, state })
        return evaluateDomValue(target, expression)
      } else if (type === 'url') {
        const page = await readPageState(target)
        const expected = waitFor.equals ?? waitFor.contains
        const satisfied = waitFor.equals !== undefined
          ? page?.url === String(expected)
          : String(page?.url || '').includes(String(expected))
        return { satisfied, url: page?.url, match: waitFor.equals !== undefined ? 'equals' : 'contains' }
      } else if (type === 'networkIdle') {
        const idleMs = Math.min(10000, Math.max(100, Number(waitFor.idleMs) || 500))
        const pendingRequests = session.requestMap.size
        const idleForMs = Date.now() - session.lastNetworkActivityAt
        return { satisfied: pendingRequests === 0 && idleForMs >= idleMs, pendingRequests, idleForMs, idleMs }
      } else {
        const probeTimeout = Math.max(50, Math.min(1000, deadline - Date.now()))
        const expression = `(async function(){return Boolean(await (${waitFor.expression}));})()`
        const value = await evaluateDomValue(target, expression, { awaitPromise: true, timeout: probeTimeout })
        return { satisfied: Boolean(value) }
      }
    } catch (error) {
      if (isTransientPageError(error)) return { satisfied: false, transientError: error.message }
      throw error
    }
  }

  const status = await GhostBridgeControl.pollUntil({
    probe,
    timeoutMs,
    overallDeadline: deadline,
    intervalMs: 200,
    sleep,
  })
  if (status.satisfied) {
    return {
      ...status,
      type,
      ...(type === 'element' ? { state: waitFor.state || 'visible' } : {}),
    }
  }

  const error = status.reason === 'batchTimeout'
    ? batchTimeoutError(`整体批处理在等待 ${type} 时超过截止时间`)
    : new Error(`等待条件 ${type} 超时(${timeoutMs}ms)`)
  error.waitStatus = { ...status, type }
  throw error
}

function validateDispatchStep(step = {}) {
  const { ref, selector, locator, action, value, key, deltaX, deltaY, waitMs = 0, waitFor } = step
  if (!ref && !selector && !locator) throw new Error("需要提供 ref、selector 或 locator")
  if (ref && !/^e\d+$/.test(String(ref))) throw new Error(`无效的 ref: ${ref}`)
  if (!action) throw new Error("需要提供 action（动作类型：click/fill/press/scroll/select/hover/focus）")
  if (!["click", "fill", "press", "scroll", "select", "hover", "focus"].includes(action)) {
    throw new Error(`不支持的动作类型: ${action}，可选: click/fill/press/scroll/select/hover/focus`)
  }
  if (action === "fill" && (value === undefined || value === null)) throw new Error("fill 动作需要提供 value 参数")
  if (action === "select" && value === undefined) throw new Error("select 动作需要提供 value 参数")

  const semanticLocator = locator || { css: ref ? `[data-ghost-ref="${ref}"]` : String(selector) }
  validateLocator(semanticLocator)
  if (waitFor) validateWaitFor(waitFor, semanticLocator)
  return semanticLocator
}

async function executeDispatchAction(target, session, step = {}, index, deadline) {
  const { ref, selector, locator, action, value, key, deltaX, deltaY, waitMs = 0, waitFor } = step
  const semanticLocator = validateDispatchStep(step)
  const locatorLabel = ref || selector || JSON.stringify(locator)
  const actionId = `a${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`
  let actionResult = { index, ...(ref ? { ref } : selector ? { selector } : { locator }), action, success: false }
  let actionCompleted = false

  try {
    ensureBeforeDeadline(deadline)
    await ensureLocatorRuntime(target)
    const locateExpression = GhostBridgeDom.buildLocateElementExpression({ locator, ref, selector, actionId })
    const loc = await evaluateDomValue(target, locateExpression)
    if (!loc?.found) throw new Error("无法定位元素")
    if (loc.disabled) throw new Error(`元素 ${locatorLabel} 已被禁用 (disabled)`)

    const cx = loc.cx
    const cy = loc.cy
    actionResult.matched = {
      tag: loc.tag,
      role: loc.role,
      name: loc.name,
      text: loc.text,
      matchCount: loc.matchCount,
    }

    // Step 2: 根据动作类型执行 CDP 命令
    if (action === "click") {
      // 物理级 CDP 鼠标点击
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1,
      })
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1,
      })
      actionResult.detail = `已点击 ${locatorLabel} (${loc.tag}) 坐标 (${cx}, ${cy})`

    } else if (action === "fill") {
      // 先点击聚焦
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1,
      })
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1,
      })
      // 全选并清空已有内容
      await evaluateDomValue(target, GhostBridgeDom.buildElementCommandExpression({ actionId, command: 'prepareFill' }))
      // 用 CDP 模拟键盘输入
      await chrome.debugger.sendCommand(target, "Input.insertText", {
        text: String(value),
      })
      // 强制触发 input/change 事件（兼容 React/Vue）
      await evaluateDomValue(target, GhostBridgeDom.buildElementCommandExpression({ actionId, command: 'dispatchInput' }))
      actionResult.detail = `已在 ${locatorLabel} (${loc.tag}) 中填入 "${String(value).slice(0, 50)}"`

    } else if (action === "press") {
      // 模拟键盘按键
      const keyName = key || value || "Enter"
      // 先确保元素聚焦
      await evaluateDomValue(target, GhostBridgeDom.buildElementCommandExpression({ actionId, command: 'focus' }))
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyDown", key: keyName,
      })
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp", key: keyName,
      })
      actionResult.detail = `已在 ${locatorLabel} 上按下 ${keyName}`

    } else if (action === "scroll") {
      const dx = deltaX ?? 0
      const dy = deltaY ?? 300
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: cx, y: cy, deltaX: dx, deltaY: dy,
      })
      actionResult.detail = `已在 ${locatorLabel} 位置滚动 (${dx}, ${dy})`

    } else if (action === "select") {
      // 下拉框选择
      await evaluateDomValue(target, GhostBridgeDom.buildElementCommandExpression({ actionId, command: 'select', payload: { value: String(value) } }))
      actionResult.detail = `已在 ${locatorLabel} 选择值 "${value}"`

    } else if (action === "hover") {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: cx, y: cy,
      })
      actionResult.detail = `已将鼠标悬停到 ${locatorLabel} (${cx}, ${cy})`

    } else if (action === "focus") {
      await evaluateDomValue(target, GhostBridgeDom.buildElementCommandExpression({ actionId, command: 'focus' }))
      actionResult.detail = `已聚焦到 ${locatorLabel}`

    }

    actionCompleted = true
    actionResult.success = true

    // Legacy fixed delay remains available, but defaults to zero. A state-based waitFor
    // is faster when the page responds quickly and safer when it responds slowly.
    if (waitMs > 0) await sleepBeforeDeadline(Math.min(Number(waitMs) || 0, 3000), deadline)
    if (waitFor) actionResult.waitFor = await waitForCondition(target, session, waitFor, semanticLocator, deadline)

    return actionResult
  } catch (error) {
    actionResult.success = false
    actionResult.actionCompleted = actionCompleted || undefined
    actionResult.error = error.message
    actionResult.diagnostics = error.diagnostics
    actionResult.waitFor = error.waitStatus
    error.actionResult = actionResult
    throw error
  } finally {
    try {
      await evaluateDomValue(target, GhostBridgeDom.buildCleanupElementExpression(actionId))
    } catch (_) {}
  }
}

async function readPageState(target) {
  const { result: afterResult } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(function() {
      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
      };
    })()`,
    returnByValue: true,
  })
  return afterResult?.value
}

// 处理来自服务器的命令
async function handleCommand(message) {
  const { id, command, token } = message
  if (!id || !command) return

  // 内部命令：服务器通知某个 MCP 会话断开，清理其 target 命名空间（不要求扩展已启用）
  if (command === "_clientDisconnected") {
    cleanupClientSession(message.params?.clientId)
    sendToServer({ id, result: { cleaned: true } })
    return
  }
  if (!state.enabled) {
    sendToServer({ id, error: "扩展已暂停，点击图标重新开启" })
    return
  }
  if (CONFIG.token && CONFIG.token !== token) {
    sendToServer({ id, error: "token 校验失败" })
    return
  }
  // 命令所属的 MCP 会话：pin/bind 的命名空间按它隔离
  const clientId = message.clientId
  const started = performance.now()
  const timing = message.params?._diagnostics ? {} : undefined
  const diagnostics = () => timing ? { ...timing, commandMs: performance.now() - started, extensionVersion: chrome.runtime.getManifest().version } : undefined
  const params = { ...(message.params || {}), clientId, _timing: timing }
  try {
    let result
    if (command === "listTabs") result = await handleListTabs(params)
    else if (command === "getTargetTab") result = await buildTargetInfo(clientId)
    else if (command === "listTargets") result = await handleListTargets(params)
    else if (command === "bindTab") result = await handleBindTab(params)
    else if (command === "unbindTab") result = await handleUnbindTab(params)
    else if (command === "pinCurrentTab") result = await handlePinCurrentTab(params)
    else if (command === "pinTab") result = await handlePinTab(params)
    else if (command === "unpinTab") result = await handleUnpinTab(params)
    else if (command === "getLastError") result = await handleGetLastError(params)
    else if (command === "getScriptSource") result = await handleGetScriptSource(params)
    else if (command === "coverageSnapshot") result = await handleCoverageSnapshot(params)
    else if (command === "findByString") result = await handleFindByString(params)
    else if (command === "symbolicHints") result = await handleSymbolicHints(params)
    else if (command === "eval") result = await handleEval(params)
    else if (command === "pageRequest") result = await handlePageRequest(params)
    else if (command === "listNetworkRequests") result = await handleListNetworkRequests(params)
    else if (command === "getNetworkDetail") result = await handleGetNetworkDetail(params)
    else if (command === "clearNetworkRequests") result = await handleClearNetworkRequests(params)
    else if (command === "perfMetrics") result = await handlePerfMetrics(params)
    else if (command === "captureScreenshot") result = await handleCaptureScreenshot(params)
    else if (command === "inspectPageSnapshot") result = await handleInspectPageSnapshot(params)
    else if (command === "getPageContent") result = await handleGetPageContent(params)
    else if (command === "getInteractiveSnapshot") result = await handleGetInteractiveSnapshot(params)
    else if (command === "dispatchAction") result = await handleDispatchAction(params)
    else throw new Error(`未知指令 ${command}`)

    sendToServer({ id, result, diagnostics: diagnostics() })
  } catch (e) {
    sendToServer({ id, error: e.message, diagnostics: diagnostics() })
  } finally {
    await maybeDetach()
  }
}

// 发送消息到服务器（通过 offscreen）
function sendToServer(data) {
  chrome.runtime.sendMessage({ type: 'send', data }).catch(() => {})
}

// ========== 状态广播 ==========

function getConnectionStatus() {
  let status
  if (!state.enabled) {
    status = 'disconnected'
  } else if (state.connected) {
    status = 'connected'
  } else {
    status = state.connectionStatus || 'connecting'
  }
  return status
}

async function buildPopupState() {
  const status = getConnectionStatus()
  const targetInfo = await buildTargetInfo()
  const targetTab = targetInfo.targetTab
  const viewingTab = targetInfo.viewingTab
  return {
    status,
    enabled: state.enabled,
    port: state.port,
    currentPort: state.currentPort,
    basePort: CONFIG.basePort,
    connectionError: state.connectionError,
    serverInfo: state.serverInfo,
    targetMode: targetInfo.targetMode,
    pinnedTabId: targetInfo.pinnedTabId,
    focusedTabId: targetInfo.focusedTabId,
    attachedTabId: targetInfo.attachedTabId,
    attachedTabIds: targetInfo.attachedTabIds,
    targets: targetInfo.targets,
    targetTab,
    viewingTab,
    targetError: targetInfo.targetError,
    tabTitle: targetTab?.title || '',
    tabUrl: targetTab?.url || '',
    viewingTitle: viewingTab?.title || '',
    viewingUrl: viewingTab?.url || '',
  }
}

// 主动推送状态给 popup
async function broadcastStatus() {
  try {
    chrome.runtime.sendMessage({
      type: 'statusUpdate',
      state: await buildPopupState()
    }).catch(() => {}) // popup 可能未打开，忽略错误
  } catch (e) {
    log(`状态广播失败：${e.message}`)
  }
}

// 监听被调试页面的导航变化，实时推送到 popup
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((sessionsByTabId.has(tabId) || tab.active) && (changeInfo.title || changeInfo.url)) {
    if (state.connected) broadcastStatus()
  }
})

// 监听用户切换标签页（Active Tab 发生变化），让调试器自动跟随到新标签页
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (state.enabled && state.connected) {
    try {
      // focused 模式保持旧行为：切换 Tab 时自动跟随（focused 是共享语义，任一会话处于 focused 即跟随）
      const anyFocused = clientSessions.size === 0
        || [...clientSessions.values()].some((client) => client.targetMode === 'focused')
      if (anyFocused) {
        await ensureAttached()
      }
      broadcastStatus()
    } catch (e) {
      log(`自动跟随切换 Tab 失败：${e.message}`)
    }
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const client of clientSessions.values()) {
    if (client.pinnedTabId === tabId) {
      client.targetMode = 'focused'
      client.pinnedTabId = null
    }
    for (const [name, boundTabId] of client.namedTargets.entries()) {
      if (boundTabId === tabId) client.namedTargets.delete(name)
    }
  }
  if (tabId === attachedTabId) {
    attachedTabId = null
  }
  if (tabId === focusedTabId) {
    focusedTabId = null
  }
  sessionsByTabId.delete(tabId)
  if (state.connected) broadcastStatus()
})


// ========== 消息监听 ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 判断消息来源
  const senderUrl = sender.url || ''
  const isFromOffscreen = senderUrl.includes('offscreen.html')
  const isFromBackground = !sender.url // background 发的消息没有 url

  // background 自己发出的消息不处理（避免循环）
  if (isFromBackground) {
    return
  }

  // 来自 offscreen 的状态更新
  if (message.type === 'status' && isFromOffscreen) {
    if (message.status === 'connected') {
      state.connected = true
      state.port = message.port
      state.currentPort = message.port
      state.connectionStatus = 'connected'
      state.connectionError = ''
      state.serverInfo = message.serverInfo || null
      setBadgeState('on')
      // 服务器可能已重启，clientId 分配从零开始，旧会话桶全部作废
      clientSessions.clear()
      log(`✅ 已连接到 ghost-bridge 服务 (端口 ${message.port})`)
      ensureAttached()
        .then(() => broadcastStatus())
        .catch((e) => log(`attach 失败：${e.message}`))
    } else if (message.status === 'disconnected') {
      state.connected = false
      state.port = null
      state.connectionStatus = 'connecting'
      state.connectionError = ''
      state.serverInfo = null
      if (state.enabled) setBadgeState('connecting')
    } else if (message.status === 'connecting') {
      state.currentPort = message.currentPort
      state.connectionStatus = 'connecting'
      state.connectionError = ''
      state.serverInfo = null
      setBadgeState('connecting')
    } else if (message.status === 'error') {
      state.currentPort = message.currentPort
      state.connectionStatus = 'error'
      state.connectionError = message.errorMessage || ''
      state.serverInfo = null
      setBadgeState('err')
    } else if (message.status === 'not_found') {
      state.currentPort = message.currentPort
      state.connectionStatus = 'not_found'
      state.connectionError = message.errorMessage || ''
      state.serverInfo = null
      setBadgeState('connecting')
    }
    broadcastStatus() // 状态变化时主动推送
    return
  }

  // 来自 offscreen 的日志
  if (message.type === 'log' && isFromOffscreen) {
    console.log(`[offscreen] ${message.msg}`)
    return
  }

  // 来自 offscreen 的命令（从服务器转发）
  if (message.type === 'command' && isFromOffscreen) {
    handleCommand(message.data)
    return
  }

  // send 消息是 background 发给 offscreen 的，这里不处理
  if (message.type === 'send') {
    return
  }

  // 来自 popup 的状态查询
  if (message.type === 'getStatus') {
    buildPopupState().then(sendResponse).catch((e) => sendResponse({ status: 'error', connectionError: e.message }))
    return true
  }

  if (message.type === 'pinCurrentTab') {
    if (!state.enabled || !state.connected) {
      sendResponse({ ok: false, error: "Ghost Bridge 尚未连接" })
      return true
    }
    handlePinCurrentTab().then((result) => sendResponse({ ok: true, result })).catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }

  if (message.type === 'unpinTab') {
    if (!state.enabled || !state.connected) {
      sendResponse({ ok: false, error: "Ghost Bridge 尚未连接" })
      return true
    }
    handleUnpinTab().then((result) => sendResponse({ ok: true, result })).catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }

  // 来自 popup 的连接请求
  if (message.type === 'connect') {
    if (message.port) {
      CONFIG.basePort = message.port
    }

    startBridgeConnection({ persist: true })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }

  // 来自 popup 的断开请求
  if (message.type === 'disconnect') {
    stopBridgeConnection({ persist: true })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }

  return false
})

// ========== 定时兜底重连 ==========
// offscreen 的重连循环在 daemon 重启/长时间找不到服务后偶发停摆（现象：手动点 Connect 才恢复）。
// 每分钟检查一次连接状态，未连接则重新触发完整连接流程，保证无人值守时也能自动恢复
chrome.alarms.create('ghost-bridge-keepalive', { delayInMinutes: 1, periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'ghost-bridge-keepalive') return
  if (!state.enabled) return
  try {
    const status = await chrome.runtime.sendMessage({ type: 'getOffscreenStatus' }).catch(() => null)
    if (!status || !status.connected) {
      log('定时兜底：连接未建立，重新触发连接流程')
      await startBridgeConnection()
    }
  } catch (e) {
    log(`定时兜底重连失败：${e.message}`)
  }
})

// ========== 唤醒探活钩子 ==========
// 系统锁屏/睡眠唤醒后，WebSocket 可能处于半开状态（onclose 不触发、徽章仍显示已连接），
// 通知 offscreen 立即发一次心跳：无响应则关闭死链并马上重连，不等 15 秒周期心跳超时
chrome.idle.onStateChanged.addListener(async (idleState) => {
  if (idleState !== 'active') return
  if (!state.enabled) return
  log('系统唤醒，触发连接探活...')
  try {
    await setupOffscreenDocument()
    const alive = await chrome.runtime.sendMessage({ type: 'healthCheck' }).catch(() => null)
    // alive === false 说明 offscreen 已自行触发重连，无需干预；
    // 仅当 offscreen 完全无响应（可能被回收）时才走完整连接流程兜底
    if (alive !== true && alive !== false) {
      const status = await chrome.runtime.sendMessage({ type: 'getOffscreenStatus' }).catch(() => null)
      if (!status || !status.connected) {
        log('唤醒探活无响应，重新建立连接...')
        await startBridgeConnection()
      }
    }
  } catch (e) {
    log(`唤醒探活失败：${e.message}`)
  }
})

chrome.runtime.onStartup.addListener(() => {
  restoreBridgeConnection()
})

chrome.runtime.onInstalled.addListener(() => {
  restoreBridgeConnection()
})

restoreBridgeConnection()
log("Ghost Bridge background 已加载")
