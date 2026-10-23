import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { conversation, eventLog, message, workspace } from './schema.js'

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageStatus = 'streaming' | 'done' | 'interrupted'

export interface WorkspaceRecord {
  id: string
  name: string
  rootPath: string
}

/** 一个根目录 = 一个工作区;重复打开同一目录复用同一条记录 */
export function ensureWorkspace(db: AppDatabase, rootPath: string, name?: string): WorkspaceRecord {
  const existing = db.select().from(workspace).where(eq(workspace.rootPath, rootPath)).all()[0]
  if (existing) {
    return { id: existing.id, name: existing.name, rootPath: existing.rootPath }
  }
  const row = {
    id: ulid(),
    name: name ?? rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'workspace',
    rootPath,
    createdAt: nowIso()
  }
  db.insert(workspace).values(row).run()
  return { id: row.id, name: row.name, rootPath: row.rootPath }
}

export interface ConversationRecord {
  id: string
  workspaceId: string
  title: string
  modeId: string
  status: 'active' | 'archived'
  lastSeq: number
  createdAt: string
  updatedAt: string
}

export function createConversation(
  db: AppDatabase,
  input: { workspaceId: string; title: string; modeId: string }
): ConversationRecord {
  const at = nowIso()
  const row: ConversationRecord = {
    id: ulid(),
    workspaceId: input.workspaceId,
    title: input.title.slice(0, 200),
    modeId: input.modeId,
    status: 'active',
    lastSeq: 0,
    createdAt: at,
    updatedAt: at
  }
  db.insert(conversation).values(row).run()
  return row
}

export function getConversation(db: AppDatabase, id: string): ConversationRecord | undefined {
  return db.select().from(conversation).where(eq(conversation.id, id)).all()[0] as
    | ConversationRecord
    | undefined
}

export function listConversations(db: AppDatabase, workspaceId: string): ConversationRecord[] {
  return db
    .select()
    .from(conversation)
    .where(eq(conversation.workspaceId, workspaceId))
    .orderBy(desc(conversation.updatedAt))
    .all() as ConversationRecord[]
}

export function deleteConversation(db: AppDatabase, id: string): void {
  // 级联依赖 foreign_keys=ON;这里显式开启事务保证原子
  db.transaction((tx) => {
    tx.delete(conversation).where(eq(conversation.id, id)).run()
  })
}

export interface MessageRecord {
  id: string
  conversationId: string
  seq: number
  role: MessageRole
  content: unknown
  status: MessageStatus
  clientRequestId: string | null
  model: string | null
  tokenIn: number
  tokenOut: number
  createdAt: string
}

export interface AppendMessageInput {
  conversationId: string
  role: MessageRole
  content: unknown
  clientRequestId?: string
  model?: string
  tokenIn?: number
  tokenOut?: number
  status?: MessageStatus
}

/**
 * 追加消息并推进 last_seq。
 * 幂等:同一 (conversation_id, client_request_id) 重复写入返回已有记录,不新增。
 */
export function appendMessage(
  db: AppDatabase,
  input: AppendMessageInput
): { record: MessageRecord; deduped: boolean } {
  const existing =
    input.clientRequestId !== undefined
      ? (db
          .select()
          .from(message)
          .where(
            and(
              eq(message.conversationId, input.conversationId),
              eq(message.clientRequestId, input.clientRequestId)
            )
          )
          .all()[0] as MessageRecord | undefined)
      : undefined
  if (existing) return { record: existing, deduped: true }

  return db.transaction((tx) => {
    const conv = tx.select().from(conversation).where(eq(conversation.id, input.conversationId)).all()[0]
    if (!conv) throw new Error(`会话不存在: ${input.conversationId}`)
    const seq = conv.lastSeq + 1
    const at = nowIso()
    const row = {
      id: ulid(),
      conversationId: input.conversationId,
      seq,
      role: input.role,
      contentJson: JSON.stringify(input.content ?? null),
      status: input.status ?? 'done',
      clientRequestId: input.clientRequestId ?? null,
      model: input.model ?? null,
      tokenIn: safeTokenCount(input.tokenIn),
      tokenOut: safeTokenCount(input.tokenOut),
      createdAt: at
    }
    tx.insert(message).values(row).run()
    tx.update(conversation)
      .set({ lastSeq: seq, updatedAt: at })
      .where(eq(conversation.id, input.conversationId))
      .run()
    return { record: toMessageRecord(row), deduped: false }
  })
}

/**
 * token 数是外部模型网关给的,可能是 undefined/NaN/负值。
 * better-sqlite3 把 NaN 绑定成 NULL,会撞 NOT NULL 约束,所以入口统一收敛。
 */
function safeTokenCount(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.trunc(value)
}

function toMessageRecord(row: typeof message.$inferSelect): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    role: row.role,
    content: JSON.parse(row.contentJson),
    status: row.status,
    clientRequestId: row.clientRequestId,
    model: row.model,
    tokenIn: row.tokenIn,
    tokenOut: row.tokenOut,
    createdAt: row.createdAt
  }
}

export function listMessages(
  db: AppDatabase,
  conversationId: string,
  opts: { afterSeq?: number; limit?: number } = {}
): MessageRecord[] {
  const after = opts.afterSeq ?? 0
  const limit = opts.limit ?? 1000
  return db
    .select()
    .from(message)
    .where(and(eq(message.conversationId, conversationId), sql`${message.seq} > ${after}`))
    .orderBy(asc(message.seq))
    .limit(limit)
    .all()
    .map(toMessageRecord)
}

/** 断线重放与审计:同一个会话内 seq 单调 */
export function appendEvent(
  db: AppDatabase,
  conversationId: string,
  type: string,
  payload: unknown
): number {
  return db.transaction((tx) => {
    const conv = tx.select().from(conversation).where(eq(conversation.id, conversationId)).all()[0]
    if (!conv) throw new Error(`会话不存在: ${conversationId}`)
    // event_log 有独立序列:lastSeq 只服务 message,不共用
    const maxRow = tx
      .select({ maxSeq: sql<number>`coalesce(max(${eventLog.seq}), 0)` })
      .from(eventLog)
      .where(eq(eventLog.conversationId, conversationId))
      .all()[0]
    const seq = (maxRow?.maxSeq ?? 0) + 1
    tx.insert(eventLog)
      .values({
        id: ulid(),
        conversationId,
        seq,
        type,
        payloadJson: JSON.stringify(payload ?? null),
        createdAt: nowIso()
      })
      .run()
    return seq
  })
}

export function listEvents(
  db: AppDatabase,
  conversationId: string,
  afterSeq = 0
): Array<{ seq: number; type: string; payload: unknown }> {
  return db
    .select()
    .from(eventLog)
    .where(and(eq(eventLog.conversationId, conversationId), sql`${eventLog.seq} > ${afterSeq}`))
    .orderBy(asc(eventLog.seq))
    .all()
    .map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payloadJson) }))
}