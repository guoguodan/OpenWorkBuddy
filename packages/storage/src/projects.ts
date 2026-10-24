import { and, desc, eq, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { conversation, project } from './schema.js'

export interface ProjectStats {
  taskCount: number
  lastActiveAt: string | null
}

export interface ProjectRecord {
  id: string
  workspaceId: string
  name: string
  description: string
  instructions: string
  skillNames: string[]
  pinnedAt: string | null
  stats: ProjectStats
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

function statsFor(db: AppDatabase, projectId: string): ProjectStats {
  const row = db
    .select({
      tasks: sql<number>`count(${conversation.id})`,
      lastActiveAt: sql<string | null>`max(${conversation.updatedAt})`
    })
    .from(conversation)
    .where(eq(conversation.projectId, projectId))
    .all()[0]
  return {
    taskCount: Number(row?.tasks ?? 0),
    lastActiveAt: row?.lastActiveAt ?? null
  }
}

function mapRow(row: typeof project.$inferSelect, stats: ProjectStats): ProjectRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    skillNames: parseNames(row.skillNames),
    pinnedAt: row.pinnedAt,
    stats,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function listProjects(db: AppDatabase, workspaceId: string): ProjectRecord[] {
  return db
    .select()
    .from(project)
    .where(eq(project.workspaceId, workspaceId))
    .orderBy(sql`${project.pinnedAt} IS NULL`, desc(project.pinnedAt), desc(project.updatedAt), desc(project.id))
    .all()
    .map((row) => mapRow(row, statsFor(db, row.id)))
}

export function getProject(db: AppDatabase, id: string): ProjectRecord | undefined {
  const row = db.select().from(project).where(eq(project.id, id)).all()[0]
  return row ? mapRow(row, statsFor(db, row.id)) : undefined
}

export interface ProjectInput {
  workspaceId: string
  name: string
  description?: string
  instructions?: string
  skillNames?: string[]
  pinned?: boolean
}

export function createProject(db: AppDatabase, input: ProjectInput): ProjectRecord {
  const at = nowIso()
  const row = {
    id: ulid(),
    workspaceId: input.workspaceId,
    name: input.name.trim().slice(0, 120) || '未命名项目',
    description: (input.description ?? '').slice(0, 600),
    instructions: (input.instructions ?? '').slice(0, 8000),
    skillNames: JSON.stringify(input.skillNames ?? []),
    pinnedAt: input.pinned ? at : null,
    createdAt: at,
    updatedAt: at
  }
  db.insert(project).values(row).run()
  return mapRow(row as typeof project.$inferSelect, { taskCount: 0, lastActiveAt: null })
}

export function updateProject(
  db: AppDatabase,
  id: string,
  patch: Partial<Omit<ProjectInput, 'workspaceId'>>
): ProjectRecord | undefined {
  const existing = getProject(db, id)
  if (!existing) return undefined
  const next: Partial<typeof project.$inferInsert> = { updatedAt: nowIso() }
  if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 120) || existing.name
  if (patch.description !== undefined) next.description = patch.description.slice(0, 600)
  if (patch.instructions !== undefined) next.instructions = patch.instructions.slice(0, 8000)
  if (patch.skillNames !== undefined) next.skillNames = JSON.stringify(patch.skillNames)
  if (patch.pinned !== undefined) next.pinnedAt = patch.pinned ? (existing.pinnedAt ?? nowIso()) : null
  db.update(project).set(next).where(eq(project.id, id)).run()
  return getProject(db, id)
}

/** 删除项目不删任务:任务回落到普通任务列表,避免误删用户成果。 */
export function deleteProject(db: AppDatabase, id: string): boolean {
  const existing = getProject(db, id)
  if (!existing) return false
  db.transaction((tx) => {
    tx.update(conversation).set({ projectId: null }).where(eq(conversation.projectId, id)).run()
    tx.delete(project).where(eq(project.id, id)).run()
  })
  return true
}

export function assertProjectInWorkspace(
  db: AppDatabase,
  workspaceId: string,
  projectId: string
): ProjectRecord {
  const row = db
    .select()
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
    .all()[0]
  if (!row) throw new Error('项目不存在或不属于当前工作区')
  return mapRow(row, statsFor(db, row.id))
}
