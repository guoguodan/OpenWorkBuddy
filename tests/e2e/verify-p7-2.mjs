/**
 * P7-2 DELIVERY_MISSING 运行时兜底验收。
 * 用法: node tests/e2e/verify-p7-2.mjs
 * 前置: pnpm --filter @openwb/daemon build
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const base = await mkdtemp(join(tmpdir(), 'owb-p7-2-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const dbPath = join(dataDir, 'openwb.db')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'p7-2' }), 'utf8')

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
  const stop = async () => {
    if (child.stdin.writable) child.stdin.end()
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 10_000))
    const code = await Promise.race([closed, timeout])
    if (code === 'timeout') { child.kill(); await closed }
    return code
  }
  return { child, events, waitFor, send: (f) => child.stdin.write(encodeFrame(f)), stop, get err() { return err } }
}

let d
try {
  d = spawnDaemon()
  await d.waitFor((e) => e.type === 'ready')

  // 1. 写了文件但不交付 → 必须发 delivery.missing,任务标 DELIVERY_MISSING
  d.send({ text: '把结论写进文件,但不要交付', mode: 'craft' })
  const missing = await d.waitFor((e) => e.type === 'delivery.missing')
  check(!!missing, 'delivery-missing-event', JSON.stringify(d.events().map((e) => e.type)))
  check(missing?.code === 'DELIVERY_MISSING', 'delivery-missing-code', JSON.stringify(missing))
  check(d.events().filter((e) => e.type === 'artifact.created').length === 0, 'no-artifact-card-on-missing')

  const db = new Database(dbPath, { readonly: true })
  const row = db.prepare('SELECT status, error_code FROM task ORDER BY created_at DESC LIMIT 1').get()
  check(row?.status === 'done', 'task-still-done', JSON.stringify(row))
  check(row?.error_code === 'DELIVERY_MISSING', 'task-marked-delivery-missing', JSON.stringify(row))
  const evt = db.prepare("SELECT count(*) n FROM event_log WHERE type='delivery.missing'").get()
  check(evt?.n === 1, 'delivery-missing-persisted', JSON.stringify(evt))
  db.close()

  // 2. 正常交付不应误报
  d.send({ text: '生成一份报告并交付', mode: 'craft' })
  await d.waitFor((e) => e.type === 'done' && d.events().filter((x) => x.type === 'done').length >= 2)
  const missingCount = d.events().filter((e) => e.type === 'delivery.missing').length
  check(missingCount === 1, 'no-false-positive-when-delivered', String(missingCount))
  check(d.events().filter((e) => e.type === 'artifact.created').length === 1, 'delivered-has-card')

  // 3. 提示词硬约束存在(模型侧提醒与运行时兜底互为补充)
  const prompt = await readFile(resolve(root, 'resources/prompts/agent-loop.md'), 'utf8')
  check(/present_files/.test(prompt), 'prompt-requires-present-files')

  await d.stop()
} finally {
  if (d && d.child.exitCode === null) d.child.kill()
  await rm(base, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nP7-2 全部通过' : `\nP7-2 失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
