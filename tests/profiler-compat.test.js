import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// Run the actual service worker and imported helpers against a CDP backend
// without Profiler; this catches accidental mandatory initialization calls.
function loadBackground(failingMethod = 'Profiler.enable') {
  const calls = []
  const replies = []
  const event = { addListener() {} }
  const chrome = {
    debugger: {
      onEvent: event, onDetach: event,
      async attach() { calls.push('attach') },
      async detach() { calls.push('detach') },
      async sendCommand(_target, method) {
        calls.push(method)
        if (method === failingMethod) throw new Error('Method not found. -32601')
        if (method === 'Page.captureScreenshot') return { data: 'image' }
        if (method === 'Runtime.evaluate') return { result: { value: { width: 800, height: 600 } } }
        return {}
      },
    },
    tabs: {
      onUpdated: event, onActivated: event, onRemoved: event,
      async get(id) { return { id, url: 'https://example.com', title: 'Example' } },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    runtime: {
      onMessage: event, onStartup: event, onInstalled: event,
      async sendMessage(message) { replies.push(message.data) },
    },
    storage: { local: { async get() { return {} } } },
    alarms: { create() {}, onAlarm: event },
    idle: { onStateChanged: event },
  }
  const context = vm.createContext({ chrome, setTimeout, clearTimeout, performance, console: { log() {} } })
  context.self = context
  const runFile = name => vm.runInContext(
    fs.readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8'), context, { filename: name }
  )
  context.importScripts = (...names) => names.forEach(runFile)
  runFile('background.js')
  vm.runInContext('state.enabled = true', context)
  return { context, calls, replies }
}

test('missing Profiler does not block screenshots or detach the session after coverage fails', async () => {
  const { context, calls, replies } = loadBackground()
  const command = (id, name) => context.handleCommand({ id, command: name, token: 'ghost-bridge-local', params: { tabId: 1 } })
  await command('before', 'captureScreenshot')
  assert.equal(replies[0].result.imageData, 'image')
  assert.equal(calls.includes('Profiler.enable'), false)

  await command('coverage', 'coverageSnapshot')
  assert.match(replies[1].error, /不支持 Profiler.enable/)
  await command('after', 'captureScreenshot')
  assert.equal(replies[2].result.imageData, 'image')
  assert.equal(calls.filter(method => method === 'attach').length, 1)
  assert.equal(calls.includes('detach'), false)
  assert.equal(calls.includes('Profiler.startPreciseCoverage'), false)
})

test('required initialization failures still detach the incomplete session', async () => {
  const { context, calls, replies } = loadBackground('Runtime.enable')
  await context.handleCommand({ id: 'screenshot', command: 'captureScreenshot', token: 'ghost-bridge-local', params: { tabId: 1 } })
  assert.match(replies[0].error, /Method not found/)
  assert.equal(calls.includes('detach'), true)
  assert.equal(calls.includes('Page.captureScreenshot'), false)
})
