import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { presentFilesTool } from '../src/tools/builtin.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'owb-artifact-'))
  await mkdir(join(root, 'out'), { recursive: true })
  await writeFile(join(root, 'out', 'report.md'), '# report\n', 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('present_files', () => {
  it('拒绝工作区外的路径', async () => {
    await expect(
      presentFilesTool.execute({ items: [{ path: '../../etc/passwd', title: 'x' }] }, { workspaceRoot: root })
    ).rejects.toThrow(/路径越界/)
  })

  it('不存在的文件直接失败,不假装交付', async () => {
    await expect(
      presentFilesTool.execute({ items: [{ path: 'out/missing.md', title: 'x' }] }, { workspaceRoot: root })
    ).rejects.toThrow()
  })

  it('html 扩展名自动识别为网页', async () => {
    await writeFile(join(root, 'out', 'demo.html'), '<h1>demo</h1>', 'utf8')
    const drafts: Array<{ kind: string; sha256?: string }> = []
    await presentFilesTool.execute(
      { items: [{ path: 'out/demo.html', title: 'demo' }] },
      { workspaceRoot: root, artifactSink: { insert: async (items) => { drafts.push(...items); return items.map((_, i) => ({ id: String(i), deduped: false })) } } }
    )
    expect(drafts[0]?.kind).toBe('html')
    expect(drafts[0]?.sha256).toHaveLength(64)
  })

  it('只允许 http/https 外链', async () => {
    await expect(
      presentFilesTool.execute(
        { items: [{ kind: 'url', url: 'file:///etc/passwd', title: 'x' }] },
        { workspaceRoot: root }
      )
    ).rejects.toThrow(/http/)
  })
})
