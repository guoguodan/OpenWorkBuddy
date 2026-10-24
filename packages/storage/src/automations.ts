import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { automation } from './schema.js'

export interface AutomationInput {
  workspaceId: string
  name: string
  scheduleType: 'once' | 'rrule'
  prompt: string
  modeId: string
  /** 产物型自动化:设置了 workflowId 时不再走提示词 Agent,直接运行工作流 */
  workflowId?: string | null
  workflowInputs?: Record<string, unknown> | null
  /** 单次执行最多尝试次数,含首次;1 表示不重试 */
  maxAttempts?: number
  /** 连续失败达到该值才提醒 */
  failureThreshold?: number
  rrule?: string | null
  scheduledAt?: string | null
  timezone?: string
  validFrom?: string | null
  validUntil?: string | null
  enabled?: boolean
  nextRunAt?: string | null
}

export interface AutomationRecord {
  id: string
  workspaceId: string
  name: string
  scheduleType: 'once' | 'rrule'
  rrule: string | null
  scheduledAt: string | null
  timezone: string
  validFrom: string | null
  validUntil: string | null
  prompt: string
  modeId: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  consecutiveFailures: number
  failureAlerted: boolean
  maxAttempts: number
  failureThreshold: number
  workflowId: string | null
  workflowInputs: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

function parseInputs(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function toRecord(row: typeof automation.$inferSelect): AutomationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    scheduleType: row.scheduleType,
    rrule: row.rrule,
    scheduledAt: row.scheduledAt,
    timezone: row.timezone,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    prompt: row.prompt,
    modeId: row.modeId,
    enabled: row.enabled === 1,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    consecutiveFailures: row.consecutiveFailures,
    failureAlerted: row.failureAlerted === 1,
    maxAttempts: row.maxAttempts,
    failureThreshold: row.failureThreshold,
    workflowId: row.workflowId,
    workflowInputs: parseInputs(row.workflowInputsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function createAutomation(db: AppDatabase, input: AutomationInput): AutomationRecord {
  const now = nowIso()
  const id = ulid()
  db.insert(automation)
    .values({
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      scheduleType: input.scheduleType,
      rrule: input.rrule ?? null,
      scheduledAt: input.scheduledAt ?? null,
      timezone: input.timezone ?? 'Asia/Shanghai',
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      prompt: input.prompt,
      modeId: input.modeId,
      workflowId: input.workflowId ?? null,
      workflowInputsJson:
        input.workflowInputs && Object.keys(input.workflowInputs).length > 0
          ? JSON.stringify(input.workflowInputs)
          : null,
      maxAttempts: clampInt(input.maxAttempts, 2, 1, 5),
      failureThreshold: clampInt(input.failureThreshold, 3, 1, 20),
      enabled: input.enabled === false ? 0 : 1,
      nextRunAt: input.nextRunAt ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run()
  return getAutomation(db, id)!
}

export function listAutomations(db: AppDatabase, workspaceId: string): AutomationRecord[] {
  return db
    .select()
    .from(automation)
    .where(eq(automation.workspaceId, workspaceId))
    .orderBy(asc(automation.createdAt))
    .all()
    .map(toRecord)
}

export function getAutomation(db: AppDatabase, id: string): AutomationRecord | undefined {
  const row = db.select().from(automation).where(eq(automation.id, id)).all()[0]
  return row ? toRecord(row) : undefined
}

export function updateAutomation(
  db: AppDatabase,
  id: string,
  patch: Partial<
    Pick<
      AutomationRecord,
      | 'name'
      | 'prompt'
      | 'modeId'
      | 'enabled'
      | 'nextRunAt'
      | 'lastRunAt'
      | 'lastStatus'
      | 'maxAttempts'
      | 'failureThreshold'
      | 'workflowId'
      | 'workflowInputs'
    >
  >
): void {
  db.update(automation)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.modeId !== undefined ? { modeId: patch.modeId } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
      ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
      ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt } : {}),
      ...(patch.lastStatus !== undefined ? { lastStatus: patch.lastStatus } : {}),
      ...(patch.maxAttempts !== undefined ? { maxAttempts: clampInt(patch.maxAttempts, 2, 1, 5) } : {}),
      ...(patch.failureThreshold !== undefined
        ? { failureThreshold: clampInt(patch.failureThreshold, 3, 1, 20) }
        : {}),
      ...(patch.workflowId !== undefined ? { workflowId: patch.workflowId } : {}),
      ...(patch.workflowInputs !== undefined
        ? {
            workflowInputsJson:
              patch.workflowInputs && Object.keys(patch.workflowInputs).length > 0
                ? JSON.stringify(patch.workflowInputs)
                : null
          }
        : {}),
      updatedAt: nowIso()
    })
    .where(eq(automation.id, id))
    .run()
}

export function deleteAutomation(db: AppDatabase, id: string): void {
  db.delete(automation).where(eq(automation.id, id)).run()
}

export interface ClaimResult {
  claimed: boolean
  /** 抢占后写入的 next_run_at;调用方据此知道"下一次"而无需立刻重算 */
  nextRunAt: string | null
}

/**
 * 事务 + 条件更新抢占(WM-AUTO-02)。
 * 条件里用 `IS :expected` 同时覆盖 NULL 与具体值;影响行数为 0 表示别人先抢到了。
 */
export function claimAutomation(
  db: AppDatabase,
  input: { id: string; expectedNextRunAt: string | null; now: string; nextRunAt: string | null }
): ClaimResult {
  return db.transaction((tx) => {
    const condition =
      input.expectedNextRunAt === null
        ? and(eq(automation.id, input.id), isNull(automation.nextRunAt))
        : and(eq(automation.id, input.id), eq(automation.nextRunAt, input.expectedNextRunAt))
    const result = tx
      .update(automation)
      .set({ lastRunAt: input.now, nextRunAt: input.nextRunAt, updatedAt: input.now })
      .where(condition)
      .run()
    return { claimed: result.changes === 1, nextRunAt: input.nextRunAt }
  })
}

/** 启动时把过期任务推到未来,不执行(错过 >3 次时用) */
export function skipAutomation(
  db: AppDatabase,
  id: string,
  input: { now: string; nextRunAt: string | null; skipped: number }
): void {
  db.update(automation)
    .set({
      nextRunAt: input.nextRunAt,
      lastStatus: `skipped:${input.skipped}`,
      updatedAt: input.now
    })
    .where(eq(automation.id, id))
    .run()
}

export function markAutomationResult(
  db: AppDatabase,
  id: string,
  input: { status: string; nextRunAt: string | null; disable?: boolean; now?: string }
): void {
  db.update(automation)
    .set({
      lastStatus: input.status,
      nextRunAt: input.nextRunAt,
      ...(input.disable ? { enabled: 0 } : {}),
      updatedAt: input.now ?? nowIso()
    })
    .where(eq(automation.id, id))
    .run()
}

export type AutomationOutcome = 'done' | 'failed' | 'interrupted'

export interface AutomationOutcomeResult {
  consecutiveFailures: number
  failureAlerted: boolean
  /** 本次执行是否跨过阈值并需要通知;同一段连续失败只返回一次 true */
  shouldAlert: boolean
}

/**
 * 记录一次完整执行的结果(不是单次 attempt)。
 *
 * 成功清零并允许下一段连续失败重新提醒;用户中断不计入失败——
 * 那不是任务本身出错,把它算进去会让阈值提醒失去意义。
 * 事务内读改写,避免后台执行与手动重扫并发时计数丢失。
 */
export function recordAutomationOutcome(
  db: AppDatabase,
  id: string,
  input: {
    status: string
    outcome: AutomationOutcome
    nextRunAt: string | null
    disable?: boolean
    now?: string
  }
): AutomationOutcomeResult {
  const now = input.now ?? nowIso()
  return db.transaction((tx) => {
    const row = tx.select().from(automation).where(eq(automation.id, id)).all()[0]
    if (!row) return { consecutiveFailures: 0, failureAlerted: false, shouldAlert: false }

    let consecutiveFailures = row.consecutiveFailures
    let failureAlerted = row.failureAlerted === 1
    let shouldAlert = false
    if (input.outcome === 'done') {
      consecutiveFailures = 0
      failureAlerted = false
    } else if (input.outcome === 'failed') {
      consecutiveFailures += 1
      if (!failureAlerted && consecutiveFailures >= row.failureThreshold) {
        failureAlerted = true
        shouldAlert = true
      }
    }

    tx.update(automation)
      .set({
        lastStatus: input.status,
        nextRunAt: input.nextRunAt,
        consecutiveFailures,
        failureAlerted: failureAlerted ? 1 : 0,
        ...(input.disable ? { enabled: 0 } : {}),
        updatedAt: now
      })
      .where(eq(automation.id, id))
      .run()

    return { consecutiveFailures, failureAlerted, shouldAlert }
  })
}

/** 到期任务:enabled=1 且 next_run_at 不为空且 <= now */
export function dueAutomations(db: AppDatabase, workspaceId: string, now: string): AutomationRecord[] {
  return db
    .select()
    .from(automation)
    .where(
      and(
        eq(automation.workspaceId, workspaceId),
        eq(automation.enabled, 1),
        sql`${automation.nextRunAt} IS NOT NULL AND ${automation.nextRunAt} <= ${now}`
      )
    )
    .orderBy(asc(automation.nextRunAt))
    .all()
    .map(toRecord)
}
