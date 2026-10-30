import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadExtensionScript } from './helpers/load-extension-script.js'

const backgroundPath = fileURLToPath(new URL('../extension/background.js', import.meta.url))

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function createChrome(storageGet, runtimeSendMessage = async () => null) {
  const listeners = {
    message: [],
    startup: [],
    installed: [],
    alarm: [],
    idle: [],
    tabsUpdated: [],
    tabsActivated: [],
    tabsRemoved: [],
    debuggerEvent: [],
    debuggerDetach: [],
  }
  const sentMessages = []
  const storageWrites = []
  let offscreenCreates = 0
  let offscreenCloses = 0

  const event = (name) => ({
    addListener(listener) {
      listeners[name].push(listener)
    },
  })

  const chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://ghost/${path}`,
      getContexts: async () => [],
      sendMessage: async (message) => {
        sentMessages.push(message)
        return runtimeSendMessage(message)
      },
      onMessage: event('message'),
      onStartup: event('startup'),
      onInstalled: event('installed'),
    },
    storage: {
      local: {
        get: storageGet,
        set: async (value) => { storageWrites.push(value) },
      },
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
    },
    offscreen: {
      createDocument: async () => { offscreenCreates++ },
      closeDocument: async () => { offscreenCloses++ },
    },
    alarms: {
      create() {},
      onAlarm: event('alarm'),
    },
    idle: {
      onStateChanged: event('idle'),
    },
    tabs: {
      query: async () => [],
      get: async () => { throw new Error('tab not found') },
      onUpdated: event('tabsUpdated'),
      onActivated: event('tabsActivated'),
      onRemoved: event('tabsRemoved'),
    },
    debugger: {
      getTargets: async () => [],
      detach: async () => {},
      onEvent: event('debuggerEvent'),
      onDetach: event('debuggerDetach'),
    },
  }

  const context = loadExtensionScript(backgroundPath, {
    chrome,
    importScripts() {},
    console,
    performance,
    setTimeout,
    clearTimeout,
  })

  return {
    context,
    chrome,
    listeners,
    sentMessages,
    storageWrites,
    get offscreenCreates() { return offscreenCreates },
    get offscreenCloses() { return offscreenCloses },
  }
}

test('Stop invalidates an in-flight restore and prevents the extension from reopening', async () => {
  const read = deferred()
  const env = createChrome(async () => read.promise)

  // background.js starts restoreBridgeConnection() immediately. Let it observe
  // the old value only after Stop has already advanced the lifecycle epoch.
  await Promise.resolve()

  const response = deferred()
  const [messageListener] = env.listeners.message
  messageListener(
    { type: 'disconnect' },
    { url: 'chrome-extension://ghost/popup.html' },
    response.resolve,
  )
  await response.promise

  read.resolve({ basePort: 33333, bridgeEnabled: true })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(env.offscreenCreates, 0)
  assert.equal(env.sentMessages.some((message) => message.type === 'connect'), false)
  assert.equal(env.storageWrites.at(-1)?.bridgeEnabled, false)
})

test('Stop intent blocks a later restore that reads stale enabled storage', async () => {
  const env = createChrome(async () => ({ basePort: 33333, bridgeEnabled: true }))
  const [messageListener] = env.listeners.message
  const response = deferred()

  messageListener(
    { type: 'disconnect' },
    { url: 'chrome-extension://ghost/popup.html' },
    response.resolve,
  )
  await response.promise

  // Simulate a startup/install restore racing after Stop. Its storage read may
  // still return an old true value, but that must not override the user intent.
  env.listeners.startup[0]()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(env.offscreenCreates, 0)
  assert.equal(env.sentMessages.some((message) => message.type === 'connect'), false)
})

test('Stop invalidates a keepalive fallback that is waiting for offscreen status', async () => {
  const health = deferred()
  const env = createChrome(
    async () => ({ basePort: 33333, bridgeEnabled: false }),
    async (message) => message.type === 'getOffscreenStatus' ? health.promise : null,
  )
  await Promise.resolve()

  const [messageListener] = env.listeners.message
  const connectResponse = deferred()
  messageListener(
    { type: 'connect' },
    { url: 'chrome-extension://ghost/popup.html' },
    connectResponse.resolve,
  )
  await connectResponse.promise

  const keepalive = env.listeners.alarm[0]({ name: 'ghost-bridge-keepalive' })
  await Promise.resolve()

  const stopResponse = deferred()
  messageListener(
    { type: 'disconnect' },
    { url: 'chrome-extension://ghost/popup.html' },
    stopResponse.resolve,
  )
  await stopResponse.promise

  health.resolve({ connected: false })
  await keepalive

  assert.equal(env.sentMessages.filter((message) => message.type === 'connect').length, 1)
})
