import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/client.js'
import { ensureWorkspace } from '../src/conversations.js'
import {
  createAutomation,
  getAutomation,
  recordAutomationOutcome,
  updateAutomation
} from '../src/automations.js'
import { migrateOrThrow } from '../src/migrate.js'

let dir: string
let dbPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-automation-'))
  dbPath = join(dir, 'openwb.db')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function setup() {
  const conn = openDatabase(dbPath)
  migrateOrThrow(conn.raw, { dbPath })
  const ws = ensureWorkspace(conn.db, dir)
  return { ...conn, ws }
}

function createSample(
  db: ReturnType<typeof setup>['db'],
  workspaceId: string,
  overrides: Partial<Parameters<typeof createAutomation>[1]> = {}
) {
  return createAutomation(db, {
    workspaceId,
    name: '示例任务',
    scheduleType: 'once',
    scheduledAt: '2026-03-01T01:00:00.000Z',
    prompt: '生成报告',
    modeId: 'craft',
    ...overrides
  })
}

describe('automation 重试与工作流字段', () => {
  it('使用默认值并把重试次数与失败阈值夹取到合法范围', () => {
    const { db, raw, ws } = setup()
    const defaults = createSample(db, ws.id)
    expect(defaults.maxAttempts).toBe(2)
    expect(defaults.failureThreshold).toBe(3)
    expect(defaults.consecutiveFailures).toBe(0)
    expect(defaults.failureAlerted).toBe(false)
    expect(defaults.workflowId).toBeNull()
    expect(defaults.workflowInputs).toBeNull()

    const tooHigh = createSample(db, ws.id, { maxAttempts: 99, failureThreshold: 999 })
    expect(tooHigh.maxAttempts).toBe(5)
    expect(tooHigh.failureThreshold).toBe(20)

    const tooLow = createSample(db, ws.id, { maxAttempts: 0, failureThreshold: -3 })
    expect(tooLow.maxAttempts).toBe(1)
    expect(tooLow.failureThreshold).toBe(1)
    raw.close()
  })

  it('保存工作流目标与输入,更新时同样夹取并支持清空输入', () => {
    const { db, raw, ws } = setup()
    const record = createSample(db, ws.id, {
      workflowId: 'weekly-report',
      workflowInputs: { topic: '周报', options: { language: 'zh-CN' } }
    })
    expect(record.workflowId).toBe('weekly-report')
    expect(record.workflowInputs).toEqual({ topic: '周报', options: { language: 'zh-CN' } })

    updateAutomation(db, record.id, {
      maxAttempts: 9,
      failureThreshold: 0,
      workflowId: null,
      workflowInputs: null
    })
    const updated = getAutomation(db, record.id)!
    expect(updated.maxAttempts).toBe(5)
    expect(updated.failureThreshold).toBe(1)
    expect(updated.workflowId).toBeNull()
    expect(updated.workflowInputs).toBeNull()
    raw.close()
  })
})

describe('recordAutomationOutcome', () => {
  it('连续失败达到阈值只提醒一次,成功清零后允许重新提醒', () => {
    const { db, raw, ws } = setup()
    const record = createSample(db, ws.id, { failureThreshold: 2 })

    const first = recordAutomationOutcome(db, record.id, {
      status: 'failed',
      outcome: 'failed',
      nextRunAt: '2026-03-02T01:00:00.000Z',
      now: '2026-03-01T01:00:00.000Z'
    })
    expect(first).toEqual({ consecutiveFailures: 1, failureAlerted: false, shouldAlert: false })

    const second = recordAutomationOutcome(db, record.id, {
      status: 'failed',
      outcome: 'failed',
      nextRunAt: '2026-03-03T01:00:00.000Z',
      now: '2026-03-02T01:00:00.000Z'
    })
    expect(second).toEqual({ consecutiveFailures: 2, failureAlerted: true, shouldAlert: true })

    const third = recordAutomationOutcome(db, record.id, {
      status: 'failed',
      outcome: 'failed',
      nextRunAt: '2026-03-04T01:00:00.000Z',
      now: '2026-03-03T01:00:00.000Z'
    })
    expect(third).toEqual({ consecutiveFailures: 3, failureAlerted: true, shouldAlert: false })

    const recovered = recordAutomationOutcome(db, record.id, {
      status: 'done',
      outcome: 'done',
      nextRunAt: '2026-03-05T01:00:00.000Z',
      now: '2026-03-04T01:00:00.000Z'
    })
    expect(recovered).toEqual({ consecutiveFailures: 0, failureAlerted: false, shouldAlert: false })

    const nextSegment = recordAutomationOutcome(db, record.id, {
      status: 'failed',
      outcome: 'failed',
      nextRunAt: '2026-03-06T01:00:00.000Z',
      now: '2026-03-05T01:00:00.000Z'
    })
    expect(nextSegment).toEqual({ consecutiveFailures: 1, failureAlerted: false, shouldAlert: false })
    raw.close()
  })

  it('中断不累加失败也不触发提醒,并保留原有计数', () => {
    const { db, raw, ws } = setup()
    const record = createSample(db, ws.id, { failureThreshold: 2 })

    recordAutomationOutcome(db, record.id, {
      status: 'failed',
      outcome: 'failed',
      nextRunAt: null,
      now: '2026-03-01T01:00:00.000Z'
    })
    const interrupted = recordAutomationOutcome(db, record.id, {
      status: 'interrupted',
      outcome: 'interrupted',
      nextRunAt: '2026-03-02T01:00:00.000Z',
      now: '2026-03-02T01:00:00.000Z'
    })
    expect(interrupted).toEqual({ consecutiveFailures: 1, failureAlerted: false, shouldAlert: false })
    const refreshed = getAutomation(db, record.id)!
    expect(refreshed.consecutiveFailures).toBe(1)
    expect(refreshed.failureAlerted).toBe(false)
    expect(refreshed.lastStatus).toBe('interrupted')
    raw.close()
  })

  it('可按结果禁用任务,任务不存在时返回零值', () => {
    const { db, raw, ws } = setup()
    const record = createSample(db, ws.id)
    recordAutomationOutcome(db, record.id, {
      status: 'failed',
      outcome: 'failed',
      nextRunAt: null,
      disable: true,
      now: '2026-03-01T01:00:00.000Z'
    })
    const disabled = getAutomation(db, record.id)!
    expect(disabled.enabled).toBe(false)
    expect(disabled.nextRunAt).toBeNull()

    expect(
      recordAutomationOutcome(db, 'missing', {
        status: 'failed',
        outcome: 'failed',
        nextRunAt: null
      })
    ).toEqual({ consecutiveFailures: 0, failureAlerted: false, shouldAlert: false })
    raw.close()
  })
})
