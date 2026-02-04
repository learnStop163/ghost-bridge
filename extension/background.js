// 使用当月1号0点的时间戳作为 token，确保同月内的服务器和插件自动匹配
function getMonthlyToken() {
  const now = new Date()
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  return String(firstDayOfMonth.getTime())
}

const CONFIG = {
  basePort: 33333,           // 基础端口
  maxPortRetries: 10,        // 最大端口重试次数，与 server.js 保持一致
  token: getMonthlyToken(), // 使用当月时间戳作为 token
  autoDetach: false, // 默认保持附加，便于持续捕获异常；可通过图标一键暂停
  maxErrors: 40, // 保持有限的事件窗口，避免上下文爆炸
  maxStackFrames: 5,
  maxRequestsTracked: 200, // 完整网络请求记录数
  maxRequestBodySize: 100000, // 最大响应体大小 100KB
}

let ws = null
let reconnectTimer = null
let attachedTabId = null
let scriptMap = new Map()
let scriptSourceCache = new Map()
let lastErrors = []
let lastErrorLocation = null
let requestMap = new Map() // requestId -> 进行中的请求元数据
let networkRequests = [] // 完整的网络请求记录
let state = { enabled: false }

function setBadgeState(status) {
  // 统一徽章状态：connecting/ on / off / err / att(附加失败)
  const map = {
    connecting: { text: "…", color: "#999" },
    on: { text: "ON", color: "#34c759" },
    off: { text: "OFF", color: "#999" },
    err: { text: "ERR", color: "#ff3b30" },
    att: { text: "ATT", color: "#ff9f0a" }, // attach denied/失败
  }
  const cfg = map[status] || map.off
  chrome.action.setBadgeText({ text: cfg.text })
  chrome.action.setBadgeBackgroundColor({ color: cfg.color })
}

