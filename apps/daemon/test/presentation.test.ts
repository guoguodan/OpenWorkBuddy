import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPresentationTool } from '../src/tools/builtin.js'

async function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'owb-pptx-tool-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('create_presentation', () => {
  it('把演示文稿写进工作区并返回页数', async () => {
    await withWorkspace(async (root) => {
      const result = await createPresentationTool.execute(
        {
          path: 'reports/rag.pptx',
          title: 'RAG 汇报',
          subtitle: '原理与落地',
          slides: [
            { title: 'RAG 汇报' },
            { title: '架构', bullets: [{ text: '离线索引' }, { text: '在线问答', level: 2 }] }
          ]
        },
        { workspaceRoot: root }
      )
      expect(result.slides).toBe(2)
      expect(result.bytes).toBeGreaterThan(1000)
      const buf = await readFile(join(root, 'reports', 'rag.pptx'))
      expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
      expect(buf.length).toBe(result.bytes)
    })
  })

  it('拒绝非 .pptx 扩展名', async () => {
    await withWorkspace(async (root) => {
      await expect(
        createPresentationTool.execute({ path: 'a.md', title: 'x', slides: [{ title: 'x' }] }, { workspaceRoot: root })
      ).rejects.toThrow(/\.pptx/)
    })
  })

  it('拒绝越界路径', async () => {
    await withWorkspace(async (root) => {
      await expect(
        createPresentationTool.execute(
          { path: '../escape.pptx', title: 'x', slides: [{ title: 'x' }] },
          { workspaceRoot: root }
        )
      ).rejects.toThrow(/越界/)
    })
  })

  it('申报为写入型工具,才能进入审批闸门', () => {
    expect(createPresentationTool.effects.writesFilesystem).toBe(true)
    expect(createPresentationTool.effects.mayIncurCost).toBe(false)
  })
})