import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { pendingEvent } from './schema.js'

export type PendingKind = 'event' | 'artifact'

export interface PendingEventRecord {
  /** 客户端生成的 ULID,重发时不变;服务端据此去重 */
  id: string
  workspaceId: string
  conversationId: string | null
  kind: PendingKind
  payload: unknown
  seq: number
  attempts: number
  lastError: string | null
  nextAttemptAt: string
  createdAt: string
  sentAt: string | null
}

/** 重试退避:1s、4s、16s…上限 5 分钟,避免断网时打满事件循环 */
export function retryDelayMs(attempts: number): number {
  const base = 1000 * 4 ** Math.max(0, attempts - 1)
  return Math.min(base, 5 * 60_000)
}

export function enqueuePending(
  db: AppDatabase,
  input: {
    workspaceId: string
    kind: PendingKind
    payload: unknown
    conversationId?: string | null
    eventId?: string
    now?: Date
  }
): PendingEventRecord {
  const at = input.now ?? new Date()
  return db.transaction((tx) => {
    return enqueuePendingTx(tx as unknown as AppDatabase, input)
  })
}

/**
 * 在调用方事务内入队。appendEvent 用它把"频道会话的事件"与事件日志
 * 写进同一个事务:要么都落,要么都不落。
 */
export function enqueuePendingTx(
  tx: AppDatabase,
  input: {
    workspaceId: string
    kind: PendingKind
    payload: unknown
    conversationId?: string | null
    eventId?: string
    now?: Date
  }
): PendingEventRecord {
  const at = input.now ?? new Date()
  // 显式传入 eventId 时按 id 幂等:同一事件重复入队不新增第二行
  if (input.eventId) {
    const existing = tx.select().from(pendingEvent).where(eq(pendingEvent.id, input.eventId)).all()[0]
    if (existing) return toRecord(existing)
  }
  const maxRow = tx
    .select({ maxSeq: sql<number>`coalesce(max(${pendingEvent.seq}), 0)` })
    .from(pendingEvent)
    .where(eq(pendingEvent.workspaceId, input.workspaceId))
    .all()[0]
  const row = {
    id: input.eventId ?? ulid(at.getTime()),
    workspaceId: input.workspaceId,
    conversationId: input.conversationId ?? null,
    kind: input.kind,
    payloadJson: JSON.stringify(input.payload ?? null),
    seq: (maxRow?.maxSeq ?? 0) + 1,
    attempts: 0,
    lastError: null,
    nextAttemptAt: at.toISOString(),
    createdAt: at.toISOString(),
    sentAt: null
  }
  tx.insert(pendingEvent).values(row).run()
  return toRecord(row)
}

/** 取一批待发项,严格按 seq 顺序;只取已到重试时间的 */
export function duePending(
  db: AppDatabase,
  workspaceId: string,
  opts: { limit?: number; now?: Date } = {}
): PendingEventRecord[] {
  const at = (opts.now ?? new Date()).toISOString()
  return db
    .select()
    .from(pendingEvent)
    .where(
      and(
        eq(pendingEvent.workspaceId, workspaceId),
        isNull(pendingEvent.sentAt),
        lte(pendingEvent.nextAttemptAt, at)
      )
    )
    .orderBy(asc(pendingEvent.seq))
    .limit(opts.limit ?? 20)
    .all()
    .map(toRecord)
}

export function listPending(db: AppDatabase, workspaceId: string): PendingEventRecord[] {
  return db
    .select()
    .from(pendingEvent)
    .where(eq(pendingEvent.workspaceId, workspaceId))
    .orderBy(asc(pendingEvent.seq))
    .all()
    .map(toRecord)
}

export function markPendingSent(db: AppDatabase, ids: string[], now: Date = new Date()): void {
  if (ids.length === 0) return
  const at = now.toISOString()
  db.transaction((tx) => {
    for (const id of ids) {
      tx.update(pendingEvent).set({ sentAt: at, lastError: null }).where(eq(pendingEvent.id, id)).run()
    }
  })
}

/** 失败不丢:记录错误并安排下一次重试,seq 不变 */
export function markPendingFailed(
  db: AppDatabase,
  id: string,
  error: string,
  now: Date = new Date()
): void {
  const row = db.select().from(pendingEvent).where(eq(pendingEvent.id, id)).all()[0]
  if (!row) return
  const attempts = row.attempts + 1
  db.update(pendingEvent)
    .set({
      attempts,
      lastError: error.slice(0, 500),
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)).toISOString()
    })
    .where(eq(pendingEvent.id, id))
    .run()
}

/** 重新唤醒全部失败项(例如用户点击"立即重试") */
export function resetPendingBackoff(db: AppDatabase, workspaceId: string, now: Date = new Date()): number {
  const rows = db
    .select({ id: pendingEvent.id })
    .from(pendingEvent)
    .where(and(eq(pendingEvent.workspaceId, workspaceId), isNull(pendingEvent.sentAt)))
    .all()
  const at = now.toISOString()
  db.transaction((tx) => {
    for (const r of rows) {
      tx.update(pendingEvent).set({ nextAttemptAt: at }).where(eq(pendingEvent.id, r.id)).run()
    }
  })
  return rows.length
}

function toRecord(row: typeof pendingEvent.$inferSelect): PendingEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    kind: row.kind as PendingKind,
    payload: JSON.parse(row.payloadJson),
    seq: row.seq,
    attempts: row.attempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    createdAt: row.createdAt,
    sentAt: row.sentAt
  }
}

export { nowIso as _nowIso }
