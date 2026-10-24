import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isAttachmentStoragePath,
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
})
