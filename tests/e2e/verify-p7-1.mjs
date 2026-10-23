/**
 * P7-1 交付物模型验收。
 * 用法: node tests/e2e/verify-p7-1.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 全程离线:OPENWB_MOCK=1。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const entry = resolve(root, 'apps/daemon/dist/index.js')
const require = createRequire(resolve(root, 'apps/daemon/package.json'))
const Database = require('better-sqlite3')

if (!existsSync(entry)) {
  console.error('缺少 daemon 产物,先执行: pnpm --filter @openwb/daemon build')
  process.exit(1)
}

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const base = await mkdtemp(join(tmpdir(), 'owb-p7-1-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const dbPath = join(dataDir, 'openwb.db')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'p7-1' }), 'utf8')

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
    try {
      out.push(JSON.parse(json))
    } catch {
      out.push({ type: 'PARSE_ERROR', raw: json })
    }
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function spawnDaemon() {
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
  const closed = new Promise((r) => child.on('close', (code) => r(code)))
  child.stdout.on('data', (b) => chunks.push(b))
  child.stderr.on('data', (b) => { err += String(b) })
  const events = () => decodeFrames(Buffer.concat(chunks))
  const waitFor = async (predicate, ms = 20_000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const hit = events().find(predicate)
      if (hit) return hit
      await sleep(50)
    }
    return null
  }
  const send = (frame) => child.stdin.write(encodeFrame(frame))
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
  return { child, events, waitFor, send, stop, get err() { return err } }
}

let d
try {
  // ── 1. 正常交付:生成文件 → present_files → 卡片事件 + 落库 ─────────────
  d = spawnDaemon()
  await d.waitFor((e) => e.type === 'ready')
  d.send({ text: '生成一份报告并交付', mode: 'craft' })
  const done = await d.waitFor((e) => e.type === 'done')
  const created = d.events().filter((e) => e.type === 'artifact.created')

  check(!!done, 'run-finished', JSON.stringify(d.events().map((e) => e.type)))
  check(created.length === 1, 'artifact-created-event', JSON.stringify(created))
  const card = created[0]?.artifact
  check(card?.kind === 'file', 'artifact-kind-file', JSON.stringify(card))
  check(card?.title === 'Mock 报告', 'artifact-title', JSON.stringify(card))
  check(typeof card?.sha256 === 'string' && card.sha256.length === 64, 'artifact-sha256', JSON.stringify(card?.sha256))
  check(card?.path === 'out/mock-report.md', 'artifact-path', JSON.stringify(card?.path))

  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare('SELECT * FROM artifact').all()
  check(rows.length === 1, 'artifact-row-inserted', JSON.stringify(rows))
  check(rows[0]?.conversation_id != null, 'artifact-conversation-linked', JSON.stringify(rows[0]))
  check(rows[0]?.size > 0, 'artifact-size-recorded', String(rows[0]?.size))

  // ── 2. 历史回放带上交付物 ─────────────────────────────────────────────
  const convId = d.events().find((e) => e.type === 'conversation.ready')?.conversationId
  d.send({ cmd: 'conversation.history', conversationId: convId, requestId: 'h1' })
  const history = await d.waitFor((e) => e.type === 'conversation.history' && e.requestId === 'h1')
  check(history?.artifacts?.length === 1, 'history-includes-artifacts', JSON.stringify(history?.artifacts))
  db.close()

  await d.stop()
} finally {
  if (d && d.child.exitCode === null) d.child.kill()
  await rm(base, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nP7-1 全部通过' : `\nP7-1 失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
