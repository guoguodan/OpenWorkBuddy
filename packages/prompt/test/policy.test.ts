import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadModes, assertRequiredModes } from '../src/loader.js'
import { isToolAllowed, visibleTools } from '../src/policy.js'
import { assemble, loadFragments } from '../src/assembler.js'
import { buildTrace } from '../src/trace.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const modesDir = join(repoRoot, 'resources/modes')
const promptsDir = join(repoRoot, 'resources/prompts')

describe('模式策略', () => {
  it('5 个策略文件全部通过校验', async () => {
    const modes = await loadModes(modesDir)
    expect(() => assertRequiredModes(modes)).not.toThrow()
    expect([...modes.keys()].sort()).toEqual(['ask', 'craft', 'expert', 'plan', 'quick'])
  })

  it('quick 模式拒绝任何工具', async () => {
    const modes = await loadModes(modesDir)
    const quick = modes.get('quick')!
    for (const tool of ['read_file', 'write_file', 'shell', 'anything']) {
      expect(isToolAllowed(quick, tool)).toBe(false)
    }
  })

  it('ask 模式允许读、拒绝写', async () => {
    const modes = await loadModes(modesDir)
    const ask = modes.get('ask')!
    expect(isToolAllowed(ask, 'read_file')).toBe(true)
    expect(isToolAllowed(ask, 'write_file')).toBe(false)
    expect(isToolAllowed(ask, 'shell')).toBe(false)
  })

  it('craft 模式允许全部基线工具', async () => {
    const modes = await loadModes(modesDir)
    const craft = modes.get('craft')!
    for (const tool of ['read_file', 'write_file', 'glob', 'grep', 'shell', 'present_files']) {
      expect(isToolAllowed(craft, tool)).toBe(true)
    }
  })

  it('visibleTools 随模式变化', async () => {
    const modes = await loadModes(modesDir)
    const all = ['read_file', 'write_file', 'shell', 'present_files']
    expect(visibleTools(modes.get('craft')!, all)).toEqual(all)
    expect(visibleTools(modes.get('ask')!, all)).toEqual(['read_file'])
    expect(visibleTools(modes.get('quick')!, all)).toEqual([])
  })

  it('plan 与 expert 均不可写', async () => {
    const modes = await loadModes(modesDir)
    for (const id of ['plan', 'expert']) {
      expect(isToolAllowed(modes.get(id)!, 'write_file')).toBe(false)
      expect(isToolAllowed(modes.get(id)!, 'shell')).toBe(false)
    }
  })
})

describe('提示词组装', () => {
  it('同一输入两次组装 sha256 相同', async () => {
    const names = ['interaction.md', 'agent-loop.md']
    const a = assemble(await loadFragments(promptsDir, names), {})
    const b = assemble(await loadFragments(promptsDir, names), {})
    expect(buildTrace('craft', a).outputSha256).toBe(buildTrace('craft', b).outputSha256)
  })

  it('不同模式产出不同提示词', async () => {
    const ask = assemble(await loadFragments(promptsDir, ['interaction.md', 'ask-mode.md']))
    const plan = assemble(await loadFragments(promptsDir, ['interaction.md', 'plan-mode.md']))
    expect(buildTrace('ask', ask).outputSha256).not.toBe(buildTrace('plan', plan).outputSha256)
  })

  it('缺失变量直接抛错,不静默填空', async () => {
    const fragments = [{ name: 'x.md', content: '你好 {{name}}' }]
    expect(() => assemble(fragments, {})).toThrow(/未提供的模板变量: name/)
  })

  it('缺失片段直接抛错', async () => {
    await expect(loadFragments(promptsDir, ['nope.md'])).rejects.toThrow(/提示词片段不存在/)
  })
})
