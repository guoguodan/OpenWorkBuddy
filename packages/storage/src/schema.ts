import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'

/**
 * 与 IMPLEMENTATION §5.2 的权威 DDL 一一对应。
 * 时间与 ID 统一存 TEXT:ID 用 ULID,时间用 ISO-8601 UTC,避免 SQLite 日期类型的时区坑。
 */

export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull().unique(),
  createdAt: text('created_at').notNull()
})

export const conversation = sqliteTable(
  'conversation',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    channelId: text('channel_id'),
    title: text('title').notNull(),
      customTitle: text('custom_title'),
    modeId: text('mode_id').notNull(),
    colleagueId: text('colleague_id').references(() => colleague.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => project.id, { onDelete: 'set null' }),
    expertId: text('expert_id'),
    pinnedAt: text('pinned_at'),
    pinOrder: integer('pin_order'),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    lastSeq: integer('last_seq').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [
    index('idx_conversation_ws').on(t.workspaceId, t.updatedAt),
    index('idx_conversation_channel').on(t.channelId, t.updatedAt),
    index('idx_conversation_pinned').on(t.workspaceId, t.pinnedAt, t.pinOrder)
  ]
)

export const message = sqliteTable(
  'message',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
    contentJson: text('content_json').notNull(),
    status: text('status', { enum: ['streaming', 'done', 'interrupted'] }).notNull().default('done'),
    clientRequestId: text('client_request_id'),
    model: text('model'),
    tokenIn: integer('token_in').notNull().default(0),
    tokenOut: integer('token_out').notNull().default(0),
    feedback: text('feedback', { enum: ['like', 'dislike'] }),
    feedbackReason: text('feedback_reason'),
    /** 本轮的运行上下文(模式/技能/场景/@文件),重放时据此恢复原请求。 */
    metaJson: text('meta_json'),
    createdAt: text('created_at').notNull()
  },
  (t) => [
    uniqueIndex('idx_message_conv_seq').on(t.conversationId, t.seq),
    uniqueIndex('idx_message_idem')
      .on(t.conversationId, t.clientRequestId)
      .where(sql`${t.clientRequestId} IS NOT NULL`),
    index('idx_message_conv').on(t.conversationId, t.seq)
  ]
)

export const task = sqliteTable(
  'task',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnySQLiteColumn => task.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'done', 'failed', 'interrupted', 'skipped']
    }).notNull(),
    phase: text('phase'),
    attempt: integer('attempt').notNull().default(0),
    inputHash: text('input_hash'),
    resultRef: text('result_ref'),
    errorCode: text('error_code'),
    /** 产生该任务的用户消息;回退时据此精确删除整轮,而不是猜时间。 */
    userMessageId: text('user_message_id'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at')
  },
  (t) => [index('idx_task_conv').on(t.conversationId, t.status), index('idx_task_parent').on(t.parentId)]
)

export const artifact = sqliteTable(
  'artifact',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').references(() => task.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').references(() => conversation.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['file', 'html', 'url', 'image'] }).notNull(),
    title: text('title').notNull(),
    description: text('description'),
    path: text('path'),
    url: text('url'),
    size: integer('size').notNull().default(0),
    sha256: text('sha256'),
    previewRef: text('preview_ref'),
    createdAt: text('created_at').notNull()
  },
  (t) => [index('idx_artifact_task').on(t.taskId), index('idx_artifact_conv').on(t.conversationId, t.createdAt)]
)

/**
 * 每轮对话的文件检查点。
 *
 * before_json / after_json 是工作区清单快照(路径 + sha256 + 大小),文件内容
 * 去重后存放在数据目录的 blob 里。回退恢复 after,重放恢复 before。
 * user_message_id 外键级联:消息被截断后检查点跟随删除,不会留下无法归属的历史。
 */
