/**
 * P6 验收(IMPLEMENTATION §7.7 十三条)。
 * 用法: node tests/e2e/verify-p6.mjs
 * 前置: pnpm --filter @openwb/daemon build
 *
 * 全程离线:OPENWB_MOCK=1,不依赖网络与真实模型。
 * 覆盖 daemon 帧链路、CLI、SQLite 落库与调度器(含模拟时钟)。
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
const cli = resolve(root, 'apps/daemon/dist/cli.js')
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

const base = await mkdtemp(join(tmpdir(), 'owb-p6-'))
const workspace = join(base, 'ws')
const dataDir = join(base, 'data')
const dbPath = join(dataDir, 'openwb.db')
await mkdir(workspace, { recursive: true })
await mkdir(dataDir, { recursive: true })
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'p6-ws' }), 'utf8')

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个常驻 daemon,支持按事件轮询,用于中断/续跑等需要时序的场景 */
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
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const chunks = []
  let err = ''
  const closed = new Promise((resolveClose) => {
    child.on('close', (code) => resolveClose(code))
  })
  child.stdout.on('data', (b) => chunks.push(b))
  child.stderr.on('data', (b) => {
    err += String(b)
  })
  const events = () => decodeFrames(Buffer.concat(chunks))
  const waitAfter = async (startIndex, predicate, ms = 20_000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const list = events()
      for (let i = startIndex; i < list.length; i++) {
        if (predicate(list[i])) return list[i]
      }
      await sleep(50)
    }
    return null
  }
  const waitFor = (predicate, ms = 20_000) => waitAfter(0, predicate, ms)
  const send = (frame) => child.stdin.write(encodeFrame(frame))
  /** 优雅关闭:stdin 结束 → daemon 取消并等待后台工作流落盘 → 再退进程 */
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
  return { child, events, waitFor, waitAfter, send, stop, closed, get err() { return err } }
}

/**
 * 顺序发送 frames,等到指定事件后再优雅关闭。
 * 工作流是异步后台执行:必须等 workflow.settled,否则 stdin 一关 daemon 就退。
 */
async function runSession(frames, opts = {}) {
  const d = spawnDaemon(opts.env ?? {})
  try {
    for (const frame of frames) d.send(frame)
    if (opts.waitFor) {
      const hit = await d.waitFor((event) => event.type === opts.waitFor, opts.timeoutMs ?? 60_000)
      if (!hit) throw new Error(`等待 ${opts.waitFor} 超时\n${d.err}`)
    }
    const code = await d.stop()
    return { code, events: d.events(), err: d.err }
  } finally {
    if (d.child.exitCode === null) d.child.kill()
  }
}

