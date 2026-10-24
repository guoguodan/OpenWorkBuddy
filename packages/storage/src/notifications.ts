import { and, desc, eq, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { notification } from './schema.js'

export type NotificationBiz = 'task' | 'automation' | 'approval' | 'system'

export interface NotificationRecord {
  id: string
  workspaceId: string
  biz: NotificationBiz
  title: string
  summary: string
  conversationId: string | null
  actionKind: 'open-conversation' | 'none'
  isRead: boolean
  isPending: boolean
  createdAt: string
}

function mapRow(row: typeof notification.$inferSelect): NotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    biz: row.biz,
    title: row.title,
    summary: row.summary,
    conversationId: row.conversationId,
    actionKind: row.actionKind,
    isRead: row.isRead === 1,
    isPending: row.isPending === 1,
    createdAt: row.createdAt
  }
}

export interface CreateNotificationInput {
  workspaceId: string
  biz: NotificationBiz
  title: string
  summary?: string
  conversationId?: string | null
  actionKind?: 'open-conversation' | 'none'
  isPending?: boolean
  /** 同一事件被重复处理时去重;为空则每次都新建 */
  dedupeKey?: string
}

/**
 * 通知去重不额外建表:用固定 id 前缀 + dedupeKey 保证幂等。
 * 例如同一任务重复发 done 事件时,不应让铃铛数量无限增长。
 */
export function createNotification(db: AppDatabase, input: CreateNotificationInput): NotificationRecord {
  const dedupeId = input.dedupeKey ? `ntf-${input.dedupeKey}`.slice(0, 120) : ulid()
  const existing = db.select().from(notification).where(eq(notification.id, dedupeId)).all()[0]
  if (existing) return mapRow(existing)

  const row = {
    id: dedupeId,
    workspaceId: input.workspaceId,
    biz: input.biz,
    title: input.title.slice(0, 200),
    summary: (input.summary ?? '').slice(0, 1000),
    conversationId: input.conversationId ?? null,
    actionKind: input.actionKind ?? (input.conversationId ? 'open-conversation' : 'none'),
    isRead: 0,
    isPending: input.isPending === true ? 1 : 0,
    createdAt: nowIso()
  }
  db.insert(notification).values(row).run()
  return mapRow(row as typeof notification.$inferSelect)
}

export function listNotifications(
  db: AppDatabase,
  workspaceId: string,
  opts: { pendingOnly?: boolean; limit?: number } = {}
): NotificationRecord[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const where = opts.pendingOnly
    ? and(eq(notification.workspaceId, workspaceId), eq(notification.isPending, 1))
    : eq(notification.workspaceId, workspaceId)
  return db
    .select()
    .from(notification)
    .where(where)
    .orderBy(desc(notification.createdAt))
    .limit(limit)
    .all()
    .map(mapRow)
}

export function unreadNotificationCount(db: AppDatabase, workspaceId: string): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(notification)
    .where(and(eq(notification.workspaceId, workspaceId), eq(notification.isRead, 0)))
    .all()[0]
  return row?.count ?? 0
}

export function markNotificationRead(db: AppDatabase, id: string): NotificationRecord | undefined {
  db.update(notification).set({ isRead: 1 }).where(eq(notification.id, id)).run()
  const row = db.select().from(notification).where(eq(notification.id, id)).all()[0]
  return row ? mapRow(row) : undefined
}

export function markAllNotificationsRead(db: AppDatabase, workspaceId: string): number {
  const result = db
    .update(notification)
    .set({ isRead: 1 })
    .where(and(eq(notification.workspaceId, workspaceId), eq(notification.isRead, 0)))
    .run()
  return result.changes
}

export function deleteNotification(db: AppDatabase, id: string): boolean {
  const result = db.delete(notification).where(eq(notification.id, id)).run()
  return result.changes > 0
}

/** 用户已经处理过审批/待办后,把对应的未处理提醒一并收起 */
export function resolveNotification(db: AppDatabase, id: string): void {
  db.update(notification).set({ isPending: 0, isRead: 1 }).where(eq(notification.id, id)).run()
}
