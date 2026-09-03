importScripts('bg-network.js', 'bg-dom.js')

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
  let _release
  const _prev = _attachLock
  _attachLock = new Promise(r => _release = r)
  await _prev
  try {
    if (!state.enabled) throw new Error("扩展已暂停，点击图标开启后再试")
    const tab = await resolveTargetTab(params)
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
          await chrome.debugger.sendCommand({ tabId: session.tabId }, "Runtime.enable")
          await chrome.debugger.sendCommand({ tabId: session.tabId }, "Log.enable")
          await chrome.debugger.sendCommand({ tabId: session.tabId }, "Console.enable").catch(() => {})
          await chrome.debugger.sendCommand({ tabId: session.tabId }, "Debugger.enable")
          await chrome.debugger.sendCommand({ tabId: session.tabId }, "Profiler.enable")
          await chrome.debugger.sendCommand({ tabId: session.tabId }, "Network.enable").catch(() => {})

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
  const durationMs = params.durationMs || 1500
  await chrome.debugger.sendCommand(target, "Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  })
  await sleep(durationMs)
  const { result } = await chrome.debugger.sendCommand(target, "Profiler.takePreciseCoverage")
  await chrome.debugger.sendCommand(target, "Profiler.stopPreciseCoverage")

  const simplified = result
    .map((item) => {
      const totalCount = item.functions.reduce((sum, f) => sum + (f.callCount || 0), 0)
      return { url: item.url || "(inline)", scriptId: item.scriptId, totalCount }
    })
    .sort((a, b) => b.totalCount - a.totalCount)
    .slice(0, 20)

  return { topScripts: simplified, rawCount: result.length }
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
  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: params.code,
    returnByValue: true,
  })
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
  const expression = GhostBridgeDom.buildInspectPageExpression({ selector, includeInteractive, maxElements })

  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })

  if (result?.value?.error) throw new Error(result.value.error)
  const value = result?.value
  if (value) {
    value.target = describeCommandTarget(params, session)
    value.tabId = session.tabId
  }
  return value
}

async function handleGetPageContent(params = {}) {
  const target = await ensureAttached(params)
  const { mode = "text", selector, maxLength = 50000, includeMetadata = true } = params
  const expression = GhostBridgeDom.buildPageContentExpression({ mode, selector, maxLength, includeMetadata })

  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })

  if (result?.value?.error) throw new Error(result.value.error)
  return result?.value
}

// ========== DOM 交互：可交互元素快照 ==========

async function handleGetInteractiveSnapshot(params = {}) {
  const { target, session } = await ensureAttachedSession(params)
  const { selector, includeText = true, maxElements = 100 } = params
  const expression = GhostBridgeDom.buildInteractiveSnapshotExpression({ selector, includeText, maxElements })

  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })

  if (result?.value?.error) throw new Error(result.value.error)
  const value = result?.value
  if (value) {
    value.target = describeCommandTarget(params, session)
    value.tabId = session.tabId
  }
  return value
}

// ========== DOM 交互：动作分发器 ==========

