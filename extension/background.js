// 使用当月1号0点的时间戳作为 token，确保同月内的服务器和插件自动匹配
function getMonthlyToken() {
  const now = new Date()
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  return String(firstDayOfMonth.getTime())
}

const CONFIG = {
  basePort: 33333,
  maxPortRetries: 10,
  token: getMonthlyToken(),
  autoDetach: false,
  maxErrors: 40,
  maxStackFrames: 5,
  maxRequestsTracked: 200,
  maxRequestBodySize: 100000,
}

let attachedTabId = null
let scriptMap = new Map()
let scriptSourceCache = new Map()
let lastErrors = []
let lastErrorLocation = null
let requestMap = new Map()
let networkRequests = []
let state = { enabled: false, connected: false, port: null, currentPort: null, scanRound: 0 }

// 待处理的请求（等待 offscreen 响应）
const pendingRequests = new Map()

function setBadgeState(status) {
  const map = {
    connecting: { text: "…", color: "#999" },
    on: { text: "ON", color: "#34c759" },
    off: { text: "OFF", color: "#999" },
    err: { text: "ERR", color: "#ff3b30" },
    att: { text: "ATT", color: "#ff9f0a" },
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

// ========== Chrome Debugger 事件处理 ==========

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

  // 网络事件处理
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

// ========== Debugger 操作 ==========

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
}

// ========== 命令处理 ==========

async function handleGetLastError() {
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
    matches.push({ start, end, context: source.slice(start, end) })
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
      results.push({ url: meta.url, scriptId: id, matches })
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
  const target = await ensureAttached()
  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: params.code,
    returnByValue: true,
  })
  return result?.value
}

async function handleListNetworkRequests(params = {}) {
  await ensureAttached()
  const { filter, method, status, resourceType, limit = 50 } = params

  let results = [...networkRequests]
  const pending = [...requestMap.values()].map(r => ({ ...r, status: "pending" }))
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

  results = results.slice(0, limit)

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
  if (!requestId) throw new Error("需要提供 requestId")

  let entry = requestMap.get(requestId)
  if (!entry) entry = networkRequests.find(r => r.requestId === requestId)
  if (!entry) throw new Error(`未找到请求: ${requestId}`)

  const result = { ...entry }

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

async function handleClearNetworkRequests() {
  await ensureAttached()
  const count = networkRequests.length
  networkRequests = []
  return { cleared: count }
}

async function handleCaptureScreenshot(params = {}) {
  const target = await ensureAttached()
  const { format = 'png', quality, fullPage = false, clip } = params

  await chrome.debugger.sendCommand(target, 'Page.enable')

  let captureParams = {
    format,
    ...(quality !== undefined && format === 'jpeg' ? { quality } : {}),
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
          imageData: data, format, fullPage: true, width: maxWidth, height: maxHeight,
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

  return { imageData: data, format, fullPage: false, width: sizeResult?.value?.width, height: sizeResult?.value?.height }
}

async function handleGetPageContent(params = {}) {
  const target = await ensureAttached()
  const { mode = "text", selector, maxLength = 50000, includeMetadata = true } = params

  const selectorStr = selector ? JSON.stringify(selector) : 'null'
  const modeStr = JSON.stringify(mode)

  const expression = `(function() {
    try {
      const result = {};
      if (document.readyState === 'loading') {
        return { error: '页面尚未加载完成，请稍后重试', readyState: document.readyState };
      }
      let targetElement = document.body;
      const selector = ${selectorStr};
      if (selector) {
        try {
          targetElement = document.querySelector(selector);
          if (!targetElement) {
            return { error: '选择器未匹配到任何元素', selector: selector, suggestion: '请检查选择器是否正确' };
          }
          result.selector = selector;
          result.matchedTag = targetElement.tagName.toLowerCase();
        } catch (e) {
          return { error: '无效的 CSS 选择器: ' + e.message, selector: selector };
        }
      }
      const includeMetadata = ${includeMetadata};
      if (includeMetadata) {
        result.metadata = {
          title: document.title || '',
          url: window.location.href,
          description: document.querySelector('meta[name="description"]')?.content || '',
          keywords: document.querySelector('meta[name="keywords"]')?.content || '',
          charset: document.characterSet,
          language: document.documentElement.lang || '',
        };
      }
      const mode = ${modeStr};
      const maxLength = ${maxLength};
      if (mode === 'text') {
        let text = targetElement.innerText || targetElement.textContent || '';
        text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
        result.contentLength = text.length;
        if (text.length > maxLength) {
          result.content = text.slice(0, maxLength);
          result.truncated = true;
        } else {
          result.content = text;
          result.truncated = false;
        }
      } else if (mode === 'html') {
        let html = targetElement.outerHTML || '';
        result.contentLength = html.length;
        if (html.length > maxLength) {
          result.content = html.slice(0, maxLength);
          result.truncated = true;
          result.note = 'HTML 已截断，可能不完整';
        } else {
          result.content = html;
          result.truncated = false;
        }
      } else if (mode === 'structured') {
        const structured = {};
        const headings = targetElement.querySelectorAll('h1,h2,h3,h4,h5,h6');
        structured.headings = Array.from(headings).slice(0, 50).map(h => ({ level: parseInt(h.tagName[1]), text: h.innerText.trim().slice(0, 200) }));
        const links = targetElement.querySelectorAll('a[href]');
        structured.links = Array.from(links).slice(0, 100).map(a => ({ text: (a.innerText || '').trim().slice(0, 100), href: a.href })).filter(l => l.href && !l.href.startsWith('javascript:'));
        const buttons = targetElement.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]');
        structured.buttons = Array.from(buttons).slice(0, 50).map(b => ({ text: (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 100), type: b.type || 'button', disabled: b.disabled || false }));
        const forms = targetElement.querySelectorAll('form');
        structured.forms = Array.from(forms).slice(0, 20).map(f => {
          const fields = Array.from(f.querySelectorAll('input, select, textarea')).slice(0, 30);
          return { action: f.action || '', method: (f.method || 'GET').toUpperCase(), fieldCount: fields.length, fields: fields.map(field => ({ tag: field.tagName.toLowerCase(), type: field.type || '', name: field.name || '', placeholder: field.placeholder || '', required: field.required || false })) };
        });
        const images = targetElement.querySelectorAll('img');
        structured.images = Array.from(images).slice(0, 50).map(img => ({ alt: img.alt || '', src: img.src ? img.src.slice(0, 200) : '' })).filter(img => img.src);
        const tables = targetElement.querySelectorAll('table');
        structured.tables = Array.from(tables).slice(0, 10).map(table => {
          const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim().slice(0, 50));
          const rows = table.querySelectorAll('tr');
          return { headers: headers.slice(0, 20), rowCount: rows.length };
        });
        result.structured = structured;
        result.counts = { headings: structured.headings.length, links: structured.links.length, buttons: structured.buttons.length, forms: structured.forms.length, images: structured.images.length, tables: structured.tables.length };
      }
      result.mode = mode;
      return result;
    } catch (e) {
      return { error: e.message };
    }
  })()`

  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })

  if (result?.value?.error) throw new Error(result.value.error)
  return result?.value
}

