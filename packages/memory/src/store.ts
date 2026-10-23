import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { AppDatabase } from '@openwb/storage'
import { memoryEntry, ulid, nowIso } from '@openwb/storage'
import { clipLine, contentHash, estimateTokens, normalize } from './format.js'
import type { MemoryItem, MemoryKind, MemoryScope } from './types.js'

export interface AddMemoryInput {
  scope: MemoryScope
  workspaceId?: string | null
  kind: MemoryKind
  content: string
  sourcePath?: string | null
  pinned?: boolean
}

export interface AddMemoryResult {
  item: MemoryItem | null
  deduped: boolean
  clipped: boolean
}

/** 写入前规范化去重:同 scope + contentHash 已存在则跳过 */
export function addMemory(db: AppDatabase, input: AddMemoryInput): AddMemoryResult {
  const { text, truncated } = clipLine(input.content)
  if (!text) return { item: null, deduped: false, clipped: false }

  const hash = contentHash(input.scope, input.kind, text)
  const existing = db
    .select()
    .from(memoryEntry)
    .where(and(eq(memoryEntry.scope, input.scope), eq(memoryEntry.contentHash, hash)))
    .all()[0]
  if (existing && !existing.deletedAt) {
    return { item: toItem(existing), deduped: true, clipped: truncated }
  }
  // 曾删除过的同内容:复活而不是插入重复行(唯一索引不允许两行同 hash)
  if (existing && existing.deletedAt) {
    db.update(memoryEntry)
      .set({ deletedAt: null, createdAt: nowIso(), pinned: input.pinned ? 1 : 0 })
      .where(eq(memoryEntry.id, existing.id))
      .run()
    return { item: toItem({ ...existing, deletedAt: null, pinned: input.pinned ? 1 : 0 }), deduped: false, clipped: truncated }
  }

  const row = {
    id: ulid(),
    scope: input.scope,
    workspaceId: input.workspaceId ?? null,
    kind: input.kind,
    content: text,
    contentHash: hash,
    sourcePath: input.sourcePath ?? null,
    pinned: input.pinned ? 1 : 0,
    tokens: estimateTokens(text),
    createdAt: nowIso(),
    deletedAt: null
  }
  db.insert(memoryEntry).values(row).run()
  return { item: toItem(row), deduped: false, clipped: truncated }
}

function toItem(row: typeof memoryEntry.$inferSelect): MemoryItem {
  return {
    id: row.id,
    scope: row.scope,
    workspaceId: row.workspaceId,
    kind: row.kind,
    content: row.content,
    contentHash: row.contentHash,
    sourcePath: row.sourcePath,
    pinned: row.pinned === 1,
    tokens: row.tokens,
    createdAt: row.createdAt
  }
}

export function listMemory(
  db: AppDatabase,
  filter: { scope?: MemoryScope; workspaceId?: string | null; limit?: number } = {}
): MemoryItem[] {
  const conditions = [isNull(memoryEntry.deletedAt)]
  if (filter.scope) conditions.push(eq(memoryEntry.scope, filter.scope))
  if (filter.workspaceId !== undefined) {
    conditions.push(
      filter.workspaceId === null
        ? isNull(memoryEntry.workspaceId)
        : eq(memoryEntry.workspaceId, filter.workspaceId)
    )
  }
  return db
    .select()
    .from(memoryEntry)
    .where(and(...conditions))
    .orderBy(desc(memoryEntry.pinned), desc(memoryEntry.createdAt))
    .limit(filter.limit ?? 500)
    .all()
    .map(toItem)
}

/** 软删除:写 deleted_at + 从 FTS 删除 + 调用方负责同步 MEMORY.md 文本 */
export function markDeleted(db: AppDatabase, id: string): void {
  const row = db.select().from(memoryEntry).where(eq(memoryEntry.id, id)).all()[0]
  if (!row) throw new Error(`记忆不存在: ${id}`)
  // FTS 由 memory_entry_au 触发器同步;这里再手工发一次 'delete' 会让索引损坏
  db.update(memoryEntry).set({ deletedAt: nowIso() }).where(eq(memoryEntry.id, id)).run()
}

export interface SearchHit {
  item: MemoryItem
  score: number
}

/** FTS5 关键词召回;查询串做安全化,避免 MATCH 语法错误 */
export function searchMemory(
  db: AppDatabase,
  query: string,
  filter: { workspaceId?: string | null; limit?: number } = {}
): SearchHit[] {
  const raw = normalize(query)
    .split(' ')
    .map((t) => t.replace(/["'*:^()\-]/g, '').trim())
    .filter((t) => t.length > 0)
  if (raw.length === 0) return []

  // trigram 分词器要求每个查询词 >= 3 字符;更短的词退回 LIKE 子串匹配,
  // 否则中文双字词(如"迁移")会静默召回 0 条。
  const longTerms = raw.filter((t) => [...t].length >= 3)
  const shortTerms = raw.filter((t) => [...t].length < 3)

  const rows: Array<Record<string, unknown>> = []
  if (longTerms.length > 0) {
    const match = longTerms.map((t) => `"${t}"`).join(' OR ')
    rows.push(
      ...(db.all(sql`
        SELECT e.id,
               e.scope, e.workspace_id, e.kind, e.content, e.content_hash, e.source_path,
               e.pinned, e.tokens, e.created_at, e.deleted_at,
               bm25(memory_fts) AS score
        FROM memory_fts f
        JOIN memory_entry e ON e.rowid = f.rowid
        WHERE memory_fts MATCH ${match}
          AND e.deleted_at IS NULL
          ${filter.workspaceId === undefined ? sql`` : filter.workspaceId === null ? sql`AND e.workspace_id IS NULL` : sql`AND e.workspace_id = ${filter.workspaceId}`}
        ORDER BY score
        LIMIT ${filter.limit ?? 20}
      `) as Array<Record<string, unknown>>)
    )
  }

  for (const term of shortTerms) {
    if (rows.length >= (filter.limit ?? 20)) break
    const like = `%${term}%`
    const extra = db.all(sql`
      SELECT e.id,
             e.scope, e.workspace_id, e.kind, e.content, e.content_hash, e.source_path,
             e.pinned, e.tokens, e.created_at, e.deleted_at,
             0.0 AS score
      FROM memory_entry e
      WHERE e.deleted_at IS NULL
        AND e.content LIKE ${like}
        ${filter.workspaceId === undefined ? sql`` : filter.workspaceId === null ? sql`AND e.workspace_id IS NULL` : sql`AND e.workspace_id = ${filter.workspaceId}`}
      ORDER BY e.pinned DESC, e.created_at DESC
      LIMIT ${filter.limit ?? 20}
    `) as Array<Record<string, unknown>>
    for (const r of extra) {
      if (!rows.some((x) => x.id === r.id)) rows.push(r)
    }
  }

  return rows.map((r) => ({
    item: {
      id: String(r.id),
      scope: r.scope as MemoryScope,
      workspaceId: (r.workspace_id as string | null) ?? null,
      kind: r.kind as MemoryKind,
      content: String(r.content),
      contentHash: String(r.content_hash),
      sourcePath: (r.source_path as string | null) ?? null,
      pinned: Number(r.pinned) === 1,
      tokens: Number(r.tokens),
      createdAt: String(r.created_at)
    },
    score: Number(r.score)
  }))
}

export function memoryById(db: AppDatabase, id: string): MemoryItem | undefined {
  const row = db.select().from(memoryEntry).where(eq(memoryEntry.id, id)).all()[0]
  return row ? toItem(row) : undefined
}