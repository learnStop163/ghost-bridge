// Usage: node scripts/benchmark-mcp.js <server.js> <tabId> [samples=5]
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

const [entry, tab, count = '5'] = process.argv.slice(2)
const tabId = Number(tab), samples = Number(count)
if (!entry || !Number.isInteger(tabId) || !Number.isInteger(samples) || samples < 1 || samples > 30) {
  throw new Error('Usage: node scripts/benchmark-mcp.js <server.js> <tabId> [samples=1..30]')
}
const client = new Client({ name: 'ghost-latency-probe', version: '1.0' })
// This probe always launches a session client, even from a daemon environment.
const clientEnv = { ...process.env, GHOST_BRIDGE_DIAGNOSTICS: '1' }
delete clientEnv.GHOST_BRIDGE_DAEMON
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.resolve(entry)], stderr: 'pipe',
  env: clientEnv,
})
let buffer = ''
transport.stderr.on('data', chunk => {
  buffer += chunk.toString()
  const lines = buffer.split('\n'); buffer = lines.pop()
  for (const line of lines) if (line.startsWith('[ghost-timing] ')) console.error(line)
})
const started = performance.now()
try {
  await client.connect(transport)
  console.log(JSON.stringify({ phase: 'clientConnect', ms: performance.now() - started }))
  const info = await client.callTool({ name: 'get_server_info', arguments: {} })
  const status = JSON.parse(info.content[0].text)
  console.log(JSON.stringify({ clientVersion: status.version, daemonVersion: status.mainVersion, serverPath: status.serverPath }))
  if (!status.chromeConnected) throw new Error('Chrome extension is not connected to this daemon; check port/environment')
  const bound = await client.callTool({ name: 'bind_tab', arguments: { name: 'benchmark', tabId } })
  if (bound.isError || bound.content?.some(c => c.text?.startsWith('Error:'))) throw new Error('Cannot bind benchmark tab')
  for (let i = 0; i < samples; i++) {
    for (const name of ['get_server_info', 'eval_script', 'inspect_page']) {
      const start = performance.now()
      const result = await client.callTool({ name, arguments: name === 'get_server_info' ? {} : name === 'eval_script'
        ? { target: 'benchmark', code: '({readyState:document.readyState})', timeoutMs: 3000 }
        : { target: 'benchmark', includeInteractive: false, includeElements: false } })
      console.log(JSON.stringify({ sample: i + 1, name, ms: performance.now() - start,
        resultChars: JSON.stringify(result).length,
        failed: Boolean(result.isError || result.content?.some(c => c.text?.startsWith('Error:'))) }))
    }
  }
} finally {
  await client.close()
}
