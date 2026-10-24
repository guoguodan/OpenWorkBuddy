/**
 * 中断生成验收。
 *
 * 覆盖:
 *   - 运行中停止不会排队等待本轮结束,daemon 会立即受理;
 *   - 已生成的部分回复按 interrupted 落库,不会假装成完整答复;
 *   - 任务状态 running -> interrupted,且不会再发 done;
 *   - 取消后串行队列已释放,下一轮可以正常完成;
 *   - 没有在跑的任务时取消返回 accepted=false,不会留下陈旧句柄。
 *
 * 用法: node tests/e2e/verify-cancel.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

function openSession(workspace, dataDir) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      OPENWB_MOCK: '1',
      // 让 mock 的逐字输出有真实的时间窗口,停止才有可观测的"中途"。
      OPENWB_MOCK_DELAY_MS: '25',
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
  const waitForEvent = async (predicate, timeoutMs = 15000) => {
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
  const call = async (frame, type, timeoutMs = 15000) => {
    const requestId = frame.requestId ?? `r-${Math.random().toString(36).slice(2, 8)}`
    send({ ...frame, requestId })
    return waitForEvent((e) => e.requestId === requestId && (e.type === type || e.type === 'error'), timeoutMs)
  }
  const close = async () => {
    child.stdin.end()
    await Promise.race([closed, sleep(5000)])
    child.kill()
  }
  return { child, send, call, waitForEvent, events, close, stderr: () => err }
}

const base = await mkdtemp(join(tmpdir(), 'owb-cancel-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const { mkdir } = await import('node:fs/promises')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"cancel-e2e"}\n', 'utf8')

const s = openSession(workspace, dataDir)
let conversationId = ''
try {
  check(Boolean(await s.waitForEvent((e) => e.type === 'ready')), 'daemon 启动')

  const created = await s.call({ cmd: 'conversation.new', title: '中断测试' }, 'conversation.created')
  conversationId = created?.conversationId ?? ''
  check(Boolean(conversationId), '创建测试会话', JSON.stringify(created))

  s.send({
    text: '请读取 package.json 并告诉我内容',
    mode: 'ask',
    conversationId,
    clientRequestId: 'cancel-turn-1'
  })

  const firstDelta = await s.waitForEvent((e) => e.type === 'delta', 8000)
  check(Boolean(firstDelta), '第一轮开始流式输出')

  // 等足够多的正文再停止,验证不是 0 字节的"伪中断"。
  while (s.events().filter((e) => e.type === 'delta').reduce((n, e) => n + (e.text?.length ?? 0), 0) < 40) {
    await sleep(20)
  }
  s.send({ cmd: 'conversation.cancel', conversationId, requestId: 'cancel-1' })

  const accepted = await s.waitForEvent(
    (e) => e.type === 'conversation.cancel' && e.requestId === 'cancel-1',
    5000
  )
  check(accepted?.accepted === true, '取消被立即受理:不排在本轮之后', JSON.stringify(accepted))

  const cancelled = await s.waitForEvent((e) => e.type === 'run.cancelled', 8000)
  check(Boolean(cancelled?.taskId), '收到 run.cancelled 且带任务 ID', JSON.stringify(cancelled))

  const beforeNext = s.events()
  check(!beforeNext.some((e) => e.type === 'done'), '取消后没有伪造 done 事件')
  check(!beforeNext.some((e) => e.type === 'error'), '取消没有被当成 AGENT_FAILED')

  const history = await s.call({ cmd: 'conversation.history', conversationId }, 'conversation.history')
  const assistants = (history?.messages ?? []).filter((m) => m.role === 'assistant')
  const partial = assistants.at(-1)
  const partialText = typeof partial?.content?.text === 'string' ? partial.content.text : ''
  check(partial?.status === 'interrupted', '部分回复状态为 interrupted', JSON.stringify(partial))
  check(partialText.length > 0, '部分回复已保留,不是空消息', partialText)
  check(
    partialText.startsWith('[mock:ask] 已读取') && partialText.length >= 24,
    '保留的是停止前已经推送给用户的文本',
    partialText
  )

  // 队列必须已经释放:同一会话立即再发一轮应当正常完成。
  s.send({
    text: '继续读取 package.json',
    mode: 'ask',
    conversationId,
    clientRequestId: 'cancel-turn-2'
  })
  const done = await s.waitForEvent((e) => e.type === 'done', 10000)
  check(Boolean(done), '取消后下一轮可正常完成', JSON.stringify(done))

  if (done) {
    const history2 = await s.call({ cmd: 'conversation.history', conversationId }, 'conversation.history')
    const allAssistants = (history2?.messages ?? []).filter((m) => m.role === 'assistant')
    check(allAssistants.length === 2, '两轮各自只有一条助手消息', `count=${allAssistants.length}`)
    check(allAssistants[0]?.status === 'interrupted', '第一轮仍是 interrupted')
    check(allAssistants[1]?.status === 'done', '第二轮是 done')

    s.send({ cmd: 'conversation.cancel', conversationId, requestId: 'cancel-2' })
    const idle = await s.waitForEvent(
      (e) => e.type === 'conversation.cancel' && e.requestId === 'cancel-2',
      5000
    )
    check(idle?.accepted === false, '空闲时取消返回 accepted=false', JSON.stringify(idle))
  }
} finally {
  await s.close()
}

const dbPath = join(dataDir, 'openwb.db')
if (existsSync(dbPath) && conversationId) {
  const db = new Database(dbPath, { readonly: true })
  const tasks = db
    .prepare('SELECT status, error_code FROM task WHERE conversation_id = ? ORDER BY created_at')
    .all(conversationId)
  check(tasks.length === 2, '数据库中有两轮任务', JSON.stringify(tasks))
  check(tasks[0]?.status === 'interrupted', '第一轮任务为 interrupted', JSON.stringify(tasks[0]))
  check(tasks[1]?.status === 'done', '第二轮任务为 done', JSON.stringify(tasks[1]))

  const messageRows = db
    .prepare("SELECT status, content_json FROM message WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq")
    .all(conversationId)
  const savedPartial = messageRows[0]
    ? JSON.parse(messageRows[0].content_json)
    : null
  check(messageRows[0]?.status === 'interrupted', '数据库中的部分回复为 interrupted')
  check(
    typeof savedPartial?.text === 'string' && savedPartial.text.length > 0,
    '数据库保留部分回复正文',
    JSON.stringify(savedPartial)
  )

  const cancelledEvents = db
    .prepare("SELECT count(*) AS n FROM event_log WHERE conversation_id = ? AND type = 'run.cancelled'")
    .get(conversationId)
  check(Number(cancelledEvents?.n) === 1, '审计链记录一次 run.cancelled', JSON.stringify(cancelledEvents))
  const failedEvents = db
    .prepare("SELECT count(*) AS n FROM event_log WHERE conversation_id = ? AND type = 'run.failed'")
    .get(conversationId)
  check(Number(failedEvents?.n) === 0, '取消不写入 run.failed', JSON.stringify(failedEvents))
  db.close()
}

await rm(base, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