async function toggleEnabled() {
  state.enabled = !state.enabled
  if (state.enabled) {
    log("已开启 Ghost Bridge")
    setBadgeState("connecting")
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect()
    } else if (ws.readyState === WebSocket.OPEN) {
      ensureAttached().catch((e) => log(`attach 失败：${e.message}`))
    }
  } else {
    log("已暂停 Ghost Bridge")
    setBadgeState("off")
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
    await detachAllTargets()
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(msg) {
  console.log(`[ghost-bridge] ${msg}`)
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return
  if (!state.enabled) return

  if (method === "Debugger.scriptParsed") {
    scriptMap.set(params.scriptId, { url: params.url || "(inline)" })
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
      text: detail.text,
      scriptId: topFrame?.scriptId,
      stack: compactStack(detail.stackTrace),
      timestamp: Date.now(),
    }
    lastErrorLocation = {
      url: entry.url,
      line: entry.line,
      column: entry.column,
      scriptId: entry.scriptId,
    }
    pushError(entry)
  }

  if (method === "Log.entryAdded") {
    const entry = params?.entry || {}
    pushError({
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
    const args = (params.args || []).map((a) => a.value).filter(Boolean)
    pushError({
      type: params.type || "console",
      severity: params.type === "error" ? "error" : params.type === "warning" ? "warn" : "info",
      url: params.stackTrace?.callFrames?.[0]?.url,
      line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      text: args.join(" "),
      stack: compactStack(params.stackTrace),
      timestamp: Date.now(),
    })
  }

  if (method === "Network.requestWillBeSent") {
    const req = params.request || {}
    const entry = {
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
    requestMap.set(params.requestId, entry)

    // 控制映射大小
    if (requestMap.size > CONFIG.maxRequestsTracked * 2) {
      const firstKey = requestMap.keys().next().value
      requestMap.delete(firstKey)
    }
  }

  if (method === "Network.responseReceived") {
    const res = params.response || {}
    const entry = requestMap.get(params.requestId)
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

      // 记录到错误列表（仅失败请求）
      if (res.status >= 400) {
        pushError({
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
    const entry = requestMap.get(params.requestId)
    if (entry) {
      entry.endTime = params.timestamp
      entry.encodedDataLength = params.encodedDataLength
      entry.duration = entry.endTime && entry.startTime
        ? Math.round((entry.endTime - entry.startTime) * 1000)
        : null
      if (entry.status === "pending") entry.status = "success"

      // 移到完成列表
      pushNetworkRequest(entry)
      requestMap.delete(params.requestId)
    }
  }

  if (method === "Network.loadingFailed") {
    const entry = requestMap.get(params.requestId)
    if (entry) {
      entry.status = "failed"
      entry.errorText = params.errorText
      entry.canceled = params.canceled
      entry.blockedReason = params.blockedReason

      pushError({
        type: "network",
        severity: "error",
        url: entry.url,
        requestId: params.requestId,
        method: entry.method,
        text: params.errorText,
        timestamp: Date.now(),
      })

      pushNetworkRequest(entry)
      requestMap.delete(params.requestId)
    }
  }
})

function pushNetworkRequest(entry) {
  networkRequests.unshift(entry)
  if (networkRequests.length > CONFIG.maxRequestsTracked) {
    networkRequests.pop()
  }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId && source.tabId === attachedTabId) {
    attachedTabId = null
    scriptMap = new Map()
    scriptSourceCache = new Map()
    networkRequests = []
    requestMap = new Map()
  }
  if (!state.enabled) return
  if (reason === "canceled_by_user") {
    log("调试被用户取消，已关闭")
    state.enabled = false
    setBadgeState("off")
  } else {
    log(`调试已断开：${reason}`)
    setBadgeState("att")
  }
})

function pushError(entry) {
  lastErrors.unshift(entry)
  if (lastErrors.length > CONFIG.maxErrors) {
    // 优先丢弃低严重度，保留 error
    const dropIdx = lastErrors
      .map((e, i) => ({ sev: e.severity || "info", i }))
      .reverse()
      .find((e) => e.sev !== "error")?.i
    if (dropIdx !== undefined) lastErrors.splice(dropIdx, 1)
    else lastErrors.pop()
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

async function ensureAttached() {
  if (!state.enabled) throw new Error("扩展已暂停，点击图标开启后再试")
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab) throw new Error("没有激活的标签页")
  if (attachedTabId !== tab.id) {
    try {
      await chrome.debugger.attach({ tabId: tab.id }, "1.3")
      setBadgeState("on")
    } catch (e) {
      setBadgeState("att")
      throw e
    }
    attachedTabId = tab.id
    scriptMap = new Map()
    scriptSourceCache = new Map()
    networkRequests = []
    requestMap = new Map()
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Runtime.enable")
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Log.enable")
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Console.enable").catch(() => {})
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Debugger.enable")
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Profiler.enable")
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Network.enable").catch(() => {})
  }
  return { tabId: attachedTabId }
}

async function maybeDetach(force = false) {
  if ((CONFIG.autoDetach || force) && attachedTabId) {
    try {
      await chrome.debugger.detach({ tabId: attachedTabId })
    } catch (e) {
      log(`detach 失败：${e.message}`)
    } finally {
      attachedTabId = null
    }
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
      } catch (e) {
        log(`detach target ${t.id} 失败：${e.message}`)
      }
    }
    // 兜底：尝试对所有标签页 detach，避免 service worker 重启后状态丢失
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (!tab.id) continue
      try {
        await chrome.debugger.detach({ tabId: tab.id })
      } catch {
        // ignore
      }
    }
  } catch (e) {
    log(`getTargets 失败：${e.message}`)
  } finally {
    attachedTabId = null
  }
}

async function handleGetLastError() {
  // 确保已附加，否则收不到异常事件
  await ensureAttached()
  const events = lastErrors.slice(0, CONFIG.maxErrors)
  const counts = events.reduce(
    (acc, e) => {
      acc.total++
      acc[e.severity || "info"] = (acc[e.severity || "info"] || 0) + 1
      return acc
    },
    { total: 0 }
  )
  return {
    lastErrorLocation,
    summary: {
      count: events.length,
      severityCount: counts,
      lastTimestamp: events[0]?.timestamp,
    },
    recent: events,
  }
}

async function pickScriptId(preferUrlContains) {
  if (preferUrlContains) {
    for (const [id, meta] of scriptMap.entries()) {
      if (meta.url && meta.url.includes(preferUrlContains)) return { id, url: meta.url }
    }
  }
  if (lastErrorLocation?.scriptId && scriptMap.has(lastErrorLocation.scriptId)) {
    const meta = scriptMap.get(lastErrorLocation.scriptId)
    return { id: lastErrorLocation.scriptId, url: meta.url }
  }
  const first = scriptMap.entries().next().value
  if (first) {
    return { id: first[0], url: first[1].url }
  }
  throw new Error("未找到可用脚本，确认页面已加载脚本")
}

async function handleGetScriptSource(params = {}) {
  const target = await ensureAttached()
  const chosen = await pickScriptId(params.scriptUrlContains)
  const { scriptSource } = await chrome.debugger.sendCommand(target, "Debugger.getScriptSource", {
    scriptId: chosen.id,
  })
  scriptSourceCache.set(chosen.id, scriptSource)
  const location = {
    line: params.line ?? lastErrorLocation?.line ?? null,
    column: params.column ?? lastErrorLocation?.column ?? null,
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
  const target = await ensureAttached()
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
    matches.push({
      start,
      end,
      context: source.slice(start, end),
    })
    idx = lower.indexOf(q, idx + q.length)
  }
  return matches
}

async function handleFindByString(params = {}) {
  const target = await ensureAttached()
  const query = params.query
  const maxMatches = params.maxMatches || 5
  const preferred = params.scriptUrlContains

  const results = []
  const entries = [...scriptMap.entries()]
  for (const [id, meta] of entries) {
    if (preferred && (!meta.url || !meta.url.includes(preferred))) continue
    if (!scriptSourceCache.has(id)) {
      const { scriptSource } = await chrome.debugger.sendCommand(target, "Debugger.getScriptSource", { scriptId: id })
      scriptSourceCache.set(id, scriptSource)
    }
    const source = scriptSourceCache.get(id)
    const matches = findContexts(source, query, maxMatches - results.length)
    if (matches.length) {
      results.push({
        url: meta.url,
        scriptId: id,
        matches,
      })
    }
    if (results.length >= maxMatches) break
  }

  return { query, results }
}

async function handleSymbolicHints() {
  const target = await ensureAttached()
  const expression = `(function(){
    try {
      const resources = performance.getEntriesByType('resource').slice(-20).map(e => ({
        name: e.name,
        type: e.initiatorType || '',
        size: e.transferSize || 0
      }));
      const globals = Object.keys(window).filter(k => k.length < 30).slice(0, 60);
      const ls = Object.keys(localStorage || {}).slice(0, 20);
      return {
        location: window.location.href,
        ua: navigator.userAgent,
        resources,
        globals,
        localStorageKeys: ls
      };
    } catch (e) {
      return { error: e.message };
    }
  })()`
  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })
  return result?.value
}

