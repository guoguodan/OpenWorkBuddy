import { and, desc, eq, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { colleague, conversation, message, task } from './schema.js'

export type ColleagueStatus = 'active' | 'paused'
export type ColleagueVisibility = 'personal' | 'project' | 'public'

export interface ColleagueStats {
  conversationCount: number
  tokenUsage: number
  lastActiveAt: string | null
  runningTasks: number
  failedTasks: number
  completedTasks: number
}

export interface ColleagueRecord {
  id: string
  workspaceId: string
  name: string
  title: string
  description: string
  instructions: string
  avatar: string
  skillNames: string[]
  connectorNames: string[]
  channelIds: string[]
  status: ColleagueStatus
  visibility: ColleagueVisibility
  memoryEnabled: boolean
  pinnedAt: string | null
  modeId: string
  stats: ColleagueStats
  createdAt: string
  updatedAt: string
}

function parseNames(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

function mapRow(row: typeof colleague.$inferSelect, stats: ColleagueStats): ColleagueRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    avatar: row.avatar,
    skillNames: parseNames(row.skillNames),
    connectorNames: parseNames(row.connectorNames),
    channelIds: parseNames(row.channelIds),
    status: row.status,
    visibility: row.visibility,
    memoryEnabled: row.memoryEnabled !== 0,
    pinnedAt: row.pinnedAt,
    modeId: row.modeId,
    stats,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function statsFor(db: AppDatabase, colleagueId: string): ColleagueStats {
  const row = db
    .select({
      conversations: sql<number>`count(distinct ${conversation.id})`,
      tokens: sql<number>`coalesce(sum(${message.tokenIn} + ${message.tokenOut}), 0)`,
      lastActiveAt: sql<string | null>`max(${conversation.updatedAt})`,
      runningTasks: sql<number>`(select count(*) from ${task} where ${task.conversationId} in (select id from ${conversation} where colleague_id = ${colleagueId}) and ${task.status} = 'running')`,
      failedTasks: sql<number>`(select count(*) from ${task} where ${task.conversationId} in (select id from ${conversation} where colleague_id = ${colleagueId}) and ${task.status} = 'failed')`,
      completedTasks: sql<number>`(select count(*) from ${task} where ${task.conversationId} in (select id from ${conversation} where colleague_id = ${colleagueId}) and ${task.status} = 'done')`
    })
    .from(conversation)
    .leftJoin(message, eq(message.conversationId, conversation.id))
    .where(eq(conversation.colleagueId, colleagueId))
    .all()[0]
  return {
    conversationCount: Number(row?.conversations ?? 0),
    tokenUsage: Number(row?.tokens ?? 0),
    lastActiveAt: row?.lastActiveAt ?? null,
    runningTasks: Number(row?.runningTasks ?? 0),
    failedTasks: Number(row?.failedTasks ?? 0),
    completedTasks: Number(row?.completedTasks ?? 0)
  }
}

export function listColleagues(db: AppDatabase, workspaceId: string): ColleagueRecord[] {
  return db
    .select()
    .from(colleague)
    .where(eq(colleague.workspaceId, workspaceId))
    // 置顶优先,其余按最近修改;同一秒内按 id 兜底保证顺序稳定。
    .orderBy(sql`${colleague.pinnedAt} IS NULL`, desc(colleague.pinnedAt), desc(colleague.updatedAt), desc(colleague.id))
    .all()
    .map((row) => mapRow(row, statsFor(db, row.id)))
}

export function getColleague(db: AppDatabase, id: string): ColleagueRecord | undefined {
  const row = db.select().from(colleague).where(eq(colleague.id, id)).all()[0]
  return row ? mapRow(row, statsFor(db, row.id)) : undefined
}

export interface ColleagueInput {
  workspaceId: string
  name: string
  title?: string
  description?: string
  instructions?: string
  avatar?: string
  skillNames?: string[]
  connectorNames?: string[]
  channelIds?: string[]
  status?: ColleagueStatus
  visibility?: ColleagueVisibility
  memoryEnabled?: boolean
  pinned?: boolean
  modeId?: string
}

export function createColleague(db: AppDatabase, input: ColleagueInput): ColleagueRecord {
  const at = nowIso()
  const row = {
    id: ulid(),
    workspaceId: input.workspaceId,
    name: input.name.trim().slice(0, 80) || '助理',
    title: (input.title ?? '').slice(0, 120),
    description: (input.description ?? '').slice(0, 600),
    instructions: (input.instructions ?? '').slice(0, 4000),
    avatar: input.avatar ?? 'assistant',
    skillNames: JSON.stringify(input.skillNames ?? []),
    connectorNames: JSON.stringify(input.connectorNames ?? []),
    channelIds: JSON.stringify(input.channelIds ?? []),
    status: input.status ?? 'active',
    visibility: input.visibility ?? 'personal',
    memoryEnabled: input.memoryEnabled === false ? 0 : 1,
    pinnedAt: input.pinned ? at : null,
    modeId: input.modeId ?? 'craft',
    createdAt: at,
    updatedAt: at
  }
  db.insert(colleague).values(row).run()
  return mapRow(row as typeof colleague.$inferSelect, {
    conversationCount: 0,
    tokenUsage: 0,
    lastActiveAt: null,
    runningTasks: 0,
    failedTasks: 0,
    completedTasks: 0
  })
}

export function updateColleague(
  db: AppDatabase,
  id: string,
  patch: Partial<Omit<ColleagueInput, 'workspaceId'>>
): ColleagueRecord | undefined {
  const existing = getColleague(db, id)
  if (!existing) return undefined
  const next: Partial<typeof colleague.$inferInsert> = { updatedAt: nowIso() }
  if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 80) || existing.name
  if (patch.title !== undefined) next.title = patch.title.slice(0, 120)
  if (patch.description !== undefined) next.description = patch.description.slice(0, 600)
  if (patch.instructions !== undefined) next.instructions = patch.instructions.slice(0, 4000)
  if (patch.avatar !== undefined) next.avatar = patch.avatar
  if (patch.skillNames !== undefined) next.skillNames = JSON.stringify(patch.skillNames)
  if (patch.connectorNames !== undefined) next.connectorNames = JSON.stringify(patch.connectorNames)
  if (patch.channelIds !== undefined) next.channelIds = JSON.stringify(patch.channelIds)
  if (patch.status !== undefined) next.status = patch.status
  if (patch.visibility !== undefined) next.visibility = patch.visibility
  if (patch.memoryEnabled !== undefined) next.memoryEnabled = patch.memoryEnabled ? 1 : 0
  if (patch.pinned !== undefined) next.pinnedAt = patch.pinned ? (existing.pinnedAt ?? nowIso()) : null
  if (patch.modeId !== undefined) next.modeId = patch.modeId
  db.update(colleague).set(next).where(eq(colleague.id, id)).run()
  return getColleague(db, id)
}

/** 会话归属校验:助理必须属于当前工作区且处于可用状态。 */
export function assertColleagueAssignable(
  db: AppDatabase,
  workspaceId: string,
  colleagueId: string,
  channelId?: string | null
): ColleagueRecord {
  const row = db
    .select()
    .from(colleague)
    .where(and(eq(colleague.id, colleagueId), eq(colleague.workspaceId, workspaceId)))
    .all()[0]
  if (!row) throw new Error('助理不存在')
  if (row.status === 'paused') throw new Error(`助理「${row.name}」已暂停,恢复后才能分配任务`)
  if (channelId) {
    const bound = parseNames(row.channelIds)
    if (!bound.includes(channelId)) {
      throw new Error(`助理「${row.name}」未绑定当前频道,请先在助理配置中接入该频道`)
    }
  }
  return mapRow(row, statsFor(db, row.id))
}

export function deleteColleague(db: AppDatabase, id: string): boolean {
  const existing = getColleague(db, id)
  if (!existing) return false
  db.delete(colleague).where(eq(colleague.id, id)).run()
  return true
}
