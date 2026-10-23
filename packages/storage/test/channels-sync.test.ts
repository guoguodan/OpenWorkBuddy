import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDbResult } from '../src/client.js'
import { migrateOrThrow } from '../src/migrate.js'
import { ensureWorkspace, createConversation, appendEvent } from '../src/conversations.js'
import {
  createChannel,
  deleteChannel,
  listChannelArtifacts,
  listChannels,
  shareArtifactToChannel
} from '../src/channels.js'
import {
  duePending,
  enqueuePending,
  listPending,
  markPendingFailed,
  markPendingSent,
  resetPendingBackoff,
  retryDelayMs
} from '../src/sync.js'
import { insertArtifacts } from '../src/artifacts.js'

let dir: string
let handle: OpenDbResult
let workspaceId: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-channel-'))
  handle = openDatabase(join(dir, 'openwb.db'))
  migrateOrThrow(handle.raw, { dbPath: handle.path })
  workspaceId = ensureWorkspace(handle.db, join(dir, 'ws')).id
})

afterEach(async () => {
  handle.raw.close()
  await rm(dir, { recursive: true, force: true })
})

describe('channel model', () => {
  it('creates v3 tables and indexes', () => {
    const names = handle.raw
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const n of ['channel', 'channel_artifact', 'pending_event']) expect(names).toContain(n)
    expect(names).toContain('idx_pending_due')
    expect(handle.raw.pragma('user_version', { simple: true })).toBe(3)
  })

  it('reuses an existing channel with the same name', () => {
    const a = createChannel(handle.db, { workspaceId, name: '  产品组  ' })
    const b = createChannel(handle.db, { workspaceId, name: '产品组' })
    expect(a.id).toBe(b.id)
    expect(a.name).toBe('产品组')
    expect(listChannels(handle.db, workspaceId)).toHaveLength(1)
  })

  it('rejects empty and oversized channel names', () => {
    expect(() => createChannel(handle.db, { workspaceId, name: '   ' })).toThrow(/不能为空/)
    expect(() => createChannel(handle.db, { workspaceId, name: 'x'.repeat(41) })).toThrow(/40/)
  })

  it('keeps conversations when a channel is deleted', () => {
    const ch = createChannel(handle.db, { workspaceId, name: '设计' })
    const conv = createConversation(handle.db, { workspaceId, title: '频道会话', modeId: 'craft', channelId: ch.id })
    deleteChannel(handle.db, ch.id)
    const row = handle.raw.prepare('SELECT channel_id FROM conversation WHERE id = ?').get(conv.id) as {
      channel_id: string | null
    }
    expect(row.channel_id).toBeNull()
    expect(listChannels(handle.db, workspaceId)).toHaveLength(0)
  })

  it('shares an artifact by reference and deduplicates', () => {
    const ch = createChannel(handle.db, { workspaceId, name: '交付' })
    const [art] = insertArtifacts(handle.db, {
      taskId: null,
      conversationId: null,
      items: [{ kind: 'file', title: '报告', path: 'a.md', size: 3, sha256: 'a'.repeat(64) }]
    })
    const first = shareArtifactToChannel(handle.db, { channelId: ch.id, artifactId: art!.record.id })
    const second = shareArtifactToChannel(handle.db, { channelId: ch.id, artifactId: art!.record.id })
    expect(first.shared).toBe(true)
    expect(second.shared).toBe(false)
    expect(listChannelArtifacts(handle.db, ch.id)).toHaveLength(1)
  })
})

describe('pending event queue', () => {
  it('queues channel events and only channel events', () => {
    const ch = createChannel(handle.db, { workspaceId, name: '同步' })
    const channelConv = createConversation(handle.db, {
      workspaceId,
      title: '频道内',
      modeId: 'craft',
      channelId: ch.id
    })
    const localConv = createConversation(handle.db, { workspaceId, title: '本地', modeId: 'craft' })
    appendEvent(handle.db, channelConv.id, 'run.started', { taskId: 't1' })
    appendEvent(handle.db, localConv.id, 'run.started', { taskId: 't2' })
    const pending = listPending(handle.db, workspaceId)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.conversationId).toBe(channelConv.id)
    expect(pending[0]?.kind).toBe('event')
    expect((pending[0]?.payload as { type: string }).type).toBe('run.started')
  })

  it('keeps FIFO order and is idempotent by eventId', () => {
    const a = enqueuePending(handle.db, { workspaceId, kind: 'event', eventId: 'e1', payload: { n: 1 } })
    enqueuePending(handle.db, { workspaceId, kind: 'event', eventId: 'e2', payload: { n: 2 } })
    enqueuePending(handle.db, { workspaceId, kind: 'event', eventId: 'e1', payload: { n: 1 } })
    const items = duePending(handle.db, workspaceId, { limit: 10 })
    expect(items.map((i) => i.id)).toEqual(['e1', 'e2'])
    expect(items[0]?.seq).toBe(a.seq)
  })

  it('backs off failed items without dropping them', () => {
    enqueuePending(handle.db, { workspaceId, kind: 'artifact', eventId: 'a1', payload: { n: 1 } })
    const now = new Date('2026-01-01T00:00:00.000Z')
    markPendingFailed(handle.db, 'a1', 'offline', now)
    const failed = listPending(handle.db, workspaceId)[0]!
    expect(failed.attempts).toBe(1)
    expect(failed.lastError).toBe('offline')
    expect(Date.parse(failed.nextAttemptAt)).toBe(now.getTime() + retryDelayMs(1))
    expect(duePending(handle.db, workspaceId, { now })).toHaveLength(0)
    markPendingSent(handle.db, ['a1'], new Date(now.getTime() + 5000))
    expect(duePending(handle.db, workspaceId, { now: new Date(now.getTime() + 5000) })).toHaveLength(0)
  })

  it('can wake failed items for an explicit retry', () => {
    enqueuePending(handle.db, { workspaceId, kind: 'event', eventId: 'r1', payload: {} })
    const now = new Date('2026-01-01T00:00:00.000Z')
    markPendingFailed(handle.db, 'r1', 'down', now)
    expect(resetPendingBackoff(handle.db, workspaceId, now)).toBe(1)
    expect(duePending(handle.db, workspaceId, { now })).toHaveLength(1)
  })
})