async function handleEval(params = {}) {
  const target = await ensureAttached()
  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: params.code,
    returnByValue: true,
  })
  return result?.value
}

// ========== 网络请求分析 ==========

async function handleListNetworkRequests(params = {}) {
  await ensureAttached()

  const {
    filter,        // url 关键词过滤
    method,        // GET/POST/PUT 等
    status,        // success/error/failed/pending
    resourceType,  // XHR/Fetch/Script/Stylesheet/Image 等
    limit = 50,
  } = params

  let results = [...networkRequests]

  // 包含进行中的请求
  const pending = [...requestMap.values()].map(r => ({ ...r, status: "pending" }))
  results = [...pending, ...results]

  // 应用过滤
  if (filter) {
    const lowerFilter = filter.toLowerCase()
    results = results.filter(r => r.url?.toLowerCase().includes(lowerFilter))
  }
  if (method) {
    results = results.filter(r => r.method?.toUpperCase() === method.toUpperCase())
  }
  if (status) {
    results = results.filter(r => r.status === status)
  }
  if (resourceType) {
    const lowerType = resourceType.toLowerCase()
    results = results.filter(r => r.resourceType?.toLowerCase() === lowerType)
  }

  // 限制数量
  results = results.slice(0, limit)

  // 简化输出，不包含 headers 详情
  return {
    total: networkRequests.length + requestMap.size,
    filtered: results.length,
    requests: results.map(r => ({
      requestId: r.requestId,
      url: r.url,
      method: r.method,
      status: r.status,
      statusCode: r.statusCode,
      resourceType: r.resourceType,
      mimeType: r.mimeType,
      duration: r.duration,
      encodedDataLength: r.encodedDataLength,
      fromCache: r.fromCache,
      timestamp: r.timestamp,
      errorText: r.errorText,
    })),
  }
}

