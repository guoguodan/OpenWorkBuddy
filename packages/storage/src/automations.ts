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
  createdAt: string
  updatedAt: string
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
  patch: Partial<Pick<AutomationRecord, 'name' | 'prompt' | 'modeId' | 'enabled' | 'nextRunAt' | 'lastRunAt' | 'lastStatus'>>
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
