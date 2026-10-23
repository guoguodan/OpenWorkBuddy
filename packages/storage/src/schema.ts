import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  index,
  integer,
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
    title: text('title').notNull(),
    modeId: text('mode_id').notNull(),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    lastSeq: integer('last_seq').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [index('idx_conversation_ws').on(t.workspaceId, t.updatedAt)]
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
    kind: text('kind', { enum: ['file', 'html', 'url', 'image'] }).notNull(),
    title: text('title').notNull(),
    path: text('path'),
    url: text('url'),
    size: integer('size').notNull().default(0),
    sha256: text('sha256'),
    previewRef: text('preview_ref'),
    createdAt: text('created_at').notNull()
  },
  (t) => [index('idx_artifact_task').on(t.taskId)]
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

export const schema = {
  workspace,
  conversation,
  message,
  task,
  artifact,
  skill,
  plugin,
  automation,
  approvalGrant,
  memoryEntry,
  eventLog
}