async function handleGetNetworkDetail(params = {}) {
  const target = await ensureAttached()
  const { requestId, includeBody = false } = params

  if (!requestId) {
    throw new Error("需要提供 requestId")
  }

  // 先从进行中的请求找
  let entry = requestMap.get(requestId)
  // 再从已完成的找
  if (!entry) {
    entry = networkRequests.find(r => r.requestId === requestId)
  }

  if (!entry) {
    throw new Error(`未找到请求: ${requestId}`)
  }

  const result = { ...entry }

  // 获取响应 body
  if (includeBody && entry.status !== "pending" && entry.status !== "failed") {
    try {
      const { body, base64Encoded } = await chrome.debugger.sendCommand(
        target,
        "Network.getResponseBody",
        { requestId }
      )

      if (base64Encoded) {
        // 二进制内容，只返回大小信息
        result.bodyInfo = {
          type: "binary",
          base64Length: body.length,
          note: "二进制内容，已 base64 编码",
        }
        // 如果小于限制，也返回 base64
        if (body.length < CONFIG.maxRequestBodySize) {
          result.bodyBase64 = body
        }
      } else {
        // 文本内容
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

async function handleClearNetworkRequests() {
  await ensureAttached()
  const count = networkRequests.length
  networkRequests = []
  return { cleared: count }
}

async function handleCommand(message) {
  const { id, command, params, token } = message
  if (!id || !command) return
  if (!state.enabled) {
    ws?.send(JSON.stringify({ id, error: "扩展已暂停，点击图标重新开启" }))
    return
  }
  if (CONFIG.token && CONFIG.token !== token) {
    ws?.send(JSON.stringify({ id, error: "token 校验失败" }))
    return
  }
  try {
    let result
    if (command === "getLastError") result = await handleGetLastError()
    else if (command === "getScriptSource") result = await handleGetScriptSource(params)
    else if (command === "coverageSnapshot") result = await handleCoverageSnapshot(params)
    else if (command === "findByString") result = await handleFindByString(params)
    else if (command === "symbolicHints") result = await handleSymbolicHints()
    else if (command === "eval") result = await handleEval(params)
    else if (command === "listNetworkRequests") result = await handleListNetworkRequests(params)
    else if (command === "getNetworkDetail") result = await handleGetNetworkDetail(params)
    else if (command === "clearNetworkRequests") result = await handleClearNetworkRequests()
    else throw new Error(`未知指令 ${command}`)

    ws?.send(JSON.stringify({ id, result }))
  } catch (e) {
    ws?.send(JSON.stringify({ id, error: e.message }))
  } finally {
    await maybeDetach()
  }
}

let currentPortIndex = 0  // 当前尝试的端口索引
let lastSuccessPort = null // 上次成功连接的端口
let wasConnected = false   // 标记是否曾经成功连接过
let scanRound = 0          // 当前扫描轮次
let connectionPhase = 'idle' // 连接阶段: idle, scanning, verifying, connected
let directPortMode = false // 是否为直接连接模式（不扫描）

/**
 * 直接连接指定端口（不扫描其他端口）
 */
function connectDirect(port) {
  directPortMode = true
  currentPortIndex = 0

  const url = new URL(`ws://localhost:${port}`)
  if (CONFIG.token) url.searchParams.set("token", CONFIG.token)

  log(`🎯 直接连接端口 ${port}...`)
  connectionPhase = 'scanning'
  ws = new WebSocket(url.toString())
  setBadgeState("connecting")

  const connectionTimeout = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }, 3000) // 直接连接给更长的超时

  let identityVerified = false
  let identityTimeout = null

  ws.onopen = () => {
    clearTimeout(connectionTimeout)
    connectionPhase = 'verifying'
    log(`🔗 WebSocket 已连接端口 ${port}，等待身份验证...`)

    identityTimeout = setTimeout(() => {
      if (!identityVerified) {
        log(`❌ 端口 ${port} 身份验证超时，回退到扫描模式...`)
        directPortMode = false
        ws.close()
        // 回退到扫描模式
        if (state.enabled) {
          scanRound = 0
          connectionPhase = 'scanning'
          setTimeout(() => connect(0, true), 100)
        } else {
          connectionPhase = 'idle'
        }
      }
    }, 3000)
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)

      if (msg.type === "identity") {
        clearTimeout(identityTimeout)

        if (msg.service === "ghost-bridge" && msg.token === CONFIG.token) {
          identityVerified = true
          wasConnected = true
          lastSuccessPort = port
          scanRound = 0
          connectionPhase = 'connected'
          directPortMode = false
          log(`✅ 已连接到 ghost-bridge 服务 (端口 ${port})`)
          setBadgeState("on")
          ensureAttached().catch((e) => log(`attach 失败：${e.message}`))
        } else {
          log(`❌ 端口 ${port} 身份验证失败，回退到扫描模式...`)
          directPortMode = false
          ws.close()
          // 回退到扫描模式
          if (state.enabled) {
            scanRound = 0
            connectionPhase = 'scanning'
            setTimeout(() => connect(0, true), 100)
          } else {
            connectionPhase = 'idle'
          }
        }
        return
      }

      if (identityVerified) {
        handleCommand(msg)
      }
    } catch (e) {
      log(`解析消息失败：${e.message}`)
    }
  }

  ws.onclose = (event) => {
    clearTimeout(connectionTimeout)
    clearTimeout(identityTimeout)

    if (directPortMode) {
      log(`❌ 无法连接到端口 ${port}，回退到扫描模式...`)
      directPortMode = false
      // 回退到扫描模式，尝试其他端口
      if (state.enabled) {
        scanRound = 0
        connectionPhase = 'scanning'
        // 立即开始扫描
        setTimeout(() => connect(0, true), 100)
      } else {
        connectionPhase = 'idle'
        setBadgeState("off")
      }
      return
    }

    if (wasConnected) {
      wasConnected = false
      log("⚠️ 连接断开，尝试重连...")
      setBadgeState("off")
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (state.enabled) {
        reconnectTimer = setTimeout(() => connectDirect(port), 2000)
      }
    }
  }

  ws.onerror = (err) => {
    clearTimeout(connectionTimeout)
    clearTimeout(identityTimeout)
  }
}

