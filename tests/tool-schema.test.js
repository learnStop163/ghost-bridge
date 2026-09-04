import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { DISPATCH_ACTION_TOOL } from '../src/tool-schemas.js'

test('dispatch_action schema stays compact and reference-based', () => {
  const serialized = JSON.stringify(DISPATCH_ACTION_TOOL)
  assert.ok(serialized.length <= 3000, `dispatch_action schema grew to ${serialized.length} characters`)
  assert.ok(DISPATCH_ACTION_TOOL.inputSchema.$defs.locator)
  assert.equal(DISPATCH_ACTION_TOOL.inputSchema.properties.locator.$ref, '#/$defs/locator')
  assert.equal(DISPATCH_ACTION_TOOL.inputSchema.properties.actions.items.$ref, '#/$defs/action')
})

test('compressed schema accepts both single and batch forms', () => {
  const validator = new AjvJsonSchemaValidator().getValidator(DISPATCH_ACTION_TOOL.inputSchema)
  assert.equal(validator({ locator: { role: 'button', name: '登录' }, action: 'click' }).valid, true)
  assert.equal(validator({
    actions: [{ selector: '#login', action: 'click', waitFor: { type: 'url', contains: '/home' } }],
  }).valid, true)
  assert.equal(validator({ actions: [{ selector: '#login' }] }).valid, false)
  assert.equal(validator({ locator: { text: '登录', nth: -1 }, action: 'click' }).valid, false)
})

test('complete tools/list payload stays below the token-oriented size budget', () => {
  const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url))
  const source = fs.readFileSync(serverPath, 'utf8')
  const marker = 'server.setRequestHandler(ListToolsRequestSchema, async () => '
  const expressionStart = source.indexOf(marker) + marker.length
  const expressionEnd = source.indexOf('\n}))', expressionStart)
  const expression = source.slice(expressionStart, expressionEnd + 3)
  const targetArg = { type: 'string', description: '命名目标（bind_tab 绑定；缺省用聚焦/锁定页，按会话隔离）' }
  const listResult = new Function(
    'TARGET_ARG',
    'DISPATCH_ACTION_TOOL',
    `return ${expression}`
  )(targetArg, DISPATCH_ACTION_TOOL)
  const size = JSON.stringify(listResult).length
  assert.ok(size <= 11500, `tools/list payload grew to ${size} characters`)
})
