import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppDatabase } from '@openwb/storage'
import { addMemory, markDeleted, listMemory } from './store.js'
import { assertInside, userMemoryPath, workspaceDailyPath, workspaceMemoryDir } from './paths.js'
import { formatLogLine, normalize, parseUserMemory, renderUserMemory } from './format.js'
import type { MemoryItem, MemoryKind } from './types.js'

const MAX_DAILY_BYTES = 1024 * 1024

/**
 * 工作区日志:只追加,同日写同一个文件,超 1MB 轮转为 YYYY-MM-DD.1.md。
 * 写入失败只记日志,不影响任务结果(调用方负责 catch)。
 */
export async function appendWorkspaceLog(
  db: AppDatabase,
  input: { workspaceId: string; workspaceRoot: string; kind: MemoryKind; content: string; createdAt?: string }
): Promise<{ item: MemoryItem | null; deduped: boolean; file: string }> {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const day = createdAt.slice(0, 10)
  const dir = workspaceMemoryDir(input.workspaceRoot)
  await mkdir(dir, { recursive: true })

  let file = workspaceDailyPath(input.workspaceRoot, day)
  await assertInside(input.workspaceRoot, file)
  file = await rotateIfNeeded(file)

  const added = addMemory(db, {
    scope: 'workspace',
    workspaceId: input.workspaceId,
    kind: input.kind,
    content: input.content,
    sourcePath: file
  })
  if (!added.item || added.deduped) return { item: added.item, deduped: added.deduped, file }

  const line = formatLogLine({ createdAt, kind: input.kind, content: added.item.content })
  await appendFile(file, line, 'utf8')
  return { item: added.item, deduped: false, file }
}

async function rotateIfNeeded(file: string): Promise<string> {
  try {
    const info = await stat(file)
    if (info.size < MAX_DAILY_BYTES) return file
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return file
    throw err
  }
  const base = file.replace(/\.md$/, '')
  for (let i = 1; i < 100; i++) {
    const candidate = `${base}.${i}.md`
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error(`日志轮转失败: ${file}`)
}

/** 用户级 MEMORY.md:读文件为权威源,同时回填索引 */
export async function readUserMemory(
  db: AppDatabase,
  dataDir: string
): Promise<{ preferences: Array<{ id: string; text: string }>; facts: Array<{ id: string; text: string }> }> {
  const file = userMemoryPath(dataDir)
  let markdown = ''
  try {
    markdown = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return { preferences: [], facts: [] }
  }
  const parsed = parseUserMemory(markdown)
  const toItems = (kind: MemoryKind) =>
    listMemory(db, { scope: 'user' })
      .filter((m) => m.kind === kind)
      .map((m) => ({ id: m.id, text: m.content }))
  return {
    preferences: parsed.preferences.length ? toItems('preference') : [],
    facts: parsed.facts.length ? toItems('fact') : []
  }
}

export async function ensureUserMemoryFile(dataDir: string): Promise<string> {
  const file = userMemoryPath(dataDir)
  await mkdir(dirname(file), { recursive: true })
  try {
    await stat(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    await writeFile(file, renderUserMemory([], []), 'utf8')
  }
  return file
}

/**
 * 删除记忆:三步同一事务语义 —— 软删 + FTS 删除 + MEMORY.md 移除对应行。
 * 文件写失败会让整个删除失败,避免"库里没了文件还在"的静默不一致。
 */
export async function deleteMemoryAndSync(
  db: AppDatabase,
  dataDir: string,
  id: string
): Promise<{ removedFromFile: boolean }> {
  const items = listMemory(db, { limit: 10_000 })
  const target = items.find((m) => m.id === id)
  let removed = false

  if (target?.scope === 'user') {
    const file = userMemoryPath(dataDir)
    const markdown = await readFile(file, 'utf8').catch(() => null)
    if (markdown) {
      const needle = normalize(target.content)
      const kept = markdown
        .split(/\r?\n/)
        .filter((line) => !(line.trim().startsWith('- ') && normalize(line.trim().slice(2)) === needle))
      const next = kept.join('\n')
      if (next !== markdown) {
        await writeFile(file, next.endsWith('\n') ? next : `${next}\n`, 'utf8')
        removed = true
      }
    }
  }

  if (target?.scope === 'workspace' && target.sourcePath) {
    const file = target.sourcePath
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text) {
      const needle = normalize(target.content)
      const kept = text
        .split(/\r?\n/)
        .filter((line) => !(normalize(line.split('|').slice(2).join('|')) === needle) || !line.startsWith('- '))
      const next = kept.join('\n')
      await writeFile(file, next.endsWith('\n') ? next : `${next}\n`, 'utf8')
      removed = true
    }
  }

  markDeleted(db, id)
  return { removedFromFile: removed }
}

/** 工作区 .openwb/ 必须进 .gitignore,否则记忆会污染用户提交 */
export async function ensureWorkspaceGitignore(workspaceRoot: string): Promise<boolean> {
  const gitDir = join(workspaceRoot, '.git')
  try {
    await stat(gitDir)
  } catch {
    return false
  }
  const file = join(workspaceRoot, '.gitignore')
  const entry = '.openwb/'
  let content = ''
  try {
    content = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const lines = content.split(/\r?\n/).map((l) => l.trim())
  if (lines.includes(entry)) return false
  const next = `${content}${content.length === 0 || content.endsWith('\n') ? '' : '\n'}${entry}\n`
  await writeFile(file, next, 'utf8')
  return true
}