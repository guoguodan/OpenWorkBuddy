import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isAttachmentStoragePath,
  isWorkspaceReferencePath,
  loadRunAttachments,
  normalizeRunAttachments
} from '../src/attachments.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'owb-run-attach-'))
  await mkdir(join(root, '.openwb', 'attachments'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(name: string, body: string | Uint8Array) {
  const rel = `.openwb/attachments/${name}`
  await writeFile(join(root, rel), body)
  return rel
}

describe('附件元数据', () => {
  it('只接受附件目录内的相对路径', () => {
    expect(isAttachmentStoragePath('.openwb/attachments/a.txt')).toBe(true)
    expect(isAttachmentStoragePath('.openwb/attachments/../../secret.txt')).toBe(false)
    expect(isAttachmentStoragePath('notes.txt')).toBe(false)
    expect(isAttachmentStoragePath('/etc/passwd')).toBe(false)
  })

  it('工作区引用只接受合法相对路径', () => {
    expect(isWorkspaceReferencePath('docs')).toBe(true)
    expect(isWorkspaceReferencePath('src/app.ts')).toBe(true)
    expect(isWorkspaceReferencePath('../secret.txt')).toBe(false)
    expect(isWorkspaceReferencePath('/etc/passwd')).toBe(false)
    expect(isWorkspaceReferencePath('C:/Windows/win.ini')).toBe(false)
    expect(isWorkspaceReferencePath('docs/../../secret.txt')).toBe(false)
    expect(isWorkspaceReferencePath('.openwb/settings.json')).toBe(false)
    expect(isWorkspaceReferencePath('docs//a.txt')).toBe(false)
  })

  it('去重并丢弃非法对象', () => {
    const list = normalizeRunAttachments([
      { path: '.openwb/attachments/a.txt', name: 'a.txt', kind: 'file' },
      { path: '.openwb/attachments/a.txt', name: 'a.txt', kind: 'file' },
      { path: '../secret.txt', name: 'secret.txt' },
      { path: '.openwb/attachments/b.png', name: 'b.png' },
      { path: '.openwb/attachments/c.txt' }
    ])
    expect(list).toHaveLength(2)
    expect(list[0]!.path).toBe('.openwb/attachments/a.txt')
    expect(list[1]!.kind).toBe('image')
  })

  it('区分上传副本与工作区引用', () => {
    const list = normalizeRunAttachments([
      { path: '.openwb/attachments/a.txt', name: 'a.txt' },
      { path: 'docs', name: 'docs', kind: 'folder' },
      { path: 'notes.md', name: 'notes.md', source: 'workspace' },
      // 工作区路径伪装成上传:必须拒绝
      { path: 'notes.md', name: 'notes.md', source: 'upload' },
      // 上传路径伪装成工作区:同样拒绝
      { path: '.openwb/attachments/a.txt', name: 'a.txt', source: 'workspace' }
    ])
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({ source: 'upload', kind: 'file' })
    expect(list[1]).toMatchObject({ source: 'workspace', kind: 'folder' })
    expect(list[2]).toMatchObject({ source: 'workspace', kind: 'file' })
  })
})

describe('loadRunAttachments', () => {
  it('文本注入正文并列出清单', async () => {
    const rel = await put('note.md', '# 标题\n内容')
    const loaded = await loadRunAttachments(root, [{ path: rel, name: 'note.md', kind: 'file' }])
    expect(loaded.injected).toBe(1)
    expect(loaded.images).toHaveLength(0)
    expect(loaded.system).toContain('# 标题')
    expect(loaded.system).toContain('note.md')
  })

  it('图片作为多模态输入而不是 UTF-8 正文', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 1, 2])
    const rel = await put('shot.png', bytes)
    const loaded = await loadRunAttachments(root, [{ path: rel, name: 'shot.png', kind: 'image' }])
    expect(loaded.images).toHaveLength(1)
    expect(loaded.images[0]!.mimeType).toBe('image/png')
    expect(loaded.images[0]!.data).toEqual(bytes)
    expect(loaded.system).not.toContain('\u0000')
  })

  it('PDF 只给路径,不注入二进制乱码', async () => {
    const rel = await put('doc.pdf', new Uint8Array([37, 80, 68, 70, 0, 255, 254]))
    const loaded = await loadRunAttachments(root, [{ path: rel, name: 'doc.pdf', kind: 'file' }])
    expect(loaded.images).toHaveLength(0)
    expect(loaded.system).toContain('PDF 文档')
    expect(loaded.system).toContain(rel)
    expect(loaded.system).not.toContain('\u0000')
  })

  it('拒绝越界路径与空文件', async () => {
    const empty = await put('empty.txt', '')
    const loaded = await loadRunAttachments(root, [
      { path: '../secret.txt', name: 'secret.txt', kind: 'file' },
      { path: empty, name: 'empty.txt', kind: 'file' }
    ])
    expect(loaded.injected).toBe(0)
    expect(loaded.rejected).toHaveLength(2)
  })

  it('识别未知二进制内容,不按文本注入', async () => {
    const rel = await put('blob.dat', new Uint8Array([1, 2, 0, 4]))
    const loaded = await loadRunAttachments(root, [{ path: rel, name: 'blob.dat', kind: 'file' }])
    expect(loaded.system).toContain('二进制内容未注入正文')
  })

  it('工作区文件原地引用并注入正文', async () => {
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'notes.md'), '# 工作区笔记\n文件夹引用正文')
    const loaded = await loadRunAttachments(root, [
      { path: 'docs/notes.md', name: 'notes.md', kind: 'file', source: 'workspace' }
    ])
    expect(loaded.injected).toBe(1)
    expect(loaded.rejected).toHaveLength(0)
    expect(loaded.system).toContain('工作区笔记')
    expect(loaded.system).toContain('docs/notes.md')
  })

  it('文件夹有界展开,跳过依赖与隐藏文件', async () => {
    await mkdir(join(root, 'docs', 'sub'), { recursive: true })
    await mkdir(join(root, 'docs', 'node_modules'), { recursive: true })
    await writeFile(join(root, 'docs', 'notes.md'), '# 说明\n正文')
    await writeFile(join(root, 'docs', 'sub', 'extra.txt'), '额外内容')
    await writeFile(join(root, 'docs', 'node_modules', 'pkg.js'), 'SKIP-ME')
    await writeFile(join(root, 'docs', '.env'), 'SECRET=1')
    const loaded = await loadRunAttachments(root, [
      { path: 'docs', name: 'docs', kind: 'folder', source: 'workspace' }
    ])
    expect(loaded.injected).toBe(2)
    expect(loaded.system).toContain('文件夹')
    expect(loaded.system).toContain('正文')
    expect(loaded.system).toContain('额外内容')
    expect(loaded.system).not.toContain('SKIP-ME')
    expect(loaded.system).not.toContain('SECRET=1')
  })

  it('空文件夹与符号链接给出可见拒绝理由', async () => {
    await mkdir(join(root, 'empty'), { recursive: true })
    await writeFile(join(root, 'real.txt'), 'x')
    await symlink(join(root, 'real.txt'), join(root, 'link.txt')).catch(() => undefined)
    const loaded = await loadRunAttachments(root, [
      { path: 'empty', name: 'empty', kind: 'folder', source: 'workspace' },
      { path: 'link.txt', name: 'link.txt', kind: 'file', source: 'workspace' }
    ])
    expect(loaded.injected).toBe(0)
    expect(loaded.rejected.length).toBeGreaterThanOrEqual(1)
    expect(loaded.system === '' || loaded.system.includes('未能读取')).toBe(true)
  })

  it('工作区引用越界被拒绝', async () => {
    const loaded = await loadRunAttachments(root, [
      { path: '../secret.txt', name: 'secret.txt', kind: 'file', source: 'workspace' }
    ])
    expect(loaded.injected).toBe(0)
    expect(loaded.rejected[0]!.reason).toContain('工作区')
  })
})
