/**
 * 最小 MCP stdio server(P5 验收用)。
 *
 * 只实现宿主真正用到的三个方法:initialize / tools/list / tools/call。
 * 支持故障注入,供验收"崩溃重启"与"连续失败降级":
 *   FAULT=crash-once   处理第一次 tools/call 就退出
 *   FAULT=always-crash 每次启动立即退出
 *   FAULT=slow         每次 tools/call 睡 2 秒
 */
import { createInterface } from 'node:readline'

const FAULT = process.env.FAULT ?? ''
const dataDir = process.env.PLUGIN_DATA ?? ''
let crashedOnce = false

/** 环境探针:把宿主没剥干净的密钥也暴露出来,验收脚本据此断言 */
const SECRET_KEYS = Object.keys(process.env).filter((key) =>
  /^(OPENAI_|ANTHROPIC_|AWS_|GITHUB_|GH_|SSH_|OPENWB_)/i.test(key)
)

if (FAULT === 'always-crash') {
  process.stderr.write('fault: always-crash\n')
  process.exit(1)
}

const tools = [
  {
    name: 'echo',
    description: '回显输入文本(P5 验收用)',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text']
    }
  },
  {
    name: 'env_probe',
    description: '返回子进程里可见的宿主敏感环境变量名(应为空数组)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'whoami',
    description: '返回插件数据目录',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'boom',
    description: '总是返回错误,用于验证错误回填',
    inputSchema: { type: 'object', properties: {} }
  }
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

async function handle(msg) {
  if (msg.method === 'initialize') {
    ok(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'owb-echo', version: '1.0.0' }
    })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    ok(msg.id, { tools })
    return
  }
  if (msg.method === 'tools/call') {
    if (FAULT === 'crash-once' && !crashedOnce) {
      crashedOnce = true
      process.stderr.write('fault: crash-once\n')
      process.exit(7)
    }
    const { name, arguments: args = {} } = msg.params ?? {}
    if (FAULT === 'slow') await new Promise((resolve) => setTimeout(resolve, 2000))
    if (name === 'echo') {
      const text = typeof args.text === 'string' ? args.text : ''
      ok(msg.id, { content: [{ type: 'text', text: `echo:${text}` }] })
      return
    }
    if (name === 'env_probe') {
      ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(SECRET_KEYS) }] })
      return
    }
    if (name === 'whoami') {
      ok(msg.id, { content: [{ type: 'text', text: dataDir }] })
      return
    }
    if (name === 'boom') {
      ok(msg.id, { isError: true, content: [{ type: 'text', text: '故意的失败' }] })
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
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    process.stderr.write(`bad json: ${trimmed.slice(0, 120)}\n`)
    return
  }
  void handle(msg)
})
process.stderr.write('owb-echo ready\n')
