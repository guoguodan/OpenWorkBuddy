import { and, desc, eq } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { inspirationPost } from './schema.js'

export interface InspirationPostRecord {
  id: string
  title: string
  body: string
  source: string
  tags: string[]
  favorite: boolean
  createdAt: string
  updatedAt: string
}

function parseTags(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 12)
  } catch {
    return []
  }
}

function mapRow(row: typeof inspirationPost.$inferSelect): InspirationPostRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    source: row.source,
    tags: parseTags(row.tags),
    favorite: row.favorite !== 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function listInspirations(db: AppDatabase, workspaceId: string): InspirationPostRecord[] {
  return db
    .select()
    .from(inspirationPost)
    .where(eq(inspirationPost.workspaceId, workspaceId))
    .orderBy(desc(inspirationPost.updatedAt), desc(inspirationPost.id))
    .all()
    .map(mapRow)
}

export interface InspirationInput {
  workspaceId: string
  title: string
  body?: string
  source?: string
  tags?: string[]
}

export function createInspiration(db: AppDatabase, input: InspirationInput): InspirationPostRecord {
  const at = nowIso()
  const row = {
    id: ulid(),
    workspaceId: input.workspaceId,
    title: input.title.trim().slice(0, 160) || '未命名灵感',
    body: (input.body ?? '').slice(0, 8000),
    source: (input.source ?? '本地').slice(0, 80),
    tags: JSON.stringify((input.tags ?? []).slice(0, 12)),
    favorite: 0,
    createdAt: at,
    updatedAt: at
  }
  db.insert(inspirationPost).values(row).run()
  return mapRow(row as typeof inspirationPost.$inferSelect)
}

export function setInspirationFavorite(
  db: AppDatabase,
  workspaceId: string,
  id: string,
  favorite: boolean
): InspirationPostRecord | undefined {
  const existing = db
    .select()
    .from(inspirationPost)
    .where(and(eq(inspirationPost.id, id), eq(inspirationPost.workspaceId, workspaceId)))
    .all()[0]
  if (!existing) return undefined
  db.update(inspirationPost)
    .set({ favorite: favorite ? 1 : 0, updatedAt: nowIso() })
    .where(eq(inspirationPost.id, id))
    .run()
  const next = db.select().from(inspirationPost).where(eq(inspirationPost.id, id)).all()[0]
  return next ? mapRow(next) : undefined
}

export function deleteInspiration(
  db: AppDatabase,
  workspaceId: string,
  id: string
): boolean {
  const existing = db
    .select()
    .from(inspirationPost)
    .where(and(eq(inspirationPost.id, id), eq(inspirationPost.workspaceId, workspaceId)))
    .all()[0]
  if (!existing) return false
  db.delete(inspirationPost).where(eq(inspirationPost.id, id)).run()
  return true
}
