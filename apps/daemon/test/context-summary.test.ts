import { describe, expect, it } from 'vitest'
import type { MessageRecord } from '@openwb/storage'
import {
  buildSummaryPrompt,
  fallbackSummary,
  planCompression,
  summaryContextText,
  toHistoryMessages
} from '../src/context-summary.js'
import type { HistoryMessage } from '../src/history.js'

function turns(count: number, size = 40): HistoryMessage[] {
  const out: HistoryMessage[] = []
  for (let i = 0; i < count; i++) {
    out.push({ role: 'user', content: `问${i}:` + 'u'.repeat(size), seq: i * 2 + 1 })
    out.push({ role: 'assistant', content: `答${i}:` + 'a'.repeat(size), seq: i * 2 + 2 })
  }
  return out
}

describe('planCompression', () => {
  it('keeps everything when under both budgets', () => {
    const messages = turns(3)
    const plan = planCompression(messages, { budget: 10_000, maxMessages: 40 })
    expect(plan.compress).toHaveLength(0)
    expect(plan.keep).toEqual(messages)
    expect(plan.lastCompressedIndex).toBe(-1)
  })

  it('only cuts on assistant boundaries so pairs stay together', () => {
    const messages = turns(8)
    const plan = planCompression(messages, { budget: 500, maxMessages: 40, minKeep: 6 })
    expect(plan.compress.length).toBeGreaterThan(0)
    expect(plan.compress.at(-1)!.role).toBe('assistant')
    expect(plan.keep[0]!.role).toBe('user')
    // 压缩与保留拼起来必须还原全部历史,不能凭空丢消息。
    expect([...plan.compress, ...plan.keep]).toEqual(messages)
  })

  it('keeps at least minKeep messages when that still satisfies the budget', () => {
    const messages = turns(10)
    const plan = planCompression(messages, { budget: 500, maxMessages: 40, minKeep: 6 })
    expect(plan.keep.length).toBeGreaterThanOrEqual(6)
    // 最小压缩量:刚好落到预算内的那个切分点,不会为了"多压一点"继续丢原文。
    expect(plan.keep.length).toBe(10)
    expect(plan.keep.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(500)
  })

  it('relaxes minKeep rather than giving up when few huge messages exceed the budget', () => {
    const messages = turns(5, 500)
    const plan = planCompression(messages, { budget: 1200, maxMessages: 40, minKeep: 6 })
    expect(plan.compress.length).toBeGreaterThan(0)
    expect(plan.keep.length).toBeGreaterThanOrEqual(2)
  })

  it('triggers on the message cap even when characters fit', () => {
    const messages = turns(10, 5)
    const plan = planCompression(messages, { budget: 100_000, maxMessages: 8, minKeep: 2 })
    expect(plan.compress.length).toBeGreaterThan(0)
    expect(plan.keep.length).toBeLessThanOrEqual(8)
  })

  it('does nothing when there is no complete turn boundary', () => {
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'x'.repeat(2000), seq: 1 },
      { role: 'assistant', content: 'y'.repeat(2000), seq: 2 }
    ]
    const plan = planCompression(messages, { budget: 100, maxMessages: 10, minKeep: 2 })
    expect(plan.compress).toHaveLength(0)
    expect(plan.keep).toEqual(messages)
  })
})

describe('summary text', () => {
  it('merges the previous summary into the new prompt', () => {
    const prompt = buildSummaryPrompt({
      messages: turns(1),
      previous: '【目标】做一份周报',
      previousCoveredSeq: 10
    })
    expect(prompt.prompt).toContain('更早的摘要')
    expect(prompt.prompt).toContain('做一份周报')
    expect(prompt.prompt).toContain('问0')
    expect(prompt.system).toContain('【目标】')
  })

  it('marks the summary as historical, not a new instruction', () => {
    const text = summaryContextText({ summary: '【目标】\n发布报告', coveredMessages: 12, coveredSeq: 24 })
    expect(text).toContain('已压缩 12 条')
    expect(text).toContain('第 24 条')
    expect(text).toContain('不是用户的新指令')
  })

  it('fallback keeps earlier questions and the previous summary', () => {
    const text = fallbackSummary(turns(2), '【目标】旧目标')
    expect(text).toContain('旧目标')
    expect(text).toContain('问1')
  })
})

describe('toHistoryMessages', () => {
  it('keeps seq and skips non-text or empty records', () => {
    const record = (seq: number, role: MessageRecord['role'], content: unknown): MessageRecord => ({
      id: `m${seq}`,
      conversationId: 'c1',
      seq,
      role,
      content,
      status: 'done',
      clientRequestId: null,
      model: null,
      tokenIn: 0,
      tokenOut: 0,
      feedback: null,
      feedbackReason: null,
      meta: null,
      createdAt: '2024-01-01T00:00:00.000Z'
    })
    const out = toHistoryMessages([
      record(1, 'user', { text: '  你好  ' }),
      record(2, 'tool', { text: '工具输出' }),
      record(3, 'assistant', {}),
      record(4, 'assistant', { text: '收到' })
    ])
    expect(out).toEqual([
      { role: 'user', content: '你好', seq: 1 },
      { role: 'assistant', content: '收到', seq: 4 }
    ])
  })
})
