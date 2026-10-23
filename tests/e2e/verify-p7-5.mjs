/**
 * P7-5 团队协同验收(本地频道 + 待发队列 + 幂等同步)。
 * 用法: node tests/e2e/verify-p7-5.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 全程离线,但会起一个本地 mock HTTP 服务端模拟云侧:
 *   POST /v1/sync/events   按 eventId 去重
 *   POST /v1/artifacts     按 X-Event-Id 去重
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')

if (!existsSync(entry)) {
  console.error('缺少 daemon 产物,先执行: pnpm --filter @openwb/daemon build')
  process.exit(1)
}

const require = createRequire(resolve(root, 'apps/daemon/package.json'))
const Database = require('better-sqlite3')

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const encodeFrame = (value) => {
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

// ── mock 云侧 ───────────────────────────────────────────────────────────
const seenEvents = new Map()
const seenArtifacts = new Map()
const eventBatches = []
const artifactPosts = []
let healthy = true

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (b) => chunks.push(b))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!healthy) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'offline' }))
      return
    }
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    if (req.method === 'POST' && req.url === '/v1/sync/events') {
      const events = Array.isArray(body?.events) ? body.events : []
      eventBatches.push(events.map((e) => e.eventId))
      for (const e of events) seenEvents.set(e.eventId, e)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: events.length }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/artifacts') {
      const id = req.headers['x-event-id']
      artifactPosts.push({ id, body })
      seenArtifacts.set(id, body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const syncUrl = `http://127.0.0.1:${port}`

const base = await mkdtemp(join(tmpdir(), 'owb-p7-5-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const dbPath = join(dataDir, 'openwb.db')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'p7-5' }), 'utf8')

function spawnDaemon(env = {}) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      OPENWB_MOCK: '1',
      OPENWB_WORKSPACE: workspace,
      OPENWB_DATA_DIR: dataDir,
      OPENWB_MODES_DIR: resolve(root, 'resources/modes'),
      OPENWB_PROMPTS_DIR: resolve(root, 'resources/prompts'),
      OPENWB_AUTOMATION_AUTOSTART: '0',
      // 后台循环关掉:测试手动调用 sync.flush,避免时序抖动
      OPENWB_SYNC_URL: syncUrl,
      OPENWB_SYNC_INTERVAL_MS: '3600000',
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const chunks = []
  let err = ''
  const closed = new Promise((r) => child.on('close', (code) => r(code)))
  child.stdout.on('data', (b) => chunks.push(b))
  child.stderr.on('data', (b) => { err += String(b) })
  const events = () => decodeFrames(Buffer.concat(chunks))
  const waitFor = async (predicate, ms = 20_000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const hit = events().find(predicate)
      if (hit) return hit
      await sleep(40)
    }
    return null
  }
  let seq = 0
  const call = async (frame, type, ms = 20_000) => {
    const requestId = `r${++seq}`
    child.stdin.write(encodeFrame({ ...frame, requestId }))
    return waitFor((e) => e.type === type && e.requestId === requestId, ms)
  }
  const stop = async () => {
    if (child.stdin.writable) child.stdin.end()
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 10_000))
    const code = await Promise.race([closed, timeout])
    if (code === 'timeout') {
      child.kill()
      await closed
    }
    return code
  }
  return { child, events, waitFor, call, stop, get err() { return err } }
}

let d
try {
  d = spawnDaemon()
  const ready = await d.waitFor((e) => e.type === 'ready')
  check(!!ready, 'daemon-ready', d.err.slice(-300))

  // ── 1. 频道生命周期 ───────────────────────────────────────────────────
  const created = await d.call({ cmd: 'channel.create', name: '产品设计' }, 'channel.created')
  const channelId = created?.channel?.id
  check(!!channelId, 'channel-created', JSON.stringify(created))
  check(created?.channel?.name === '产品设计', 'channel-name-normalized')

  const dup = await d.call({ cmd: 'channel.create', name: '产品设计' }, 'channel.created')
  check(dup?.channel?.id === channelId, 'duplicate-channel-reused')

  const list = await d.call({ cmd: 'channel.list' }, 'channel.list')
  check(list?.channels?.length === 1, 'channel-listed-once', JSON.stringify(list?.channels))
  check(list?.channels?.[0]?.conversationCount === 0, 'empty-channel-zero-conversations')

  // ── 2. 频道会话事件自动入队 ───────────────────────────────────────────
  const conv = await d.call(
    { cmd: 'conversation.new', title: '频道任务', mode: 'craft', channelId },
    'conversation.created'
  )
  const conversationId = conv?.conversationId
  check(!!conversationId, 'channel-conversation-created')

  const done = await (async () => {
    const before = d.events().filter((e) => e.type === 'done').length
    d.child.stdin.write(encodeFrame({ text: '生成一份报告并交付', mode: 'craft', conversationId }))
    const start = Date.now()
    while (Date.now() - start < 20_000) {
      const list = d.events().filter((e) => e.type === 'done')
      if (list.length > before) return list[list.length - 1]
      await sleep(40)
    }
    return null
  })()
  check(!!done, 'channel-run-finished', d.err.slice(-300))

  const convList = await d.call({ cmd: 'conversation.list' }, 'conversation.list')
  const mine = convList?.conversations?.find((c) => c.id === conversationId)
  check(mine?.channelId === channelId, 'conversation-has-channel', JSON.stringify(mine))
  check(mine?.channelName === '产品设计', 'conversation-has-channel-name', JSON.stringify(mine))
  const local = convList?.conversations?.find((c) => !c.channelId)
  check(!!local, 'local-conversation-still-exists')

  const db = new Database(dbPath, { readonly: true })
  const queued = db
    .prepare("SELECT id, kind, seq, sent_at FROM pending_event ORDER BY seq")
    .all()
  db.close()
  check(queued.length >= 2, 'events-enqueued', JSON.stringify(queued))
  check(queued.every((q) => q.kind === 'event'), 'only-events-queued-before-share', JSON.stringify(queued))
  check(queued.every((q) => q.sent_at === null), 'queue-not-sent-yet', JSON.stringify(queued))

  const seqs = queued.map((q) => q.seq)
  check(seqs.every((n, i) => i === 0 || n > seqs[i - 1]), 'queue-seq-monotonic', JSON.stringify(seqs))

  // ── 3. 服务端不可达:失败保留队列 ─────────────────────────────────────
  healthy = false
  const firstFlush = await d.call({ cmd: 'sync.flush' }, 'sync.flushed')
  check(firstFlush?.stopped === true, 'flush-stops-on-failure', JSON.stringify(firstFlush))
  check(!!firstFlush?.lastError?.includes('503'), 'flush-surfaces-http-status', JSON.stringify(firstFlush))

  const db2 = new Database(dbPath, { readonly: true })
  const afterFail = db2.prepare('SELECT id, sent_at, attempts, last_error FROM pending_event ORDER BY seq').all()
  db2.close()
  check(afterFail.every((q) => q.sent_at === null), 'queue-survives-failure', JSON.stringify(afterFail))
  check(afterFail.every((q) => q.attempts === 1), 'failure-counted', JSON.stringify(afterFail))
  check(afterFail.every((q) => q.last_error), 'failure-reason-recorded', JSON.stringify(afterFail))
  check(seenEvents.size === 0, 'nothing-accepted-while-down')

  // ── 4. 恢复后按序重放,且 resend 幂等 ────────────────────────────────
  healthy = true
  const secondFlush = await d.call({ cmd: 'sync.flush', retryFailed: true }, 'sync.flushed')
  check(secondFlush?.stopped === false, 'flush-recovers', JSON.stringify(secondFlush))
  check(secondFlush?.sentEvents >= 2, 'events-sent-after-recovery', JSON.stringify(secondFlush))
  check(secondFlush?.queue?.pending === 0, 'queue-drained', JSON.stringify(secondFlush?.queue))
  check(seenEvents.size >= 2, 'server-received-events', String(seenEvents.size))
  check(eventBatches.length >= 1, 'server-got-event-batch', JSON.stringify(eventBatches))
  const flat = eventBatches.flat()
  check(new Set(flat).size === flat.length, 'no-duplicate-event-in-wire-batches', JSON.stringify(eventBatches))

  const sentIds = [...seenEvents.keys()]
  const db3 = new Database(dbPath, { readonly: true })
  const sentRows = db3.prepare('SELECT id FROM pending_event ORDER BY seq').all()
  db3.close()
  check(
    sentRows.every((r) => sentIds.includes(r.id)),
    'wire-event-id-matches-local-id',
    JSON.stringify({ sentIds, sentRows })
  )

  // 再发一次:队列已清空,不得重复上报
  const before = eventBatches.length
  const thirdFlush = await d.call({ cmd: 'sync.flush' }, 'sync.flushed')
  check(thirdFlush?.sentEvents === 0, 'resend-is-idempotent', JSON.stringify(thirdFlush))
  check(eventBatches.length === before, 'no-extra-network-call-when-empty')

  // ── 5. 产物转发与 /v1/artifacts ──────────────────────────────────────
  const artifactEvent = d.events().find((e) => e.type === 'artifact.created')
  const artifactId = artifactEvent?.artifact?.id
  check(!!artifactId, 'artifact-created-in-channel', JSON.stringify(artifactEvent))

  const shared = await d.call(
    { cmd: 'channel.shareArtifact', channelId, artifactId },
    'channel.artifactShared'
  )
  check(shared?.shared === true, 'artifact-shared', JSON.stringify(shared))
  check(shared?.artifacts?.length === 1, 'channel-lists-shared-artifact', JSON.stringify(shared?.artifacts))

  const sharedAgain = await d.call(
    { cmd: 'channel.shareArtifact', channelId, artifactId },
    'channel.artifactShared'
  )
  check(sharedAgain?.shared === false, 'share-is-idempotent')

  const flush4 = await d.call({ cmd: 'sync.flush' }, 'sync.flushed')
  check(flush4?.sentArtifacts === 1, 'artifact-uploaded', JSON.stringify(flush4))
  check(artifactPosts.length === 1, 'artifact-posted-once', JSON.stringify(artifactPosts))
  check(artifactPosts[0]?.body?.channelId === channelId, 'artifact-payload-has-channel')
  check(artifactPosts[0]?.body?.artifactId === artifactId, 'artifact-payload-has-artifact')
  check(typeof artifactPosts[0]?.id === 'string', 'artifact-post-has-idempotency-key', JSON.stringify(artifactPosts[0]))

  const flush5 = await d.call({ cmd: 'sync.flush' }, 'sync.flushed')
  check(flush5?.sentArtifacts === 0, 'artifact-resend-idempotent', JSON.stringify(flush5))
  check(artifactPosts.length === 1, 'artifact-posted-still-once')

  const status = await d.call({ cmd: 'sync.status' }, 'sync.status')
  check(status?.configured === true, 'sync-status-configured', JSON.stringify(status))
  check(status?.pending === 0, 'sync-status-empty', JSON.stringify(status))
  check(status?.lastError === null, 'sync-status-clear-error', JSON.stringify(status))

  // ── 6. 删除频道不连坐会话 ────────────────────────────────────────────
  const removed = await d.call({ cmd: 'channel.delete', channelId }, 'channel.deleted')
  check(removed?.channelId === channelId, 'channel-deleted')
  const afterList = await d.call({ cmd: 'channel.list' }, 'channel.list')
  check(afterList?.channels?.length === 0, 'channel-list-empty-after-delete')
  const convAfter = await d.call({ cmd: 'conversation.list' }, 'conversation.list')
  const kept = convAfter?.conversations?.find((c) => c.id === conversationId)
  check(!!kept, 'conversation-survives-channel-delete', JSON.stringify(kept))
  check(kept?.channelId === null, 'conversation-detached', JSON.stringify(kept))

  await d.stop()
} finally {
  if (d && d.child.exitCode === null) d.child.kill()
  server.close()
  await rm(base, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nP7-5 全部通过' : `\nP7-5 失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
