import { describe, expect, it } from 'vitest'
import type { MessageRecord } from '@openwb/storage'
import { buildHistoryContext, historyNotice } from '../src/history.js'

function msg(
  seq: number,
  role: 'user' | 'assistant',
  text: string | null,
  id = `m${seq}`
): MessageRecord {
  return {
    id,
    conversationId: 'c1',
    seq,
    role,
    content: text === null ? {} : { text },
    status: 'done',
    clientRequestId: null,
    model: null,
    tokenIn: 0,
    tokenOut: 0,
    feedback: null,
    feedbackReason: null,
    meta: null,
    createdAt: '2024-01-01T00:00:00.000Z'
  }
}

describe('buildHistoryContext', () => {
  it('keeps earlier turns in order and drops the current message', () => {
    const history = [
      msg(1, 'user', '第一问'),
      msg(2, 'assistant', '第一答'),
      msg(3, 'user', '第二问'),
      msg(4, 'assistant', '第二答'),
      msg(5, 'user', '第三问')
    ]
    const built = buildHistoryContext(history, { currentUserMessageId: 'm5' })
    expect(built.messages).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '第二答' }
    ])
    expect(built.dropped).toBe(0)
  })

  it('drops oldest turns first when over the character budget', () => {
    const history = [
      msg(1, 'user', 'a'.repeat(100)),
      msg(2, 'assistant', 'b'.repeat(100)),
      msg(3, 'user', 'c'.repeat(100)),
      msg(4, 'assistant', 'd'.repeat(100))
    ]
    const built = buildHistoryContext(history, { limits: { maxMessages: 10, maxChars: 250 } })
    expect(built.messages).toEqual([
      { role: 'user', content: 'c'.repeat(100) },
      { role: 'assistant', content: 'd'.repeat(100) }
    ])
    expect(built.dropped).toBe(2)
    expect(historyNotice(built.dropped)).toContain('2 条')
  })

  it('caps the number of messages', () => {
    const history = [msg(1, 'user', '一'), msg(2, 'assistant', '二'), msg(3, 'user', '三')]
    const built = buildHistoryContext(history, { limits: { maxMessages: 2, maxChars: 10_000 } })
    // 只留两条会以 assistant 开头,再被裁掉,保证上下文首条是 user。
    expect(built.messages.map((m) => m.content)).toEqual(['三'])
    expect(built.dropped).toBe(2)
  })

  it('keeps pairing when the cap still leaves a user turn first', () => {
    const history = [
      msg(1, 'user', '一'),
      msg(2, 'assistant', '二'),
      msg(3, 'user', '三'),
      msg(4, 'assistant', '四')
    ]
    const built = buildHistoryContext(history, { limits: { maxMessages: 2, maxChars: 10_000 } })
    expect(built.messages).toEqual([
      { role: 'user', content: '三' },
      { role: 'assistant', content: '四' }
    ])
    expect(built.dropped).toBe(2)
  })

  it('never starts with an assistant message', () => {
    const history = [msg(1, 'assistant', '孤立的答复'), msg(2, 'user', '提问')]
    expect(buildHistoryContext(history).messages).toEqual([{ role: 'user', content: '提问' }])
  })

  it('skips empty or non-text messages', () => {
    const history = [msg(1, 'user', ''), msg(2, 'assistant', null), msg(3, 'user', '有内容')]
    expect(buildHistoryContext(history).messages).toEqual([{ role: 'user', content: '有内容' }])
  })

  it('reports no notice when nothing was dropped', () => {
    expect(historyNotice(0)).toBeNull()
  })
})
