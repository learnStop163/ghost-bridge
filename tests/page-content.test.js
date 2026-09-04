import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadExtensionScript } from './helpers/load-extension-script.js'
import { FakeDocument, FakeElement, createWindow } from './helpers/fake-dom.js'

const domPath = fileURLToPath(new URL('../extension/bg-dom.js', import.meta.url))
const { GhostBridgeDom } = loadExtensionScript(domPath)

function evaluatePageContent(window, options) {
  const expression = GhostBridgeDom.buildPageContentExpression(options)
  return new Function('document', 'window', `return ${expression}`)(window.document, window)
}

test('text pagination uses contiguous slices from offset zero', () => {
  const body = new FakeElement('body', { text: '0123456789abcdefghijklmnopqrstuvwxyz' })
  const window = createWindow(body)
  const first = evaluatePageContent(window, { mode: 'text', selector: null, maxLength: 10, offset: 0, includeMetadata: false })
  const second = evaluatePageContent(window, { mode: 'text', selector: null, maxLength: 10, offset: 10, includeMetadata: false })
  assert.equal(first.content, '0123456789')
  assert.equal(second.content, 'abcdefghij')
  assert.equal(first.hasMore, true)
  assert.equal(second.offset, 10)
})

test('iframe counters distinguish absent, readable and inaccessible frames', () => {
  const noFrame = evaluatePageContent(createWindow(new FakeElement('body', { text: 'main' })), {
    mode: 'text', selector: null, maxLength: 100, offset: 0, includeMetadata: false,
  })
  assert.equal(noFrame.iframeCount, 0)
  assert.equal(noFrame.includesIframes, false)

  const body = new FakeElement('body', { text: 'main' })
  const readable = new FakeElement('iframe')
  readable.contentDocument = new FakeDocument(new FakeElement('body', { text: 'frame text' }))
  const frameWindow = {
    document: readable.contentDocument,
    Event: class { constructor(type) { this.type = type } },
    getComputedStyle: (element) => element._style,
  }
  readable.contentDocument.defaultView = frameWindow

  const inaccessible = new FakeElement('iframe')
  Object.defineProperty(inaccessible, 'contentDocument', {
    get() { throw new Error('cross origin') },
  })
  body.append(readable, inaccessible)

  const result = evaluatePageContent(createWindow(body), {
    mode: 'text', selector: null, maxLength: 100, offset: 0, includeMetadata: false,
  })
  assert.equal(result.iframeCount, 2)
  assert.equal(result.readableIframeCount, 1)
  assert.equal(result.crossOriginSkipped, 1)
  assert.equal(result.includesIframes, true)
  assert.match(result.content, /frame text/)
})
