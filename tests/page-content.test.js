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

test('inspect returns at most three shallow iframe summaries without reading bodies', () => {
  const body = new FakeElement('body')
  for (let i = 0; i < 5; i++) {
    const frame = new FakeElement('iframe')
    frame.contentDocument = {}
    Object.defineProperty(frame.contentDocument, 'body', { get() { throw new Error('must not scan child body') } })
    body.append(frame)
  }
  const window = createWindow(body)
  const query = body.querySelectorAll.bind(body)
  body.querySelectorAll = selector => selector === 'iframe' ? query(selector) : []
  const expression = GhostBridgeDom.buildInspectPageExpression({ includeInteractive: false, maxElements: 20 })
  const result = new Function('document', 'window', `return ${expression}`)(window.document, window)
  assert.equal(result.error, undefined)
  assert.equal(result.iframeCount, 5)
  assert.equal(result.frames.length, 3)
  assert.equal(result.framesOmitted, 2)
  assert.equal(result.frames[0].readable, 'in-page')
})


test('inspect distinguishes bridge candidates from unavailable frames, including access errors', () => {
  const body = new FakeElement('body')
  const candidate = new FakeElement('iframe')
  candidate.src = 'https://example.test/frame'
  candidate.contentDocument = null
  const inaccessible = new FakeElement('iframe')
  inaccessible.src = 'https://example.test/other'
  Object.defineProperty(inaccessible, 'contentDocument', { get() { throw new Error('denied') } })
  const unavailable = new FakeElement('iframe')
  unavailable.contentDocument = null
  body.append(candidate, inaccessible, unavailable)
  const window = createWindow(body)
  const query = body.querySelectorAll.bind(body)
  body.querySelectorAll = selector => selector === 'iframe' ? query(selector) : []
  const expression = GhostBridgeDom.buildInspectPageExpression({ includeInteractive: false, maxElements: 20 })
  const result = new Function('document', 'window', `return ${expression}`)(window.document, window)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.frames.map(f => f.readable), ['via-bridge', 'via-bridge', 'no'])
})

test('combined inspect reads optional text once with an explicit budget', () => {
  const body = new FakeElement('body', { text: 'abcdefghijklmno' })
  const window = createWindow(body)
  body.querySelectorAll = () => []
  const options = { includeInteractive: false, maxElements: 20, textMaxLength: 5 }
  const run = includeText => new Function('document', 'window', `return ${GhostBridgeDom.buildInspectWithTextExpression({ ...options, includeText })}`)(window.document, window)
  assert.equal(run(false).text, undefined)
  const result = run(true)
  assert.equal(result.error, undefined)
  assert.equal(result.text.content, 'abcde')
  assert.equal(result.text.hasMore, true)
  assert.equal(result.text.offset, 0)
  assert.ok(result.page)
})