/** 写一个项目级工作流(同名覆盖内置),返回 id */
async function writeWorkflow(id, body) {
  const dir = join(workspace, '.openwb', 'workflows')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${id}.yaml`)
  await writeFile(file, body, 'utf8')
  return file
}

/** 直接跑 CLI(独立进程),用于验证不依赖 daemon 帧链路的入口 */
function runCli(args, env = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: {
        ...process.env,
        OPENWB_MOCK: '1',
        OPENWB_WORKSPACE: workspace,
        OPENWB_DATA_DIR: dataDir,
        OPENWB_WORKFLOWS_DIR: resolve(root, 'resources/workflows'),
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    child.on('close', (code) => resolveResult({ code, out, err }))
  })
}

const baseYaml = (id, phases) => `schemaVersion: 1
id: ${id}
name: ${id}
description: p6 test
mode: craft
limits:
  maxDurationSec: 30
  maxModelCalls: 20
inputs: []
outputs: []
phases:
${phases}
`

const db = () => new Database(dbPath, { readonly: true })

try {
  // ── 1. deep-research 跑通并产出带可点击来源的报告 ─────────────────────────
  {
    const d = spawnDaemon()
    await d.waitFor((e) => e.type === 'ready')
    d.send({ cmd: 'workflow.run', workflowId: 'deep-research', inputs: { question: 'q' }, requestId: 'r1' })
    const settled = await d.waitFor((e) => e.type === 'workflow.settled', 30_000)
    check(settled?.status === 'done', '1. deep-research 跑通', JSON.stringify(settled?.error ?? settled?.status))
    const output = settled?.outputBindings?.[0]
    const reportPath = output?.path ? join(workspace, output.path) : null
    check(Boolean(reportPath) && existsSync(reportPath), '1b. 报告文件落盘', reportPath ?? '')
    if (reportPath && existsSync(reportPath)) {
      const text = await readFile(reportPath, 'utf8')
      check(/\[来源 \d+\]\(https?:\/\/[^)]+\)/.test(text), '1c. 报告带可点击来源链接')
    }
    await d.stop()
  }

  // ── 1d. CLI 不依赖 daemon 帧链路:list 可见内置工作流,run 能落盘 ────────
  {
    const listed = await runCli(['workflow', 'list'])
    check(
      listed.code === 0 && /deep-research\t\[builtin\]/.test(listed.out),
      '1d. CLI list 列出内置工作流',
      `${listed.code} ${listed.out.slice(0, 120)}${listed.err.slice(0, 200)}`
    )

    const cliWorkspace = join(base, 'cli-ws')
    await mkdir(cliWorkspace, { recursive: true })
    await writeFile(join(cliWorkspace, 'a.ts'), 'export const a = 1\n', 'utf8')
    const ran = await runCli(['workflow', 'run', 'code-review', '--input', 'focus=test'], {
      OPENWB_WORKSPACE: cliWorkspace
    })
    let parsed = null
    try {
      parsed = JSON.parse(ran.out)
    } catch {
      parsed = null
    }
    check(
      ran.code === 0 && parsed?.status === 'done' && existsSync(join(cliWorkspace, parsed.outputBindings?.[0]?.path ?? '')),
      '1e. CLI run 产出报告文件',
      `${ran.code} ${ran.out.slice(0, 200)}${ran.err.slice(-300)}`
    )
  }

  // ── 2. eval( / Function( 被拒绝,不执行 ──────────────────────────────────
  {
    await writeWorkflow(
      'eval-flow',
      baseYaml(
        'eval-flow',
        `  - id: phase-eval
    parallel: false
    steps:
      - id: bad
        type: prompt
        prompt: '{{eval("1+1")}}'
        save_as: out
        output: text
`
      )
    )
    const r = await runSession([{ cmd: 'workflow.run', workflowId: 'eval-flow', requestId: 'e1' }], {
      waitFor: 'workflow.settled'
    })
    const settled = r.events.find((e) => e.type === 'workflow.settled')
    check(settled?.status === 'failed' && /eval/.test(settled?.error?.message ?? ''), '2. eval( 被拒绝', settled?.error?.message)
  }

  // ── 3. parallel 阶段实际并发(时间戳重叠) ────────────────────────────────
  {
    await writeWorkflow(
      'parallel-flow',
      baseYaml(
        'parallel-flow',
        `  - id: phase-parallel
    parallel: true
    steps:
      - id: step-a
        type: prompt
        prompt: "a"
        save_as: out-a
        output: text
      - id: step-b
        type: prompt
        prompt: "b"
        save_as: out-b
        output: text
      - id: step-c
        type: prompt
        prompt: "c"
        save_as: out-c
        output: text
`
      )
    )
    const d = spawnDaemon({ OPENWB_WORKFLOW_MOCK_DELAY_MS: '400' })
    await d.waitFor((e) => e.type === 'ready')
    d.send({ cmd: 'workflow.run', workflowId: 'parallel-flow', requestId: 'p1' })
    const firstStart = Date.now()
    const a = await d.waitFor((e) => e.type === 'workflow.step' && e.stepId === 'step-a' && e.status === 'started')
    const b = await d.waitFor((e) => e.type === 'workflow.step' && e.stepId === 'step-b' && e.status === 'started')
    const c = await d.waitFor((e) => e.type === 'workflow.step' && e.stepId === 'step-c' && e.status === 'started')
    const timeToStartAll = Date.now() - firstStart
    const settled = await d.waitFor((e) => e.type === 'workflow.settled')
    await d.stop()
    check(settled?.status === 'done', '3. 并行阶段完成')
    check(Boolean(a && b && c), '3b. 三个 step 都启动')
    // 单步 mock 延迟 400ms;串行至少 1200ms,并发时三步应在 600ms 内全部启动
    check(
      timeToStartAll < 600,
      '3c. 三个 step 几乎同时启动(非串行)',
      `${timeToStartAll}ms`
    )
  }

  // ── 4. 单 step 首次失败、重试成功 → done ────────────────────────────────
  {
    await writeWorkflow(
      'retry-flow',
      baseYaml(
        'retry-flow',
        `  - id: phase-retry
    parallel: false
    steps:
      - id: flaky
        type: prompt
        prompt: "x"
        save_as: out
        output: text
        retry: { maxAttempts: 3, backoffMs: 5 }
`
      )
    )
    const r = await runSession([{ cmd: 'workflow.run', workflowId: 'retry-flow', requestId: 't1' }], {
      waitFor: 'workflow.settled',
      env: { OPENWB_WORKFLOW_MOCK_FAIL: 'flaky:1' }
    })
    const settled = r.events.find((e) => e.type === 'workflow.settled')
    const retries = r.events.filter((e) => e.type === 'workflow.step' && e.stepId === 'flaky' && e.status === 'retry')
    check(settled?.status === 'done', '4. 首次失败重试后 done', JSON.stringify(settled?.error))
    check(retries.length === 1, '4b. 恰好重试一次', String(retries.length))
  }

  // ── 5. 重试耗尽 → 后续 phase 不执行,前序产物在盘 ───────────────────────
  {
    await writeWorkflow(
      'exhaust-flow',
      baseYaml(
        'exhaust-flow',
        `  - id: first
    parallel: false
    steps:
      - id: ok
        type: prompt
        prompt: "ok"
        save_as: ok
        output: text
  - id: boom
    parallel: false
    steps:
      - id: bad
        type: prompt
        prompt: "bad"
        save_as: bad
        output: text
        retry: { maxAttempts: 2, backoffMs: 1 }
  - id: never
    parallel: false
    steps:
      - id: nope
        type: prompt
        prompt: "nope"
        save_as: nope
        output: text
`
      )
    )
    const r = await runSession([{ cmd: 'workflow.run', workflowId: 'exhaust-flow', requestId: 'x1' }], {
      waitFor: 'workflow.settled',
      env: { OPENWB_WORKFLOW_MOCK_FAIL: 'bad:99' }
    })
    const settled = r.events.find((e) => e.type === 'workflow.settled')
    const neverStarted = r.events.some((e) => e.type === 'workflow.phase' && e.phaseId === 'never' && e.status === 'started')
    check(settled?.status === 'failed', '5. 重试耗尽后整体失败', settled?.status)
    check(!neverStarted, '5b. 后续 phase 未执行')
    const runId = settled?.runId
    const phaseFile = runId ? join(workspace, '.openwb', 'runs', runId, 'first.json') : null
    check(phaseFile && existsSync(phaseFile), '5c. 已完成 phase 产物仍在磁盘', phaseFile ?? '')
  }

  // ── 6. 中断 sleep 工具,3 秒内停止且 task.status=interrupted ─────────────
  {
    await writeWorkflow(
      'sleep-flow',
      baseYaml(
        'sleep-flow',
        `  - id: phase-sleep
    parallel: false
    steps:
      - id: sleepy
        type: tool
        tool: sleep
        args: { ms: 10000 }
        save_as: out
`
      )
    )
    const d = spawnDaemon()
    await d.waitFor((e) => e.type === 'ready')
    d.send({ cmd: 'workflow.run', workflowId: 'sleep-flow', requestId: 's1' })
    const queued = await d.waitFor((e) => e.type === 'workflow.queued', 10_000)
    const runId = queued?.runId
    const started = Date.now()
    await sleep(300)
    d.send({ cmd: 'workflow.cancel', runId, requestId: 's2' })
    const settled = await d.waitFor((e) => e.type === 'workflow.settled' && e.runId === runId, 10_000)
    const elapsed = Date.now() - started
    check(settled?.status === 'interrupted', '6. 中断后状态为 interrupted', settled?.status)
    check(elapsed < 3000, '6b. 3 秒内停止', `${elapsed}ms`)
    const inspect = db()
    const task = inspect.prepare('SELECT status FROM task WHERE id = ?').get(queued?.taskId)
    check(task?.status === 'interrupted', '6c. task.status=interrupted', task?.status)
    inspect.close()
    await d.stop()
  }

  // ── 7. 从 failed 的 phase 续跑,已完成 phase 不重复调用模型 ──────────────
  {
    await writeWorkflow(
      'resume-flow',
      baseYaml(
        'resume-flow',
        `  - id: first
    parallel: false
    steps:
      - id: step-a
        type: prompt
        prompt: "a"
        save_as: out-a
        output: text
  - id: second
    parallel: false
    steps:
      - id: step-b
        type: prompt
        prompt: "b"
        save_as: out-b
        output: text
`
      )
    )
    const d = spawnDaemon({ OPENWB_WORKFLOW_MOCK_FAIL: 'step-b:99' })
    await d.waitFor((e) => e.type === 'ready')
    d.send({ cmd: 'workflow.run', workflowId: 'resume-flow', runId: 'resume-1', requestId: 'q1' })
    const first = await d.waitFor((e) => e.type === 'workflow.settled' && e.runId === 'resume-1', 20_000)
    const firstPhases = d.events().filter((e) => e.type === 'workflow.phase' && e.runId === 'resume-1')
    await d.stop()
    check(first?.status === 'failed', '7. 首次在第二个 phase 失败', first?.status)

    const d2 = spawnDaemon()
    await d2.waitFor((e) => e.type === 'ready')
    d2.send({ cmd: 'workflow.resume', runId: 'resume-1', requestId: 'q2' })
    const resumed = await d2.waitFor((e) => e.type === 'workflow.settled' && e.runId === 'resume-1', 20_000)
    const resumedPhases = d2.events().filter((e) => e.type === 'workflow.phase' && e.runId === 'resume-1')
    const resumedSteps = d2.events().filter((e) => e.type === 'workflow.step' && e.runId === 'resume-1')
    await d2.stop()
    check(resumed?.status === 'done', '7. 续跑成功')
    check(
      !resumedPhases.some((e) => e.phaseId === 'first' && e.status === 'started'),
      '7b. 已完成 phase 未重新执行',
      JSON.stringify(resumedPhases.map((e) => `${e.phaseId}:${e.status}`))
    )
    check(
      resumedSteps.some((e) => e.stepId === 'step-b') && !resumedSteps.some((e) => e.stepId === 'step-a'),
      '7c. 只重跑失败 phase 的 step'
    )
    check(firstPhases.some((e) => e.phaseId === 'first' && e.status === 'done'), '7d. 首个 phase 在失败前已完成')
    check(
      typeof first?.modelCalls === 'number' && resumed?.modelCalls === first.modelCalls + 1,
      '7e. 模型调用只增加失败 phase 的一次',
      `${first?.modelCalls} -> ${resumed?.modelCalls}`
    )
  }

  // ── 8. 带前后缀的 JSON 可提取并通过校验 ────────────────────────────────
  {
    await writeWorkflow(
      'json-flow',
      baseYaml(
        'json-flow',
        `  - id: phase-json
    parallel: false
    steps:
      - id: js
        type: prompt
        prompt: "j"
        save_as: out
        output: json
        schema:
          type: object
          required: [angles]
          properties:
            angles:
              type: array
              minItems: 1
              items: { type: string }
`
      )
    )
    const r = await runSession([{ cmd: 'workflow.run', workflowId: 'json-flow', requestId: 'j1' }], {
      waitFor: 'workflow.settled'
    })
    const settled = r.events.find((e) => e.type === 'workflow.settled')
    check(settled?.status === 'done', '8. 前后缀 JSON 提取成功', settled?.status)
  }

  // ── 9. 非法 JSON 重试 1 次,再失败标记 STEP_OUTPUT_INVALID ───────────────
  {
    await writeWorkflow(
      'badjson-flow',
      baseYaml(
        'badjson-flow',
        `  - id: phase-badjson
    parallel: false
    steps:
      - id: bad
        type: prompt
        prompt: "bad"
        save_as: out
        output: json
        schema:
          type: object
          required: [x]
`
      )
    )
    const r = spawnDaemon({ OPENWB_WORKFLOW_MOCK_INVALID_JSON: 'bad' })
    await r.waitFor((e) => e.type === 'ready')
    r.send({ cmd: 'workflow.run', workflowId: 'badjson-flow', requestId: 'b1' })
    const settled = await r.waitFor((e) => e.type === 'workflow.settled', 20_000)
    const retries = r.events().filter((e) => e.type === 'workflow.step' && e.stepId === 'bad' && e.status === 'retry')
    check(settled?.status === 'failed' && settled?.error?.code === 'STEP_OUTPUT_INVALID', '9. 非法 JSON 标记 STEP_OUTPUT_INVALID', settled?.error?.code)
    check(retries.length === 1, '9b. 恰好重试 1 次', String(retries.length))
    await r.stop()
  }

  // ── 10. RRULE 每日任务在模拟时钟推进 24h 后触发一次 ─────────────────────
  {
    const d = spawnDaemon()
    await d.waitFor((e) => e.type === 'ready')
    d.send({
      cmd: 'automation.create',
      name: 'daily',
      scheduleType: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      timezone: 'Asia/Shanghai',
      prompt: 'daily task',
      modeId: 'craft',
      nextRunAt: '2026-03-01T01:00:00.000Z',
      requestId: 'a1'
    })
    const created = await d.waitFor((e) => e.type === 'automation.created')
    const id = created?.automation?.id
    check(Boolean(id), '10. 创建每日自动化')
    // 初始 next_run_at 应为 2026-03-01T01:00:00Z(上海 09:00)
    const db3 = db()
    const row = db3.prepare('SELECT next_run_at FROM automation WHERE id = ?').get(id)
    check(row?.next_run_at === '2026-03-01T01:00:00.000Z', '10b. 初始 next_run_at 正确', row?.next_run_at)
    db3.close()
    // 推进 24h 后扫描,应触发一次
    d.send({ cmd: 'automation.scan', now: '2026-03-02T01:00:30.000Z', requestId: 'a2' })
    const scanned = await d.waitFor((e) => e.type === 'automation.scanned')
    check(scanned?.claimed?.includes(id), '10c. 推进 24h 后触发一次', JSON.stringify(scanned?.claimed))
    await d.stop()
  }

  // ── 11. 两个并发调度器抢占,只执行一次 ──────────────────────────────────
  {
    const d1 = spawnDaemon()
    const d2 = spawnDaemon()
    await d1.waitFor((e) => e.type === 'ready')
    await d2.waitFor((e) => e.type === 'ready')
    d1.send({ cmd: 'automation.create', name: 'once', scheduleType: 'once', scheduledAt: '2026-03-01T00:00:00.000Z', prompt: 'once', modeId: 'craft', requestId: 'o1' })
    const created = await d1.waitFor((e) => e.type === 'automation.created')
    const id = created?.automation?.id
    // 两个 daemon 同时扫描
    d1.send({ cmd: 'automation.scan', now: '2026-03-01T01:00:00.000Z', requestId: 'o2' })
    d2.send({ cmd: 'automation.scan', now: '2026-03-01T01:00:00.000Z', requestId: 'o3' })
    const s1 = await d1.waitFor((e) => e.type === 'automation.scanned')
    const s2 = await d2.waitFor((e) => e.type === 'automation.scanned')
    const claimed = (s1?.claimed ?? []).concat(s2?.claimed ?? [])
    check(claimed.filter((x) => x === id).length === 1, '11. 两个调度器只执行一次', JSON.stringify(claimed))
    await Promise.all([d1.stop(), d2.stop()])
  }

  // ── 12. 错过 1 天 → 补跑一次 ───────────────────────────────────────────
  {
    const d = spawnDaemon()
    await d.waitFor((e) => e.type === 'ready')
    d.send({ cmd: 'automation.create', name: 'catchup', scheduleType: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0', timezone: 'Asia/Shanghai', prompt: 'catchup', modeId: 'craft', requestId: 'c1' })
    const created = await d.waitFor((e) => e.type === 'automation.created')
    const id = created?.automation?.id
    // 把 next_run_at 改成昨天,模拟错过 1 天
    const db4 = new Database(dbPath)
    db4.prepare('UPDATE automation SET next_run_at = ? WHERE id = ?').run('2026-02-28T01:00:00.000Z', id)
    db4.close()
    d.send({ cmd: 'automation.scan', now: '2026-03-01T02:00:00.000Z', startup: true, requestId: 'c2' })
    const scanned = await d.waitFor((e) => e.type === 'automation.scanned')
    check(scanned?.claimed?.includes(id), '12. 错过 1 天补跑一次', JSON.stringify(scanned?.claimed))
    await d.stop()
  }

  // ── 13. 错过 5 天 → 不补跑,记录跳过次数 ────────────────────────────────
  {
    const d = spawnDaemon()
    await d.waitFor((e) => e.type === 'ready')
    d.send({ cmd: 'automation.create', name: 'skip', scheduleType: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0', timezone: 'Asia/Shanghai', prompt: 'skip', modeId: 'craft', requestId: 'k1' })
    const created = await d.waitFor((e) => e.type === 'automation.created')
    const id = created?.automation?.id
    const db4 = new Database(dbPath)
    db4.prepare('UPDATE automation SET next_run_at = ? WHERE id = ?').run('2026-02-24T01:00:00.000Z', id)
    db4.close()
    d.send({ cmd: 'automation.scan', now: '2026-03-01T02:00:00.000Z', startup: true, requestId: 'k2' })
    const scanned = await d.waitFor((e) => e.type === 'automation.scanned')
    check(!scanned?.claimed?.includes(id), '13. 错过 5 天不补跑', JSON.stringify(scanned?.claimed))
    const db3 = db()
    const row = db3.prepare('SELECT last_status FROM automation WHERE id = ?').get(id)
    check(/^skipped:\d+$/.test(row?.last_status ?? ''), '13b. 记录跳过次数', row?.last_status)
    db3.close()
    await d.stop()
  }
} catch (err) {
  console.error('P6 验收异常:', err)
  failed++
} finally {
  // Windows 上 SQLite 的 -wal/-shm 可能仍在释放,清理失败不应掩盖验收结果
  try {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (cleanupError) {
    console.warn(`临时目录清理失败(不影响验收结论): ${cleanupError.message}`)
  }
}

console.log(failed === 0 ? '\nP6 全部通过' : `\nP6 失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
