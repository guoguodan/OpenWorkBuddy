import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PREVIEW_CSP, resolvePreview } from '../src/main/preview-policy.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'owb-preview-'))
  await writeFile(join(root, 'demo.html'), '<h1>hi</h1>', 'utf8')
  await writeFile(join(root, 'notes.md'), '# notes', 'utf8')
  await writeFile(join(root, 'pic.png'), Buffer.alloc(32))
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
