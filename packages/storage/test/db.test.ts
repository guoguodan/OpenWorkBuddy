import Database from 'better-sqlite3'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, assertForeignKeysOn } from '../src/client.js'
import { migrateOrThrow, currentVersion, TARGET_VERSION } from '../src/migrate.js'
import { MIGRATIONS } from '../src/migrations.js'
import {
  ensureWorkspace,
  createConversation,
  appendMessage,
  listMessages,
  deleteConversation,
  appendEvent,
  listEvents
} from '../src/conversations.js'
import { createTask, transitionTask } from '../src/tasks.js'
import { conversation, message, task, eventLog } from '../src/schema.js'
import { eq } from 'drizzle-orm'

const TABLES = [
  'workspace',
  'conversation',
  'message',
  'task',
  'artifact',
  'skill',
  'plugin',
  'automation',
  'approval_grant',
  'memory_entry',
  'event_log'
]

let dir: string
let dbPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-db-'))
  dbPath = join(dir, 'openwb.db')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('creates all ten tables plus FTS', () => {
    const { raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    const names = raw
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of TABLES) expect(names).toContain(t)
    expect(names).toContain('memory_fts')
    expect(currentVersion(raw)).toBe(TARGET_VERSION)
    raw.close()
  })

  it('is idempotent when already at target version', () => {
    const { raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    const again = migrateOrThrow(raw, { dbPath })
    expect(again.from).toBe(TARGET_VERSION)
    expect(again.backupPath).toBeUndefined()
    raw.close()
  })

  it('refuses to start when the db version is newer than the app', () => {
    const { raw } = openDatabase(dbPath)
    raw.pragma(`user_version = ${TARGET_VERSION + 1}`)
    expect(() => migrateOrThrow(raw, { dbPath })).toThrow(/高于应用支持的/)
    raw.close()
  })

  it('backups an existing database before migrating and keeps at most 3', async () => {
    const { raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    raw.close()

    // 临时追加一条 v2 迁移,用它触发 5 次"升级"以验证备份与保留策略
    const fake = {
      version: 2,
      name: 'test_only',
      sql: 'CREATE TABLE IF NOT EXISTS backup_probe (id TEXT PRIMARY KEY);'
    }
    MIGRATIONS.push(fake)
    try {
      for (let i = 0; i < 5; i++) {
        const conn = openDatabase(dbPath)
        try {
          conn.raw.pragma('user_version = 1')
          migrateOrThrow(conn.raw, { dbPath })
          expect(currentVersion(conn.raw)).toBe(2)
        } finally {
          conn.raw.close()
        }
      }
    } finally {
      MIGRATIONS.pop()
    }

    const backups = (await readdir(join(dir, 'backups'))).filter((f) => f.endsWith('.db'))
    expect(backups.length).toBe(3)
  })

  it('keeps foreign keys enabled per connection', () => {
    const { raw } = openDatabase(dbPath)
    expect(() => assertForeignKeysOn(raw)).not.toThrow()
    raw.close()
  })
})

