import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, migrateOrThrow, ensureWorkspace } from '@openwb/storage'
import {
  addMemory,
  listMemory,
  searchMemory,
  markDeleted,
  appendWorkspaceLog,
  ensureUserMemoryFile,
  deleteMemoryAndSync,
  ensureWorkspaceGitignore,
  buildInjection,
  parseUserMemory,
  renderUserMemory,
  clipLine,
  estimateTokens,
  assertInside
} from '../src/index.js'

let dir: string
let workspaceRoot: string
let dataDir: string
const openHandles: Array<{ close: () => void }> = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owb-mem-'))
  workspaceRoot = join(dir, 'ws')
  dataDir = join(dir, 'data')
  await mkdir(workspaceRoot, { recursive: true })
})

afterEach(async () => {
  for (const h of openHandles.splice(0)) {
    try { h.close() } catch {}
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function open() {
  const { db, raw } = openDatabase(join(dataDir, 'openwb.db'))
  migrateOrThrow(raw, { dbPath: join(dataDir, 'openwb.db') })
  const ws = ensureWorkspace(db, workspaceRoot)
  openHandles.push(raw)
  return { db, raw, ws }
}

describe('format helpers', () => {
  it('clips a line longer than 500 chars and marks it', () => {
    const out = clipLine('中'.repeat(600))
    expect(out.truncated).toBe(true)
    expect(out.text).toContain('…[truncated]')
    expect(out.text.length).toBeLessThanOrEqual(500 + '…[truncated]'.length)
  })

  it('parses a human-editable MEMORY.md', () => {
    const md = ['# 用户记忆', '', '## 偏好', '- 中文优先', '- 结论先行', '', '## 事实', '- 用 pnpm'].join('\n')
    expect(parseUserMemory(md)).toEqual({
      preferences: ['中文优先', '结论先行'],
      facts: ['用 pnpm']
    })
  })

  it('round-trips through renderUserMemory', () => {
    const md = renderUserMemory(['a'], ['b'])
    expect(parseUserMemory(md)).toEqual({ preferences: ['a'], facts: ['b'] })
  })

  it('estimates CJK tokens higher than latin', () => {
    expect(estimateTokens('中文')).toBeGreaterThan(estimateTokens('ab'))
  })
})

describe('store', () => {
  it('dedupes identical content within the same scope', () => {
    const { db, ws, raw } = open()
    const a = addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: '使用 pnpm' })
    const b = addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: '使用   pnpm ' })
    expect(a.deduped).toBe(false)
    expect(b.deduped).toBe(true)
    expect(listMemory(db, { scope: 'workspace' })).toHaveLength(1)
    raw.close()
  })

  it('revives a previously deleted identical entry instead of failing on the unique index', () => {
    const { db, ws, raw } = open()
    const a = addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: 'x' })
    markDeleted(db, a.item!.id)
    expect(listMemory(db, { scope: 'workspace' })).toHaveLength(0)
    const b = addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: 'x' })
    expect(b.item).not.toBeNull()
    expect(listMemory(db, { scope: 'workspace' })).toHaveLength(1)
    raw.close()
  })

  it('recalls with FTS5 keyword search', () => {
    const { db, ws, raw } = open()
    addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: '数据库迁移只允许增量' })
    addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: '前端使用 React' })
    const hits = searchMemory(db, '迁移', { workspaceId: ws.id })
    expect(hits.length).toBe(1)
    expect(hits[0]!.item.content).toContain('迁移')
    raw.close()
  })

  it('does not return deleted entries from search', () => {
    const { db, ws, raw } = open()
    const a = addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: '可删除的条目内容' })
    markDeleted(db, a.item!.id)
    expect(searchMemory(db, '可删除', { workspaceId: ws.id })).toHaveLength(0)
    raw.close()
  })
})

describe('workspace log file', () => {
  it('appends two lines on the same day instead of overwriting', async () => {
    const { db, ws, raw } = open()
    const at = '2026-10-23T01:00:00.000Z'
    const r1 = await appendWorkspaceLog(db, {
      workspaceId: ws.id, workspaceRoot, kind: 'fact', content: '第一条', createdAt: at
    })
    await appendWorkspaceLog(db, {
      workspaceId: ws.id, workspaceRoot, kind: 'log', content: '第二条', createdAt: at
    })
    const text = await readFile(r1.file, 'utf8')
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('第一条')
    expect(lines[1]).toContain('第二条')
    raw.close()
  })

  it('writes the documented log line format', async () => {
    const { db, ws, raw } = open()
    const at = '2026-10-23T02:00:00.000Z'
    const r = await appendWorkspaceLog(db, {
      workspaceId: ws.id, workspaceRoot, kind: 'fact', content: '该项目使用 pnpm workspace', createdAt: at
    })
    const text = await readFile(r.file, 'utf8')
    expect(text).toBe(`- ${at} | fact | 该项目使用 pnpm workspace\n`)
    raw.close()
  })

  it('rejects a path that escapes the workspace', async () => {
    await expect(assertInside(workspaceRoot, join(workspaceRoot, '..', 'evil.md'))).rejects.toThrow(/越界/)
  })

  it('adds .openwb/ to an existing .gitignore exactly once', async () => {
    await mkdir(join(workspaceRoot, '.git'), { recursive: true })
    await writeFile(join(workspaceRoot, '.gitignore'), 'node_modules/\n', 'utf8')
    expect(await ensureWorkspaceGitignore(workspaceRoot)).toBe(true)
    expect(await ensureWorkspaceGitignore(workspaceRoot)).toBe(false)
    const text = await readFile(join(workspaceRoot, '.gitignore'), 'utf8')
    expect(text).toBe('node_modules/\n.openwb/\n')
  })

  it('skips .gitignore when the workspace is not a git repo', async () => {
    expect(await ensureWorkspaceGitignore(workspaceRoot)).toBe(false)
  })
})

