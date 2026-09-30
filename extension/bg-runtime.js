(function initGhostBridgeRuntime(global) {
  async function evaluateScript({ sendCommand, target, code, awaitPromise = true, timeoutMs, withTimeout, label = 'eval_script' }) {
    const command = sendCommand(target, 'Runtime.evaluate', {
      expression: code,
      returnByValue: true,
      awaitPromise,
      timeout: timeoutMs,
    })
    const { result, exceptionDetails } = await withTimeout(command, timeoutMs + 1000, label)
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || '脚本执行失败')
    }
    return result?.value
  }

  async function mergeFrames({ value, maxLength, frames, read }) {
    // offset/hasMore describe the original document stream, not appended supplements.
    if (value.offset > 0) {
      value.crossOriginNote = '跨域正文补充仅在 offset=0 返回，不参与主文档分页'
      return
    }
    let merged = 0
    for (let index = 0; index < frames.length; index++) {
      const header = `\n\n[跨域 iframe ${index + 1}]\n`
      const budget = maxLength - (value.content || '').length - header.length
      if (budget < 1) {
        value.crossOriginBudgetSkipped = frames.length - index
        break
      }
      try {
        const child = await read(frames[index][0], budget)
        if (child?.text) {
          const text = child.text.slice(0, budget)
          value.content = (value.content || '') + header + text
          merged++
          if (child.truncated || child.text.length > budget) value.crossOriginTruncated = true
        }
      } catch (_) {
        value.crossOriginFailed = (value.crossOriginFailed || 0) + 1
      }
    }
    if (merged) {
      value.crossOriginMerged = merged
      value.crossOriginSkipped = Math.max(0, value.crossOriginSkipped - merged)
      value.includesIframes = true
      value.crossOriginNote = '跨域正文为补充；offset/contentLength/hasMore 仅描述主文档及同源内容'
    }
  }

  // Profiler 域与普通功能无关，某些 chrome.debugger 后端可能返回 -32601。
  // 因此 attach 时不再启用，仅在采集覆盖率时
  // 按需启用；启用失败只让 coverage_snapshot 不可用，不拖垮整个调试会话。
  async function collectCoverage({ sendCommand, target, durationMs = 1500, sleep }) {
    const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    try {
      await sendCommand(target, 'Profiler.enable')
    } catch (e) {
      const message = String(e?.message || e)
      if (/-32601|method.*not found|wasn't found/i.test(message)) {
        throw new Error(`当前调试后端不支持 Profiler.enable（${message}），coverage_snapshot 不可用`, { cause: e })
      }
      throw new Error(`启用覆盖率采集失败：${message}`, { cause: e })
    }
    await sendCommand(target, 'Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true,
    })
    try {
      await wait(durationMs)
      const { result } = await sendCommand(target, 'Profiler.takePreciseCoverage')
      return {
        topScripts: result
          .map((item) => {
            const totalCount = item.functions.reduce((sum, f) => sum + (f.callCount || 0), 0)
            return { url: item.url || '(inline)', scriptId: item.scriptId, totalCount }
          })
          .sort((a, b) => b.totalCount - a.totalCount)
          .slice(0, 20),
        rawCount: result.length,
      }
    } finally {
      // 无论读取成败都要停掉精确覆盖率采集，避免采样在后台一直跑
      await sendCommand(target, 'Profiler.stopPreciseCoverage').catch(() => {})
    }
  }

  global.GhostBridgeRuntime = { evaluateScript, mergeFrames, collectCoverage }
})(self)
