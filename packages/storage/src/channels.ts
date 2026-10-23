import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import type { ArtifactRecord } from './artifacts.js'
import { toArtifactRecord } from './artifacts.js'
import { artifact, channel, channelArtifact, conversation } from './schema.js'

export interface ChannelRecord {
  id: string
  workspaceId: string
  name: string
  description: string | null
  createdAt: string
}

export interface ChannelSummary extends ChannelRecord {
  conversationCount: number
}

/** 频道名允许中文,但去掉首尾空白并限制长度 */
export function normalizeChannelName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new Error('频道名不能为空')
  if (trimmed.length > 40) throw new Error('频道名不能超过 40 个字符')
  return trimmed
}

export function createChannel(
  db: AppDatabase,
  input: { workspaceId: string; name: string; description?: string }
): ChannelRecord {
  const name = normalizeChannelName(input.name)
  const existing = db
    .select()
    .from(channel)
    .where(and(eq(channel.workspaceId, input.workspaceId), eq(channel.name, name)))
    .all()[0]
  // 同名频道复用:界面上重复点击"新建"不应产生两个长得一样的频道
  if (existing) return toRecord(existing)
  const row = {
    id: ulid(),
    workspaceId: input.workspaceId,
    name,
    description: input.description?.trim() ? input.description.trim().slice(0, 200) : null,
    createdAt: nowIso()
  }
  db.insert(channel).values(row).run()
  return row
}

export function listChannels(db: AppDatabase, workspaceId: string): ChannelSummary[] {
  const rows = db
    .select()
    .from(channel)
    .where(eq(channel.workspaceId, workspaceId))
    .orderBy(asc(channel.createdAt))
    .all()
  const counts = new Map(
    db
      .select({ channelId: conversation.channelId, n: sql<number>`count(*)` })
      .from(conversation)
      .where(and(eq(conversation.workspaceId, workspaceId), sql`${conversation.channelId} IS NOT NULL`))
      .groupBy(conversation.channelId)
      .all()
      .map((r) => [r.channelId ?? '', Number(r.n)] as const)
  )
  return rows.map((r) => ({ ...toRecord(r), conversationCount: counts.get(r.id) ?? 0 }))
}

export function deleteChannel(db: AppDatabase, channelId: string): void {
  db.transaction((tx) => {
    // 频道删除不连坐会话:会话退回本地,消息与交付物都保留
    tx.update(conversation).set({ channelId: null }).where(eq(conversation.channelId, channelId)).run()
    tx.delete(channel).where(eq(channel.id, channelId)).run()
  })
}

export function listConversationsByChannel(db: AppDatabase, channelId: string): Array<{
  id: string
  title: string
  updatedAt: string
  lastSeq: number
}> {
  return db
    .select()
    .from(conversation)
    .where(eq(conversation.channelId, channelId))
    .orderBy(asc(conversation.createdAt))
    .all()
    .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, lastSeq: r.lastSeq }))
}

export function localConversations(db: AppDatabase, workspaceId: string): Array<{
  id: string
  title: string
  updatedAt: string
}> {
  return db
    .select()
    .from(conversation)
    .where(and(eq(conversation.workspaceId, workspaceId), isNull(conversation.channelId)))
    .all()
    .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt }))
}

/**
 * 把交付物转发到频道。共享的是引用,不复制文件:
 * 同一频道重复转发同一产物只保留一条。
 */
export function shareArtifactToChannel(
  db: AppDatabase,
  input: { channelId: string; artifactId: string; now?: Date }
): { shared: boolean } {
  const at = (input.now ?? new Date()).toISOString()
  const existing = db
    .select()
    .from(channelArtifact)
    .where(
      and(eq(channelArtifact.channelId, input.channelId), eq(channelArtifact.artifactId, input.artifactId))
    )
    .all()[0]
  if (existing) return { shared: false }
  const art = db.select().from(artifact).where(eq(artifact.id, input.artifactId)).all()[0]
  if (!art) throw new Error(`交付物不存在: ${input.artifactId}`)
  db.insert(channelArtifact)
    .values({ id: ulid(), channelId: input.channelId, artifactId: input.artifactId, sharedAt: at })
    .run()
  return { shared: true }
}

export function listChannelArtifacts(db: AppDatabase, channelId: string): ArtifactRecord[] {
  return db
    .select({ artifact })
    .from(channelArtifact)
    .innerJoin(artifact, eq(artifact.id, channelArtifact.artifactId))
    .where(eq(channelArtifact.channelId, channelId))
    .orderBy(asc(channelArtifact.sharedAt))
    .all()
    .map((r) => toArtifactRecord(r.artifact))
}

function toRecord(row: typeof channel.$inferSelect): ChannelRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt
  }
}
