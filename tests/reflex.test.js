import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDecisionMessages,
  parseDecision,
  checkDecision,
  runReflexTask,
  resolveReflexConfig,
  REFLEX_CONF_FLOOR,
} from '../scripts/reflex-engine.js'

test('resolveReflexConfig: 执行器语义——不内置厂商默认，model 必须显式', () => {
  // 什么都没有：不启用
  assert.equal(resolveReflexConfig({}).enabled, false)
  // 只有 ANTHROPIC_*（Claude Code 用户常见）：协议兼容可借用，但没有 model 仍不启用
  // —— 避免默认模型名打到不认识它的端点上
  const borrowed = resolveReflexConfig({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'k' })
  assert.equal(borrowed.enabled, false)
  assert.equal(borrowed.baseUrl, 'https://api.anthropic.com')
  // 显式三件套（优先级高于 ANTHROPIC_*）
  const full = resolveReflexConfig({
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: 'wrong',
    GHOST_BRIDGE_REFLEX_BASE_URL: 'https://open.bigmodel.cn/api/anthropic/',
    GHOST_BRIDGE_REFLEX_KEY: 'k2',
    GHOST_BRIDGE_REFLEX_MODEL: 'glm-5.3-flash',
  })
  assert.equal(full.enabled, true)
  assert.equal(full.baseUrl, 'https://open.bigmodel.cn/api/anthropic') // 去尾部斜杠
  assert.equal(full.model, 'glm-5.3-flash')
  // 借用 ANTHROPIC_* + 显式 model 也算齐备（自部署/网关场景）
  assert.equal(
    resolveReflexConfig({ ANTHROPIC_BASE_URL: 'https://x.example', ANTHROPIC_AUTH_TOKEN: 'k', GHOST_BRIDGE_REFLEX_MODEL: 'm' }).enabled,
    true,
  )
})

const ELEMENTS = [
  { ref: 'e1', tag: 'button', text: '登录' },
  { ref: 'e2', tag: 'div', role: 'tab', text: '密码登录' },
  { ref: 'e3', tag: 'div', role: 'tab', text: '验证码登录' },
  { ref: 'e4', tag: 'input', placeholder: '请输入密码' },
]

const snap = async () => ({ elements: ELEMENTS, title: '测试页', url: 'https://t.example/login' })
const dispatch = async () => ({ success: true, detail: 'ok' })

test('parseDecision extracts fenced and raw JSON, and degrades garbage safely', () => {
  assert.deepEqual(parseDecision('```json\n{"action":"click","ref":"e3","confidence":0.9}\n```'), {
    action: 'click', ref: 'e3', valueKey: null, key: null, confidence: 0.9,
  })
  assert.equal(parseDecision('前置废话 {"action":"stop","confidence":1} 后缀').action, 'stop')
  assert.equal(parseDecision('完全不是JSON').action, 'unparseable')
  assert.equal(parseDecision('完全不是JSON').confidence, 0)
})

test('checkDecision enforces exact-match avoidText, preset values and press whitelist', () => {
  // 整词匹配：「验证码登录」不命中 avoidText「登录」
  assert.equal(
    checkDecision({ action: 'click', ref: 'e3', confidence: 0.9 }, { elementText: '验证码登录', avoidText: ['登录'], params: {} }).ok,
    true,
  )
  assert.equal(
    checkDecision({ action: 'click', ref: 'e1', confidence: 0.9 }, { elementText: '登录', avoidText: ['登录'], params: {} }).reason,
    'avoid',
  )
  assert.equal(checkDecision({ action: 'click', ref: 'e1', confidence: 0.5 }, { elementText: '登录' }).reason, 'low-confidence')
  // fill 值只能来自预设参数表
  assert.deepEqual(
    checkDecision({ action: 'fill', ref: 'e4', valueKey: '密码', confidence: 1 }, { elementText: '请输入密码', params: { 密码: 'x' } }),
    { ok: true, value: 'x', key: undefined },
  )
  assert.equal(
    checkDecision({ action: 'fill', ref: 'e4', valueKey: '不存在的参数', confidence: 1 }, { elementText: '请输入密码', params: { 密码: 'x' } }).reason,
    'no-value',
  )
  assert.equal(checkDecision({ action: 'press', ref: 'e4', key: 'Enter', confidence: 1 }, {}).ok, true)
  assert.equal(checkDecision({ action: 'press', ref: 'e4', key: 'Control+A', confidence: 1 }, {}).reason, 'press-key')
  assert.equal(checkDecision({ action: 'scroll', confidence: 1 }, {}).reason, 'unsupported-action')
})

