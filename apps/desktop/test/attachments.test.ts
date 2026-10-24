import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importAttachmentData,
  importAttachmentPaths
} from '../src/main/attachments.js'

let root = ''
let outside = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'owb-attach-'))
  outside = await mkdtemp(join(tmpdir(), 'owb-attach-src-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('附件导入', () => {
  it('复制到工作区附件目录并保留原始文件名', async () => {
    const source = join(outside, '季度 报告.md')
    await writeFile(source, '# 报告', 'utf8')
    const result = await importAttachmentPaths(root, [source])
    expect(result.rejected).toEqual([])
    expect(result.attachments).toHaveLength(1)
    const saved = result.attachments[0]!
    expect(saved.path.startsWith('.openwb/attachments/')).toBe(true)
    expect(saved.name).toBe('季度 报告.md')
    expect(saved.kind).toBe('file')
    expect(await readFile(join(root, saved.path), 'utf8')).toBe('# 报告')
    expect(saved.path).not.toContain('..')
  })

  it('同内容重复导入只保留一份', async () => {
    const a = join(outside, 'a.txt')
    const b = join(outside, 'b.txt')
    await writeFile(a, 'same', 'utf8')
    await writeFile(b, 'same', 'utf8')
    const first = await importAttachmentPaths(root, [a])
    const second = await importAttachmentPaths(root, [a])
    expect(second.attachments[0]!.path).toBe(first.attachments[0]!.path)
  })

  it('识别图片并拒绝不支持的类型', async () => {
    const image = join(outside, 'shot.PNG')
    const exe = join(outside, 'setup.exe')
    await writeFile(image, Buffer.from([137, 80, 78, 71]))
    await writeFile(exe, 'MZ')
    const result = await importAttachmentPaths(root, [image, exe])
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]!.kind).toBe('image')
    expect(result.rejected[0]!.reason).toContain('不支持的文件类型')
  })

  it('拒绝空文件和超大文件', async () => {
    const empty = join(outside, 'empty.txt')
    const large = join(outside, 'large.txt')
    await writeFile(empty, '')
    await writeFile(large, 'x'.repeat(200))
    const result = await importAttachmentPaths(root, [empty, large], { maxFileBytes: 100 })
    expect(result.attachments).toEqual([])
    expect(result.rejected.map((item) => item.reason).join('|')).toContain('文件为空')
    expect(result.rejected.map((item) => item.reason).join('|')).toContain('超过')
  })

  it('拒绝目录与符号链接', async () => {
    const dir = join(outside, 'folder.txt')
    await mkdir(dir)
    const link = join(outside, 'link.txt')
    await symlink(join(outside, 'missing.txt'), link).catch(() => undefined)
    const result = await importAttachmentPaths(root, [dir, link])
    expect(result.attachments).toEqual([])
    expect(result.rejected.some((item) => item.reason.includes('只能添加文件'))).toBe(true)
  })

  it('超出数量上限时提示且不写入多余文件', async () => {
    const sources = Array.from({ length: 3 }, (_, index) => join(outside, `f${index}.txt`))
    for (const source of sources) await writeFile(source, source, 'utf8')
    const result = await importAttachmentPaths(root, sources, { maxFiles: 2 })
    expect(result.attachments).toHaveLength(2)
    expect(result.rejected.at(-1)!.reason).toContain('最多引用 2 个文件')
  })

  it('净化危险文件名但保留可读后缀', async () => {
    const result = await importAttachmentData(root, [
      { name: '../evil:name?.md', data: new TextEncoder().encode('x') }
    ])
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]!.name).toBe('evil_name_.md')
    const files = await readdir(join(root, '.openwb', 'attachments'))
    expect(files[0]).not.toContain('..')
  })

  it('字节导入可处理浏览器拖拽且大小正确', async () => {
    const result = await importAttachmentData(root, [
      { name: 'drop.json', data: new TextEncoder().encode('{"a":1}') }
    ])
    const saved = result.attachments[0]!
    expect(saved.size).toBe(7)
    expect((await stat(join(root, saved.path))).size).toBe(7)
  })
})