export const fileCheckpoint = sqliteTable(
  'file_checkpoint',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    userMessageId: text('user_message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    messageSeq: integer('message_seq').notNull(),
    beforeJson: text('before_json').notNull(),
    afterJson: text('after_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [
    uniqueIndex('idx_file_checkpoint_msg').on(t.userMessageId),
    index('idx_file_checkpoint_conv').on(t.conversationId, t.messageSeq)
  ]
)

/**
 * 会话上下文压缩摘要。
 *
 * 长对话超出上下文预算时,把最早的若干轮压成结构化摘要继续使用,而不是
 * 静默丢弃。covered_seq 是摘要覆盖到的最后一条消息序号:回退/重放把消息
 * 截断到该序号之前时,摘要必须失效,否则模型会带着"已经不存在的历史"继续回答。
 * 一个会话只保留一份最新摘要,旧摘要直接被覆盖。
 */
export const conversationSummary = sqliteTable(
  'conversation_summary',
  {
    conversationId: text('conversation_id')
      .primaryKey()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    coveredSeq: integer('covered_seq').notNull(),
    coveredMessages: integer('covered_messages').notNull().default(0),
    summary: text('summary').notNull(),
    sourceChars: integer('source_chars').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [index('idx_conversation_summary_seq').on(t.conversationId, t.coveredSeq)]
)

export const skill = sqliteTable(
  'skill',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['builtin', 'user', 'project'] }).notNull(),
    name: text('name').notNull(),
    version: text('version'),
    path: text('path').notNull(),
    enabled: integer('enabled').notNull().default(1),
    installedAt: text('installed_at').notNull()
  },
  (t) => [uniqueIndex('idx_skill_scope_name').on(t.scope, t.name)]
)

export const plugin = sqliteTable(
  'plugin',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['connector', 'expert', 'mcp'] }).notNull(),
    name: text('name').notNull(),
    version: text('version'),
    enabled: integer('enabled').notNull().default(1),
    permissionsJson: text('permissions_json').notNull().default('[]'),
    manifestJson: text('manifest_json').notNull(),
    installedAt: text('installed_at').notNull()
  },
  (t) => [uniqueIndex('idx_plugin_kind_name').on(t.kind, t.name)]
)

export const automation = sqliteTable(
  'automation',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    scheduleType: text('schedule_type', { enum: ['once', 'rrule'] }).notNull(),
    rrule: text('rrule'),
    scheduledAt: text('scheduled_at'),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    validFrom: text('valid_from'),
    validUntil: text('valid_until'),
    prompt: text('prompt').notNull(),
    modeId: text('mode_id').notNull(),
    enabled: integer('enabled').notNull().default(1),
    nextRunAt: text('next_run_at'),
    lastRunAt: text('last_run_at'),
    lastStatus: text('last_status'),
    /** WM-AUTO-06:连续失败按"整次执行"计数,重试次数不重复累加 */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** 达到阈值后只提醒一次,成功执行后清零 */
    failureAlerted: integer('failure_alerted').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(2),
    failureThreshold: integer('failure_threshold').notNull().default(3),
    /** 产物型自动化:直接运行工作流,输出写回服务后再交付 */
    workflowId: text('workflow_id'),
    workflowInputsJson: text('workflow_inputs_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [index('idx_automation_due').on(t.enabled, t.nextRunAt)]
)

export const approvalGrant = sqliteTable(
  'approval_grant',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['once', 'session', 'always'] }).notNull(),
    groupKey: text('group_key').notNull(),
    toolName: text('tool_name').notNull(),
    grantedAt: text('granted_at').notNull(),
    expiresAt: text('expires_at')
  },
  (t) => [uniqueIndex('idx_grant_group').on(t.groupKey)]
)

export const memoryEntry = sqliteTable(
  'memory_entry',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['cloud', 'user', 'workspace'] }).notNull(),
    workspaceId: text('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['fact', 'preference', 'summary', 'log'] }).notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    sourcePath: text('source_path'),
    pinned: integer('pinned').notNull().default(0),
    tokens: integer('tokens').notNull().default(0),
    createdAt: text('created_at').notNull(),
    deletedAt: text('deleted_at')
  },
  (t) => [
    index('idx_memory_scope').on(t.scope, t.workspaceId, t.createdAt),
    uniqueIndex('idx_memory_hash').on(t.scope, t.contentHash)
  ]
)

export const eventLog = sqliteTable(
  'event_log',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull()
  },
  (t) => [uniqueIndex('idx_event_conv_seq').on(t.conversationId, t.seq)]
)

export const channel = sqliteTable(
  'channel',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: text('created_at').notNull()
  },
  (t) => [
    uniqueIndex('idx_channel_ws_name').on(t.workspaceId, t.name),
    index('idx_channel_ws').on(t.workspaceId, t.createdAt)
  ]
)

/**
 * 消息中心的业务通知。
 *
 * 与 event_log 分开:event_log 是会话内可重放的事件流水,这里只保存
 * 用户需要看到/处理的跨会话提醒。biz 用来区分来源(任务、定时任务、审批),
 * conversationId 允许为空,因为定时任务结果可能在会话被删后仍然需要展示。
 */
