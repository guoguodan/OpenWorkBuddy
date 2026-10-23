/**
 * P7-4 全局搜索验收。
 * 用法: node tests/e2e/verify-p7-4.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 全程离线:OPENWB_MOCK=1。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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

let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`PASS ${label}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const base = await mkdtemp(join(tmpdir(), 'owb-p7-4-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'p7-4' }), 'utf8')

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
let stderr = ''
child.stdout.on('data', (b) => chunks.push(b))
child.stderr.on('data', (b) => { stderr += String(b) })
const closed = new Promise((r) => child.on('close', (code) => r(code)))
const events = () => decodeFrames(Buffer.concat(chunks))

async function waitFor(predicate, ms = 20_000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = events().find(predicate)
    if (hit) return hit
    await sleep(40)
  }
  return null
}

const send = (frame) => child.stdin.write(encodeFrame(frame))
let requestSeq = 0
async function query(q) {
  const requestId = `s${++requestSeq}`
  send({ cmd: 'search.query', query: q, requestId })
  const reply = await waitFor((e) => e.type === 'search.result' && e.requestId === requestId)
  return reply
}

async function run(text) {
  const before = events().filter((e) => e.type === 'done').length
  send({ text, mode: 'craft' })
  const start = Date.now()
  while (Date.now() - start < 20_000) {
    const done = events().filter((e) => e.type === 'done')
    if (done.length > before) return done[done.length - 1]
    await sleep(40)
  }
  return null
}

try {
  const ready = await waitFor((e) => e.type === 'ready')
  check(!!ready, 'daemon-ready', stderr.slice(-300))

  // ── 1. 中文消息:能命中,且带上跳转所需的 conversationId + seq ──────────
  const first = await run('请记住关键词 alpha,我们聊聊产品设计')
  check(!!first, 'first-run-finished', stderr.slice(-300))
  const convId = first?.conversationId

  const zh = await query('产品设计')
  const messages = zh?.groups?.find((g) => g.group === 'message')
  check((messages?.items?.length ?? 0) > 0, 'chinese-message-hit', JSON.stringify(zh?.groups))
  check(messages?.items?.[0]?.conversationId === convId, 'hit-conversation-id', JSON.stringify(messages?.items?.[0]))
  check(typeof messages?.items?.[0]?.seq === 'number', 'hit-has-seq', JSON.stringify(messages?.items?.[0]))
  check(
    /产品设计/.test(messages?.items?.[0]?.snippet ?? ''),
    'hit-snippet-contains-query',
    JSON.stringify(messages?.items?.[0]?.snippet)
  )
  check(messages?.items?.[0]?.conversationTitle?.length > 0, 'hit-conversation-title', JSON.stringify(messages?.items?.[0]))

  // ── 2. 交付物与任务分组 ────────────────────────────────────────────────
  const second = await run('生成一份季度复盘报告并交付')
  check(!!second, 'delivery-run-finished', stderr.slice(-300))

  const artifactResult = await query('Mock')
  const artifactGroup = artifactResult?.groups?.find((g) => g.group === 'artifact')
  check((artifactGroup?.items?.length ?? 0) > 0, 'artifact-group-hit', JSON.stringify(artifactResult?.groups))
  check(artifactGroup?.items?.[0]?.title === 'Mock 报告', 'artifact-hit-title', JSON.stringify(artifactGroup?.items?.[0]))
  check(artifactGroup?.items?.[0]?.conversationId === convId, 'artifact-hit-conversation', JSON.stringify(artifactGroup?.items?.[0]))

  const taskResult = await query('季度复盘')
  const taskGroup = taskResult?.groups?.find((g) => g.group === 'task')
  check((taskGroup?.items?.length ?? 0) > 0, 'task-group-hit', JSON.stringify(taskResult?.groups))
  check(
    (taskGroup?.items?.[0]?.title ?? '').includes('季度复盘'),
    'task-hit-title',
    JSON.stringify(taskGroup?.items?.[0])
  )

  // ── 3. 每组最多 5 条,但 total 保留真实数量 ──────────────────────────────
  for (let i = 0; i < 3; i++) await run(`alpha 第 ${i} 次补充`)
  const capped = await query('alpha')
  const cappedMessages = capped?.groups?.find((g) => g.group === 'message')
  check((cappedMessages?.total ?? 0) > 5, 'total-exceeds-page-size', String(cappedMessages?.total))
  check(cappedMessages?.items?.length === 5, 'message-group-capped-at-5', String(cappedMessages?.items?.length))
  check(
    capped?.groups?.every((g) => g.items.length <= 5),
    'all-groups-capped',
    JSON.stringify(capped?.groups?.map((g) => [g.group, g.items.length]))
  )

  // ── 4. 特殊字符不产生 SQL/FTS 语法错误 ─────────────────────────────────
  for (const q of ['"', '*', 'a"b', '100%', 'a_b', '()', 'NEAR(', '\\']) {
    const r = await query(q)
    check(
      r?.type === 'search.result',
      `special-query-${JSON.stringify(q)}`,
      stderr.slice(-200)
    )
  }
  const errors = events().filter((e) => e.type === 'error')
  check(errors.length === 0, 'no-error-events', JSON.stringify(errors))

  check((await query('   '))?.groups?.length === 0, 'blank-query-empty')
} finally {
  if (child.stdin.writable) child.stdin.end()
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 10_000))
  const code = await Promise.race([closed, timeout])
  if (code === 'timeout') {
    child.kill()
    await closed
  }
  await rm(base, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nP7-4 全部通过' : `\nP7-4 失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
