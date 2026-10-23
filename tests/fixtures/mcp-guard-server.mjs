/**
 * P8 审批验收用 MCP server。
 *
 * 每个工具在被真正执行时都会往 argv[2] 追加一行 marker。验收脚本据此证明
 * "审批未通过时工具根本没有执行",而不是只看返回文案。
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const markerPath = process.argv[2]

function mark(tool) {
  if (!markerPath) return
  appendFileSync(markerPath, `${tool}\n`, 'utf8')
}

const tools = [
  {
    name: 'charge',
    description: '会触发计费的工具(需要审批)',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } }
    }
  },
  {
    name: 'audit',
    description: '与 charge 同组的另一个计费工具',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } }
    }
  }
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function handle(msg) {
  if (msg.method === 'initialize') {
    ok(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'owb-guard', version: '1.0.0' }
    })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    ok(msg.id, { tools })
    return
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name
    if (name === 'charge' || name === 'audit') {
      mark(name)
      ok(msg.id, { content: [{ type: 'text', text: `${name}:executed` }] })
      return
    }
    ok(msg.id, { isError: true, content: [{ type: 'text', text: `未知工具: ${name}` }] })
    return
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未实现: ${msg.method}` } })
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    handle(JSON.parse(trimmed))
  } catch (err) {
    process.stderr.write(`bad json: ${err.message}\n`)
  }
})
