import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { artifact, conversation, eventLog, message, task, workspace } from './schema.js'
import { enqueuePendingTx } from './sync.js'

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
  channelId: string | null
  title: string
  /** 用户手动设置的标题;为空时展示自动标题 title */
  customTitle: string | null
  modeId: string
  colleagueId: string | null
  projectId: string | null
  expertId: string | null
  pinnedAt: string | null
  pinOrder: number | null
  status: 'active' | 'archived'
  lastSeq: number
  createdAt: string
  updatedAt: string
}

/**
 * 任务列表筛选用的聚合状态。
 *
 * 会话本身没有运行状态:真正执行的是 task 行。这里把 task/artifact 聚合成
 * 界面需要的四个事实,避免渲染层根据消息数量或时间猜测"是否执行中"。
 */
export interface ConversationSummaryStats {
  taskTotal: number
  pending: number
  running: number
  failed: number
  done: number
  artifacts: number
}

export type ConversationSummaryRecord = ConversationRecord & ConversationSummaryStats

export function createConversation(
  db: AppDatabase,
  input: {
    workspaceId: string
    title: string
    modeId: string
    channelId?: string | null
    colleagueId?: string | null
    projectId?: string | null
    expertId?: string | null
  }
): ConversationRecord {
  const at = nowIso()
  const row: ConversationRecord = {
    id: ulid(),
    workspaceId: input.workspaceId,
    channelId: input.channelId ?? null,
    title: input.title.slice(0, 200),
    customTitle: null,
    modeId: input.modeId,
    colleagueId: input.colleagueId ?? null,
    projectId: input.projectId ?? null,
    expertId: input.expertId ?? null,
    pinnedAt: null,
    pinOrder: null,
    status: 'active',
    lastSeq: 0,
    createdAt: at,
    updatedAt: at
  }
  db.insert(conversation).values(row).run()
  return row
}

export function setConversationChannel(
  db: AppDatabase,
  conversationId: string,
  channelId: string | null
): void {
  db.update(conversation)
    .set({ channelId, updatedAt: nowIso() })
    .where(eq(conversation.id, conversationId))
    .run()
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
    // 置顶组按用户在侧栏拖出的顺序;未置顶仍按最近活动倒序。
    .orderBy(
      sql`${conversation.pinnedAt} is null`,
      asc(conversation.pinOrder),
      desc(conversation.updatedAt)
    )
    .all() as ConversationRecord[]
}

/**
 * 列出工作区会话并附带任务/交付物统计。
 *
 * 用一次分组查询而不是每个会话再查一次:列表滚动时 N+1 会直接拖慢首屏。
 * 统计来自真实 task 与 artifact 行,不做任何乐观推断。
 */
export function listConversationSummaries(
  db: AppDatabase,
  workspaceId: string
): ConversationSummaryRecord[] {
  const rows = listConversations(db, workspaceId)
  if (rows.length === 0) return []

  const taskStats = db
    .select({
      conversationId: task.conversationId,
      total: sql<number>`count(*)`,
        pending: sql<number>`sum(case when ${task.status} = 'pending' then 1 else 0 end)`,
      running: sql<number>`sum(case when ${task.status} = 'running' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${task.status} = 'failed' then 1 else 0 end)`,
      done: sql<number>`sum(case when ${task.status} = 'done' then 1 else 0 end)`
    })
    .from(task)
    .groupBy(task.conversationId)
    .all()

  const artifactStats = db
    .select({
      conversationId: artifact.conversationId,
      total: sql<number>`count(*)`
    })
    .from(artifact)
    .groupBy(artifact.conversationId)
    .all()

  const tasksById = new Map(taskStats.map((row) => [row.conversationId, row]))
  const artifactsById = new Map(
    artifactStats
      .filter((row) => Boolean(row.conversationId))
      .map((row) => [row.conversationId as string, row.total])
  )

  return rows.map((row) => {
    const stats = tasksById.get(row.id)
    return {
      ...row,
      taskTotal: Number(stats?.total ?? 0),
      pending: Number(stats?.pending ?? 0),
      running: Number(stats?.running ?? 0),
      failed: Number(stats?.failed ?? 0),
      done: Number(stats?.done ?? 0),
      artifacts: Number(artifactsById.get(row.id) ?? 0)
    }
  })
}

/** 置顶只改排序依据,不改 updatedAt:置顶不应把任务伪装成“刚刚有活动”。 */
export function setConversationPinned(
  db: AppDatabase,
  conversationId: string,
  pinned: boolean
): ConversationRecord | undefined {
  const existing = getConversation(db, conversationId)
  if (!existing) return undefined
  // 新置顶排到末尾;取消置顶清空排序,避免之后重新置顶沿用旧位置。
  const maxRow = pinned
    ? db
        .select({ maxOrder: sql<number>`coalesce(max(${conversation.pinOrder}), 0)` })
        .from(conversation)
        .where(and(eq(conversation.workspaceId, existing.workspaceId), eq(conversation.status, 'active')))
        .all()[0]
    : undefined
  db.update(conversation)
    .set({
      pinnedAt: pinned ? nowIso() : null,
      pinOrder: pinned ? Number(maxRow?.maxOrder ?? 0) + 1 : null
    })
    .where(eq(conversation.id, conversationId))
    .run()
  return getConversation(db, conversationId)
}

