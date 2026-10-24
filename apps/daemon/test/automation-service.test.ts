import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureWorkspace,
  getAutomation,
  insertArtifacts,
  listArtifactsByTask,
  openDatabase,
  migrateOrThrow,
  updateAutomation,
  type AppDatabase
} from '@openwb/storage'
import { ToolRegistry } from '@openwb/tools'
import { WorkflowService } from '../src/workflows/service.js'

let base = ''
let db: AppDatabase
let raw: ReturnType<typeof openDatabase>['raw']
let workspaceId = ''
let workspaceRoot = ''
let dataDir = ''
let builtinDir = ''

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'owb-auto-svc-'))
  workspaceRoot = join(base, 'ws')
  dataDir = join(base, 'data')
  builtinDir = join(base, 'builtin')
  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(builtinDir, { recursive: true })
  const conn = openDatabase(join(dataDir, 'openwb.db'))
  migrateOrThrow(conn.raw, { dbPath: join(dataDir, 'openwb.db') })
  db = conn.db
  raw = conn.raw
  workspaceId = ensureWorkspace(db, workspaceRoot).id
  process.env.OPENWB_MOCK = '1'
  process.env.OPENWB_AUTOMATION_RETRY_BASE_MS = '0'
})

afterEach(async () => {
  raw.close()
  delete process.env.OPENWB_MOCK
  delete process.env.OPENWB_AUTOMATION_RETRY_BASE_MS
  await rm(base, { recursive: true, force: true })
})

interface Harness {
  service: WorkflowService
  events: Array<Record<string, unknown>>
  waitFinish: (count: number) => Promise<Record<string, unknown>>
  changePrompt: (fn: () => Promise<{ status: 'done' | 'failed' | 'interrupted'; message?: string }>) => void
}

function createService(): Harness {
  const events: Array<Record<string, unknown>> = []
  let prompt = async (): Promise<{ status: 'done' | 'failed' | 'interrupted'; message?: string }> => ({
    status: 'done'
  })
  const service = new WorkflowService({
    db,
    workspaceId,
    workspaceRoot,
    dataDir,
    builtinDir,
    registry: new ToolRegistry(),
    emit: (event) => {
      events.push(event)
    },
    runAutomationPrompt: (_input) => prompt(),
    gateToolExecution: async () => ({}),
    log: () => {},
    artifactSinkFor: (taskId, conversationId) => ({
      insert: async (items) => {
        const results = insertArtifacts(db, { taskId, conversationId, items })
        return results.map((item) => ({ id: item.record.id, deduped: item.deduped }))
      }
    }),
    sleep: async () => {}
  })
  const waitFinish = async (count: number, timeoutMs = 10_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const finished = events.filter((event) => event.type === 'automation.finished')
      if (finished.length >= count) return finished[count - 1]!
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 20))
    }
    throw new Error(`等待 automation.finished 超时(期望 ${count} 次)`)
  }
  return {
    service,
    events,
    waitFinish,
    changePrompt: (fn) => {
      prompt = fn
    }
  }
}

async function runOnce(harness: Harness, id: string, runCount: number, nowIso: string): Promise<Record<string, unknown>> {
  updateAutomation(db, id, { nextRunAt: nowIso })
  await harness.service.scan(nowIso)
  return await harness.waitFinish(runCount)
}

