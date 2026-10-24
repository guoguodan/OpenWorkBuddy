import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { artifact, conversation, task } from './schema.js'

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

export function toArtifactRecord(row: typeof artifact.$inferSelect): ArtifactRecord {
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
        out.push({ record: toArtifactRecord(row as typeof artifact.$inferSelect), deduped: false })
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
  return rows[0] ? toArtifactRecord(rows[0]) : undefined
}

export function listArtifactsByTask(db: AppDatabase, taskId: string): ArtifactRecord[] {
  return db
    .select()
    .from(artifact)
    .where(eq(artifact.taskId, taskId))
    .orderBy(asc(artifact.createdAt))
    .all()
    .map(toArtifactRecord)
}

export function listArtifactsByConversation(db: AppDatabase, conversationId: string): ArtifactRecord[] {
  return db
    .select()
    .from(artifact)
    .where(eq(artifact.conversationId, conversationId))
    .orderBy(asc(artifact.createdAt))
    .all()
    .map(toArtifactRecord)
}

/**
 * 重命名交付物只改展示标题,不改磁盘文件名。
 *
 * 交付物路径是 agent 写文件时的真实路径,一旦改动会让历史记录指错文件;
 * 用户要的是"在我的成果列表里换个易懂的名字",这不需要也不应该动文件。
 */
export function renameArtifact(db: AppDatabase, id: string, title: string): ArtifactRecord | null {
  const next = title.trim()
  if (!next) throw new Error('标题不能为空')
  const result = db.update(artifact).set({ title: next }).where(eq(artifact.id, id)).run()
  if (result.changes === 0) return null
  const row = db.select().from(artifact).where(eq(artifact.id, id)).get()
  return row ? toArtifactRecord(row) : null
}

/**
 * 移除交付物记录只删清单条目,不删文件。
 *
 * 用户点"移除"是想从成果列表里清掉,而不是希望磁盘上的报告消失;
 * 反向删除文件属于破坏性操作,必须走审批与回收站,不能藏在列表操作里。
 */
export function removeArtifact(db: AppDatabase, id: string): boolean {
  const result = db.delete(artifact).where(eq(artifact.id, id)).run()
  return result.changes > 0
}
export function countArtifactsByTask(db: AppDatabase, taskId: string): number {
  const rows = db
    .select({ n: sql<number>`count(*)` })
    .from(artifact)
    .where(eq(artifact.taskId, taskId))
    .all()
  return rows[0]?.n ?? 0
}

/**
 * 资料库:跨会话的交付物清单。
 *
 * 交付物必须能追溯到"哪个任务、哪个会话产出的",否则用户在资料库里看到
 * 一堆同名文件却不知道从哪来。会话/任务被删除后仍然保留 artifact 记录会
 * 变成孤儿,所以这里用 left join 并把标题降级为 null。
 */
export interface LibraryArtifact extends ArtifactRecord {
  conversationTitle: string | null
  taskTitle: string | null
  conversationId: string | null
}

export function listLibraryArtifacts(db: AppDatabase, options: { limit?: number } = {}): LibraryArtifact[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
  const rows = db
    .select({
      artifact,
      conversationTitle: conversation.title,
      taskTitle: task.title
    })
    .from(artifact)
    .leftJoin(conversation, eq(artifact.conversationId, conversation.id))
    .leftJoin(task, eq(artifact.taskId, task.id))
    .orderBy(sql`${artifact.createdAt} DESC`)
    .limit(limit)
    .all()
  return rows.map((row) => ({
    ...toArtifactRecord(row.artifact),
    conversationTitle: row.conversationTitle ?? null,
    taskTitle: row.taskTitle ?? null
  }))
}

