/**
 * 多轮上下文验收。
 *
 * 起一个假的 OpenAI 兼容服务,真实 daemon 用 OPENAI_BASE_URL 指向它,
 * 检查第二轮请求体里是否真的带了第一轮的问答。
 *
 * 用法: node tests/e2e/verify-history.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')
if (!existsSync(entry)) {
  console.error('缺少 daemon 产物,先执行 pnpm --filter @openwb/daemon build')
  process.exit(1)
}

let failed = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, label, detail = '') => {
  if (ok) console.log('PASS ' + label)
  else {
    failed++
    console.log('FAIL ' + label + (detail ? ' :: ' + detail : ''))
  }
}

const requests = []
const server = http.createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (b) => {
    body += b
  })
  req.on('end', () => {
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {}
    requests.push(parsed)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const id = 'chatcmpl-' + requests.length
    const created = Math.floor(Date.now() / 1000)
    const chunk = (delta, finish) =>
      'data: ' +
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: 'fake',
        choices: [{ index: 0, delta, finish_reason: finish ?? null }]
      }) +
      '\n\n'
    res.write(chunk({ role: 'assistant', content: '回答' + requests.length }))
    res.write(chunk({}, 'stop'))
    res.write(
      'data: ' +
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'fake',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }) +
        '\n\n'
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}
function decodeFrames(buf) {
  const out = []
  let offset = 0
  while (buf.length - offset >= 4) {
    const len = buf.readUInt32BE(offset)
    if (buf.length - offset < 4 + len) break
    const json = buf.subarray(offset + 4, offset + 4 + len).toString('utf8')
    offset += 4 + len
    try {
      out.push(JSON.parse(json))
    } catch {
      out.push({ type: 'PARSE_ERROR' })
    }
  }
  return out
}

const base = await mkdtemp(join(tmpdir(), 'owb-history-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"history-e2e"}\n', 'utf8')

const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: {
    ...process.env,
    OPENWB_MOCK: '0',
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:' + port + '/v1',
    OPENWB_MODEL: 'fake-model',
    OPENWB_WORKSPACE: workspace,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_AUTOMATION_AUTOSTART: '0'
  },
  stdio: ['pipe', 'pipe', 'pipe']
})
const chunks = []
let err = ''
let cursor = 0
child.stdout.on('data', (b) => chunks.push(b))
child.stderr.on('data', (b) => {
  err += String(b)
})
const closed = new Promise((r) => child.on('close', (code) => r(code)))
const events = () => decodeFrames(Buffer.concat(chunks))
const send = (frame) => child.stdin.write(encodeFrame(frame))
const waitForEvent = async (predicate, timeoutMs = 20000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const all = events()
    for (let i = cursor; i < all.length; i++) {
      if (predicate(all[i])) {
        cursor = i + 1
        return all[i]
      }
    }
    await sleep(20)
  }
  return null
}
const call = async (frame, type) => {
  const requestId = 'r-' + Math.random().toString(36).slice(2, 8)
  send({ ...frame, requestId })
  return waitForEvent((e) => e.requestId === requestId && (e.type === type || e.type === 'error'))
}

// 自动标题也是一次模型请求,会混进记录里;只保留真正的对话请求。
const isMainRequest = (body) =>
  !String(body?.messages?.[0]?.content ?? '').startsWith('你是会话标题生成器')
const mainRequests = () => requests.filter(isMainRequest)

try {
  check(Boolean(await waitForEvent((e) => e.type === 'ready', 20000)), 'daemon 启动')
  const conv = await call({ cmd: 'conversation.new', title: '上下文测试' }, 'conversation.created')
  const conversationId = conv?.conversationId
  check(Boolean(conversationId), '创建会话')

  const runTurn = async (text) => {
    send({ text, mode: 'craft', conversationId })
    await waitForEvent((e) => e.type === 'conversation.ready')
    return await waitForEvent((e) => e.type === 'done')
  }

  await runTurn('第一轮:项目代号是凤凰')
  check(mainRequests().length === 1, '第一轮只发一次对话请求', String(mainRequests().length))
  const firstBody = mainRequests()[0]
  check(
    firstBody?.messages?.length === 2,
    '第一轮只有 system + 当前提问',
    JSON.stringify((firstBody?.messages ?? []).map((m) => m.role))
  )

  await runTurn('第二轮:代号是什么?')
  check(mainRequests().length === 2, '第二轮再次请求', String(mainRequests().length))
  const second = mainRequests()[1]
  const roles = (second?.messages ?? []).map((m) => m.role)
  const texts = (second?.messages ?? []).map((m) => m.content)
  check(roles.join(',') === 'system,user,assistant,user', '第二轮带上了第一轮的问答', JSON.stringify(roles))
  check(texts.includes('第一轮:项目代号是凤凰'), '历史里保留第一轮提问', JSON.stringify(texts))
  check(texts.includes('回答1'), '历史里保留第一轮答复', JSON.stringify(texts))
  check(texts.filter((t) => t === '第二轮:代号是什么?').length === 1, '当前提问不重复', JSON.stringify(texts))
  check(roles.lastIndexOf('user') === roles.length - 1, '当前提问在最后', JSON.stringify(roles))

  const conv2 = await call({ cmd: 'conversation.new', title: '另一个会话' }, 'conversation.created')
  send({ text: '新会话第一问', mode: 'craft', conversationId: conv2.conversationId })
  await waitForEvent((e) => e.type === 'conversation.ready')
  await waitForEvent((e) => e.type === 'done')
  const third = mainRequests()[2]
  const thirdTexts = (third?.messages ?? []).map((m) => m.content)
  check(!thirdTexts.includes('第一轮:项目代号是凤凰'), '新会话不串上一个会话的上下文', JSON.stringify(thirdTexts))
  check(third?.messages?.length === 2, '新会话只有 system + 当前提问', String(third?.messages?.length))
} finally {
  child.stdin.end()
  await Promise.race([closed, sleep(4000)])
  child.kill()
  server.close()
}

if (failed > 0 && err.trim()) {
  console.log('--- daemon stderr ---\n' + err.split('\n').slice(-15).join('\n'))
}
await rm(base, { recursive: true, force: true }).catch(() => undefined)
process.exit(failed === 0 ? 0 : 1)