/**
 * 重排置顶任务。
 *
 * 必须传入当前全部置顶任务且顺序完整,否则拒绝执行:
 * 部分更新会让未提交的项落在旧序号上,刷新后顺序看似"随机跳变"。
 */
export function reorderPinnedConversations(
  db: AppDatabase,
  workspaceId: string,
  orderedIds: string[]
): ConversationRecord[] {
  const pinned = db
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.workspaceId, workspaceId),
        eq(conversation.status, 'active'),
        sql`${conversation.pinnedAt} is not null`
      )
    )
    .all() as ConversationRecord[]
  const pinnedIds = new Set(pinned.map((item) => item.id))
  const givenIds = new Set(orderedIds)
  if (givenIds.size !== orderedIds.length) throw new Error('置顶排序包含重复任务')
  if (
    givenIds.size !== pinnedIds.size ||
    orderedIds.some((id) => !pinnedIds.has(id))
  ) {
    throw new Error('置顶排序必须覆盖当前全部置顶任务')
  }

  db.transaction((tx) => {
    orderedIds.forEach((id, index) => {
      tx.update(conversation)
        .set({ pinOrder: index + 1 })
        .where(eq(conversation.id, id))
        .run()
    })
  })

  return orderedIds
    .map((id) => getConversation(db, id))
    .filter((item): item is ConversationRecord => Boolean(item))
}

/**
 * 重命名写入 custom_title,保留自动标题 title 作为兜底。
 *
 * 不推进 updatedAt:改名只是标签调整,不能把任务伪装成"刚刚有活动"。
 * 传入空标题时保留原值,避免用户误清空后列表出现无标题行。
 */
export function renameConversation(
  db: AppDatabase,
  conversationId: string,
  title: string
): ConversationRecord | undefined {
  const existing = getConversation(db, conversationId)
  if (!existing) return undefined
  const next = title.trim().slice(0, 200)
  if (!next) return existing
  db.update(conversation).set({ customTitle: next }).where(eq(conversation.id, conversationId)).run()
  return getConversation(db, conversationId)
}

/**
 * 自动标题只写 title,并且绝不覆盖用户手动标题。
 *
 * 由首轮请求触发:新会话创建时标题是占位符,首轮内容不足以直接当标题,
 * 需要模型压缩成可辨识的短句。调用方负责保证只在第一轮成功结束时调用。
 */
export function setConversationAutoTitle(
  db: AppDatabase,
  conversationId: string,
  title: string
): ConversationRecord | undefined {
  const existing = getConversation(db, conversationId)
  if (!existing) return undefined
  const next = title.trim().replace(/\s+/g, ' ').slice(0, 200)
  if (!next) return existing
  if (existing.customTitle) return existing
  db.update(conversation).set({ title: next }).where(eq(conversation.id, conversationId)).run()
  return getConversation(db, conversationId)
}

/** 对外展示标题:用户标题优先,没有用户标题才用自动标题。 */
export function conversationDisplayTitle(record: ConversationRecord): string {
  return record.customTitle?.trim() || record.title
}

/** 指定助理后,后续消息会沿用该助理身份;新建会话时由 UI 显式传入。 */
export function setConversationColleague(
  db: AppDatabase,
  conversationId: string,
  colleagueId: string | null
): ConversationRecord | undefined {
  const existing = getConversation(db, conversationId)
  if (!existing) return undefined
  db.update(conversation).set({ colleagueId }).where(eq(conversation.id, conversationId)).run()
  return getConversation(db, conversationId)
}

/** 项目归属只影响分组与运行上下文,不推进 updatedAt。 */
export function setConversationProject(
  db: AppDatabase,
  conversationId: string,
  projectId: string | null
): ConversationRecord | undefined {
  const existing = getConversation(db, conversationId)
  if (!existing) return undefined
  db.update(conversation).set({ projectId }).where(eq(conversation.id, conversationId)).run()
  return getConversation(db, conversationId)
}

/** 专家归属只影响运行上下文;切换会话时按 expertId 恢复显示。 */
export function setConversationExpert(
  db: AppDatabase,
  conversationId: string,
  expertId: string | null
): ConversationRecord | undefined {
  const existing = getConversation(db, conversationId)
  if (!existing) return undefined
  db.update(conversation).set({ expertId }).where(eq(conversation.id, conversationId)).run()
  return getConversation(db, conversationId)
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
    const id = ulid()
    const createdAt = nowIso()
    tx.insert(eventLog)
      .values({
        id,
        conversationId,
        seq,
        type,
        payloadJson: JSON.stringify(payload ?? null),
        createdAt
      })
      .run()
    // 频道内的事件才需要端云同步;eventId 直接复用 event_log.id,
    // 重放时保持不变,服务端据此幂等。
    if (conv.channelId) {
      enqueuePendingTx(tx as unknown as AppDatabase, {
        workspaceId: conv.workspaceId,
        kind: 'event',
        eventId: id,
        conversationId,
        payload: { eventId: id, conversationId, seq, type, payload: payload ?? null, createdAt }
      })
    }
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
