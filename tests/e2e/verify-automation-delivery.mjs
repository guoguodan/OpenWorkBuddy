/**
 * WM-AUTO-06 验收:自动化失败重试、连续失败阈值通知、工作流产物交付。
 *
 * 用法: node tests/e2e/verify-automation-delivery.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 全程离线:OPENWB_MOCK=1;失败由 OPENWB_WORKFLOW_MOCK_FAIL 注入。
 * 失败通知按"连续失败阈值"只发一条,不能因为每次新建会话而反复打扰。
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

const base = await mkdtemp(join(tmpdir(), 'owb-auto-e2e-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const dbPath = join(dataDir, 'openwb.db')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'auto-e2e' }), 'utf8')

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

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
      out.push({ type: 'PARSE_ERROR', raw: json })
    }
  }
  return out
}

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
      OPENWB_AUTOMATION_RETRY_BASE_MS: '0',
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const chunks = []
  let err = ''
  const closed = new Promise((resolveClose) => child.on('close', (code) => resolveClose(code)))
  child.stdout.on('data', (b) => chunks.push(b))
  child.stderr.on('data', (b) => {
    err += String(b)
  })
  const events = () => decodeFrames(Buffer.concat(chunks))
  const waitFor = async (predicate, ms = 30_000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const hit = events().find(predicate)
      if (hit) return hit
      await sleep(30)
    }
    return null
  }
  const send = (frame) => child.stdin.write(encodeFrame(frame))
  const stop = async () => {
    if (child.stdin.writable) child.stdin.end()
    const timeout = new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 10_000))
    const code = await Promise.race([closed, timeout])
    if (code === 'timeout') {
      child.kill()
      await closed
    }
    return code
  }
  return { child, events, waitFor, send, stop, get err() { return err } }
}

async function writeWorkflow(id, yaml) {
  const dir = join(workspace, '.openwb', 'workflows')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${id}.yaml`), yaml, 'utf8')
}

async function createAutomation(d, input) {
  d.send({ cmd: 'automation.create', ...input, requestId: `create-${input.name}` })
  const created = await d.waitFor((e) => e.type === 'automation.created' && e.automation?.name === input.name)
  if (!created) throw new Error(`创建自动化失败: ${input.name}\n${d.err}`)
  return created.automation
}

async function runScan(d, id, now, label) {
  const before = d.events().filter((e) => e.type === 'automation.finished' && e.id === id).length
  d.send({ cmd: 'automation.scan', now, requestId: `scan-${label}` })
  const scanned = await d.waitFor((e) => e.type === 'automation.scanned' && e.requestId === `scan-${label}`)
  if (!scanned?.claimed?.includes(id)) throw new Error(`扫描未领取任务 ${id}`)
  const start = Date.now()
  while (Date.now() - start < 30_000) {
    const finished = d.events().filter((e) => e.type === 'automation.finished' && e.id === id)
    if (finished.length > before) return finished[finished.length - 1]
    await sleep(30)
  }
  throw new Error(`等待 automation.finished 超时: ${label}\n${d.err}`)
}

function setNextRunAt(id, nextRunAt) {
  const db = new Database(dbPath)
  db.prepare('UPDATE automation SET next_run_at = ? WHERE id = ?').run(nextRunAt, id)
  db.close()
}

try {
  await writeWorkflow(
    'always-fail',
    `schemaVersion: 1
id: always-fail
name: 必然失败
mode: craft
inputs: []
outputs: []
phases:
  - id: only
    steps:
      - id: boom
        type: prompt
        prompt: "boom"
        save_as: out
        output: text
`
  )
  await writeWorkflow(
    'deliver-report',
    `schemaVersion: 1
id: deliver-report
name: 每日产物
mode: craft
inputs:
  - name: topic
    required: true
outputs:
  - name: report
    kind: file
    path: reports/{{run.id}}/report.md
phases:
  - id: draft
    steps:
      - id: write
        type: prompt
        prompt: "写一段关于 {{inputs.topic}} 的说明"
        save_as: report
        output: markdown
`
  )

  // ── 1. 单次执行内重试,耗尽后只计一次连续失败 ─────────────────────────
  {
    const d = spawnDaemon({ OPENWB_WORKFLOW_MOCK_FAIL: 'boom:99' })
    await d.waitFor((e) => e.type === 'ready')
    const automation = await createAutomation(d, {
      name: '阈值失败任务',
      scheduleType: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      timezone: 'Asia/Shanghai',
      prompt: '阈值失败任务',
      modeId: 'craft',
      workflowId: 'always-fail',
      maxAttempts: 2,
      failureThreshold: 2,
      nextRunAt: '2026-03-01T01:00:00.000Z'
    })
    check(automation.maxAttempts === 2 && automation.failureThreshold === 2, '1. 重试与阈值设置落库')

    const first = await runScan(d, automation.id, '2026-03-01T01:00:00.000Z', 'first')
    check(first.status === 'failed' && first.attempts === 2, '1b. 单次执行重试到上限', `${first.status}/${first.attempts}`)
    check(first.consecutiveFailures === 1 && first.shouldAlert === false, '1c. 重试不重复累计失败', JSON.stringify(first))

    setNextRunAt(automation.id, '2026-03-02T01:00:00.000Z')
    const second = await runScan(d, automation.id, '2026-03-02T01:00:00.000Z', 'second')
    check(second.consecutiveFailures === 2 && second.shouldAlert === true, '2. 达到阈值时提醒', JSON.stringify(second))

    setNextRunAt(automation.id, '2026-03-03T01:00:00.000Z')
    const third = await runScan(d, automation.id, '2026-03-03T01:00:00.000Z', 'third')
    check(third.consecutiveFailures === 3 && third.shouldAlert === false, '3. 同一段连续失败不再提醒', JSON.stringify(third))

    d.send({ cmd: 'notifications.list', requestId: 'ntf-list' })
    const listed = await d.waitFor((e) => e.type === 'notifications.list' && e.requestId === 'ntf-list')
    const alerts = (listed?.notifications ?? []).filter(
      (item) => item.biz === 'automation' && String(item.title).includes('阈值失败任务')
    )
    check(alerts.length === 1, '3b. 消息中心只有一条失败提醒', JSON.stringify(alerts.map((item) => item.title)))
    check(alerts[0]?.isPending === true, '3c. 失败提醒标记为待处理')
    await d.stop()
  }

  // ── 4. 工作流产物写入 artifact 表,并能从会话历史查询 ──────────────────
  {
    const d = spawnDaemon()
    await d.waitFor((e) => e.type === 'ready')
    const automation = await createAutomation(d, {
      name: '每日产物任务',
      scheduleType: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      timezone: 'Asia/Shanghai',
      prompt: '每日产物任务',
      modeId: 'craft',
      workflowId: 'deliver-report',
      workflowInputs: { topic: '周报' },
      maxAttempts: 1,
      nextRunAt: '2026-03-01T01:00:00.000Z'
    })

    const finished = await runScan(d, automation.id, '2026-03-01T01:00:00.000Z', 'artifact')
    check(finished.status === 'done', '4. 工作流型自动化执行成功', JSON.stringify(finished.status))
    const binding = finished.outputBindings?.[0]
    check(Boolean(binding?.path), '4b. 事件携带产物绑定', JSON.stringify(finished.outputBindings))
    if (binding?.path) {
      const content = await readFile(join(workspace, binding.path), 'utf8')
      check(content.length > 0, '4c. 产物文件已落盘', binding.path)
    }

    const started = d.events().find((e) => e.type === 'automation.started' && e.id === automation.id)
    const conversationId = started?.conversationId
    d.send({ cmd: 'conversation.history', conversationId, requestId: 'history' })
    const history = await d.waitFor((e) => e.type === 'conversation.history' && e.requestId === 'history')
    const artifacts = history?.artifacts ?? []
    check(artifacts.length === 1, '4d. 会话历史能查到产物', JSON.stringify(artifacts.map((a) => a.title)))
    check(artifacts[0]?.path === binding?.path, '4e. 产物路径与任务输出一致')
    check(String(artifacts[0]?.sha256 ?? '').length === 64, '4f. 产物带 sha256')

    d.send({ cmd: 'notifications.list', requestId: 'ntf-done' })
    const listed = await d.waitFor((e) => e.type === 'notifications.list' && e.requestId === 'ntf-done')
    const doneAlert = (listed?.notifications ?? []).find(
      (item) => item.biz === 'automation' && String(item.title).includes('每日产物任务')
    )
    check(Boolean(doneAlert) && /产出 1 个文件/.test(doneAlert.summary ?? ''), '4g. 成功通知说明产物数量', doneAlert?.summary)
    await d.stop()
  }
} catch (err) {
  console.error('WM-AUTO-06 验收异常:', err)
  failed++
} finally {
  try {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (cleanupError) {
    console.warn(`临时目录清理失败(不影响验收结论): ${cleanupError.message}`)
  }
}

if (failed > 0) {
  console.log(`\nWM-AUTO-06 失败 ${failed} 项`)
  process.exit(1)
}
console.log('\nWM-AUTO-06 全部通过')
