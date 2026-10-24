import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDbResult } from '../src/client.js'
import { migrateOrThrow } from '../src/migrate.js'
import { ensureWorkspace } from '../src/conversations.js'
import { DEFAULT_SETTINGS, getWorkspaceSettings, setWorkspaceSetting } from '../src/settings.js'
import { createColleague, deleteColleague, getColleague, listColleagues, updateColleague } from '../src/colleagues.js'

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
})
