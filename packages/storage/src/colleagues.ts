import { desc, eq } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { colleague } from './schema.js'

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
  modeId: string
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

function mapRow(row: typeof colleague.$inferSelect): ColleagueRecord {
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
    modeId: row.modeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function listColleagues(db: AppDatabase, workspaceId: string): ColleagueRecord[] {
  return db
    .select()
    .from(colleague)
    .where(eq(colleague.workspaceId, workspaceId))
    .orderBy(desc(colleague.updatedAt))
    .all()
    .map(mapRow)
}

export function getColleague(db: AppDatabase, id: string): ColleagueRecord | undefined {
  const row = db.select().from(colleague).where(eq(colleague.id, id)).all()[0]
  return row ? mapRow(row) : undefined
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
    modeId: input.modeId ?? 'craft',
    createdAt: at,
    updatedAt: at
  }
  db.insert(colleague).values(row).run()
  return mapRow(row as typeof colleague.$inferSelect)
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
  if (patch.modeId !== undefined) next.modeId = patch.modeId
  db.update(colleague).set(next).where(eq(colleague.id, id)).run()
  return getColleague(db, id)
}

export function deleteColleague(db: AppDatabase, id: string): boolean {
  const existing = getColleague(db, id)
  if (!existing) return false
  db.delete(colleague).where(eq(colleague.id, id)).run()
  return true
}
