import { describe, expect, it } from 'vitest'
import {
  assertExpertExclusive,
  buildExpertPrompt,
  ExpertConflictError,
  expertSectionNames,
  type ExpertInfo
} from '../src/expert-mode.js'

const single: ExpertInfo = {
  id: 'legal-expert',
  name: '法务顾问',
  description: '合同与合规',
  instructions: '先指出风险条款,再给修改建议。',
  team: []
}

const team: ExpertInfo = {
  id: 'deal-team',
  name: '并购专家团队',
  description: '法务与财务协同',
  instructions: '给出结论时必须同时覆盖法律与财务视角。',
  team: [
    { id: 'legal-expert', name: '法务顾问', role: '合规', instructions: '关注违约与责任上限。' },
    { id: 'finance-expert', name: '财务分析师', role: null, instructions: '' }
  ]
}

describe('assertExpertExclusive', () => {
  it('allows the first expert when the conversation has none', () => {
    expect(() => assertExpertExclusive(null, { id: 'a', name: 'A' })).not.toThrow()
  })

  it('treats re-selecting the same expert as idempotent', () => {
    expect(() =>
      assertExpertExclusive({ id: 'a', name: 'A' }, { id: 'a', name: 'A' })
    ).not.toThrow()
  })

  it('rejects a second, different expert with a machine-readable conflict', () => {
    try {
      assertExpertExclusive({ id: 'a', name: '法务顾问' }, { id: 'b', name: '财务分析师' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertConflictError)
      const conflict = err as ExpertConflictError
      expect(conflict.code).toBe('EXPERT_CONFLICT')
      expect(conflict.current).toEqual({ id: 'a', name: '法务顾问' })
      expect(conflict.requested).toEqual({ id: 'b', name: '财务分析师' })
      expect(conflict.message).toContain('法务顾问')
      expect(conflict.message).toContain('财务分析师')
      expect(conflict.message).toContain('一个会话只允许一个专家')
    }
  })
})

describe('buildExpertPrompt', () => {
  it('keeps the single-expert wording and its professional boundary', () => {
    const prompt = buildExpertPrompt(single)
    expect(prompt).toContain('# 专家角色')
    expect(prompt).toContain('你正在以「法务顾问」专家身份工作。')
    expect(prompt).toContain('先指出风险条款,再给修改建议。')
    expect(prompt).toContain('保持专业边界')
    expect(prompt).not.toContain('团队成员')
  })

  it('merges every team member instruction and their roles', () => {
    const prompt = buildExpertPrompt(team)
    expect(prompt).toContain('「并购专家团队」专家团队的身份工作')
    expect(prompt).toContain('## 团队成员')
    expect(prompt).toContain('### 1. 法务顾问(合规)')
    expect(prompt).toContain('关注违约与责任上限。')
    expect(prompt).toContain('### 2. 财务分析师')
    expect(prompt).toContain('该成员未声明额外准则')
    expect(prompt).toContain('不要虚构未列出的成员')
  })

  it('names the trace sections without leaking instructions', () => {
    expect(expertSectionNames(single)).toEqual(['expert'])
    expect(expertSectionNames(team)).toEqual(['expert', 'expert-team'])
    expect(expertSectionNames(null)).toEqual([])
  })
})