describe('user memory file', () => {
  it('creates MEMORY.md on demand', async () => {
    const file = await ensureUserMemoryFile(dataDir)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('## 偏好')
    expect(text).toContain('## 事实')
  })

  it('removes the matching line from MEMORY.md when deleting', async () => {
    const { db, raw } = open()
    const file = await ensureUserMemoryFile(dataDir)
    await writeFile(
      file,
      renderUserMemory(['报告用中文,结论先行', '代码示例用 TypeScript'], ['常用工作区 D 盘']),
      'utf8'
    )
    const a = addMemory(db, { scope: 'user', kind: 'preference', content: '报告用中文,结论先行' })
    const b = addMemory(db, { scope: 'user', kind: 'preference', content: '代码示例用 TypeScript' })
    addMemory(db, { scope: 'user', kind: 'fact', content: '常用工作区 D 盘' })

    await deleteMemoryAndSync(db, dataDir, a.item!.id)
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('报告用中文')
    expect(text).toContain('代码示例用 TypeScript')
    const remaining = listMemory(db, { scope: 'user' }).map((m) => m.id)
    expect(remaining).toHaveLength(2)
    expect(remaining).toContain(b.item!.id)
    expect(remaining).not.toContain(a.item!.id)
    raw.close()
  })
})

describe('injection', () => {
  it('keeps all preferences but truncates facts when over budget', async () => {
    const { db, ws, raw } = open()
    const file = await ensureUserMemoryFile(dataDir)
    const prefs = Array.from({ length: 3 }, (_, i) => `偏好条目${i}`)
    const facts = Array.from({ length: 40 }, (_, i) => `事实条目${i}`.repeat(10))
    await writeFile(file, renderUserMemory(prefs, facts), 'utf8')
    for (const p of prefs) addMemory(db, { scope: 'user', kind: 'preference', content: p })
    for (const f of facts) addMemory(db, { scope: 'user', kind: 'fact', content: f })

    const result = await buildInjection({
      db, dataDir, workspaceId: ws.id, budget: { user: 120, workspace: 200 }
    })
    const userBlock = result.blocks.find((b) => b.scope === 'user')!
    for (const p of prefs) expect(userBlock.text).toContain(p)
    expect(userBlock.truncated).toBeGreaterThan(0)
    expect(result.truncatedTotal).toBeGreaterThan(0)
    raw.close()
  })

  it('marks provenance in the injected blocks', async () => {
    const { db, ws, raw } = open()
    addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: '项目用 pnpm' })
    const result = await buildInjection({ db, dataDir, workspaceId: ws.id, query: 'pnpm' })
    expect(result.text).toContain('<memory scope="workspace" retrieved="true">')
    expect(result.text).toContain('项目用 pnpm')
    raw.close()
  })

  it('falls back to recent workspace memory when keywords do not match', async () => {
    const { db, ws, raw } = open()
    addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'log', content: '请求: 整理季度汇报 | 模式: craft' })
    addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'log', content: '请求: 修复登录问题 | 模式: craft' })

    // 长句任务几乎不可能整句命中 FTS,不能因此一条都不注入。
    const result = await buildInjection({
      db, dataDir, workspaceId: ws.id, query: '把字符串 p2-craft 写入 out/craft.txt,然后只回复完成'
    })
    const block = result.blocks.find((b) => b.scope === 'workspace')
    expect(block).toBeDefined()
    expect(block!.ids.length).toBe(2)
    expect(result.text).toContain('整理季度汇报')
    raw.close()
  })

  it('keeps keyword hits ahead of the recency fallback', async () => {
    const { db, ws, raw } = open()
    addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'log', content: '请求: 迁移数据库 | 模式: craft' })
    addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'log', content: '请求: 调整配色 | 模式: craft' })
    const result = await buildInjection({ db, dataDir, workspaceId: ws.id, query: '迁移' })
    const block = result.blocks.find((b) => b.scope === 'workspace')
    expect(block!.ids.length).toBe(1)
    expect(result.text).toContain('迁移数据库')
    raw.close()
  })

  it('does not re-inject a deleted memory on the next conversation', async () => {
    const { db, ws, raw } = open()
    const a = addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: '应被删除的记忆' })
    const before = await buildInjection({ db, dataDir, workspaceId: ws.id, query: '删除' })
    expect(before.text).toContain('应被删除的记忆')

    await deleteMemoryAndSync(db, dataDir, a.item!.id)
    const after = await buildInjection({ db, dataDir, workspaceId: ws.id, query: '删除' })
    expect(after.text).not.toContain('应被删除的记忆')
    raw.close()
  })

  it('scopes workspace memory so another workspace cannot see it', async () => {
    const { db, ws, raw } = open()
    const other = ensureWorkspace(db, join(dir, 'ws2'))
    addMemory(db, { scope: 'workspace', workspaceId: ws.id, kind: 'fact', content: '只属于 ws1 的秘密标记' })
    const result = await buildInjection({ db, dataDir, workspaceId: other.id, query: '秘密标记' })
    expect(result.text).not.toContain('只属于 ws1')
    raw.close()
  })
})
