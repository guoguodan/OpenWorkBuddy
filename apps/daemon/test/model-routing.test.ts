import { describe, expect, it } from 'vitest'
import {
  LONG_CONTEXT_ATTACHMENTS,
  LONG_CONTEXT_CHARS,
  looksLikeCodeTask,
  looksLikeLongContext,
  routeModel,
  type ModelRouteInput
} from '../src/model-routing.js'

const base: ModelRouteInput = {
  autoRoute: true,
  manualModel: null,
  defaultModel: 'default/model',
  fastModel: 'fast/model',
  deepModel: 'deep/model',
  codeModel: 'code/model',
  modeId: 'craft',
  scene: null,
  text: '帮我把这份会议纪要整理成一封邮件',
  attachmentCount: 0,
  hasImages: false
}

const route = (patch: Partial<ModelRouteInput> = {}) => routeModel({ ...base, ...patch })

describe('routeModel', () => {
  it('always honors an explicit manual selection, even with auto routing on', () => {
    const decision = route({ manualModel: 'manual/model', modeId: 'quick', scene: 'coding' })
    expect(decision).toMatchObject({
      model: 'manual/model',
      rule: 'manual',
      preferredModel: 'manual/model'
    })
    expect(decision.reason).toContain('手动')
  })

  it('keeps the historical default when auto routing is off', () => {
    const decision = route({ autoRoute: false, modeId: 'quick', text: 'x'.repeat(LONG_CONTEXT_CHARS) })
    expect(decision).toMatchObject({ model: 'default/model', rule: 'auto-off', task: 'chat' })
    expect(decision.preferredModel).toBeNull()
  })

  it('routes quick mode to the fast model', () => {
    const decision = route({ modeId: 'quick' })
    expect(decision).toMatchObject({
      model: 'fast/model',
      rule: 'quick-mode',
      task: 'quick',
      preferredModel: 'fast/model'
    })
    expect(decision.reason).toContain('轻量模型')
  })

  it('routes long text to the deep model before code rules apply', () => {
    const decision = route({ text: `${'重构数据库迁移脚本 '.repeat(800)}` })
    expect(decision).toMatchObject({ model: 'deep/model', rule: 'long-context', task: 'long-context' })
  })

  it('routes attachment-heavy turns to the deep model', () => {
    const decision = route({
      modeId: 'ask',
      text: '看看这些文件',
      attachmentCount: LONG_CONTEXT_ATTACHMENTS
    })
    expect(decision.rule).toBe('long-context')
    expect(decision.model).toBe('deep/model')
  })

  it('routes coding scenes and code-shaped text to the code model', () => {
    expect(route({ modeId: 'craft', scene: 'coding', text: '整理需求' }).rule).toBe('code-task')
    expect(route({ modeId: 'ask', text: '修复这个 TypeScript 报错' }).rule).toBe('code-task')
    expect(route({ modeId: 'craft', text: '打开 src/main.ts' }).rule).toBe('code-task')
  })

  it('keeps ordinary office requests on the default model', () => {
    const decision = route({ modeId: 'craft', text: '把上周的销售数据整理成周报' })
    expect(decision).toMatchObject({ model: 'default/model', rule: 'default', task: 'chat' })
    expect(decision.preferredModel).toBeNull()
  })

  it('falls back to the default model when a rule has no dedicated model', () => {
    const decision = route({ modeId: 'quick', fastModel: null })
    expect(decision).toMatchObject({ model: 'default/model', rule: 'quick-mode', preferredModel: null })
    expect(decision.reason).toContain('未配置')
  })

  it('ignores blank or whitespace-only dedicated model names', () => {
    expect(route({ modeId: 'quick', fastModel: '   ' }).model).toBe('default/model')
  })
})

describe('routing heuristics', () => {
  it('treats images plus another attachment as long context', () => {
    expect(looksLikeLongContext({ text: '看图', attachmentCount: 2, hasImages: true })).toBe(true)
    expect(looksLikeLongContext({ text: '看图', attachmentCount: 1, hasImages: true })).toBe(false)
  })

  it('does not treat a coding scene as a code task without a scene signal', () => {
    expect(looksLikeCodeTask({ modeId: 'craft', scene: null, text: '写一份季度总结' })).toBe(false)
    expect(looksLikeCodeTask({ modeId: 'craft', scene: 'coding', text: '写一份季度总结' })).toBe(true)
  })
})
