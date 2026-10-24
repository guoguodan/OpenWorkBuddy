import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDbResult } from '../src/client.js'
import { migrateOrThrow } from '../src/migrate.js'
import { createConversation, ensureWorkspace } from '../src/conversations.js'
import {
  insertArtifacts,
  listArtifactsByConversation,
  removeArtifact,
  renameArtifact
} from '../src/artifacts.js'

let dir: string
let handle: OpenDbResult
let conversationId: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-artifacts-'))
  handle = openDatabase(join(dir, 'openwb.db'))
  migrateOrThrow(handle.raw, { dbPath: handle.path })
  const workspace = ensureWorkspace(handle.db, join(dir, 'ws'))
  const conversation = createConversation(handle.db, {
    workspaceId: workspace.id,
    title: '交付物测试',
    modeId: 'craft'
  })
  conversationId = conversation.id
})

afterEach(async () => {
  handle.raw.close()
  await rm(dir, { recursive: true, force: true })
})

function insertFile(title = '验收报告', path = 'out/report.md') {
  const [result] = insertArtifacts(handle.db, {
    taskId: null,
    conversationId,
    items: [{ kind: 'file', title, path, size: 12, sha256: `${path}-hash` }]
  })
  if (!result) throw new Error(' artifact fixture was not inserted')
  return result.record
}

describe('artifact record management', () => {
  it('renames only the display title and keeps the path', () => {
    const record = insertFile()
    const updated = renameArtifact(handle.db, record.id, '  季度验收报告  ')
    expect(updated?.title).toBe('季度验收报告')
    expect(updated?.path).toBe('out/report.md')
    expect(listArtifactsByConversation(handle.db, conversationId)).toMatchObject([
      { id: record.id, title: '季度验收报告', path: 'out/report.md' }
    ])
  })

  it('rejects an empty title', () => {
    const record = insertFile()
    expect(() => renameArtifact(handle.db, record.id, '   ')).toThrow(/标题不能为空/)
    expect(listArtifactsByConversation(handle.db, conversationId)[0]?.title).toBe('验收报告')
  })

  it('returns null when the artifact does not exist', () => {
    expect(renameArtifact(handle.db, 'missing', '新名字')).toBeNull()
  })

  it('removes the record but keeps the file on disk', async () => {
    const record = insertFile()
    const filePath = join(dir, 'ws', 'out', 'report.md')
    await mkdir(join(dir, 'ws', 'out'), { recursive: true })
    await writeFile(filePath, '# report\n', 'utf8')
    expect(existsSync(filePath)).toBe(true)

    expect(removeArtifact(handle.db, record.id)).toBe(true)
    expect(listArtifactsByConversation(handle.db, conversationId)).toEqual([])
    expect(existsSync(filePath)).toBe(true)
  })

  it('reports a missing record instead of deleting again', () => {
    const record = insertFile()
    expect(removeArtifact(handle.db, record.id)).toBe(true)
    expect(removeArtifact(handle.db, record.id)).toBe(false)
  })
})