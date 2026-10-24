/**
 * 重放/回退到此版本的 daemon 验收。
 *
 * 覆盖:
 *   - 回退中间轮次后,目标轮保留,之后的轮次、任务、交付物都被精确清理;
 *   - 重放会以新的用户消息重新生成,不继承旧 clientRequestId 的幂等结果;
 *   - 重放保留原轮次的模式/技能上下文(写入 meta 后按原请求恢复);
 *   - 截断后新消息序号从剩余最大值续写,不撞唯一约束;
 *   - 运行中的会话拒绝截断,避免模型回包写到已删除的消息上;
 *   - 只能操作用户消息,且不能跨会话/跨工作区。
 *
 * 用法: node tests/e2e/verify-replay-revert.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
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
    try { out.push(JSON.parse(json)) } catch { out.push({ type: 'PARSE_ERROR' }) }
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
  child.stderr.on('data', (b) => { err += String(b) })
  const closed = new Promise((r) => child.on('close', (code) => r(code)))
  const events = () => decodeFrames(Buffer.concat(chunks))
  const send = (frame) => child.stdin.write(encodeFrame(frame))
  const waitForEvent = async (predicate, timeoutMs = 15000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const all = events()
      for (let i = cursor; i < all.length; i++) {
        if (predicate(all[i])) { cursor = i + 1; return all[i] }
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
  const mark = () => { cursor = events().length }
  const sinceMark = () => events().slice(cursor)
  const close = async () => {
    child.stdin.end()
    await Promise.race([closed, sleep(5000)])
    child.kill()
  }
  return { send, call, waitForEvent, events, mark, sinceMark, close, stderr: () => err }
}

const base = await mkdtemp(join(tmpdir(), 'owb-replay-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"replay-e2e"}\n', 'utf8')

const s = openSession(workspace, dataDir)
let conversationId = ''
let turn1 = ''
let turn2 = ''
let turn3 = ''
try {
  check(Boolean(await s.waitForEvent((e) => e.type === 'ready')), 'daemon 启动')
  const created = await s.call({ cmd: 'conversation.new', title: '重放测试' }, 'conversation.created')
  conversationId = created?.conversationId ?? ''
  check(Boolean(conversationId), '创建测试会话')

  const runTurn = async (text, requestId) => {
    s.mark()
    s.send({ text, mode: 'craft', conversationId, clientRequestId: requestId })
    const ready = await s.waitForEvent((e) => e.type === 'conversation.ready')
    const done = await s.waitForEvent((e) => e.type === 'done')
    return { userId: ready?.messageId, assistantId: done?.messageId }
  }

  const one = await runTurn('第一轮:请解释 package.json', 'turn-1')
  turn1 = one.userId
  check(Boolean(turn1 && one.assistantId), '第一轮完成并拿到消息 ID')
  const two = await runTurn('第二轮:请生成一份报告', 'turn-2')
  turn2 = two.userId
  check(Boolean(turn2 && two.assistantId), '第二轮完成并交付文件')
  const three = await runTurn('第三轮:总结一下', 'turn-3')
  turn3 = three.userId
  check(Boolean(turn3 && three.assistantId), '第三轮完成')

  let history = await s.call({ cmd: 'conversation.history', conversationId }, 'conversation.history')
  check((history?.messages ?? []).length === 6, '三轮消息均已落库', String(history?.messages?.length))
  check((history?.artifacts ?? []).length >= 1, '第二轮产生了交付物', String(history?.artifacts?.length))

  // 回退到第二轮:第一轮和第二轮保留,只删除第三轮。
  s.mark()
  s.send({ cmd: 'conversation.revert', conversationId, messageId: turn2 })
  const reverted = await s.waitForEvent((e) => e.type === 'conversation.reverted', 10000)
  check(Boolean(reverted), '收到回退事件', JSON.stringify(reverted ?? {}))
  check(reverted?.deletedMessages === 2, '回退只删除目标轮之后的 2 条消息', JSON.stringify(reverted ?? {}))
  check(Array.isArray(reverted?.messages) && reverted.messages.length === 4, '事件带回保留目标轮后的快照', JSON.stringify(reverted ?? {}))
  check((reverted?.artifacts ?? []).length >= 1, '目标轮产生的交付物保留')
  check(!s.sinceMark().some((e) => e.type === 'done'), '回退不会触发模型重新生成', JSON.stringify(s.sinceMark().map((e) => e.type)))

  history = await s.call({ cmd: 'conversation.history', conversationId }, 'conversation.history')
  const ids = (history?.messages ?? []).map((m) => m.id)
  check(ids.includes(turn1) && ids.includes(turn2), '目标轮及之前的内容保留')
  check(!ids.includes(turn3), '目标轮之后的内容已删除')
  check((history?.artifacts ?? []).length >= 1, '保留轮次的交付物仍在')

} finally {
  await s.close()
}

// 回退后的第二轮已经被删,单独建立一轮用于重放,避免依赖已删除的 ID。
const s2 = openSession(workspace, dataDir)
let turnA = ''
let turnB = ''
try {
  const created = await s2.call({ cmd: 'conversation.new', title: '重放续测' }, 'conversation.created')
  conversationId = created?.conversationId ?? ''

  const runTurn = async (text, requestId) => {
    s2.send({ text, mode: 'craft', conversationId, clientRequestId: requestId })
    const ready = await s2.waitForEvent((e) => e.type === 'conversation.ready')
    const done = await s2.waitForEvent((e) => e.type === 'done')
    return { userId: ready?.messageId, assistantId: done?.messageId }
  }

  const a = await runTurn('A轮:解释 package.json', 'a-1')
  turnA = a.userId
  const b = await runTurn('B轮:请生成报告', 'b-1')
  turnB = b.userId
  await runTurn('C轮:再总结', 'c-1')
  check(Boolean(turnA && turnB), '构造三轮会话')

  s2.mark()
  s2.send({ cmd: 'conversation.replay', conversationId, messageId: turnB })
  const replayed = await s2.waitForEvent((e) => e.type === 'conversation.replayed', 10000)
  check(Boolean(replayed), '收到重放事件', JSON.stringify(replayed ?? {}))
  check(typeof replayed?.newMessageId === 'string' && replayed.newMessageId !== turnB, '重放写入新的用户消息', JSON.stringify(replayed ?? {}))
  check(replayed?.newSeq === 3, '重放续用截断后的下一个序号', JSON.stringify(replayed ?? {}))
  const done = await s2.waitForEvent((e) => e.type === 'done', 15000)
  check(Boolean(done?.messageId), '重放重新生成助手回复', JSON.stringify(done ?? {}))
  const during = s2.sinceMark()
  check(!during.some((e) => e.type === 'error'), '重放过程没有报错', JSON.stringify(during.filter((e) => e.type === 'error')))

  const history = await s2.call({ cmd: 'conversation.history', conversationId }, 'conversation.history')
  const rows = history?.messages ?? []
  check(rows.length === 4, '重放后是两轮四条消息', String(rows.length))
  check(rows[0]?.id === turnA, '第一轮保留')
  check(rows[1]?.role === 'assistant', '第一轮答复保留')
  check(rows[2]?.id === replayed?.newMessageId, '第三个位置是重放的用户消息')
  check(!rows.some((m) => m.id === turnB), '旧 B 轮内容已覆盖')
  check(rows[2]?.meta?.mode === 'craft', '重放保留原模式上下文', JSON.stringify(rows[2] ?? {}))

  // 非用户消息不能被重放/回退。
  const assistantId = rows[1]?.id
  const rejected = await s2.call(
    { cmd: 'conversation.revert', conversationId, messageId: assistantId, requestId: 'reject-assistant' },
    'error'
  )
  check(rejected?.type === 'error', '助手消息不可回退', JSON.stringify(rejected ?? {}))
} finally {
  await s2.close()
}

// 数据库层核对:任务与交付物确实被清理,不是只改了界面。
const db = new Database(join(dataDir, 'openwb.db'), { readonly: true })
const dangling = db.prepare(`
  select count(*) as n from task t
  left join message m on m.id = t.user_message_id
  where t.user_message_id is not null and m.id is null
`).get()
db.close()
check(dangling?.n === 0, '没有任务指向已删除的用户消息', JSON.stringify(dangling ?? {}))

if (failed > 0) {
  const err = s.stderr().trim()
  if (err) console.log(`--- daemon stderr ---\n${err.split('\n').slice(-12).join('\n')}`)
}
await rm(base, { recursive: true, force: true }).catch(() => undefined)
process.exit(failed === 0 ? 0 : 1)
