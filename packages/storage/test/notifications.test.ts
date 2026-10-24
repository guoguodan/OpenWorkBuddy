import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/client.js'
import { migrateOrThrow } from '../src/migrate.js'
import { ensureWorkspace, createConversation, deleteConversation } from '../src/conversations.js'
import {
  createNotification,
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  resolveNotification,
  unreadNotificationCount
} from '../src/notifications.js'

let dir: string
let dbPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-notify-'))
  dbPath = join(dir, 'openwb.db')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function setup() {
  const conn = openDatabase(dbPath)
  migrateOrThrow(conn.raw, { dbPath })
  const ws = ensureWorkspace(conn.db, dir)
  return { ...conn, ws }
}

describe('notifications', () => {
  it('creates a notification and is idempotent for the same dedupe key', () => {
    const { db, raw, ws } = setup()
    const first = createNotification(db, {
      workspaceId: ws.id,
      biz: 'task',
      title: '任务已完成:周报',
      summary: '点开查看结果',
      conversationId: null,
      dedupeKey: 'task-1-done'
    })
    const second = createNotification(db, {
      workspaceId: ws.id,
      biz: 'task',
      title: '任务已完成:周报',
      dedupeKey: 'task-1-done'
    })
    expect(second.id).toBe(first.id)
    expect(listNotifications(db, ws.id)).toHaveLength(1)
    expect(unreadNotificationCount(db, ws.id)).toBe(1)
    raw.close()
  })

  it('tracks unread counts across single, bulk and pending reads', () => {
    const { db, raw, ws } = setup()
    const a = createNotification(db, { workspaceId: ws.id, biz: 'task', title: 'A' })
    const b = createNotification(db, { workspaceId: ws.id, biz: 'approval', title: 'B', isPending: true })
    createNotification(db, { workspaceId: ws.id, biz: 'automation', title: 'C' })

    expect(unreadNotificationCount(db, ws.id)).toBe(3)
    expect(listNotifications(db, ws.id, { pendingOnly: true }).map((n) => n.id)).toEqual([b.id])

    const read = markNotificationRead(db, a.id)
    expect(read?.isRead).toBe(true)
    expect(unreadNotificationCount(db, ws.id)).toBe(2)
    expect(markAllNotificationsRead(db, ws.id)).toBe(2)
    expect(unreadNotificationCount(db, ws.id)).toBe(0)

    // 已读不等于已处理:待处理过滤仍应保留审批项
    expect(listNotifications(db, ws.id, { pendingOnly: true }).map((n) => n.id)).toEqual([b.id])
    raw.close()
  })

  it('resolves a pending notification and can delete it', () => {
    const { db, raw, ws } = setup()
    const n = createNotification(db, {
      workspaceId: ws.id,
      biz: 'approval',
      title: '需要你确认:write_file',
      isPending: true
    })
    resolveNotification(db, n.id)
    const resolved = listNotifications(db, ws.id)[0]!
    expect(resolved.isPending).toBe(false)
    expect(resolved.isRead).toBe(true)

    expect(deleteNotification(db, n.id)).toBe(true)
    expect(deleteNotification(db, n.id)).toBe(false)
    expect(listNotifications(db, ws.id)).toHaveLength(0)
    raw.close()
  })

  it('keeps the notification after conversation deletion with a null reference', () => {
    const { db, raw, ws } = setup()
    const conv = createConversation(db, { workspaceId: ws.id, title: '任务', modeId: 'craft' })
    createNotification(db, {
      workspaceId: ws.id,
      biz: 'task',
      title: '任务已完成',
      conversationId: conv.id,
      dedupeKey: `task-${conv.id}`
    })

    deleteConversation(db, conv.id)

    const items = listNotifications(db, ws.id)
    expect(items).toHaveLength(1)
    expect(items[0]!.conversationId).toBeNull()
    raw.close()
  })

  it('isolates notifications by workspace', () => {
    const { db, raw, ws } = setup()
    const other = ensureWorkspace(db, `${dir}-other`, 'other')
    createNotification(db, { workspaceId: ws.id, biz: 'system', title: 'mine' })
    createNotification(db, { workspaceId: other.id, biz: 'system', title: 'theirs' })
    expect(listNotifications(db, ws.id).map((n) => n.title)).toEqual(['mine'])
    expect(listNotifications(db, other.id).map((n) => n.title)).toEqual(['theirs'])
    raw.close()
  })
})