// 处理来自服务器的命令
async function handleCommand(message) {
  const { id, command, params, token } = message
  if (!id || !command) return
  if (!state.enabled) {
    sendToServer({ id, error: "扩展已暂停，点击图标重新开启" })
    return
  }
  if (CONFIG.token && CONFIG.token !== token) {
    sendToServer({ id, error: "token 校验失败" })
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
    else if (command === "captureScreenshot") result = await handleCaptureScreenshot(params)
    else if (command === "getPageContent") result = await handleGetPageContent(params)
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

// 主动推送状态给 popup
function broadcastStatus() {
  let status
  if (!state.enabled) {
    status = 'disconnected'
  } else if (state.connected) {
    status = 'connected'
  } else if (state.scanRound >= 2) {
    status = 'not_found'
  } else {
    status = 'scanning'
  }
  chrome.runtime.sendMessage({
    type: 'statusUpdate',
    state: {
      status,
      enabled: state.enabled,
      port: state.port,
      currentPort: state.currentPort,
      basePort: CONFIG.basePort,
      scanRound: state.scanRound,
    }
  }).catch(() => {}) // popup 可能未打开，忽略错误
}

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
      setBadgeState('on')
      log(`✅ 已连接到 ghost-bridge 服务 (端口 ${message.port})`)
      ensureAttached().catch((e) => log(`attach 失败：${e.message}`))
    } else if (message.status === 'disconnected') {
      state.connected = false
      state.port = null
      if (state.enabled) setBadgeState('connecting')
    } else if (message.status === 'scanning') {
      state.currentPort = message.currentPort
      setBadgeState('connecting')
    } else if (message.status === 'not_found') {
      state.scanRound++
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
    let status
    if (!state.enabled) {
      status = 'disconnected'
    } else if (state.connected) {
      status = 'connected'
    } else if (state.scanRound >= 2) {
      status = 'not_found'
    } else {
      status = 'scanning'
    }
    sendResponse({
      status,
      enabled: state.enabled,
      port: state.port,
      currentPort: state.currentPort,
      basePort: CONFIG.basePort,
      scanRound: state.scanRound,
    })
    return true
  }

  // 来自 popup 的连接请求
  if (message.type === 'connect') {
    if (message.port) {
      CONFIG.basePort = message.port
      chrome.storage.local.set({ basePort: message.port })
    }
    state.enabled = true
    state.scanRound = 0
    setBadgeState('connecting')

    // 启动 offscreen 并开始连接
    setupOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        type: 'connect',
        basePort: CONFIG.basePort,
        token: CONFIG.token,
        maxPortRetries: CONFIG.maxPortRetries,
      }).catch(() => {})
    })

    sendResponse({ ok: true })
    return true
  }

  // 来自 popup 的断开请求
  if (message.type === 'disconnect') {
    state.enabled = false
    state.connected = false
    state.scanRound = 0
    setBadgeState('off')
    detachAllTargets().catch(() => {})

    // 通知 offscreen 断开
    chrome.runtime.sendMessage({ type: 'disconnect' }).catch(() => {})

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

// 默认暂停
setBadgeState("off")
log("Ghost Bridge background 已加载")
