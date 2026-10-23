import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { artifact } from './schema.js'

export type ArtifactKind = 'file' | 'html' | 'url' | 'image'

export interface ArtifactRecord {
  id: string
  taskId: string | null
  conversationId: string | null
  kind: ArtifactKind
  title: string
  description: string | null
  path: string | null
  url: string | null
  size: number
  sha256: string | null
  previewRef: string | null
  createdAt: string
}

export interface ArtifactInput {
  kind: ArtifactKind
  title: string
  description?: string
  path?: string
  url?: string
  size?: number
  sha256?: string
}

function toRecord(row: typeof artifact.$inferSelect): ArtifactRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    // v2 才加入 conversation_id;旧库升级后该列一定存在
    conversationId: (row as { conversationId?: string | null }).conversationId ?? null,
    kind: row.kind as ArtifactKind,
    title: row.title,
    description: (row as { description?: string | null }).description ?? null,
    path: row.path,
    url: row.url,
    size: row.size,
    sha256: row.sha256,
    previewRef: row.previewRef,
    createdAt: row.createdAt
  }
}

export interface InsertArtifactsResult {
  record: ArtifactRecord
  deduped: boolean
}

/**
 * 同一任务内按 sha256 去重(URL 按 url 去重)。
 * 去重只发生在任务边界内:不同任务再次交付同一文件仍应各自留痕。
 */
export function insertArtifacts(
  db: AppDatabase,
  input: { taskId: string | null; conversationId: string | null; items: ArtifactInput[] }
): InsertArtifactsResult[] {
  return db.transaction((tx) => {
    const out: InsertArtifactsResult[] = []
    for (const item of input.items) {
      const existing = findExisting(tx as unknown as AppDatabase, input.taskId, item)
      if (existing) {
        out.push({ record: existing, deduped: true })
        continue
      }
      const row = {
        id: ulid(),
        taskId: input.taskId,
        conversationId: input.conversationId,
        kind: item.kind,
        title: item.title,
        description: item.description ?? null,
        path: item.path ?? null,
        url: item.url ?? null,
        size: item.size ?? 0,
        sha256: item.sha256 ?? null,
        previewRef: null,
        createdAt: nowIso()
      }
      tx.insert(artifact).values(row as typeof artifact.$inferInsert).run()
      out.push({ record: toRecord(row as typeof artifact.$inferSelect), deduped: false })
    }
    return out
  })
}

function findExisting(
  db: AppDatabase,
  taskId: string | null,
  item: ArtifactInput
): ArtifactRecord | undefined {
  const taskCond = taskId === null ? isNull(artifact.taskId) : eq(artifact.taskId, taskId)
  let cond
  if (item.kind === 'url') {
    if (!item.url) return undefined
    cond = and(taskCond, eq(artifact.kind, 'url'), eq(artifact.url, item.url))
  } else {
    if (!item.sha256) return undefined
    cond = and(taskCond, eq(artifact.sha256, item.sha256))
  }
  const rows = db.select().from(artifact).where(cond).orderBy(asc(artifact.createdAt)).all()
  return rows[0] ? toRecord(rows[0]) : undefined
}

export function listArtifactsByTask(db: AppDatabase, taskId: string): ArtifactRecord[] {
  return db
    .select()
    .from(artifact)
    .where(eq(artifact.taskId, taskId))
    .orderBy(asc(artifact.createdAt))
    .all()
    .map(toRecord)
}

export function listArtifactsByConversation(db: AppDatabase, conversationId: string): ArtifactRecord[] {
  return db
    .select()
    .from(artifact)
    .where(eq(artifact.conversationId, conversationId))
    .orderBy(asc(artifact.createdAt))
    .all()
    .map(toRecord)
}

export function countArtifactsByTask(db: AppDatabase, taskId: string): number {
  const rows = db
    .select({ n: sql<number>`count(*)` })
    .from(artifact)
    .where(eq(artifact.taskId, taskId))
    .all()
  return rows[0]?.n ?? 0
}

