import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listWorkspaceFiles, resolveWorkspaceEntry } from '../src/main/workspace-files.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'owb-files-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'readme.md'), '# hi', 'utf8')
  await writeFile(join(root, 'docs', 'notes.txt'), 'notes', 'utf8')
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8')
  await writeFile(join(root, '.git', 'config'), 'x', 'utf8')
  await writeFile(join(root, '.env'), 'SECRET=1', 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listWorkspaceFiles', () => {
  it('返回工作区相对路径并跳过依赖、隐藏目录与隐藏文件', async () => {
    const files = await listWorkspaceFiles(root)
    const paths = files.map((f) => f.path)
    expect(paths).toContain('readme.md')
    expect(paths).toContain('docs/notes.txt')
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false)
    expect(paths.some((p) => p.startsWith('.git'))).toBe(false)
    expect(paths).not.toContain('.env')
  })

  it('限制数量与深度', async () => {
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(root, 'a', 'b', 'c', 'deep.txt'), 'x', 'utf8')
    const files = await listWorkspaceFiles(root, { limit: 1, maxDepth: 1 })
    expect(files).toHaveLength(1)
    expect(files[0]?.path).not.toContain('deep.txt')
  })

  it('跳过符号链接文件', async () => {
    const target = join(root, 'outside.txt')
    await writeFile(target, 'x', 'utf8')
    await symlink(target, join(root, 'link.txt')).catch(() => undefined)
    const files = await listWorkspaceFiles(root)
    expect(files.some((f) => f.path === 'link.txt')).toBe(false)
  })

  it('纳秒级限制参数不会失控', async () => {
    const files = await listWorkspaceFiles(root, { limit: 999_999, maxDepth: 999 })
    expect(files.length).toBeLessThanOrEqual(2000)
  })

  it('文件夹本身也出现在清单里,供整体引用', async () => {
    const files = await listWorkspaceFiles(root)
    const docs = files.find((f) => f.path === 'docs')
    expect(docs?.kind).toBe('folder')
    expect(files.find((f) => f.path === 'readme.md')?.kind).toBe('file')
    // 依赖与隐藏目录仍然不可选
    expect(files.some((f) => f.path === 'node_modules')).toBe(false)
    expect(files.some((f) => f.path === '.git')).toBe(false)
  })
})

describe('resolveWorkspaceEntry', () => {
  it('区分文件与文件夹并返回绝对路径', async () => {
    const folder = await resolveWorkspaceEntry(root, 'docs')
    expect(folder.kind).toBe('folder')
    expect(folder.relativePath).toBe('docs')
    const file = await resolveWorkspaceEntry(root, 'docs/notes.txt')
    expect(file.kind).toBe('file')
    expect(file.absolutePath).toBe(join(root, 'docs', 'notes.txt'))
  })

  it('拒绝绝对路径、上跳与内部目录', async () => {
    await expect(resolveWorkspaceEntry(root, '../outside')).rejects.toThrow()
    await expect(resolveWorkspaceEntry(root, 'docs/../../outside')).rejects.toThrow()
    await expect(resolveWorkspaceEntry(root, join(root, 'readme.md'))).rejects.toThrow()
    await expect(resolveWorkspaceEntry(root, '.openwb/attachments/a.txt')).rejects.toThrow()
  })

  it('拒绝符号链接目标', async () => {
    await symlink(join(root, 'docs'), join(root, 'link-dir')).catch(() => undefined)
    const linked = await resolveWorkspaceEntry(root, 'link-dir').catch((err: Error) => err)
    expect(linked instanceof Error).toBe(true)
  })
})
