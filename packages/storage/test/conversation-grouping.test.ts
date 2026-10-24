import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDbResult } from '../src/client.js'
import { migrateOrThrow } from '../src/migrate.js'
import { createColleague, deleteColleague } from '../src/colleagues.js'
import {
  createConversation,
  ensureWorkspace,
  getConversation,
  listConversationSummaries,
  listConversations,
  renameConversation,
  setConversationPinned
} from '../src/conversations.js'
import { createTask, transitionTask } from '../src/tasks.js'
import { insertArtifacts } from '../src/artifacts.js'

let dir: string
let handle: OpenDbResult
let workspaceId: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-grouping-'))
  handle = openDatabase(join(dir, 'openwb.db'))
  migrateOrThrow(handle.raw, { dbPath: handle.path })
  workspaceId = ensureWorkspace(handle.db, join(dir, 'ws')).id
})

afterEach(async () => {
  handle.raw.close()
  await rm(dir, { recursive: true, force: true })
})

describe('conversation grouping fields', () => {
  it('persists pin state without touching updatedAt', () => {
    const conv = createConversation(handle.db, { workspaceId, title: '周报', modeId: 'craft' })
    expect(conv.pinnedAt).toBeNull()

    setConversationPinned(handle.db, conv.id, true)
    const pinned = getConversation(handle.db, conv.id)
    expect(pinned?.pinnedAt).toBeTruthy()
    expect(pinned?.updatedAt).toBe(conv.updatedAt)

    setConversationPinned(handle.db, conv.id, false)
    expect(getConversation(handle.db, conv.id)?.pinnedAt).toBeNull()
  })

  it('returns pinned and unpinned conversations together for client grouping', () => {
    const a = createConversation(handle.db, { workspaceId, title: 'A', modeId: 'craft' })
    createConversation(handle.db, { workspaceId, title: 'B', modeId: 'craft' })
    setConversationPinned(handle.db, a.id, true)
    const all = listConversations(handle.db, workspaceId)
    expect(all).toHaveLength(2)
    expect(all.filter((c) => c.pinnedAt)).toHaveLength(1)
  })

  it('renames a task and keeps it in place', () => {
    const conv = createConversation(handle.db, { workspaceId, title: '旧标题', modeId: 'craft' })
    const renamed = renameConversation(handle.db, conv.id, '  新标题  ')
    expect(renamed?.title).toBe('新标题')
    expect(renamed?.updatedAt).toBe(conv.updatedAt)
  })

  it('ignores an empty rename instead of erasing the title', () => {
    const conv = createConversation(handle.db, { workspaceId, title: '保留我', modeId: 'craft' })
    expect(renameConversation(handle.db, conv.id, '   ')?.title).toBe('保留我')
  })

  it('stores colleague ownership and clears it when the colleague is deleted', () => {
    const colleague = createColleague(handle.db, { workspaceId, name: '研究助理' })
    const conv = createConversation(handle.db, {
      workspaceId,
      title: '与助理协作',
      modeId: 'craft',
      colleagueId: colleague.id
    })
    expect(getConversation(handle.db, conv.id)?.colleagueId).toBe(colleague.id)

    expect(deleteColleague(handle.db, colleague.id)).toBe(true)
    expect(getConversation(handle.db, conv.id)?.colleagueId).toBeNull()
  })

  it('aggregates task and artifact facts per conversation for filtering', () => {
    const conv = createConversation(handle.db, { workspaceId, title: '带任务', modeId: 'craft' })
    createTask(handle.db, { conversationId: conv.id, title: '待处理任务' })
    const running = createTask(handle.db, { conversationId: conv.id, title: '执行中任务' })
    transitionTask(handle.db, running, 'running')
    const failed = createTask(handle.db, { conversationId: conv.id, title: '失败任务' })
    transitionTask(handle.db, failed, 'running')
    transitionTask(handle.db, failed, 'failed')
    const done = createTask(handle.db, { conversationId: conv.id, title: '完成任务' })
    transitionTask(handle.db, done, 'running')
    transitionTask(handle.db, done, 'done')
    insertArtifacts(handle.db, {
      taskId: done,
      conversationId: conv.id,
      items: [{ kind: 'file', title: 'report.md', path: 'report.md', sha256: 'abc123' }]
    })

    const summary = listConversationSummaries(handle.db, workspaceId).find((item) => item.id === conv.id)
    expect(summary?.taskTotal).toBe(4)
    expect(summary?.pending).toBe(1)
    expect(summary?.running).toBe(1)
    expect(summary?.failed).toBe(1)
    expect(summary?.done).toBe(1)
    expect(summary?.artifacts).toBe(1)
  })

  it('reports zero stats for a conversation that never ran a task', () => {
    const conv = createConversation(handle.db, { workspaceId, title: '草稿', modeId: 'craft' })
    const summary = listConversationSummaries(handle.db, workspaceId).find((item) => item.id === conv.id)
    expect(summary).toMatchObject({ taskTotal: 0, pending: 0, running: 0, failed: 0, done: 0, artifacts: 0 })
  })
})
