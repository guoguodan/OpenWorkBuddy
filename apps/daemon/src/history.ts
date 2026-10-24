import type { MessageRecord } from '@openwb/storage'

/**
 * 会话历史转成模型消息。
 *
 * 真实产品在同一个会话里能记住前文;只看当前这一条用户消息会让"继续"、
 * "再改一下刚才那个"这类说法完全失效。这里把已落库的历史按原顺序拼回去,
 * 但必须保住两条约束:
 *   1. 只保留 user/assistant 文本,工具调用细节不进上下文(避免旧工具结果污染);
 *   2. 超出预算时从最早的消息开始丢,并明确告知模型"更早的对话已被省略",
 *      而不是悄悄截断让模型误以为那是全部历史。
 */
export interface HistoryLimits {
  /** 最多保留多少条历史消息(不含本轮)。 */
  maxMessages: number
  /** 历史文本总字符预算。中文大致 1 字≈1 token,按字符数控制足够保守。 */
  maxChars: number
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxMessages: 40,
  maxChars: 24_000
}

export type HistoryMessage = { role: 'user' | 'assistant'; content: string; seq?: number }

export interface HistoryContext {
  messages: HistoryMessage[]
  /** 因预算被丢弃的消息条数;>0 时由调用方注入省略说明。 */
  dropped: number
  chars: number
}

/**
 * 从最近的往前取,取满预算后再翻回原来的先后顺序。
 *
 * 单独抽出来是为了让"摘要之后仍超预算"的最后兜底与普通历史共用同一套规则,
 * 不会出现两处裁剪逻辑,一个保留 assistant 开头、另一个不保留。
 */
export function trimHistoryMessages(
  candidates: HistoryMessage[],
  limits: HistoryLimits
): HistoryMessage[] {
  const kept: HistoryMessage[] = []
  let chars = 0
  for (let i = candidates.length - 1; i >= 0; i--) {
    const item = candidates[i]!
    if (kept.length >= limits.maxMessages) break
    if (chars + item.content.length > limits.maxChars && kept.length > 0) break
    kept.unshift(item)
    chars += item.content.length
  }
  // 上下文必须以 user 消息开头:有些网关不接受首条为 assistant 的数组。
  while (kept.length > 0 && kept[0]!.role === 'assistant') kept.shift()
  return kept
}

function textOf(message: MessageRecord): string {
  const content = message.content as { text?: unknown } | null
  const text = content && typeof content === 'object' ? content.text : undefined
  if (typeof text !== 'string' || !text.trim()) return ''
  // 历史里附件已经落到磁盘,重放时才是权威输入;这里只提醒模型前一轮带过附件,
  // 避免把附件正文重复塞进上下文,也避免模型忘记自己看过哪些文件。
  const raw = (content as { attachments?: unknown } | null)?.attachments
  if (!Array.isArray(raw) || raw.length === 0) return text.trim()
  const names = raw
    .slice(0, 50)
    .map((item) =>
      item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
        ? (item as { name: string }).name
        : ''
    )
    .filter(Boolean)
  if (names.length === 0) return text.trim()
  return `${text.trim()}\n\n[上一轮附带文件:${names.join('、')}]`
}

/**
 * 构造本轮之前的对话上下文。
 *
 * `currentUserMessageId` 用来排除本轮自己:它已经作为最后一条 user 消息单独传入,
 * 再拼一次会让模型看到两条一模一样的提问。
 */
export function buildHistoryContext(
  history: MessageRecord[],
  options: { currentUserMessageId?: string; limits?: HistoryLimits } = {}
): HistoryContext {
  const limits = options.limits ?? DEFAULT_HISTORY_LIMITS
  const candidates: HistoryMessage[] = []
  for (const message of history) {
    if (options.currentUserMessageId && message.id === options.currentUserMessageId) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOf(message)
    if (!text) continue
    candidates.push({ role: message.role, content: text })
  }

  const kept = trimHistoryMessages(candidates, limits)
  if (kept.length === 0) return { messages: [], dropped: candidates.length, chars: 0 }

  return {
    messages: kept,
    dropped: candidates.length - kept.length,
    chars: kept.reduce((sum, item) => sum + item.content.length, 0)
  }
}

/** 被省略的历史要用一句话说明,否则模型会把"没看到"当成"没发生过"。 */
export function historyNotice(dropped: number): string | null {
  if (dropped <= 0) return null
  return `更早的 ${dropped} 条对话因上下文长度限制未提供给模型。需要时请让用户补充关键信息,不要臆测被省略的内容。`
}
