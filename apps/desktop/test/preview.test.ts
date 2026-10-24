import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_TEXT_BYTES, PREVIEW_CSP, readTextPreview, resolvePreview } from '../src/main/preview-policy.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'owb-preview-'))
  await writeFile(join(root, 'demo.html'), '<h1>hi</h1>', 'utf8')
  await writeFile(join(root, 'notes.md'), '# notes', 'utf8')
  await writeFile(join(root, 'pic.png'), Buffer.alloc(32))
  await writeFile(join(root, 'app.ts'), ['export const answer = 42', ''].join(String.fromCharCode(10)), 'utf8')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(root, 'page.html'), '<p>hello</p>', 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolvePreview', () => {
  it('CSP 禁脚本、禁网、禁框架', () => {
    expect(PREVIEW_CSP).toContain("script-src 'none'")
    expect(PREVIEW_CSP).toContain("connect-src 'none'")
    expect(PREVIEW_CSP).toContain("default-src 'none'")
  })

  it('html 走沙箱窗口并带上 CSP', async () => {
    const r = await resolvePreview(root, { kind: 'html', path: 'demo.html' })
    expect(r.mode).toBe('html-window')
    expect(r.csp).toBe(PREVIEW_CSP)
    expect(r.sha256).toHaveLength(64)
  })

  it('普通文件交给系统程序', async () => {
    const r = await resolvePreview(root, { kind: 'file', path: 'notes.md' })
    expect(r.mode).toBe('system')
  })

  it('图片走图片窗口', async () => {
    const r = await resolvePreview(root, { kind: 'image', path: 'pic.png' })
    expect(r.mode).toBe('image-window')
  })

  it('拒绝越界路径', async () => {
    await expect(resolvePreview(root, { kind: 'file', path: '../secret.txt' })).rejects.toThrow(/路径越界/)
  })

  it('url 需要二次确认,且只允许 http/https', async () => {
    await expect(resolvePreview(root, { kind: 'url', url: 'https://example.com' })).rejects.toThrow(/URL_NEEDS_CONFIRM/)
    const ok = await resolvePreview(root, { kind: 'url', url: 'https://example.com' }, { confirmedUrl: true })
    expect(ok.mode).toBe('browser')
    await expect(
      resolvePreview(root, { kind: 'url', url: 'file:///etc/passwd' }, { confirmedUrl: true })
    ).rejects.toThrow(/http/)
  })

  it('图片 > 20MB 拒绝内嵌渲染', async () => {
    // 用稀疏文件避免真的写 21MB 到磁盘
    const big = join(root, 'big.png')
    const fh = await (await import('node:fs/promises')).open(big, 'w')
    await fh.truncate(20 * 1024 * 1024 + 1)
    await fh.close()
    await expect(resolvePreview(root, { kind: 'image', path: 'big.png' })).rejects.toThrow(/20MB/)
  })
})

describe('readTextPreview', () => {
  it('按扩展名给出预览格式', async () => {
    const md = await readTextPreview(root, { path: 'notes.md' })
    expect(md?.format).toBe('markdown')
    expect(md?.text).toContain('# notes')
    const code = await readTextPreview(root, { path: 'app.ts' })
    expect(code?.format).toBe('code')
    expect(code?.text).toContain('answer')
    const html = await readTextPreview(root, { path: 'page.html' })
    expect(html?.format).toBe('html')
  })

  it('二进制与未知扩展名返回 null,交给系统程序', async () => {
    expect(await readTextPreview(root, { path: 'pic.png' })).toBeNull()
    expect(await readTextPreview(root, { path: 'binary.bin' })).toBeNull()
  })

  it('拒绝工作区外的路径', async () => {
    await expect(readTextPreview(root, { path: '../secret.txt' })).rejects.toThrow(/路径越界/)
  })

  it('只读取前 2MB,并按 UTF-8 边界截断', async () => {
    const big = join(root, 'big.log')
    // 每个汉字 3 字节,保证 2MB 边界落在字符内部,用来验证不会解出半个字。
    const chunk = Buffer.from('日志记录\n', 'utf8')
    const fh = await (await import('node:fs/promises')).open(big, 'w')
    const total = MAX_TEXT_BYTES + 1024
    const repeated = Buffer.alloc(total)
    for (let i = 0; i < total; i += chunk.length) chunk.copy(repeated, i)
    await fh.write(repeated)
    await fh.close()

    const r = await readTextPreview(root, { path: 'big.log' })
    expect(r?.truncated).toBe(true)
    expect(r?.size).toBe(total)
    expect(Buffer.byteLength(r?.text ?? '', 'utf8')).toBeLessThanOrEqual(MAX_TEXT_BYTES)
    expect(r?.text).not.toContain('\uFFFD')
  })
})