describe('conversation and message', () => {
  it('survives a reopen with messages and token stats intact', () => {
    const first = openDatabase(dbPath)
    migrateOrThrow(first.raw, { dbPath })
    const ws = ensureWorkspace(first.db, dir)
    const conv = createConversation(first.db, { workspaceId: ws.id, title: 't', modeId: 'craft' })
    appendMessage(first.db, {
      conversationId: conv.id,
      role: 'user',
      content: { text: '你好' },
      tokenIn: 11,
      tokenOut: 22
    })
    first.raw.close()

    const second = openDatabase(dbPath)
    migrateOrThrow(second.raw, { dbPath })
    const rows = listMessages(second.db, conv.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toEqual({ text: '你好' })
    expect(rows[0]!.tokenIn).toBe(11)
    expect(rows[0]!.tokenOut).toBe(22)
    second.raw.close()
  })

  it('coerces NaN/negative token counts instead of violating NOT NULL', () => {
    const { db, raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    const ws = ensureWorkspace(db, dir)
    const conv = createConversation(db, { workspaceId: ws.id, title: 't', modeId: 'craft' })
    // 中转网关可能回 NaN(better-sqlite3 会绑成 NULL)或负数
    const row = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: { text: 'x' },
      tokenIn: Number.NaN,
      tokenOut: -3
    })
    expect(row.record.tokenIn).toBe(0)
    expect(row.record.tokenOut).toBe(0)
    expect(listMessages(db, conv.id)[0]!.tokenIn).toBe(0)
    raw.close()
  })

  it('dedupes by client_request_id', () => {
    const { db, raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    const ws = ensureWorkspace(db, dir)
    const conv = createConversation(db, { workspaceId: ws.id, title: 't', modeId: 'craft' })
    const input = {
      conversationId: conv.id,
      role: 'user' as const,
      content: { text: 'hi' },
      clientRequestId: 'req-1'
    }
    const a = appendMessage(db, input)
    const b = appendMessage(db, input)
    expect(a.deduped).toBe(false)
    expect(b.deduped).toBe(true)
    expect(b.record.id).toBe(a.record.id)
    expect(listMessages(db, conv.id)).toHaveLength(1)
    raw.close()
  })

  it('isolates messages between conversations', () => {
    const { db, raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    const ws = ensureWorkspace(db, dir)
    const a = createConversation(db, { workspaceId: ws.id, title: 'A', modeId: 'craft' })
    const b = createConversation(db, { workspaceId: ws.id, title: 'B', modeId: 'craft' })
    appendMessage(db, { conversationId: a.id, role: 'user', content: { text: 'only-a' } })
    appendMessage(db, { conversationId: b.id, role: 'user', content: { text: 'only-b' } })
    expect(listMessages(db, a.id).map((m) => m.content)).toEqual([{ text: 'only-a' }])
    expect(listMessages(db, b.id).map((m) => m.content)).toEqual([{ text: 'only-b' }])
    raw.close()
  })

  it('cascades messages, tasks and events on conversation delete', () => {
    const { db, raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    const ws = ensureWorkspace(db, dir)
    const conv = createConversation(db, { workspaceId: ws.id, title: 't', modeId: 'craft' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: { text: 'x' } })
    createTask(db, { conversationId: conv.id, title: 'step' })
    appendEvent(db, conv.id, 'test', { ok: true })

    deleteConversation(db, conv.id)

    expect(db.select().from(conversation).where(eq(conversation.id, conv.id)).all()).toHaveLength(0)
    expect(db.select().from(message).where(eq(message.conversationId, conv.id)).all()).toHaveLength(0)
    expect(db.select().from(task).where(eq(task.conversationId, conv.id)).all()).toHaveLength(0)
    expect(db.select().from(eventLog).where(eq(eventLog.conversationId, conv.id)).all()).toHaveLength(0)
    raw.close()
  })

  it('keeps event log seq independent and retrievable after restart', () => {
    const first = openDatabase(dbPath)
    migrateOrThrow(first.raw, { dbPath })
    const ws = ensureWorkspace(first.db, dir)
    const conv = createConversation(first.db, { workspaceId: ws.id, title: 't', modeId: 'craft' })
    appendEvent(first.db, conv.id, 'a', { n: 1 })
    appendEvent(first.db, conv.id, 'b', { n: 2 })
    first.raw.close()

    const second = openDatabase(dbPath)
    const events = listEvents(second.db, conv.id)
    expect(events.map((e) => e.seq)).toEqual([1, 2])
    expect(events[1]!.payload).toEqual({ n: 2 })
    second.raw.close()
  })
})

describe('task persistence', () => {
  it('increments attempt when retrying a failed task', () => {
    const { db, raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    const ws = ensureWorkspace(db, dir)
    const conv = createConversation(db, { workspaceId: ws.id, title: 't', modeId: 'craft' })
    const id = createTask(db, { conversationId: conv.id, title: 'step' })

    expect(transitionTask(db, id, 'running').attempt).toBe(0)
    expect(transitionTask(db, id, 'failed', { errorCode: 'E1' }).attempt).toBe(0)
    expect(transitionTask(db, id, 'running').attempt).toBe(1)
    expect(() => transitionTask(db, id, 'done')).not.toThrow()
    raw.close()
  })

  it('rejects failed -> done directly', () => {
    const { db, raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    const ws = ensureWorkspace(db, dir)
    const conv = createConversation(db, { workspaceId: ws.id, title: 't', modeId: 'craft' })
    const id = createTask(db, { conversationId: conv.id, title: 'step' })
    transitionTask(db, id, 'running')
    transitionTask(db, id, 'failed')
    expect(() => transitionTask(db, id, 'done')).toThrow(/非法任务状态迁移/)
    raw.close()
  })
})

describe('ddl parity', () => {
  it('every schema table exists in the migrated database', () => {
    const { db: _db, raw } = openDatabase(dbPath)
    migrateOrThrow(raw, { dbPath })
    const names = new Set(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => (r as { name: string }).name)
    )
    for (const t of TABLES) expect(names.has(t)).toBe(true)
    raw.close()
  })
})