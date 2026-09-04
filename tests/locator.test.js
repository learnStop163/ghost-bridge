import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadExtensionScript } from './helpers/load-extension-script.js'
import { FakeDocument, FakeElement, createWindow } from './helpers/fake-dom.js'

const domPath = fileURLToPath(new URL('../extension/bg-dom.js', import.meta.url))
const { GhostBridgeDom } = loadExtensionScript(domPath)

test('role and accessible name locate one visible element', () => {
  const body = new FakeElement('body')
  const button = body.append(new FakeElement('button', { attrs: { 'aria-label': '登录' }, rect: { left: 10, top: 20, width: 80, height: 30 } }))
  const runtime = GhostBridgeDom.createLocatorRuntime(createWindow(body))
  const result = runtime.locate({ role: 'button', name: '登录' }, 'a1')
  assert.equal(result.found, true)
  assert.equal(result.cx, 50)
  assert.equal(result.cy, 35)
  assert.equal(button.focused, undefined)
})

test('ambiguous locator returns compact candidates and nth resolves it', () => {
  const body = new FakeElement('body')
  body.append(
    new FakeElement('button', { text: '保存' }),
    new FakeElement('button', { text: '保存', rect: { left: 200, top: 0, width: 100, height: 24 } })
  )
  const runtime = GhostBridgeDom.createLocatorRuntime(createWindow(body))
  const ambiguous = runtime.locate({ role: 'button', name: '保存' }, 'a1')
  assert.equal(ambiguous.ambiguous, true)
  assert.equal(ambiguous.matchCount, 2)
  assert.equal(ambiguous.candidates.length, 2)

  const selected = runtime.locate({ role: 'button', name: '保存', nth: 1 }, 'a2')
  assert.equal(selected.found, true)
  assert.equal(selected.cx, 250)
})

test('hidden elements cannot be acted on and disabled elements are reported', () => {
  const body = new FakeElement('body')
  body.append(
    new FakeElement('button', { text: '隐藏', style: { display: 'none' } }),
    new FakeElement('button', { text: '禁用', disabled: true })
  )
  const runtime = GhostBridgeDom.createLocatorRuntime(createWindow(body))
  assert.match(runtime.locate({ text: '隐藏' }, 'a1').error, /未匹配/)
  assert.equal(runtime.probe({ text: '隐藏' }, 'hidden').satisfied, true)
  assert.equal(runtime.locate({ text: '禁用' }, 'a2').disabled, true)
  assert.equal(runtime.probe({ text: '禁用' }, 'enabled').satisfied, false)
})

test('label, placeholder, text and testId locators are supported', () => {
  const body = new FakeElement('body')
  const label = new FakeElement('label', { text: '用户名' })
  const input = new FakeElement('input', { attrs: { placeholder: '请输入用户名', 'data-testid': 'username' } })
  input.labels = [label]
  const message = new FakeElement('span', { text: '登录成功' })
  body.append(label, input, message)
  const runtime = GhostBridgeDom.createLocatorRuntime(createWindow(body))

  for (const locator of [
    { label: '用户名' },
    { placeholder: '请输入用户名' },
    { testId: 'username' },
    { text: '登录成功' },
  ]) {
    assert.equal(runtime.locate(locator, JSON.stringify(locator)).found, true)
  }
})

test('open shadow roots and same-origin iframe coordinates are traversed', () => {
  const body = new FakeElement('body')
  const host = body.append(new FakeElement('div'))
  const shadowButton = host.attachShadow().append(new FakeElement('button', { text: 'Shadow action' }))

  const iframe = new FakeElement('iframe', { rect: { left: 100, top: 50, width: 400, height: 300 } })
  const frameBody = new FakeElement('body')
  frameBody.append(new FakeElement('button', { text: 'Frame action', rect: { left: 10, top: 20, width: 20, height: 10 } }))
  iframe.contentDocument = new FakeDocument(frameBody)
  iframe.contentDocument.defaultView = createWindow().document.defaultView
  assignFrameWindow(iframe.contentDocument)
  body.append(iframe)

  const runtime = GhostBridgeDom.createLocatorRuntime(createWindow(body))
  assert.equal(runtime.locate({ role: 'button', name: 'Shadow action' }, 'shadow').found, true)
  assert.equal(shadowButton.tagName, 'BUTTON')
  const frameResult = runtime.locate({ role: 'button', name: 'Frame action' }, 'frame')
  assert.equal(frameResult.cx, 120)
  assert.equal(frameResult.cy, 75)
})

function assignFrameWindow(document) {
  const frameWindow = {
    document,
    Event: class { constructor(type) { this.type = type } },
    getComputedStyle: (element) => element._style,
  }
  document.defaultView = frameWindow
}
