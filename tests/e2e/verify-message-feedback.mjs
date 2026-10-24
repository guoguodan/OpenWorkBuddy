/**
 * 消息级工具栏的 daemon 验收。
 *
 * 覆盖:
 *   - 用户消息在 conversation.ready 中带回真实 ID;
 *   - 助手完成后 done 带回可反馈的消息 ID;
 *   - 点赞、点踩(带原因)、再次点击取消,均持久化到 message 表;
 *   - 刷新/重启后 conversation.history 仍返回反馈状态;
 *   - 用户消息不能通过反馈接口写入,防止伪造实体。
 *
 * 用法: node tests/e2e/verify-message-feedback.mjs
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
  return { send, call, waitForEvent, events, close, stderr: () => err }
}

const base = await mkdtemp(join(tmpdir(), 'owb-feedback-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
await (await import('node:fs/promises')).mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"feedback-e2e"}\n', 'utf8')

let conversationId
let userId
let assistantId

const first = openSession(workspace, dataDir)
try {
  const created = await first.call({ cmd: 'conversation.new', title: '新会话' }, 'conversation.created')
  conversationId = created?.conversationId
  check(Boolean(conversationId), '创建测试会话')

  first.send({ cmd: 'chat', conversationId, mode: 'ask', text: '请解释这段代码的结构' })
  const ready = await first.waitForEvent((e) => e.type === 'conversation.ready', 10000)
  userId = ready?.messageId
  check(Boolean(userId), 'conversation.ready 带用户消息 ID', JSON.stringify(ready ?? {}))

  const done = await first.waitForEvent((e) => e.type === 'done', 15000)
  assistantId = done?.messageId
  check(Boolean(assistantId), 'done 带助手消息 ID', JSON.stringify(done ?? {}))
  check(userId !== assistantId, '用户与助手使用不同消息 ID')

  const liked = await first.call(
    { cmd: 'message.feedback', messageId: assistantId, feedback: 'like' },
    'message.feedback'
  )
  check(liked?.feedback === 'like', '点赞写入成功', JSON.stringify(liked ?? {}))
  check(liked?.feedbackReason === null, '点赞不保留点踩原因', JSON.stringify(liked ?? {}))

  const disliked = await first.call(
    {
      cmd: 'message.feedback',
      messageId: assistantId,
      feedback: 'dislike',
      reason: 'code_error|返回中没有示例'
    },
    'message.feedback'
  )
  check(disliked?.feedback === 'dislike', '点踩切换成功', JSON.stringify(disliked ?? {}))
  check(
    disliked?.feedbackReason === 'code_error|返回中没有示例',
    '点踩原因一并保存',
    JSON.stringify(disliked ?? {})
  )

  const cleared = await first.call(
    { cmd: 'message.feedback', messageId: assistantId, feedback: null },
    'message.feedback'
  )
  check(cleared?.feedback === null && cleared?.feedbackReason === null, '再次点击可取消反馈', JSON.stringify(cleared ?? {}))

  const userRejected = await first.call(
    { cmd: 'message.feedback', messageId: userId, feedback: 'like', requestId: 'user-like' },
    'error'
  )
  check(userRejected?.type === 'error', '用户消息无法写入助手反馈', JSON.stringify(userRejected ?? {}))

  // 留下点踩状态,供重启后的恢复断言。
  await first.call(
    { cmd: 'message.feedback', messageId: assistantId, feedback: 'dislike', reason: 'misunderstanding' },
    'message.feedback'
  )
} finally {
  await first.close()
}

const second = openSession(workspace, dataDir)
try {
  const history = await second.call(
    { cmd: 'conversation.history', conversationId },
    'conversation.history'
  )
  const rows = history?.messages ?? []
  const user = rows.find((m) => m.id === userId)
  const assistant = rows.find((m) => m.id === assistantId)
  check(user?.role === 'user', '用户消息可从历史按 ID 找回')
  check(assistant?.feedback === 'dislike', '重启后仍能恢复点踩状态', JSON.stringify(assistant ?? {}))
  check(
    assistant?.feedbackReason === 'misunderstanding',
    '重启后仍能恢复点踩原因',
    JSON.stringify(assistant ?? {})
  )
} finally {
  await second.close()
}

const db = new Database(join(dataDir, 'openwb.db'), { readonly: true })
const row = db.prepare('select feedback, feedback_reason from message where id = ?').get(assistantId)
db.close()
check(row?.feedback === 'dislike', '数据库确实写入反馈', JSON.stringify(row ?? {}))
check(row?.feedback_reason === 'misunderstanding', '数据库确实写入原因', JSON.stringify(row ?? {}))

if (failed > 0) {
  const err = first.stderr().trim()
  if (err) console.log(`--- daemon stderr ---\n${err.split('\n').slice(-12).join('\n')}`)
}
await rm(base, { recursive: true, force: true }).catch(() => undefined)
process.exit(failed === 0 ? 0 : 1)
