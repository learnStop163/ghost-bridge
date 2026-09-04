import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadExtensionScript } from './helpers/load-extension-script.js'

const controlPath = fileURLToPath(new URL('../extension/bg-control.js', import.meta.url))
const { GhostBridgeControl } = loadExtensionScript(controlPath, { setTimeout })

test('pollUntil succeeds without a model-visible polling round trip', async () => {
  let clock = 0
  let probes = 0
  const result = await GhostBridgeControl.pollUntil({
    probe: async () => ({ satisfied: ++probes === 3 }),
    timeoutMs: 1000,
    overallDeadline: 2000,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  assert.equal(result.satisfied, true)
  assert.equal(result.attempts, 3)
  assert.equal(result.elapsedMs, 400)
})

test('pollUntil distinguishes condition timeout from overall batch timeout', async () => {
  let clock = 0
  const condition = await GhostBridgeControl.pollUntil({
    probe: async () => ({ satisfied: false }),
    timeoutMs: 500,
    overallDeadline: 2000,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  assert.equal(condition.reason, 'conditionTimeout')

  clock = 0
  const batch = await GhostBridgeControl.pollUntil({
    probe: async () => ({ satisfied: false }),
    timeoutMs: 2000,
    overallDeadline: 300,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  assert.equal(batch.reason, 'batchTimeout')
})

test('runActionBatch stops remaining actions after failure', async () => {
  const executed = []
  const result = await GhostBridgeControl.runActionBatch([1, 2, 3], async (item) => {
    executed.push(item)
    if (item === 2) throw new Error('failed')
    return { success: true, item }
  })
  assert.deepEqual(executed, [1, 2])
  assert.equal(result.stopped, true)
  assert.equal(result.results[1].success, false)
})

test('runActionBatch always stops at the overall deadline even when stopOnError is false', async () => {
  const executed = []
  const timeout = new Error('deadline')
  timeout.batchTimeout = true
  const result = await GhostBridgeControl.runActionBatch([1, 2, 3], async (item) => {
    executed.push(item)
    if (item === 2) throw timeout
    return { success: true, item }
  }, { stopOnError: false })
  assert.deepEqual(executed, [1, 2])
  assert.equal(result.stopped, true)
})
