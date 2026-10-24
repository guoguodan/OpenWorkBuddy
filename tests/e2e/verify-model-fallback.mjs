/**
 * 模型失败降级验收(WM-MODEL-04)。
 *
 * 起一个 OpenAI 兼容桩,检查真实 daemon 的内部行为:
 *   1. 主模型重试耗尽且本步无输出 -> 请求体切到备用模型,最终 done;
 *   2. 事件里明确给出 model.fallback,助手消息与 trace 记录实际模型;
 *   3. 已产生文本后失败 -> 不切换模型,避免同一条回复跨模型拼接;
 *   4. 备用模型与主模型相同或未配置 -> 不发起额外模型请求。
 *
 * 用法: node tests/e2e/verify-model-fallback.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

const primary = 'primary/model-a'
const backup = 'backup/model-b'
let failed = 0
let plan = []
let requests = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const server = http.createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let raw = ''
  req.on('data', (b) => {
    raw += b
  })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    const isTitle = String(body?.messages?.[0]?.content ?? '').startsWith('你是会话标题生成器')
    if (!isTitle) requests.push({ model: body.model, stream: body.stream === true })
    const action = isTitle ? { status: 200 } : (plan.shift() ?? { status: 200 })
    if (action.status !== 200) {
      if (action.streamText) {
        // 先正常吐出一段文本再断流:模拟"已经产生输出后失败",
        // daemon 必须拒绝换模型重来,否则用户会看到重复回答。
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'chatcmpl-partial',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: action.streamText }, finish_reason: null }]
            }) +
            '\n\n'
        )
        res.write('data: ' + JSON.stringify({ error: { message: action.message ?? 'upstream reset' } }) + '\n\n')
        res.end()
        return
      }
      res.writeHead(action.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: action.message ?? 'gateway error' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const id = 'chatcmpl-' + (requests.length + 1)
    const created = Math.floor(Date.now() / 1000)
    const chunk = (delta, finish) =>
      'data: ' +
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }]
      }) +
      '\n\n'
    res.write(chunk({ role: 'assistant', content: action.text ?? '备用模型回答通过' }))
    res.write(chunk({}, 'stop'))
    res.write(
      'data: ' +
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
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

const base = await mkdtemp(join(tmpdir(), 'owb-model-fallback-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"fallback-e2e"}\n', 'utf8')

const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: {
    ...process.env,
    OPENWB_MOCK: '0',
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OPENWB_MODEL: primary,
    OPENWB_WORKSPACE: workspace,
    OPENWB_DATA_DIR: dataDir,
    OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
    OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
    OPENWB_STREAM_RETRY_BASE_MS: '10',
    OPENWB_STREAM_MAX_ATTEMPTS: '2',
    OPENWB_AUTOMATION_AUTOSTART: '0',
    OPENWB_ENV_FILE: join(base, 'nonexistent.env')
  },
  stdio: ['pipe', 'pipe', 'pipe']
})
const chunks = []
let stderr = ''
child.stdout.on('data', (b) => chunks.push(b))
child.stderr.on('data', (b) => {
  stderr += String(b)
})
const closed = new Promise((r) => child.on('close', r))
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
  return waitFor((e) => e.requestId === requestId && (e.type === type || e.type === 'error'), 25000)
}
const runTurn = async (conversationId, text) => {
  send({ text, mode: 'craft', conversationId })
  await waitFor((e) => e.type === 'conversation.ready')
  return waitFor((e) => e.type === 'done' || e.type === 'error', 30000)
}

try {
  check(Boolean(await waitFor((e) => e.type === 'ready', 20000)), 'daemon-started')
  const created = await call({ cmd: 'conversation.new', title: '模型降级' }, 'conversation.created')
  const conversationId = created?.conversationId
  check(Boolean(conversationId), 'conversation-created')

  check(
    (await call({ cmd: 'settings.set', key: 'fallbackModel', value: backup }, 'settings.updated'))?.settings
      ?.fallbackModel === backup,
    'fallback-setting-persisted'
  )

  // 1. 主模型连续 503 用尽 2 次尝试,随后备用模型成功。
  plan = [
    { status: 503, message: 'primary overloaded' },
    { status: 503, message: 'primary overloaded' },
    { status: 200, text: '备用模型回答通过' }
  ]
  requests = []
  cursor = 0
  const first = await runTurn(conversationId, '请验证主模型失败后的降级')
  const fallbackEvent = events().find((e) => e.type === 'model.fallback')
  check(first?.type === 'done', 'fallback-turn-done', String(first?.type))
  check(fallbackEvent?.from === primary && fallbackEvent?.to === backup, 'fallback-event-names-models', JSON.stringify(fallbackEvent ?? null))
  check(requests.length === 3, 'primary-retried-then-backup-once', JSON.stringify(requests))
  check(
    requests.slice(0, 2).every((r) => r.model === primary) && requests[2]?.model === backup,
    'request-body-switches-model',
    JSON.stringify(requests)
  )
  check(
    !requests.slice(0, 2).some((r) => r.model === backup),
    'backup-not-used-before-retry-budget',
    JSON.stringify(requests)
  )

  const history = await call({ cmd: 'conversation.history', conversationId }, 'conversation.history')
  const assistant = [...(history?.messages ?? [])].reverse().find((m) => m.role === 'assistant')
  check(assistant?.content?.text === '备用模型回答通过', 'assistant-text-saved', JSON.stringify(assistant?.content ?? null))
  check(assistant?.model === backup, 'assistant-records-actual-model', String(assistant?.model ?? null))

  const traceFiles = await readdir(join(workspace, '.openwb/traces')).catch(() => [])
  check(traceFiles.length > 0, 'trace-written')
  if (traceFiles.length > 0) {
    const latest = traceFiles.sort().at(-1)
    const trace = JSON.parse(await readFile(join(workspace, '.openwb/traces', latest), 'utf8'))
    check(trace.model === backup, 'trace-records-actual-model', String(trace.model ?? null))
  }

  // 2. 已产生文本后断流:不得换模型重来,避免重复输出。
  plan = [{ status: 502, streamText: '已经开始的回答', message: 'connection reset' }]
  requests = []
  const beforeSecond = events().length
  const second = await runTurn(conversationId, '验证已有输出后不切换模型')
  const secondEvents = events().slice(beforeSecond)
  check(second?.type === 'error', 'partial-output-turn-fails', String(second?.type))
  check(!secondEvents.some((e) => e.type === 'model.fallback'), 'no-fallback-after-partial-output')
  check(requests.length === 1 && requests[0]?.model === primary, 'partial-output-does-not-retry', JSON.stringify(requests))

  // 3. 备用模型与主模型相同:不得多打一轮。
  await call({ cmd: 'settings.set', key: 'fallbackModel', value: primary }, 'settings.updated')
  plan = [
    { status: 503, message: 'down' },
    { status: 503, message: 'down' }
  ]
  requests = []
  const beforeThird = events().length
  const third = await runTurn(conversationId, '备用模型与主模型相同时不应额外尝试')
  const thirdEvents = events().slice(beforeThird)
  check(third?.type === 'error', 'same-model-fallback-fails', String(third?.type))
  check(!thirdEvents.some((e) => e.type === 'model.fallback'), 'same-model-fallback-no-event')
  check(requests.length === 2, 'same-model-fallback-no-extra-call', JSON.stringify(requests))

  // 4. 清除备用模型:同样只走主模型预算。
  await call({ cmd: 'settings.set', key: 'fallbackModel', value: null }, 'settings.updated')
  plan = [
    { status: 503, message: 'down' },
    { status: 503, message: 'down' }
  ]
  requests = []
  const beforeFourth = events().length
  const fourth = await runTurn(conversationId, '没有备用模型时不应降级')
  const fourthEvents = events().slice(beforeFourth)
  check(fourth?.type === 'error', 'no-fallback-model-fails', String(fourth?.type))
  check(!fourthEvents.some((e) => e.type === 'model.fallback'), 'no-fallback-model-no-event')
  check(requests.length === 2, 'no-fallback-model-no-extra-call', JSON.stringify(requests))
} catch (err) {
  failed++
  console.error(`FAIL 运行异常: ${err?.message ?? err}`)
} finally {
  child.stdin.end()
  await Promise.race([closed, sleep(4000)])
  child.kill()
  server.close()
}

if (failed > 0 && stderr.trim()) {
  console.log('--- daemon stderr ---\n' + stderr.split('\n').slice(-20).join('\n'))
}
await rm(base, { recursive: true, force: true }).catch(() => undefined)
process.exit(failed === 0 ? 0 : 1)
