/**
 * 流式失败自动重试验收。
 *
 * 起一个假的 OpenAI 兼容服务,按场景返回错误,检查真实 daemon 的行为:
 *   1. 首次 503、第二次成功 -> 只重试一次,最终 done,事件里有 retry.scheduled/recovered;
 *   2. 401 鉴权失败 -> 不重试,请求只发一次,最终 error;
 *   3. 连续 503 直到用尽预算 -> 请求次数 = maxAttempts,最终 error。
 *
 * 用法: node tests/e2e/verify-retry.mjs
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

let plan = []
let requests = []
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
    const isTitle = String(parsed?.messages?.[0]?.content ?? '').startsWith('你是会话标题生成器')
    // 自动标题请求永远成功,避免干扰重试断言。
    const action = isTitle ? { status: 200 } : (plan.shift() ?? { status: 200 })
    if (action.status !== 200) {
      res.writeHead(action.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: action.message ?? 'gateway error', type: 'server_error' } }))
      return
    }
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
    res.write(chunk({ role: 'assistant', content: '重试后的回答' }))
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

const base = await mkdtemp(join(tmpdir(), 'owb-retry-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"retry-e2e"}\n', 'utf8')

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
    OPENWB_STREAM_RETRY_BASE_MS: '20',
    OPENWB_STREAM_MAX_ATTEMPTS: '3',
    OPENWB_AUTOMATION_AUTOSTART: '0'
  },
  stdio: ['pipe', 'pipe', 'pipe']
})
const chunks = []
let err = ''
child.stdout.on('data', (b) => chunks.push(b))
child.stderr.on('data', (b) => {
  err += String(b)
})
const closed = new Promise((r) => child.on('close', (code) => r(code)))
const events = () => decodeFrames(Buffer.concat(chunks))
const send = (frame) => child.stdin.write(encodeFrame(frame))
let cursor = 0
const waitFor = async (predicate, timeoutMs = 20000) => {
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
  return waitFor((e) => e.requestId === requestId && (e.type === type || e.type === 'error'))
}
const isMainRequest = (body) =>
  !String(body?.messages?.[0]?.content ?? '').startsWith('你是会话标题生成器')
const mainCount = () => requests.filter(isMainRequest).length

const runTurn = async (conversationId, text) => {
  send({ text, mode: 'craft', conversationId })
  await waitFor((e) => e.type === 'conversation.ready')
  return await waitFor((e) => e.type === 'done' || e.type === 'error')
}

try {
  check(Boolean(await waitFor((e) => e.type === 'ready', 20000)), 'daemon 启动')
  const conv = await call({ cmd: 'conversation.new', title: '重试测试' }, 'conversation.created')
  const conversationId = conv?.conversationId
  check(Boolean(conversationId), '创建会话')

  // 场景 1:一次 503 后恢复
  plan = [{ status: 503, message: 'upstream overloaded' }]
  requests = []
  const first = await runTurn(conversationId, '第一次请求会失败')
  const retryEvents = events().filter((e) => e.type === 'retry.scheduled' || e.type === 'retry.recovered')
  const scheduled = retryEvents.find((e) => e.type === 'retry.scheduled')
  const recovered = retryEvents.find((e) => e.type === 'retry.recovered')
  check(retryEvents.filter((e) => e.type === 'retry.scheduled').length === 1, '失败后发出一次 retry.scheduled')
  check(scheduled?.attempt === 1, '首次重试编号为 1', String(scheduled?.attempt))
  check(Boolean(recovered), '成功后发出 retry.recovered')
  check(first?.type === 'done', '重试后最终完成', String(first?.type))
  check(mainCount() === 2, '503 只重试一次(共 2 次请求)', String(mainCount()))

  // 场景 2:鉴权失败不重试
  plan = [{ status: 401, message: 'Incorrect API key provided' }]
  requests = []
  const second = await runTurn(conversationId, '第二次请求鉴权失败')
  check(second?.type === 'error', '鉴权失败以 error 结束', String(second?.type))
  check(second?.code === 'AGENT_FAILED', '鉴权失败上报 AGENT_FAILED', String(second?.code))
  check(mainCount() === 1, '401 不重试', String(mainCount()))
  check(!events().some((e) => e.type === 'retry.scheduled' && e.reason?.includes('Incorrect API key')), '401 不排重试')

  // 场景 3:持续 503 用尽预算
  plan = [
    { status: 503, message: 'down' },
    { status: 503, message: 'down' },
    { status: 503, message: 'down' }
  ]
  requests = []
  const third = await runTurn(conversationId, '第三次持续失败')
  check(third?.type === 'error', '重试耗尽后报错', String(third?.type))
  check(mainCount() === 3, '最多尝试 3 次', String(mainCount()))
} finally {
  child.stdin.end()
  await Promise.race([closed, sleep(4000)])
  child.kill()
  server.close()
}

if (failed > 0 && err.trim()) {
  console.log('--- daemon stderr ---\n' + err.split('\n').slice(-20).join('\n'))
}
await rm(base, { recursive: true, force: true }).catch(() => undefined)
process.exit(failed === 0 ? 0 : 1)
