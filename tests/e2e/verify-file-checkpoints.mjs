/**
 * 文件检查点验收。
 *
 * 覆盖:
 *   - 每轮开始抓基线、结束抓结果,同一轮只有一条检查点;
 *   - 回退到较早版本时,被后续轮次覆盖的文件恢复成目标轮的版本;
 *   - 回退时被后续轮次删除的文件能重新出现;
 *   - 重放某轮前先把该轮之前的文件状态恢复,再重新生成;
 *   - 与轮次无关的用户文件不会被删除;
 *   - 事件里带回 files 统计,界面能知道文件是否真的回退了。
 *
 * 用法: node tests/e2e/verify-file-checkpoints.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  const call = async (frame, type, timeoutMs = 20000) => {
    const requestId = frame.requestId ?? `r-${Math.random().toString(36).slice(2, 8)}`
    send({ ...frame, requestId })
    return waitForEvent(
      (e) => e.requestId === requestId && (e.type === type || e.type === 'error'),
      timeoutMs
    )
  }
  const mark = () => {
    cursor = events().length
  }
  const sinceMark = () => events().slice(cursor)
  const close = async () => {
    child.stdin.end()
    await Promise.race([closed, sleep(5000)])
    child.kill()
  }
  return { send, call, waitForEvent, events, mark, sinceMark, close, stderr: () => err }
}

const readOrNull = async (path) => await readFile(path, 'utf8').catch(() => null)

const base = await mkdtemp(join(tmpdir(), 'owb-checkpoint-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const reportPath = join(workspace, 'out', 'mock-report.md')
const manualPath = join(workspace, 'notes', 'manual.txt')
await mkdir(workspace, { recursive: true })
await mkdir(dirname(manualPath), { recursive: true })
await writeFile(join(workspace, 'package.json'), '{"name":"checkpoint-e2e"}\n', 'utf8')
// 用户手工文件:任何一轮都没有碰过它,回退不能把它当成本轮产物删掉。
await writeFile(manualPath, '手工笔记\n', 'utf8')

const s = openSession(workspace, dataDir)
try {
  check(Boolean(await s.waitForEvent((e) => e.type === 'ready')), 'daemon 启动')
  const created = await s.call({ cmd: 'conversation.new', title: '检查点测试' }, 'conversation.created')
  const conversationId = created?.conversationId ?? ''
  check(Boolean(conversationId), '创建测试会话')

  const runTurn = async (text, requestId) => {
    s.send({ text, mode: 'craft', conversationId, clientRequestId: requestId })
    const ready = await s.waitForEvent((e) => e.type === 'conversation.ready')
    const done = await s.waitForEvent((e) => e.type === 'done')
    return { userId: ready?.messageId, assistantId: done?.messageId }
  }

  const turn1 = await runTurn('请生成第一轮报告', 'cp-t1')
  const firstBody = await readOrNull(reportPath)
  check(typeof firstBody === 'string' && firstBody.includes('第一轮报告'), '第一轮写出了报告', String(firstBody))

  const turn2 = await runTurn('请生成第二轮报告', 'cp-t2')
  const secondBody = await readOrNull(reportPath)
  check(typeof secondBody === 'string' && secondBody.includes('第二轮报告'), '第二轮覆盖了同一个文件', String(secondBody))

  // 回退到第一轮:文件要回到第一轮的内容,无关文件不能被删。
  s.mark()
  s.send({ cmd: 'conversation.revert', conversationId, messageId: turn1.userId })
  const reverted = await s.waitForEvent((e) => e.type === 'conversation.reverted', 15000)
  check(Boolean(reverted), '收到回退事件', JSON.stringify(reverted ?? {}))
  const afterRevert = await readOrNull(reportPath)
  check(afterRevert === firstBody, '回退后文件恢复到第一轮内容', String(afterRevert))
  check((await readOrNull(manualPath)) === '手工笔记\n', '与轮次无关的用户文件保留')
  check(reverted?.files?.applied === true, '事件标记文件已回退', JSON.stringify(reverted?.files ?? {}))
  check((reverted?.files?.restored ?? 0) >= 1, '事件报告恢复了文件数', JSON.stringify(reverted?.files ?? {}))
  check((reverted?.files?.touched ?? 0) >= 1, '事件报告触碰的路径数', JSON.stringify(reverted?.files ?? {}))
  const afterRevertIds = (reverted?.messages ?? []).map((m) => m.id)
  check(afterRevertIds.includes(turn1.userId) && !afterRevertIds.includes(turn2.userId), '回退只删掉后续轮次')

  // 重放第一轮:先回到该轮之前(还没有报告),再重新生成。
  s.mark()
  s.send({ cmd: 'conversation.replay', conversationId, messageId: turn1.userId })
  const replayed = await s.waitForEvent((e) => e.type === 'conversation.replayed', 15000)
  check(Boolean(replayed), '收到重放事件', JSON.stringify(replayed ?? {}))
  check(replayed?.files?.applied === true, '重放也执行了文件回退', JSON.stringify(replayed?.files ?? {}))
  const done = await s.waitForEvent((e) => e.type === 'done', 20000)
  check(Boolean(done?.messageId), '重放重新生成答复', JSON.stringify(done ?? {}))
  const afterReplay = await readOrNull(reportPath)
  check(typeof afterReplay === 'string' && afterReplay.includes('第一轮报告'), '重放重新生成同一份报告', String(afterReplay))
  check((await readOrNull(manualPath)) === '手工笔记\n', '重放不影响无关文件')
  check(!s.sinceMark().some((e) => e.type === 'error'), '重放过程没有报错', JSON.stringify(s.sinceMark().filter((e) => e.type === 'error')))
} finally {
  await s.close()
}

// 第二轮删除文件后回退,文件必须重新出现。
const s2 = openSession(workspace, dataDir)
try {
  const created = await s2.call({ cmd: 'conversation.new', title: '删除恢复测试' }, 'conversation.created')
  const conversationId = created?.conversationId ?? ''
  const runTurn = async (text, requestId) => {
    s2.send({ text, mode: 'craft', conversationId, clientRequestId: requestId })
    const ready = await s2.waitForEvent((e) => e.type === 'conversation.ready')
    const done = await s2.waitForEvent((e) => e.type === 'done')
    return { userId: ready?.messageId, assistantId: done?.messageId }
  }
  const turn1 = await runTurn('请生成第三轮报告', 'cp-del-t1')
  const beforeDelete = await readOrNull(reportPath)
  check(typeof beforeDelete === 'string' && beforeDelete.includes('第三轮报告'), '准备出待删除文件', String(beforeDelete))

  // 删除属于破坏性操作,必须走真实审批:批准后才允许落盘。
  s2.send({ cmd: 'approval.ready', requestId: 'cp-approval-ready' })
  await s2.waitForEvent((e) => e.type === 'approval.ready')
  s2.send({ text: 'delete_files:["out/mock-report.md"]', mode: 'craft', conversationId, clientRequestId: 'cp-del-t2' })
  const ready = await s2.waitForEvent((e) => e.type === 'conversation.ready')
  const approval = await s2.waitForEvent((e) => e.type === 'approval.request')
  check(Boolean(approval?.request?.id), '删除前弹出审批', JSON.stringify(approval ?? {}))
  s2.send({ cmd: 'approval.respond', approvalId: approval.request.id, approved: true, scope: 'once' })
  const done = await s2.waitForEvent((e) => e.type === 'done')
  const turn2 = { userId: ready?.messageId, assistantId: done?.messageId }
  check((await readOrNull(reportPath)) === null, '第二轮删除了文件')

  s2.mark()
  s2.send({ cmd: 'conversation.revert', conversationId, messageId: turn1.userId })
  const reverted = await s2.waitForEvent((e) => e.type === 'conversation.reverted', 15000)
  check(Boolean(reverted), '删除场景回退事件到达', JSON.stringify(reverted ?? {}))
  const restored = await readOrNull(reportPath)
  check(restored === beforeDelete, '回退恢复了被删除的文件', String(restored))
  check((reverted?.files?.deleted ?? 0) === 1 || (reverted?.files?.restored ?? 0) === 1, '删除恢复计入统计', JSON.stringify(reverted?.files ?? {}))
  check(Boolean(turn2?.userId), '破坏性轮次已落库')
} finally {
  await s2.close()
}

// 数据库层核对:每轮一条检查点,且都带 before/after。
const db = new Database(join(dataDir, 'openwb.db'), { readonly: true })
const rows = db
  .prepare(
    'select conversation_id as cid, message_seq as seq, before_json as before, after_json as after from file_checkpoint order by conversation_id, message_seq'
  )
  .all()
const userMessages = db
  .prepare("select count(*) as n from message where role = 'user'")
  .get()
db.close()
// 被回退/重放截断的轮次会级联清理检查点,因此不变量是"每条存活的用户消息恰好一条"。
check(rows.length === 2, '存活轮次各有检查点', JSON.stringify(rows.map((r) => `${r.cid}:${r.seq}`)))
check(rows.length === userMessages.n, '检查点数与存活用户消息数一致', `${rows.length} vs ${userMessages.n}`)
check(
  rows.every((r) => typeof r.before === 'string' && r.before.length > 0),
  '每轮都有基线快照',
  JSON.stringify(rows.map((r) => Boolean(r.before)))
)
check(
  rows.every((r) => typeof r.after === 'string' && r.after.length > 0),
  '每轮都有结果快照',
  JSON.stringify(rows.map((r) => Boolean(r.after)))
)
const keys = rows.map((r) => `${r.cid}:${r.seq}`)
check(new Set(keys).size === keys.length, '同一会话同一轮只有一条检查点', JSON.stringify(keys))

if (failed > 0) {
  const err = s.stderr().trim() || s2.stderr().trim()
  if (err) console.log(`--- daemon stderr ---\n${err.split('\n').slice(-12).join('\n')}`)
}
await rm(base, { recursive: true, force: true }).catch(() => undefined)
process.exit(failed === 0 ? 0 : 1)
