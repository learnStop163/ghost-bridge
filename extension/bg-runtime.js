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

  global.GhostBridgeRuntime = { evaluateScript }
})(self)
