import { eq } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { approvalGrant } from './schema.js'

/**
 * 审批记忆仓储。
 *
 * group_key 是唯一的:同一组只有一条授权,"always" 重新授权时覆盖旧期限。
 * 过期记录不删除,供审计排查;读取时按时间判定无效。
 */

export type GrantScope = 'once' | 'session' | 'always'

export interface ApprovalGrantRecord {
  id: string
  scope: GrantScope
  groupKey: string
  toolName: string
  grantedAt: string
  expiresAt: string | null
}

function mapRow(row: typeof approvalGrant.$inferSelect): ApprovalGrantRecord {
  return {
    id: row.id,
    scope: row.scope,
    groupKey: row.groupKey,
    toolName: row.toolName,
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt
  }
}

export function getApprovalGrant(db: AppDatabase, groupKey: string): ApprovalGrantRecord | undefined {
  const row = db.select().from(approvalGrant).where(eq(approvalGrant.groupKey, groupKey)).all()[0]
  return row ? mapRow(row) : undefined
}

export function listApprovalGrants(db: AppDatabase): ApprovalGrantRecord[] {
  return db.select().from(approvalGrant).all().map(mapRow)
}

/** 持久授权必须是 always 且未过期;session/once 永不从数据库读回。 */
export function hasActiveApprovalGrant(db: AppDatabase, groupKey: string, now = new Date()): boolean {
  const grant = getApprovalGrant(db, groupKey)
  if (!grant) return false
  if (grant.scope !== 'always') return false
  if (!grant.expiresAt) return true
  return new Date(grant.expiresAt).getTime() > now.getTime()
}

export function upsertApprovalGrant(
  db: AppDatabase,
  input: {
    groupKey: string
    toolName: string
    expiresAt: string
    scope?: GrantScope
  }
): ApprovalGrantRecord {
  const existing = getApprovalGrant(db, input.groupKey)
  if (existing) {
    db.update(approvalGrant)
      .set({
        scope: input.scope ?? 'always',
        toolName: input.toolName,
        grantedAt: nowIso(),
        expiresAt: input.expiresAt
      })
      .where(eq(approvalGrant.id, existing.id))
      .run()
    return { ...existing, scope: input.scope ?? 'always', toolName: input.toolName, grantedAt: nowIso(), expiresAt: input.expiresAt }
  }
  const row: typeof approvalGrant.$inferInsert = {
    id: ulid(),
    scope: input.scope ?? 'always',
    groupKey: input.groupKey,
    toolName: input.toolName,
    grantedAt: nowIso(),
    expiresAt: input.expiresAt
  }
  db.insert(approvalGrant).values(row).run()
  return mapRow(row as typeof approvalGrant.$inferSelect)
}

export function deleteApprovalGrant(db: AppDatabase, groupKey: string): boolean {
  const existing = getApprovalGrant(db, groupKey)
  if (!existing) return false
  db.delete(approvalGrant).where(eq(approvalGrant.id, existing.id)).run()
  return true
}

export function pruneExpiredApprovalGrants(db: AppDatabase, now = new Date()): number {
  const rows = listApprovalGrants(db)
  let removed = 0
  for (const row of rows) {
    if (!row.expiresAt) continue
    if (new Date(row.expiresAt).getTime() > now.getTime()) continue
    db.delete(approvalGrant).where(eq(approvalGrant.id, row.id)).run()
    removed++
  }
  return removed
}
