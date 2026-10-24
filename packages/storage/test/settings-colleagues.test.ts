import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDbResult } from '../src/client.js'
import { migrateOrThrow } from '../src/migrate.js'
import { ensureWorkspace } from '../src/conversations.js'
import { DEFAULT_SETTINGS, getWorkspaceSettings, setWorkspaceSetting } from '../src/settings.js'
import {
  assertColleagueAssignable,
  createColleague,
  deleteColleague,
  getColleague,
  listColleagues,
  updateColleague
} from '../src/colleagues.js'
import { appendMessage, createConversation } from '../src/conversations.js'

let dir: string
let handle: OpenDbResult
let workspaceId: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-settings-'))
  handle = openDatabase(join(dir, 'openwb.db'))
  migrateOrThrow(handle.raw, { dbPath: handle.path })
  workspaceId = ensureWorkspace(handle.db, join(dir, 'ws')).id
})

afterEach(async () => {
  handle.raw.close()
  await rm(dir, { recursive: true, force: true })
})

describe('workspace settings', () => {
  it('falls back to defaults without writing rows', () => {
    expect(getWorkspaceSettings(handle.db, workspaceId)).toEqual(DEFAULT_SETTINGS)
    const count = handle.raw.prepare('SELECT COUNT(*) AS n FROM workspace_setting').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('persists permission mode and model, and upserts in place', () => {
    setWorkspaceSetting(handle.db, workspaceId, 'permissionMode', 'readOnly')
    setWorkspaceSetting(handle.db, workspaceId, 'model', 'demo-model')
    setWorkspaceSetting(handle.db, workspaceId, 'permissionMode', 'fullAccess')
    const settings = getWorkspaceSettings(handle.db, workspaceId)
    expect(settings.permissionMode).toBe('fullAccess')
    expect(settings.model).toBe('demo-model')
    const count = handle.raw.prepare('SELECT COUNT(*) AS n FROM workspace_setting').get() as { n: number }
    expect(count.n).toBe(2)
  })

  it('treats an unknown stored value as the safe default', () => {
    setWorkspaceSetting(handle.db, workspaceId, 'permissionMode', 'root')
    expect(getWorkspaceSettings(handle.db, workspaceId).permissionMode).toBe('default')
  })

  it('removes the row when the value is cleared', () => {
    setWorkspaceSetting(handle.db, workspaceId, 'model', 'demo-model')
    setWorkspaceSetting(handle.db, workspaceId, 'model', null)
    expect(getWorkspaceSettings(handle.db, workspaceId).model).toBeNull()
  })
})

describe('colleague repository', () => {
  it('creates, lists and trims a colleague', () => {
    const created = createColleague(handle.db, {
      workspaceId,
      name: '  研究助理  ',
      title: '行业研究',
      instructions: '先确认范围'
    })
    expect(created.name).toBe('研究助理')
    expect(created.title).toBe('行业研究')
    expect(created.skillNames).toEqual([])
    expect(listColleagues(handle.db, workspaceId)).toHaveLength(1)
  })

  it('updates fields and keeps the record addressable by id', () => {
    const created = createColleague(handle.db, { workspaceId, name: '设计助理' })
    const updated = updateColleague(handle.db, created.id, {
      description: '负责视觉方案',
      skillNames: ['code-review']
    })
    expect(updated?.description).toBe('负责视觉方案')
    expect(updated?.skillNames).toEqual(['code-review'])
    expect(getColleague(handle.db, created.id)?.description).toBe('负责视觉方案')
  })

  it('deletes only inside the owning workspace and reports removal', () => {
    const created = createColleague(handle.db, { workspaceId, name: '待删除' })
    expect(deleteColleague(handle.db, created.id)).toBe(true)
    expect(deleteColleague(handle.db, created.id)).toBe(false)
    expect(getColleague(handle.db, created.id)).toBeUndefined()
  })

  it('rejects an empty name by falling back to a safe label', () => {
    const created = createColleague(handle.db, { workspaceId, name: '   ' })
    expect(created.name).toBe('助理')
  })

  it('persists availability, visibility, memory, pin and channel bindings', () => {
    const created = createColleague(handle.db, {
      workspaceId,
      name: '渠道助理',
      status: 'paused',
      visibility: 'project',
      memoryEnabled: false,
      pinned: true,
      channelIds: ['ch-1', 'ch-2'],
      skillNames: ['research'],
      connectorNames: ['mail']
    })
    expect(created.status).toBe('paused')
    expect(created.visibility).toBe('project')
    expect(created.memoryEnabled).toBe(false)
    expect(created.pinnedAt).toBeTruthy()
    expect(created.channelIds).toEqual(['ch-1', 'ch-2'])

    const updated = updateColleague(handle.db, created.id, {
      status: 'active',
      visibility: 'public',
      memoryEnabled: true,
      pinned: false,
      channelIds: ['ch-2']
    })
    expect(updated?.status).toBe('active')
    expect(updated?.visibility).toBe('public')
    expect(updated?.memoryEnabled).toBe(true)
    expect(updated?.pinnedAt).toBeNull()
    expect(updated?.channelIds).toEqual(['ch-2'])
  })

  it('sorts pinned colleagues before recently updated ones', () => {
    const older = createColleague(handle.db, { workspaceId, name: '普通助理' })
    const newer = createColleague(handle.db, { workspaceId, name: '最近更新' })
    updateColleague(handle.db, older.id, { pinned: true })
    expect(listColleagues(handle.db, workspaceId).map((c) => c.id)).toEqual([older.id, newer.id])
  })

  it('rejects assigning a paused colleague or an unbound channel', () => {
    const colleague = createColleague(handle.db, {
      workspaceId,
      name: '频道助理',
      status: 'active',
      channelIds: ['ch-allowed']
    })
    expect(assertColleagueAssignable(handle.db, workspaceId, colleague.id).id).toBe(colleague.id)
    expect(() => assertColleagueAssignable(handle.db, workspaceId, colleague.id, 'ch-other')).toThrow(/未绑定/)
    expect(assertColleagueAssignable(handle.db, workspaceId, colleague.id, 'ch-allowed').id).toBe(colleague.id)

    updateColleague(handle.db, colleague.id, { status: 'paused' })
    expect(() => assertColleagueAssignable(handle.db, workspaceId, colleague.id)).toThrow(/已暂停/)
    expect(() => assertColleagueAssignable(handle.db, 'other-workspace', colleague.id)).toThrow(/不存在/)
  })

  it('aggregates conversation count and token usage per colleague', () => {
    const colleague = createColleague(handle.db, { workspaceId, name: '统计助理' })
    const conv = createConversation(handle.db, {
      workspaceId,
      title: '统计会话',
      modeId: 'craft',
      colleagueId: colleague.id
    })
    appendMessage(handle.db, {
      conversationId: conv.id,
      role: 'assistant',
      content: { text: '回复' },
      tokenIn: 120,
      tokenOut: 30
    })
    appendMessage(handle.db, { conversationId: conv.id, role: 'user', content: { text: '问题' } })
    const stats = getColleague(handle.db, colleague.id)?.stats
    expect(stats?.conversationCount).toBe(1)
    expect(stats?.tokenUsage).toBe(150)
    expect(stats?.lastActiveAt).toBeTruthy()
  })

  it('counts running, failed and completed tasks without inflating token usage', () => {
    const colleague = createColleague(handle.db, { workspaceId, name: '任务统计助理' })
    const otherColleague = createColleague(handle.db, { workspaceId, name: '另一位助理' })
    const conv = createConversation(handle.db, {
      workspaceId,
      title: '任务统计会话',
      modeId: 'craft',
      colleagueId: colleague.id
    })
    const otherConv = createConversation(handle.db, {
      workspaceId,
      title: '其他会话',
      modeId: 'craft',
      colleagueId: otherColleague.id
    })
    appendMessage(handle.db, {
      conversationId: conv.id,
      role: 'assistant',
      content: { text: '回复' },
      tokenIn: 10,
      tokenOut: 5
    })
    const at = new Date().toISOString()
    const insertTask = handle.raw.prepare(
      'INSERT INTO task (id, conversation_id, title, status, attempt, created_at) VALUES (?, ?, ?, ?, 0, ?)'
    )
    insertTask.run('task-running', conv.id, '运行中', 'running', at)
    insertTask.run('task-failed', conv.id, '失败', 'failed', at)
    insertTask.run('task-done-1', conv.id, '完成一', 'done', at)
    insertTask.run('task-done-2', conv.id, '完成二', 'done', at)
    insertTask.run('task-other', otherConv.id, '别的助理', 'running', at)

    const stats = getColleague(handle.db, colleague.id)?.stats
    expect(stats).toMatchObject({
      conversationCount: 1,
      tokenUsage: 15,
      runningTasks: 1,
      failedTasks: 1,
      completedTasks: 2
    })
    expect(getColleague(handle.db, otherColleague.id)?.stats.runningTasks).toBe(1)
  })
})
