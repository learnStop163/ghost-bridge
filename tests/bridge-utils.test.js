import test from 'node:test'
import assert from 'node:assert/strict'
import { boundedOut, calculateDispatchBudget } from '../src/bridge-utils.js'

test('boundedOut caps the final escaped JSON string', () => {
  const result = boundedOut({ value: ('"\\\n'.repeat(2000)) }, 1000)
  assert.ok(result.length <= 1000)
  const parsed = JSON.parse(result)
  assert.equal(parsed.truncated, true)
  assert.ok(parsed.originalLength > 1000)
})

test('dispatch budget keeps the server timeout beyond extension execution', () => {
  const budget = calculateDispatchBudget({
    actions: [
      { action: 'click', selector: '#go', waitFor: { type: 'element', timeoutMs: 5000 } },
      { action: 'fill', selector: '#name', waitMs: 300 },
    ],
    snapshotAfter: true,
  })
  assert.ok(budget.executionTimeoutMs >= budget.estimatedExecutionMs)
  assert.equal(budget.serverTimeoutMs, budget.executionTimeoutMs + 5000)
})

test('dispatch budget rejects an unbounded worst-case batch', () => {
  assert.throws(
    () => calculateDispatchBudget({
      actions: Array.from({ length: 7 }, () => ({
        action: 'click',
        selector: 'button',
        waitFor: { type: 'element', timeoutMs: 10000 },
      })),
    }),
    /超过 60000ms/
  )
})

test('explicit overall timeout safely bounds a larger theoretical batch', () => {
  const budget = calculateDispatchBudget({
    timeoutMs: 15000,
    actions: Array.from({ length: 7 }, () => ({
      action: 'click',
      selector: 'button',
      waitFor: { type: 'element', timeoutMs: 10000 },
    })),
  })
  assert.equal(budget.executionTimeoutMs, 15000)
  assert.equal(budget.serverTimeoutMs, 20000)
})

test('compact inspect output shares a budget and retains complete element entries', async () => {
  const { compactInspectOutput } = await import('../src/bridge-utils.js')
  const value = { summary: { title: '标题'.repeat(1000), frames: [{ index: 0, readable: true }] }, interactive: { elements: Array.from({ length: 20 }, (_, i) => ({ ref: `e${i}`, text: 'x'.repeat(1000) })) } }
  const text = compactInspectOutput(value)
  assert.ok(text.length <= 8000)
  const parsed = JSON.parse(text)
  assert.ok(parsed.elementsOmitted > 0)
  assert.equal(parsed.summary.frames[0].readable, true)
  assert.equal(parsed.interactive.elements[0].ref, 'e0')
  assert.equal(value.interactive.elements.length, 20)
})

test('combined inspect keeps short text and iframe state within the shared budget', async () => {
  const { compactInspectOutput } = await import('../src/bridge-utils.js')
  const text = { content: '正文'.repeat(750), crossOriginBudgetSkipped: 1 }
  const result = compactInspectOutput({ summary: { frames: [{ readable: 'via-bridge' }] }, text,
    interactive: { elements: Array.from({ length: 20 }, (_, i) => ({ ref: `e${i}`, text: 'a'.repeat(900) })) } })
  assert.ok(result.length <= 8000)
  assert.deepEqual(JSON.parse(result).text, text)
})
