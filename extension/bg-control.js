(function initGhostBridgeControl(global) {
  async function pollUntil({
    probe,
    timeoutMs,
    overallDeadline = Infinity,
    intervalMs = 200,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    const startedAt = now()
    const conditionDeadline = startedAt + timeoutMs
    let attempts = 0
    let detail

    while (now() < conditionDeadline && now() < overallDeadline) {
      attempts++
      detail = await probe()
      if (detail?.satisfied) {
        return { satisfied: true, elapsedMs: now() - startedAt, attempts, detail }
      }
      const remaining = Math.min(conditionDeadline, overallDeadline) - now()
      if (remaining > 0) await sleep(Math.min(intervalMs, remaining))
    }

    return {
      satisfied: false,
      reason: now() >= overallDeadline ? 'batchTimeout' : 'conditionTimeout',
      elapsedMs: now() - startedAt,
      attempts,
      detail,
    }
  }

  async function runActionBatch(actions, execute, {
    stopOnError = true,
    isTerminalError = (error) => Boolean(error?.batchTimeout),
    mapError = (error, index) => ({ index, success: false, error: error.message }),
  } = {}) {
    const results = []
    for (let index = 0; index < actions.length; index++) {
      try {
        results.push(await execute(actions[index], index))
      } catch (error) {
        results.push(mapError(error, index))
        if (stopOnError || isTerminalError(error)) break
      }
    }
    return { results, stopped: results.length < actions.length }
  }

  global.GhostBridgeControl = { pollUntil, runActionBatch }
})(self)