describe('automation 失败重试与连续失败阈值', () => {
  it('重试成功后不累计失败次数', async () => {
    const harness = createService()
    let calls = 0
    harness.changePrompt(async () => {
      calls += 1
      return calls < 3 ? { status: 'failed', message: '模型超时' } : { status: 'done' }
    })
    const record = harness.service.createAutomation({
      workspaceId,
      name: '需要重试',
      scheduleType: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      timezone: 'Asia/Shanghai',
      prompt: '生成周报',
      modeId: 'craft',
      maxAttempts: 3,
      nextRunAt: '2026-03-01T01:00:00.000Z'
    })

    const finished = await runOnce(harness, record.id, 1, '2026-03-01T01:00:00.000Z')
    expect(calls).toBe(3)
    expect(finished.status).toBe('done')
    expect(finished.attempts).toBe(3)
    expect(finished.consecutiveFailures).toBe(0)
    expect(getAutomation(db, record.id)?.consecutiveFailures).toBe(0)
  })

  it('连续失败达到阈值只提醒一次,成功后计数清零', async () => {
    const harness = createService()
    harness.changePrompt(async () => ({ status: 'failed', message: '上游 500' }))
    const record = harness.service.createAutomation({
      workspaceId,
      name: '阈值任务',
      scheduleType: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      timezone: 'Asia/Shanghai',
      prompt: '巡检',
      modeId: 'craft',
      maxAttempts: 1,
      failureThreshold: 2,
      nextRunAt: '2026-03-01T01:00:00.000Z'
    })

    const first = await runOnce(harness, record.id, 1, '2026-03-01T01:00:00.000Z')
    expect(first.consecutiveFailures).toBe(1)
    expect(first.shouldAlert).toBe(false)

    const second = await runOnce(harness, record.id, 2, '2026-03-02T01:00:00.000Z')
    expect(second.consecutiveFailures).toBe(2)
    expect(second.failureAlerted).toBe(true)
    expect(second.shouldAlert).toBe(true)

    // 同一段连续失败不能反复打扰用户
    const third = await runOnce(harness, record.id, 3, '2026-03-03T01:00:00.000Z')
    expect(third.consecutiveFailures).toBe(3)
    expect(third.shouldAlert).toBe(false)

    harness.changePrompt(async () => ({ status: 'done' }))
    const recovered = await runOnce(harness, record.id, 4, '2026-03-04T01:00:00.000Z')
    expect(recovered.status).toBe('done')
    expect(recovered.consecutiveFailures).toBe(0)
    expect(recovered.failureAlerted).toBe(false)
  })

  it('用户中断不重试也不计失败', async () => {
    const harness = createService()
    let calls = 0
    harness.changePrompt(async () => {
      calls += 1
      return { status: 'interrupted' }
    })
    const record = harness.service.createAutomation({
      workspaceId,
      name: '会被中断',
      scheduleType: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      timezone: 'Asia/Shanghai',
      prompt: '长任务',
      modeId: 'craft',
      maxAttempts: 3,
      nextRunAt: '2026-03-01T01:00:00.000Z'
    })

    const finished = await runOnce(harness, record.id, 1, '2026-03-01T01:00:00.000Z')
    expect(calls).toBe(1)
    expect(finished.status).toBe('interrupted')
    expect(finished.consecutiveFailures).toBe(0)
  })
})

describe('automation 工作流产物', () => {
  it('工作流输出写入 artifact 表并可从任务查询', async () => {
    await mkdir(join(workspaceRoot, '.openwb', 'workflows'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.openwb', 'workflows', 'artifact-demo.yaml'),
      [
        'schemaVersion: 1',
        'id: artifact-demo',
        'name: 产物自动化',
        'mode: craft',
        'inputs:',
        '  - name: topic',
        '    required: true',
        'outputs:',
        '  - name: report',
        '    kind: file',
        '    path: reports/{{run.id}}/report.md',
        'phases:',
        '  - id: draft',
        '    steps:',
        '      - id: write',
        '        type: prompt',
        '        prompt: "写一段关于 {{inputs.topic}} 的说明"',
        '        save_as: report',
        '        output: markdown'
      ].join('\n'),
      'utf8'
    )

    const harness = createService()
    const record = harness.service.createAutomation({
      workspaceId,
      name: '每日产物',
      scheduleType: 'rrule',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      timezone: 'Asia/Shanghai',
      prompt: '每日产物',
      modeId: 'craft',
      workflowId: 'artifact-demo',
      workflowInputs: { topic: '周报' },
      maxAttempts: 1,
      nextRunAt: '2026-03-01T01:00:00.000Z'
    })

    const finished = await runOnce(harness, record.id, 1, '2026-03-01T01:00:00.000Z')
    expect(finished.status).toBe('done')
    const bindings = finished.outputBindings as Array<{ name: string; path: string }>
    expect(bindings).toHaveLength(1)
    const content = await readFile(join(workspaceRoot, bindings[0]!.path), 'utf8')
    expect(content).toContain('研究结论')

    const startedEvent = harness.events.find((event) => event.type === 'automation.started')
    expect(startedEvent?.workflowId).toBe('artifact-demo')
    const conversationId = startedEvent?.conversationId as string
    const runs = await harness.service.listRuns()
    const runId = runs.runs[0]!.runId as string
    expect(finished.runId).toBe(runId)

    const taskId = raw
      .prepare('SELECT id FROM task WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(conversationId) as { id: string } | undefined
    expect(taskId?.id).toBeTruthy()
    const artifacts = listArtifactsByTask(db, taskId!.id)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.path).toBe(bindings[0]!.path)
    expect(artifacts[0]!.title).toContain('产物自动化')
    expect(artifacts[0]!.sha256).toHaveLength(64)
  })
})
