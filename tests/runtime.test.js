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
