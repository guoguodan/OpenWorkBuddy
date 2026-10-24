import { describe, expect, it } from 'vitest'
import {
  MAX_RECOMMENDATIONS,
  recommendPlugins,
  tokenizeTask,
  type RecommendablePlugin
} from '../src/plugin-recommend.js'

const connector = (patch: Partial<RecommendablePlugin> = {}): RecommendablePlugin => ({
  name: 'jira-connector',
  displayName: 'Jira 连接器',
  description: '读取 Jira 项目、缺陷与迭代数据',
  kind: 'connector',
  enabled: false,
  permissions: ['network'],
  tools: [{ name: 'jira_search_issues', description: '搜索缺陷与任务' }],
  ...patch
})

const expert = (patch: Partial<RecommendablePlugin> = {}): RecommendablePlugin => ({
  name: 'legal-expert',
  displayName: '法务顾问',
  description: '合同审查与合规风险',
  kind: 'expert',
  enabled: true,
  permissions: [],
  tools: [],
  instructions: '先指出风险条款,再给出修改建议。',
  ...patch
})

describe('tokenizeTask', () => {
  it('drops request pleasantries and keeps domain words', () => {
    const tokens = tokenizeTask('请帮我看看这份合同中违约条款的风险')
    expect(tokens).toContain('合同')
    expect(tokens).toContain('违约')
    expect(tokens).toContain('风险')
    expect(tokens).not.toContain('帮我')
    expect(tokens).not.toContain('请帮')
  })

  it('keeps latin product names as single tokens', () => {
    expect(tokenizeTask('sync JIRA issues to Notion')).toEqual(
      expect.arrayContaining(['jira', 'issues', 'notion'])
    )
  })
})

describe('recommendPlugins', () => {
  it('recommends a matching connector with a user-facing reason', () => {
    const list = recommendPlugins('帮我整理 Jira 里本周的缺陷', [connector()])
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('jira-connector')
    expect(list[0]!.kind).toBe('connector')
    expect(list[0]!.matched).toContain('jira')
    expect(list[0]!.reason).toContain('连接后')
  })

  it('never recommends a connector that is already connected', () => {
    expect(recommendPlugins('帮我整理 Jira 里本周的缺陷', [connector({ enabled: true })])).toEqual([])
  })

  it('does not recommend the expert already active in this conversation', () => {
    const task = '审查这份合同的违约条款风险'
    expect(recommendPlugins(task, [expert()])).toHaveLength(1)
    expect(recommendPlugins(task, [expert()], { activeExpertId: 'legal-expert' })).toEqual([])
  })

  it('skips disabled experts because they cannot run', () => {
    expect(recommendPlugins('审查合同风险', [expert({ enabled: false })])).toEqual([])
  })

  it('caps results at three and sorts by score', () => {
    const many: RecommendablePlugin[] = [
      expert({ name: 'expert-a', displayName: 'A', description: '合同审查' }),
      expert({ name: 'expert-b', displayName: 'B', description: '合同审查与合规' }),
      expert({ name: 'expert-c', displayName: 'C', description: '合同审查合规风险' }),
      expert({ name: 'expert-d', displayName: 'D', description: '合同审查合规风险条款' })
    ]
    const list = recommendPlugins('审查合同合规风险条款', many)
    expect(list).toHaveLength(MAX_RECOMMENDATIONS)
    expect(MAX_RECOMMENDATIONS).toBe(3)
    expect(list[0]!.score).toBeGreaterThanOrEqual(list[1]!.score)
    expect(list[1]!.score).toBeGreaterThanOrEqual(list[2]!.score)
  })

  it('returns nothing for empty or unrelated input', () => {
    expect(recommendPlugins('', [connector()])).toEqual([])
    expect(recommendPlugins('今天天气不错去散步', [connector()])).toEqual([])
  })
})