function connect(portIndex = 0, isNewRound = false) {
  if (!state.enabled) return
  
  // 如果超出范围，立即从头开始（不等待）
  if (portIndex >= CONFIG.maxPortRetries) {
    scanRound++
    log(`📡 第 ${scanRound} 轮扫描完毕，立即开始第 ${scanRound + 1} 轮...`)
    // 立即从头开始，只等待 500ms 避免太激进
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => connect(0, true), 500)
    return
  }
  
  // 新一轮扫描开始的提示
  if (portIndex === 0 && isNewRound) {
    log(`🔄 开始第 ${scanRound + 1} 轮端口扫描 (${CONFIG.basePort}-${CONFIG.basePort + CONFIG.maxPortRetries - 1})`)
  }
  
  const port = CONFIG.basePort + portIndex
  currentPortIndex = portIndex
  
  const url = new URL(`ws://localhost:${port}`)
  if (CONFIG.token) url.searchParams.set("token", CONFIG.token)
  
  // 只在第一轮或成功连接时打印详细日志，避免刷屏
  if (scanRound === 0 || portIndex === 0) {
    log(`尝试连接端口 ${port}...`)
  }
  connectionPhase = 'scanning'
  ws = new WebSocket(url.toString())
  setBadgeState("connecting")
  
  // 设置连接超时（1秒，加快扫描速度）
  const connectionTimeout = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }, 1000)
  
  // 身份验证超时（连接后 2 秒内必须收到正确的 identity 消息）
  let identityVerified = false
  let identityTimeout = null
  
  ws.onopen = () => {
    clearTimeout(connectionTimeout)
    // 不立即标记为成功，等待身份验证
    connectionPhase = 'verifying'
    log(`🔗 WebSocket 已连接端口 ${port}，等待身份验证...`)
    
    // 设置身份验证超时
    identityTimeout = setTimeout(() => {
      if (!identityVerified) {
        log(`❌ 端口 ${port} 身份验证超时，可能不是 ghost-bridge 服务`)
        connectionPhase = 'scanning'
        ws.close()
        // 超时后主动扫描下一个端口
        if (state.enabled) {
          setTimeout(() => connect(portIndex + 1), 50)
        }
      }
    }, 2000)
  }
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      
      // 处理身份验证消息
      if (msg.type === "identity") {
        clearTimeout(identityTimeout)
        
        if (msg.service === "ghost-bridge" && msg.token === CONFIG.token) {
          identityVerified = true
          wasConnected = true
          lastSuccessPort = port
          scanRound = 0
          connectionPhase = 'connected'
          log(`✅ 身份验证成功，已连接到 ghost-bridge 服务 (端口 ${port})`)
          setBadgeState("on")
          // 自动附加当前活动标签，确保能立即捕获异常/console
          ensureAttached().catch((e) => log(`attach 失败：${e.message}`))
        } else {
          log(`❌ 端口 ${port} 身份验证失败 (service: ${msg.service}, token 匹配: ${msg.token === CONFIG.token})`)
          connectionPhase = 'scanning'
          ws.close()
          // 立即尝试下一个端口
          if (state.enabled) {
            setTimeout(() => connect(portIndex + 1), 50)
          }
        }
        return
      }
      
      // 只有验证通过后才处理其他命令
      if (identityVerified) {
        handleCommand(msg)
      }
    } catch (e) {
      log(`解析消息失败：${e.message}`)
    }
  }
  ws.onclose = (event) => {
    clearTimeout(connectionTimeout)
    clearTimeout(identityTimeout)
    
    // 如果是连接阶段就失败了（还没成功连接过），立即尝试下一个端口
    if (!wasConnected && event.code === 1006) {
      if (state.enabled) {
        // 立即尝试下一个端口，不等待
        setTimeout(() => connect(portIndex + 1), 50)
      }
      return
    }
    
    // 身份验证失败导致的关闭，不重置 wasConnected（让上面的逻辑处理下一个端口）
    if (!identityVerified && wasConnected === false) {
      return
    }
    
    // 曾经连接成功后断开
    wasConnected = false
    scanRound = 0
    connectionPhase = 'scanning'
    log("⚠️ WebSocket 断开，立即重试...")
    setBadgeState("off")
    if (reconnectTimer) clearTimeout(reconnectTimer)
    
    if (state.enabled) {
      // 如果有上次成功的端口，优先尝试那个端口
      const startIndex = lastSuccessPort 
        ? lastSuccessPort - CONFIG.basePort 
        : 0
      // 断开后立即重试，不等待
      reconnectTimer = setTimeout(() => connect(startIndex), 100)
    } else {
      connectionPhase = 'idle'
    }
  }
  ws.onerror = (err) => {
    clearTimeout(connectionTimeout)
    clearTimeout(identityTimeout)
    // 错误不打印，避免刷屏，让 onclose 处理
  }
}

