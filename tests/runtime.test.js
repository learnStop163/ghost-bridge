import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadExtensionScript } from './helpers/load-extension-script.js'

const runtimePath = fileURLToPath(new URL('../extension/bg-runtime.js', import.meta.url))
const { GhostBridgeRuntime } = loadExtensionScript(runtimePath)
const passthroughTimeout = (promise) => promise

test('evaluateScript awaits completion and sends a CDP-enforced timeout', async () => {
  let command
  const value = await GhostBridgeRuntime.evaluateScript({
    sendCommand: async (_target, method, params) => {
      command = { method, params }
      await Promise.resolve()
      return { result: { value: 42 } }
    },
    target: { tabId: 1 },
    code: 'Promise.resolve(42)',
    timeoutMs: 750,
    withTimeout: passthroughTimeout,
  })
  assert.equal(value, 42)
  assert.equal(command.method, 'Runtime.evaluate')
  assert.equal(command.params.awaitPromise, true)
  assert.equal(command.params.timeout, 750)
})

test('evaluateScript surfaces page exceptions', async () => {
  await assert.rejects(
    GhostBridgeRuntime.evaluateScript({
      sendCommand: async () => ({ exceptionDetails: { text: 'boom' } }),
      target: { tabId: 1 },
      code: 'throw new Error()',
      timeoutMs: 500,
      withTimeout: passthroughTimeout,
    }),
    /boom/
  )
})

test('evaluateScript propagates CDP termination on timeout', async () => {
  await assert.rejects(
    GhostBridgeRuntime.evaluateScript({
      sendCommand: async (_target, _method, params) => {
        assert.equal(params.timeout, 100)
        throw new Error('Execution was terminated')
      },
      target: { tabId: 1 },
      code: 'while(true){}',
      timeoutMs: 100,
      withTimeout: passthroughTimeout,
    }),
    /terminated/
  )
})

test('frame merge skips reads when no room remains and counts only retained bodies', async () => {
  let reads = 0
  const value = { content: '12345', crossOriginSkipped: 2, offset: 0 }
  await GhostBridgeRuntime.mergeFrames({ value, maxLength: 5, frames: [['a'], ['b']], read: async () => { reads++; return { text: 'body' } } })
  assert.equal(reads, 0)
  assert.equal(value.crossOriginMerged, undefined)
  assert.equal(value.crossOriginBudgetSkipped, 2)
})

test('frame merge budgets separators and preserves success before a failed frame', async () => {
  const value = { content: 'main', crossOriginSkipped: 2, offset: 0, contentLength: 4, hasMore: false }
  await GhostBridgeRuntime.mergeFrames({ value, maxLength: 100, frames: [['a'], ['b']], read: async id => {
    if (id === 'b') throw new Error('gone')
    return { text: 'body' }
  } })
  assert.match(value.content, /body/)
  assert.equal(value.crossOriginMerged, 1)
  assert.equal(value.crossOriginFailed, 1)
  assert.equal(value.contentLength, 4)
  assert.equal(value.hasMore, false)
})

test('frame body never exceeds remaining budget and offset pages do not repeat it', async () => {
  const value = { content: '', offset: 0, crossOriginSkipped: 1 }
  await GhostBridgeRuntime.mergeFrames({ value, maxLength: 25, frames: [['a']], read: async budgetId => ({ text: 'x'.repeat(100) }) })
  assert.equal(value.content.length, 25)
  assert.equal(value.crossOriginMerged, 1)
  assert.equal(value.crossOriginTruncated, true)
  await GhostBridgeRuntime.mergeFrames({ value: { offset: 10, crossOriginSkipped: 1 }, maxLength: 100, frames: [['a']], read: () => { throw new Error('must not read') } })
})

test('collectCoverage enables Profiler on demand and simplifies results', async () => {
  const calls = []
  const sendCommand = async (_target, method) => {
    calls.push(method)
    if (method === 'Profiler.takePreciseCoverage') {
      return {
        result: [
          { url: '', scriptId: '1', functions: [{ callCount: 2 }, { callCount: 0 }] },
          { url: 'https://a.test/b.js', scriptId: '2', functions: [{ callCount: 9 }] },
        ],
      }
    }
    return {}
  }
  const slept = []
  const out = await GhostBridgeRuntime.collectCoverage({
    sendCommand,
    target: { tabId: 1 },
    durationMs: 5,
    sleep: async (ms) => { slept.push(ms) },
  })
  assert.deepEqual(calls, [
    'Profiler.enable',
    'Profiler.startPreciseCoverage',
    'Profiler.takePreciseCoverage',
    'Profiler.stopPreciseCoverage',
  ])
  assert.deepEqual(slept, [5])
  assert.equal(out.rawCount, 2)
  // 展开到宿主 realm 再比较：vm 上下文对象的原型与 assert/strict 的原型检查不相等
  assert.deepEqual(out.topScripts.map((s) => ({ ...s })), [
    { url: 'https://a.test/b.js', scriptId: '2', totalCount: 9 },
    { url: '(inline)', scriptId: '1', totalCount: 2 },
  ])
})

test('collectCoverage fails softly when the browser has no Profiler domain', async () => {
  const attempted = []
  const sendCommand = async (_target, method) => {
    attempted.push(method)
    if (method === 'Profiler.enable') throw new Error('Method not found. -32601')
    return {}
  }
  await assert.rejects(
    GhostBridgeRuntime.collectCoverage({ sendCommand, target: { tabId: 1 } }),
    /不支持 Profiler.enable/
  )
  // 只探测 enable，不再发起采集命令，也不影响会话其余功能
  assert.deepEqual(attempted, ['Profiler.enable'])
})

test('collectCoverage preserves non-capability errors without claiming Profiler is unsupported', async () => {
  const cause = new Error('Debugger is not attached')
  await assert.rejects(
    GhostBridgeRuntime.collectCoverage({
      sendCommand: async () => { throw cause },
      target: { tabId: 1 },
    }),
    error => {
      assert.match(error.message, /启用覆盖率采集失败.*Debugger is not attached/)
      assert.doesNotMatch(error.message, /不支持/)
      assert.equal(error.cause, cause)
      return true
    }
  )
})

test('collectCoverage always stops precise coverage when reading fails', async () => {
  const calls = []
  const sendCommand = async (_target, method) => {
    calls.push(method)
    if (method === 'Profiler.takePreciseCoverage') throw new Error('boom')
    return {}
  }
  await assert.rejects(
    GhostBridgeRuntime.collectCoverage({
      sendCommand,
      target: { tabId: 1 },
      durationMs: 0,
      sleep: async () => {},
    }),
    /boom/
  )
  assert.deepEqual(calls.slice(-1), ['Profiler.stopPreciseCoverage'])
})