export const notification = sqliteTable(
  'notification',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    biz: text('biz', { enum: ['task', 'automation', 'approval', 'system'] }).notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    conversationId: text('conversation_id').references(() => conversation.id, { onDelete: 'set null' }),
    actionKind: text('action_kind', { enum: ['open-conversation', 'none'] }).notNull().default('none'),
    isRead: integer('is_read').notNull().default(0),
    isPending: integer('is_pending').notNull().default(0),
    createdAt: text('created_at').notNull()
  },
  (t) => [
    index('idx_notification_ws').on(t.workspaceId, t.createdAt),
    index('idx_notification_pending').on(t.workspaceId, t.isPending, t.isRead)
  ]
)

/** 待发队列:eventId 由客户端生成,重发沿用同一个 id,服务端据此幂等 */
export const pendingEvent = sqliteTable(
  'pending_event',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id'),
    kind: text('kind', { enum: ['event', 'artifact'] }).notNull(),
    payloadJson: text('payload_json').notNull(),
    seq: integer('seq').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: text('next_attempt_at').notNull(),
    createdAt: text('created_at').notNull(),
    sentAt: text('sent_at')
  },
  (t) => [
    uniqueIndex('idx_pending_ws_seq').on(t.workspaceId, t.seq),
    index('idx_pending_due').on(t.workspaceId, t.sentAt, t.nextAttemptAt, t.seq)
  ]
)

export const channelArtifact = sqliteTable(
  'channel_artifact',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    sharedAt: text('shared_at').notNull()
  },
  (t) => [
    uniqueIndex('idx_channel_artifact_once').on(t.channelId, t.artifactId),
    index('idx_channel_artifact').on(t.channelId, t.sharedAt)
  ]
)

/**
 * 工作区级设置。单行 key/value:权限档位、默认运行位置等开关变化频繁,
 * 不值得每加一个开关就改一次 DDL。
 */
export const workspaceSetting = sqliteTable(
  'workspace_setting',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })]
)

/** 助理档案:角色定义 + 指令 + 绑定的技能/连接器。 */
export const colleague = sqliteTable(
  'colleague',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    instructions: text('instructions').notNull().default(''),
    avatar: text('avatar').notNull().default('assistant'),
    skillNames: text('skill_names').notNull().default('[]'),
    connectorNames: text('connector_names').notNull().default('[]'),
    channelIds: text('channel_ids').notNull().default('[]'),
    status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
    visibility: text('visibility', { enum: ['personal', 'project', 'public'] })
      .notNull()
      .default('personal'),
    memoryEnabled: integer('memory_enabled').notNull().default(1),
    pinnedAt: text('pinned_at'),
    modeId: text('mode_id').notNull().default('craft'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [index('idx_colleague_ws').on(t.workspaceId, t.pinnedAt, t.createdAt)]
)

/**
 * 项目:独立于"资料库"的协作实体。
 *
 * 项目保存自己的指令与技能边界,归属项目的任务通过 conversation.project_id 聚合。
 * 本地版没有云端成员,但字段仍按真实产品建模,避免以后只能靠改名硬塞。
 */
export const project = sqliteTable(
  'project',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    instructions: text('instructions').notNull().default(''),
    skillNames: text('skill_names').notNull().default('[]'),
    pinnedAt: text('pinned_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [index('idx_project_ws').on(t.workspaceId, t.pinnedAt, t.updatedAt)]
)

/**
 * 外部服务连接。
 *
 * status 只在真正探测成功后才置为 connected:没有凭据时绝不伪造"已连接"。
 * endpoint 只保存脱敏后的地址,不含 query/fragment,避免把 token 写进数据库。
 */
export const serviceConnection = sqliteTable(
  'service_connection',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['mailbox', 'tencentDocs', 'ima', 'lexiang'] }).notNull(),
    status: text('status', { enum: ['not_connected', 'connecting', 'connected', 'error'] })
      .notNull()
      .default('not_connected'),
    endpoint: text('endpoint'),
    account: text('account'),
    lastError: text('last_error'),
    lastCheckedAt: text('last_checked_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.provider] })]
)

/** 灵感社区:本地信息流,发布/收藏都持久化,不借用技能或资料库的存储。 */
export const inspirationPost = sqliteTable(
  'inspiration_post',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    source: text('source').notNull().default('本地'),
    tags: text('tags').notNull().default('[]'),
    favorite: integer('favorite').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [index('idx_inspiration_ws').on(t.workspaceId, t.createdAt)]
)

export const schema = {
  workspace,
  conversation,
  message,
  task,
  artifact,
  fileCheckpoint,
  conversationSummary,
  skill,
  plugin,
  automation,
  approvalGrant,
  memoryEntry,
  eventLog,
  channel,
  pendingEvent,
  channelArtifact,
  workspaceSetting,
  colleague,
  project,
  serviceConnection,
  inspirationPost
}