test('runReflexTask happy path: click then model stop, with history injected into decide', async () => {
  const seenHistorys = []
  const decisions = [
    { action: 'click', ref: 'e3', confidence: 0.98 },
    { action: 'stop', confidence: 0.95 },
  ]
  let i = 0
  const decide = async ({ history }) => {
    seenHistorys.push([...history])
    return decisions[Math.min(i++, decisions.length - 1)]
  }
  const result = await runReflexTask({ task: '切换到验证码登录', snapshot: snap, dispatch, decide })
  assert.equal(result.outcome, 'stopped-by-model')
  assert.equal(result.executed, 1)
  // 第二轮 decide 收到了第一轮的历史 —— pilot 的命门修复点
  assert.deepEqual(seenHistorys[1], ['click「验证码登录」'])
  assert.equal(result.lastState.elementCount, 4)
  assert.ok(Array.isArray(result.lastState.topElements))
  // 结果经 JSON 往返（server 的 compact/序列化路径）后关键信息存活
  const round = JSON.parse(JSON.stringify(result))
  assert.equal(round.outcome, 'stopped-by-model')
  assert.equal(round.executed, 1)
  assert.equal(round.steps[0].element, '验证码登录')
  assert.equal(round.steps[0].decision.confidence, 0.98)
  assert.equal(round.lastState.topElements[2].text, '验证码登录')
})

test('runReflexTask blocks low-confidence decisions instead of executing', async () => {
  const decide = async () => ({ action: 'click', ref: 'e1', confidence: 0.45 })
  let dispatched = 0
  const result = await runReflexTask({
    task: '点登录', snapshot: snap, decide,
    dispatch: async () => { dispatched++; return {} },
  })
  assert.equal(result.outcome, 'blocked-low-confidence')
  assert.equal(dispatched, 0)
  assert.match(result.steps[0].note, /low-confidence/)
})

test('runReflexTask detects stuck loops after the same action repeats 3 times', async () => {
  const decide = async () => ({ action: 'click', ref: 'e2', confidence: 0.99 })
  const result = await runReflexTask({ task: '随便', snapshot: snap, dispatch, decide, maxSteps: 10 })
  assert.equal(result.outcome, 'stuck')
  assert.equal(result.steps.length, 3)
})

test('runReflexTask surfaces decision errors (e.g. quota 429) with the steps already taken', async () => {
  const decideCalls = []
  const decide = async (input) => {
    decideCalls.push(input)
    if (decideCalls.length === 1) return { action: 'click', ref: 'e2', confidence: 0.9 }
    throw new Error('http-429 quota exhausted')
  }
  const result = await runReflexTask({ task: '两步任务', snapshot: snap, dispatch, decide })
  assert.equal(result.outcome, 'decision-error')
  assert.equal(result.executed, 1)
  assert.match(result.steps[1].note, /http-429/)
})

test('runReflexTask caps maxSteps at the hard ceiling', async () => {
  // 交替 ref 避开卡死检测，验证 15 步硬顶（调用方传 99 也只跑 15）
  let flip = 0
  const decide = async () => ({ action: 'click', ref: flip++ % 2 ? 'e2' : 'e3', confidence: 0.99 })
  const result = await runReflexTask({ task: '交替', snapshot: snap, dispatch, decide, maxSteps: 99 })
  assert.equal(result.outcome, 'max-steps')
  assert.equal(result.steps.length, 15)
  assert.equal(result.executed, 15)
})

test('buildDecisionMessages includes task, params, history and elements', () => {
  const m = buildDecisionMessages({
    task: '填密码', params: { 密码: 'x' }, elements: ELEMENTS, history: ['click「验证码登录」'],
  })
  assert.match(m.user, /任务:填密码/)
  assert.match(m.user, /已执行动作:click「验证码登录」/)
  assert.match(m.user, /页面元素列表:/)
  assert.ok(m.system.includes('stop'))
})

test('runReflexTask fill only uses preset values even when the model invents content', async () => {
  const decide = async () => ({ action: 'fill', ref: 'e4', valueKey: '模型自己编的key', confidence: 1 })
  let dispatched = 0
  const result = await runReflexTask({
    task: '填密码', params: { 密码: 'test123' }, snapshot: snap,
    dispatch: async () => { dispatched++; return {} }, decide,
  })
  assert.equal(result.outcome, 'blocked-no-value')
  assert.equal(dispatched, 0)
})

test('conf floor default matches the calibrated probe result', () => {
  assert.equal(REFLEX_CONF_FLOOR, 0.6)
})