async function handleDispatchAction(params = {}) {
  const anyNamedTargets = [...clientSessions.values()].some((client) => client.namedTargets.size > 0)
  if (anyNamedTargets && !params.target && params.tabId === undefined) {
    throw new Error("已绑定命名 target 时，dispatch_action 必须提供 target，避免跨页面误用 ref")
  }
  const target = await ensureAttached(params)
  const { ref, action, value, key, deltaX, deltaY, waitMs = 500 } = params

  if (!ref) throw new Error("需要提供 ref（元素标识，如 'e1'）")
  if (!action) throw new Error("需要提供 action（动作类型：click/fill/press/scroll/select/hover/focus）")

  // Step 1: 实时获取目标元素的最新坐标和状态
  const locateExpression = `(function() {
    try {
      const el = document.querySelector('[data-ghost-ref="${ref}"]');
      if (!el) return { error: '元素未找到，ref 可能已失效，请重新获取快照' };
      // 关键修复：确保元素在视口内，否则超出屏幕的坐标无法被 CDP 模拟点击
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return { error: '元素不可见（宽高为 0）' };
      return {
        found: true,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        cx: Math.round(rect.left + rect.width / 2),
        cy: Math.round(rect.top + rect.height / 2),
        disabled: el.disabled || false,
        value: (el.value || '').slice(0, 100),
      };
    } catch (e) { return { error: e.message }; }
  })()`

  const { result: locResult } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: locateExpression,
    returnByValue: true,
  })

  const loc = locResult?.value
  if (!loc || loc.error) throw new Error(loc?.error || "无法定位元素")
  if (loc.disabled) throw new Error(`元素 ${ref} 已被禁用 (disabled)`)

  const cx = loc.cx
  const cy = loc.cy

  let actionResult = { ref, action, success: true }

  // Step 2: 根据动作类型执行 CDP 命令
  if (action === "click") {
    // 物理级 CDP 鼠标点击
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1,
    })
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1,
    })
    actionResult.detail = `已点击 ${ref} (${loc.tag}) 坐标 (${cx}, ${cy})`

  } else if (action === "fill") {
    if (value === undefined || value === null) throw new Error("fill 动作需要提供 value 参数")
    // 先点击聚焦
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1,
    })
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1,
    })
    // 全选并清空已有内容
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(function() {
        const el = document.querySelector('[data-ghost-ref="${ref}"]');
        if (el) { el.focus(); el.select && el.select(); }
      })()`,
    })
    // 用 CDP 模拟键盘输入
    await chrome.debugger.sendCommand(target, "Input.insertText", {
      text: String(value),
    })
    // 强制触发 input/change 事件（兼容 React/Vue）
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(function() {
        const el = document.querySelector('[data-ghost-ref="${ref}"]');
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`,
    })
    actionResult.detail = `已在 ${ref} (${loc.tag}) 中填入 "${String(value).slice(0, 50)}"`

  } else if (action === "press") {
    // 模拟键盘按键
    const keyName = key || value || "Enter"
    // 先确保元素聚焦
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(function() {
        const el = document.querySelector('[data-ghost-ref="${ref}"]');
        if (el) el.focus();
      })()`,
    })
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyDown", key: keyName,
    })
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp", key: keyName,
    })
    actionResult.detail = `已在 ${ref} 上按下 ${keyName}`

  } else if (action === "scroll") {
    const dx = deltaX || 0
    const dy = deltaY || 300
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x: cx, y: cy, deltaX: dx, deltaY: dy,
    })
    actionResult.detail = `已在 ${ref} 位置滚动 (${dx}, ${dy})`

  } else if (action === "select") {
    // 下拉框选择
    if (value === undefined) throw new Error("select 动作需要提供 value 参数")
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(function() {
        const el = document.querySelector('[data-ghost-ref="${ref}"]');
        if (el && el.tagName === 'SELECT') {
          el.value = ${JSON.stringify(String(value))};
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`,
    })
    actionResult.detail = `已在 ${ref} 选择值 "${value}"`

  } else if (action === "hover") {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: cx, y: cy,
    })
    actionResult.detail = `已将鼠标悬停到 ${ref} (${cx}, ${cy})`

  } else if (action === "focus") {
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(function() {
        const el = document.querySelector('[data-ghost-ref="${ref}"]');
        if (el) el.focus();
      })()`,
    })
    actionResult.detail = `已聚焦到 ${ref}`

  } else {
    throw new Error(`不支持的动作类型: ${action}，可选: click/fill/press/scroll/select/hover/focus`)
  }

  // Step 3: 等待页面响应
  if (waitMs > 0) {
    await sleep(Math.min(waitMs, 3000))
  }

  // Step 4: 获取操作后状态摘要
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
  if (afterResult?.value) {
    actionResult.pageAfter = afterResult.value
  }

  return actionResult
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
  const params = { ...(message.params || {}), clientId }
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

    sendToServer({ id, result })
  } catch (e) {
    sendToServer({ id, error: e.message })
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
