/**
 * 长对话上下文压缩验收。
 *
 * 用较小的历史预算驱动真实 daemon 触发压缩,检查:
 *   1. 超预算后确实发出摘要请求,且请求里包含被压缩的原文;
 *   2. 主对话请求的 system 带上了压缩摘要,最早的原文不再直接出现在 messages;
 *   3. 摘要落库,covered_seq/条数与实际压缩范围一致;
 *   4. 摘要请求失败时降级为本地摘要,主任务仍然完成;
 *   5. 回退到摘要覆盖范围内时摘要被删除,不会基于已删除历史回答。
 *
 * 用法: node tests/e2e/verify-context-summary.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
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

const require = createRequire(resolve(root, 'apps/daemon/package.json'))
const Database = require('better-sqlite3')

let failed = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const requests = []
let summaryMode = 'ok'
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
    const system = String(parsed?.messages?.[0]?.content ?? '')
    const isTitle = system.startsWith('你是会话标题生成器')
    const isSummary = system.startsWith('你是对话压缩器')
    requests.push({ body: parsed, isTitle, isSummary })

    if (isSummary && summaryMode === 'fail') {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'summary upstream down' } }))
      return
    }

    const id = 'chatcmpl-' + requests.length
    const created = Math.floor(Date.now() / 1000)
    const text = isSummary
      ? '【目标】\n继续完成季度报告\n【约束】\n保持中文\n【已确认事实】\n项目代号凤凰\n【已完成】\n列出大纲\n【未决】\n补充数据'
      : isTitle
        ? '季度报告'
        : '回答' + requests.length
    // generateText(标题/摘要)带 stream:false,必须回普通 JSON;
    // 主对话带 stream:true,才回 SSE。两者混用会让摘要被判定为无效响应。
    if (parsed?.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created,
          model: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
        })
      )
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
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
    res.write(chunk({ role: 'assistant', content: text }))
    res.write(chunk({}, 'stop'))
    res.write(
      'data: ' +
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'fake',
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
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

const base = await mkdtemp(join(tmpdir(), 'owb-summary-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"summary-e2e"}\n', 'utf8')

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
    // 小预算:几轮长文本就触发压缩,不必真的堆到两万字。
    OPENWB_HISTORY_MAX_CHARS: '1200',
    OPENWB_HISTORY_MAX_MESSAGES: '8',
    OPENWB_STREAM_RETRY_BASE_MS: '10',
    OPENWB_STREAM_MAX_ATTEMPTS: '1',
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
const mainRequests = () => requests.filter((r) => !r.isTitle && !r.isSummary)
const summaryRequests = () => requests.filter((r) => r.isSummary)

const runTurn = async (conversationId, text) => {
  send({ cmd: 'chat', mode: 'craft', conversationId, text })
  await waitFor((e) => e.type === 'conversation.ready')
  return await waitFor((e) => e.type === 'done' || e.type === 'error')
}

const marker = 'MARKER-EARLY-' + Date.now()
const padding = (tag) => `${tag} ` + '内容'.repeat(120)

try {
  check(Boolean(await waitFor((e) => e.type === 'ready', 20000)), 'daemon 启动')
  const conv = await call({ cmd: 'conversation.new', title: '摘要测试' }, 'conversation.created')
  const conversationId = conv?.conversationId
  check(Boolean(conversationId), '创建会话')

  // 第一轮写入一个只在此处出现的标记,后面用它验证"原文是否还在上下文里"。
  const first = await runTurn(conversationId, `${marker} ${padding('第一轮目标')}`)
  check(first?.type === 'done', '第一轮完成', String(first?.type))
  for (let i = 2; i <= 6; i++) {
    const result = await runTurn(conversationId, padding(`第${i}轮补充`))
    check(result?.type === 'done', `第${i}轮完成`, String(result?.type))
  }

  const summaries = summaryRequests()
  check(summaries.length >= 1, '超预算后发出摘要请求', String(summaries.length))
  check(
    summaries.some((r) => JSON.stringify(r.body).includes(marker)),
    '摘要请求包含被压缩的原文'
  )
  const summaryEvent = events().find((e) => e.type === 'context.summary')
  check(Boolean(summaryEvent), '发出 context.summary 事件')
  check((summaryEvent?.coveredMessages ?? 0) > 0, '事件报告压缩消息数', JSON.stringify(summaryEvent ?? {}))
  check(summaryEvent?.fallback === false, '正常摘要不标记 fallback')

  const last = mainRequests().at(-1)
  const system = String(last?.body?.messages?.[0]?.content ?? '')
  // 只看对话消息:system 里还会带记忆/工作区日志,不能把那里的历史请求
  // 当成"近期原文"来判断。
  const texts = (last?.body?.messages ?? [])
    .filter((m) => m.role !== 'system')
    .map((m) => String(m.content))
  check(system.includes('更早对话的压缩摘要'), '主请求 system 注入压缩摘要')
  check(system.includes('项目代号凤凰'), '摘要内容真正进入上下文')
  check(
    !texts.some((t) => t.includes(marker)),
    '被压缩的原文不再作为近期消息重复发送',
    JSON.stringify(texts.map((t) => [t.slice(0, 24), t.includes(marker)]))
  )

  const db = new Database(join(dataDir, 'openwb.db'), { readonly: true })
  const row = db
    .prepare('select covered_seq, covered_messages, summary, source_chars from conversation_summary where conversation_id = ?')
    .get(conversationId)
  const messages = db
    .prepare("select id, seq, role from message where conversation_id = ? and role = 'user' order by seq")
    .all(conversationId)
  db.close()
  check(Boolean(row), '摘要已落库', JSON.stringify(row ?? {}))
  check((row?.covered_seq ?? 0) > 0, '摘要记录覆盖序号', JSON.stringify(row ?? {}))
  check((row?.source_chars ?? 0) > 0, '摘要记录源字符数', JSON.stringify(row ?? {}))
  check(String(row?.summary ?? '').includes('项目代号凤凰'), '数据库保存模型摘要原文')

  // 降级:摘要请求 503,主任务仍必须完成,并用本地兜底摘要。
  summaryMode = 'fail'
  const fallback = await runTurn(conversationId, padding('触发摘要失败的第七轮'))
  check(fallback?.type === 'done', '摘要失败不阻塞主任务', String(fallback?.type))
  const fallbackEvent = [...events()].reverse().find((e) => e.type === 'context.summary')
  if (fallbackEvent) check(fallbackEvent.fallback === true, '失败时标记 fallback')
  else check(true, '失败时未再次压缩(已有摘要已覆盖,属可接受)')
  summaryMode = 'ok'

  // 回退到最早的用户消息:摘要覆盖范围被删除,摘要必须一起失效。
  const target = messages[0]
  check(Boolean(target?.id), '定位最早用户消息')
  send({ cmd: 'conversation.revert', conversationId, messageId: target.id })
  const reverted = await waitFor((e) => e.type === 'conversation.reverted')
  check(Boolean(reverted), '回退成功')
  const db2 = new Database(join(dataDir, 'openwb.db'), { readonly: true })
  const after = db2
    .prepare('select covered_seq from conversation_summary where conversation_id = ?')
    .get(conversationId)
  db2.close()
  check(!after, '回退覆盖范围后摘要被删除', JSON.stringify(after ?? {}))
} finally {
  child.stdin.end()
  await Promise.race([closed, sleep(4000)])
  child.kill()
  server.close()
  if (failed > 0 && err.trim()) {
    console.log('--- daemon stderr ---\n' + err.split('\n').slice(-15).join('\n'))
  }
  await rm(base, { recursive: true, force: true }).catch(() => undefined)
}

process.exit(failed === 0 ? 0 : 1)
