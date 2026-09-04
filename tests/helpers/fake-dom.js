function descendants(root) {
  const result = []
  for (const child of root.children || []) {
    result.push(child, ...descendants(child))
  }
  return result
}

function matchesSelector(element, selector) {
  const value = selector.trim()
  if (value === '*') return true
  if (value.startsWith('#')) return element.id === value.slice(1)
  if (value.startsWith('.')) return String(element.getAttribute('class') || '').split(/\s+/).includes(value.slice(1))

  const tagAndAttr = value.match(/^([a-zA-Z][\w-]*)?(?:\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\])?$/)
  if (!tagAndAttr) throw new Error(`Unsupported fake selector: ${selector}`)
  const [, tag, attribute, expected] = tagAndAttr
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false
  if (!attribute) return Boolean(tag)
  const actual = element.getAttribute(attribute)
  return expected === undefined ? actual !== null : actual === expected
}

class FakeRoot {
  constructor() {
    this.children = []
  }

  append(...elements) {
    for (const element of elements) {
      element.parentNode = this
      this.children.push(element)
      if (this.ownerDocument) assignDocument(element, this.ownerDocument)
    }
    return elements.at(-1)
  }

  querySelectorAll(selector) {
    return descendants(this).filter((element) => matchesSelector(element, selector))
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
}

export class FakeElement extends FakeRoot {
  constructor(tagName, { attrs = {}, text = '', rect, style = {}, disabled = false, hidden = false } = {}) {
    super()
    this.tagName = tagName.toUpperCase()
    this.attributes = { ...attrs }
    this._text = text
    this._rect = rect || { left: 0, top: 0, width: 100, height: 24 }
    this._style = { display: 'block', visibility: 'visible', opacity: '1', ...style }
    this.disabled = disabled
    this.hidden = hidden
    this.isConnected = true
    this.value = attrs.value || ''
    this.type = attrs.type || ''
    this.placeholder = attrs.placeholder || ''
    this.id = attrs.id || ''
    this.htmlFor = attrs.for || ''
    this.multiple = false
    this.options = []
    this.events = []
  }

  get innerText() {
    return [this._text, ...this.children.map((child) => child.innerText)].filter(Boolean).join(' ')
  }

  get textContent() {
    return this.innerText
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? String(this.attributes[name]) : null
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'id') this.id = String(value)
  }

  getBoundingClientRect() {
    return { ...this._rect, right: this._rect.left + this._rect.width, bottom: this._rect.top + this._rect.height }
  }

  getRootNode() {
    let current = this
    while (current.parentNode) current = current.parentNode
    return current
  }

  closest(selector) {
    let current = this.parentNode
    while (current instanceof FakeElement) {
      if (matchesSelector(current, selector)) return current
      current = current.parentNode
    }
    return null
  }

  attachShadow() {
    const root = new FakeRoot()
    root.host = this
    root.ownerDocument = this.ownerDocument
    this.shadowRoot = root
    return root
  }

  scrollIntoView() {}
  focus() { this.focused = true }
  select() { this.selected = true }
  dispatchEvent(event) { this.events.push(event.type); return true }
}

function assignDocument(element, document) {
  element.ownerDocument = document
  for (const child of element.children) assignDocument(child, document)
  if (element.shadowRoot) {
    element.shadowRoot.ownerDocument = document
    for (const child of element.shadowRoot.children) assignDocument(child, document)
  }
}

export class FakeDocument extends FakeRoot {
  constructor(body = new FakeElement('body')) {
    super()
    this.readyState = 'complete'
    this.title = 'Test page'
    this.characterSet = 'UTF-8'
    this.documentElement = new FakeElement('html')
    this.documentElement.lang = 'zh-CN'
    this.body = body
    this.documentElement.append(body)
    this.append(this.documentElement)
    this.ownerDocument = this
    assignDocument(this.documentElement, this)
  }

  getElementById(id) {
    return this.querySelectorAll('*').find((element) => element.id === id) || null
  }
}

export function createWindow(body = new FakeElement('body')) {
  const document = new FakeDocument(body)
  class FakeEvent {
    constructor(type) { this.type = type }
  }
  const window = {
    document,
    Event: FakeEvent,
    location: { href: 'https://example.test/page' },
    innerWidth: 1280,
    innerHeight: 720,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: (element) => element._style,
  }
  document.defaultView = window
  return window
}