// 移除 action.onClicked（有 popup 时不会触发）

// 消息监听器：供 popup 获取状态和控制
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getStatus') {
    // 返回当前状态，使用 connectionPhase 提供更准确的状态
    let status
    if (!state.enabled) {
      status = 'disconnected'
    } else if (connectionPhase === 'connected' && ws && ws.readyState === WebSocket.OPEN) {
      status = 'connected'
    } else if (connectionPhase === 'verifying') {
      status = 'verifying'
    } else if (connectionPhase === 'scanning' || connectionPhase === 'idle') {
      // 如果扫描多轮仍未找到，显示 not_found
      status = scanRound >= 2 ? 'not_found' : 'scanning'
    } else {
      status = 'disconnected'
    }
    
    // 计算当前正在扫描的端口
    const currentPort = CONFIG.basePort + currentPortIndex
    
    sendResponse({
      status,
      enabled: state.enabled,
      port: lastSuccessPort,
      currentPort,
      basePort: CONFIG.basePort,
      scanRound,
    })
    return true
  }
  
  if (message.type === 'connect') {
    // 先关闭现有连接
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close()
    }

    // 如果指定了端口，直接连接该端口（不扫描）
    if (message.port) {
      CONFIG.basePort = message.port
      chrome.storage.local.set({ basePort: message.port })
      state.enabled = true
      scanRound = 0
      connectionPhase = 'scanning'
      // 直接连接指定端口，maxPortRetries 设为 1 表示只尝试这一个端口
      connectDirect(message.port)
    } else {
      // 没有指定端口，从 basePort 开始扫描
      state.enabled = true
      scanRound = 0
      connectionPhase = 'scanning'
      connect(0, true)
    }

    sendResponse({ ok: true })
    return true
  }
  
  if (message.type === 'disconnect') {
    state.enabled = false
    scanRound = 0
    connectionPhase = 'idle'
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
    detachAllTargets().catch(() => {})
    setBadgeState('off')
    sendResponse({ ok: true })
    return true
  }
  
  return false
})

// 启动时从 storage 加载端口配置
chrome.storage.local.get(['basePort'], (result) => {
  if (result.basePort) {
    CONFIG.basePort = result.basePort
  }
})

// 默认暂停：设置徽章为 OFF
setBadgeState("off")

// 不自动连接，等待用户在 popup 中点击"启用连接"
// connect()
