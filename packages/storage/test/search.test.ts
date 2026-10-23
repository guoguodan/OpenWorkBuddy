import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/client.js'
import { migrateOrThrow } from '../src/migrate.js'
import { appendMessage, createConversation, ensureWorkspace } from '../src/conversations.js'
import { createTask } from '../src/tasks.js'
import { insertArtifacts } from '../src/artifacts.js'
import { search, toMatchQuery, type SearchResult } from '../src/search.js'

let dir: string
let dbPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-search-'))
  dbPath = join(dir, 'openwb.db')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function withDb<T>(fn: (ctx: ReturnType<typeof openDatabase> & { wsId: string }) => T): T {
  const conn = openDatabase(dbPath)
  migrateOrThrow(conn.raw, { dbPath })
  const ws = ensureWorkspace(conn.db, dir)
  try {
    return fn({ ...conn, wsId: ws.id })
  } finally {
    conn.raw.close()
  }
}

function groupOf(result: SearchResult, group: string) {
  return result.groups.find((g) => g.group === group)
}

describe('global search', () => {
  it('finds a Chinese message and reports its conversation + seq', () => {
    withDb(({ db, raw, wsId }) => {
      const conv = createConversation(db, { workspaceId: wsId, title: '产品讨论', modeId: 'craft' })
      appendMessage(db, { conversationId: conv.id, role: 'user', content: { text: '我们聊聊产品设计' } })
      appendMessage(db, { conversationId: conv.id, role: 'assistant', content: { text: '好的,先从用户旅程开始' } })

      const result = search(raw, '产品设计')
      const messages = groupOf(result, 'message')
      expect(messages?.items.length).toBeGreaterThan(0)
      expect(messages?.items[0]!.conversationId).toBe(conv.id)
      expect(messages?.items[0]!.seq).toBe(1)
      expect(messages?.items[0]!.snippet).toContain('产品设计')
    })
  })

  it('caps each group at five hits but keeps the full total', () => {
    withDb(({ db, raw, wsId }) => {
      const conv = createConversation(db, { workspaceId: wsId, title: '批量', modeId: 'craft' })
      for (let i = 0; i < 7; i++) {
        appendMessage(db, { conversationId: conv.id, role: 'user', content: { text: `第${i}条 alpha 记录` } })
      }
      const messages = groupOf(search(raw, 'alpha'), 'message')
      expect(messages?.items.length).toBe(5)
      expect(messages?.total).toBe(7)
    })
  })

  it('groups artifacts and tasks separately', () => {
    withDb(({ db, raw, wsId }) => {
      const conv = createConversation(db, { workspaceId: wsId, title: '交付会话', modeId: 'craft' })
      const taskId = createTask(db, { conversationId: conv.id, title: '季度复盘任务' })
      insertArtifacts(db, {
        taskId,
        conversationId: conv.id,
        items: [{ kind: 'file', title: '季度复盘报告', path: 'out/review.md', size: 10, sha256: 'a'.repeat(64) }]
      })

      const result = search(raw, '季度复盘')
      expect(groupOf(result, 'artifact')?.items[0]?.title).toBe('季度复盘报告')
      expect(groupOf(result, 'artifact')?.items[0]?.conversationId).toBe(conv.id)
      expect(groupOf(result, 'task')?.items[0]?.title).toBe('季度复盘任务')
    })
  })

  it('does not crash on FTS syntax characters or SQL wildcards', () => {
    withDb(({ db, raw, wsId }) => {
      const conv = createConversation(db, { workspaceId: wsId, title: '特殊', modeId: 'craft' })
      appendMessage(db, { conversationId: conv.id, role: 'user', content: { text: '100% 完成 a_b' } })
      for (const q of ['"', '*', 'a"b', '100%', 'a_b', '()', 'NEAR(', '\\']) {
        expect(() => search(raw, q)).not.toThrow()
      }
      // % 与 _ 必须被当作字面量,否则 LIKE 会把 a_b 当成通配
      expect(groupOf(search(raw, '100%'), 'message')?.items.length).toBe(1)
    })
  })

  it('returns an empty result for whitespace-only queries', () => {
    withDb(({ raw }) => {
      expect(search(raw, '   ').groups).toEqual([])
    })
  })
})

describe('toMatchQuery', () => {
  it('quotes tokens and strips FTS operators', () => {
    expect(toMatchQuery('alpha beta')).toBe('"alpha"* AND "beta"*')
    expect(toMatchQuery('a"b*')).toBe('"ab"*')
    expect(toMatchQuery('  ')).toBe('')
  })
})
