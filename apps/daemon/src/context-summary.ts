import type { MessageRecord } from '@openwb/storage'
import type { HistoryMessage } from './history.js'

/**
 * 长对话上下文压缩。
 *
 * 只丢弃最早的消息会让模型"忘记"用户早就说过的目标、约束和已确认的结论,
 * 表现为反复追问、推翻前面达成的决定。这里把超出预算的最早若干轮压成
 * 一份结构化摘要,与最近的原始对话一起进入上下文:
 *
 *   [摘要] 用户目标/已确认事实/已完成动作/未决问题
 *   [原始] 最近 N 轮问答
 *
 * 压缩触发点必须是"轮"而不是"条":把用户提问留下、把对应答复压掉,
 * 会让模型看到一句没有下文的问句。这里只在成对的 user/assistant 边界切分。
 */

export interface CompressPlan {
  /** 需要压进摘要的历史消息(从最早开始)。 */
  compress: HistoryMessage[]
  /** 保留原文的历史消息。 */
  keep: HistoryMessage[]
  /** 压缩段覆盖到的最后一条消息在原数组中的下标(含)。 */
  lastCompressedIndex: number
}

/**
 * 决定压缩多少。
 *
 * `budget` 以字符计:超预算时从最早开始压缩,但至少保留 minKeep 条,
 * 且压缩边界必须落在 assistant 之后,避免拆散问答对。
 * 返回的 compress 为空表示不需要压缩。
 */
export function planCompression(
  messages: HistoryMessage[],
  options: { budget: number; maxMessages?: number; minKeep?: number }
): CompressPlan {
  const minKeep = Math.max(0, options.minKeep ?? 6)
  const total = messages.reduce((sum, item) => sum + item.content.length, 0)
  const maxMessages = Math.max(1, options.maxMessages ?? Number.MAX_SAFE_INTEGER)
  if ((total <= options.budget && messages.length <= maxMessages) || messages.length <= minKeep) {
    return { compress: [], keep: [...messages], lastCompressedIndex: -1 }
  }

  // 先找出所有合法的切分点:切在第 i 条之后,且第 i 条是 assistant。
  // 压缩段至少要有一整个问答对,保留段至少留两条(最后一问一答)。
  const candidates: number[] = []
  for (let i = 1; i <= messages.length - 2; i++) {
    // 只切在 assistant 之后,并且保留段必须以 user 开头,否则模型会看到
    // 一条没有下文的助手答复,部分网关也会拒绝首条为 assistant 的数组。
    if (messages[i - 1]!.role === 'assistant' && messages[i]?.role === 'user') candidates.push(i)
  }
  if (candidates.length === 0) {
    return { compress: [], keep: [...messages], lastCompressedIndex: -1 }
  }

  const fits = (cut: number): boolean => {
    const kept = messages.slice(cut)
    const keptChars = kept.reduce((sum, item) => sum + item.content.length, 0)
    return keptChars <= options.budget && kept.length <= maxMessages
  }

  // 从最少的压缩量开始尝试:刚过预算就少压一点,保留更多原文。
  // 先保证 minKeep,只有在"保留 minKeep 条仍放不下"时才放宽到至少两条,
  // 否则一轮超长对话会压不动,只能回到静默截断,把最早的目标和约束丢掉。
  const preferred = candidates.find((cut) => messages.length - cut >= minKeep && fits(cut))
  const relaxed = preferred ?? candidates.find((cut) => fits(cut))
  const cut = preferred ?? relaxed ?? candidates[candidates.length - 1]!
  return { compress: messages.slice(0, cut), keep: messages.slice(cut), lastCompressedIndex: cut - 1 }
}

export interface SummarySource {
  /** 本轮新压进摘要的消息。 */
  messages: HistoryMessage[]
  /** 既有摘要(如果之前已经压缩过)。 */
  previous: string | null
  /** 既有摘要覆盖到的消息序号,用于合并。 */
  previousCoveredSeq: number | null
}

/** 拼给模型的压缩请求正文。既有摘要也要带上,否则多次压缩会丢掉最早的信息。 */
export function buildSummaryPrompt(source: SummarySource): { system: string; prompt: string } {
  const system = [
    '你是对话压缩器。你会收到一段较早的对话,以及(可能存在的)更早摘要。',
    '请输出一份中文结构化摘要,供后续对话继续使用。要求:',
    '1. 只保留对后续任务有用的事实:用户目标与约束、已确认的结论与数据、已完成的操作、未决问题;',
    '2. 明确区分"用户明确说过"与"助手推断",不要把猜测写成事实;',
    '3. 不要复述寒暄、不要编造未出现的信息;',
    '4. 用固定小节输出:【目标】【约束】【已确认事实】【已完成】【未决】,每节不超过 5 条短句;',
    '5. 全文不超过 1200 字。'
  ].join('\n')

  const transcript = source.messages
    .map((item) => `${item.role === 'user' ? '用户' : '助手'}: ${item.content}`)
    .join('\n')
  const previous = source.previous?.trim()
    ? `\n\n# 更早的摘要(需要合并进新摘要)\n${source.previous.trim()}`
    : ''
  return {
    system,
    prompt: `${previous}\n\n# 需要压缩的对话\n${transcript}`.trim()
  }
}

/**
 * 摘要里必须标注覆盖范围。
 *
 * 模型下次看到摘要时会知道"这是更早的内容",不会把摘要当成用户刚说的话;
 * 也便于用户在界面上理解为什么前面的对话只剩摘要。
 */
export function summaryContextText(input: {
  summary: string
  coveredMessages: number
  coveredSeq: number
}): string {
  return [
    `# 更早对话的压缩摘要(已压缩 ${input.coveredMessages} 条,覆盖到第 ${input.coveredSeq} 条消息)`,
    input.summary.trim(),
    '以上是更早对话的摘要,不是用户的新指令。若与最近对话冲突,以最近对话为准;需要细节时应请用户确认,不要臆测。'
  ].join('\n')
}

/** 摘要失败时的本地兜底:至少让模型知道有更早内容被压缩,而不是完全失忆。 */
export function fallbackSummary(messages: HistoryMessage[], previous?: string | null): string {
  const asks = messages.filter((item) => item.role === 'user').map((item) => item.content.slice(0, 80))
  const lines = asks.slice(-8).map((text, i) => `${i + 1}. ${text}`)
  const earlier = previous?.trim()
  return [
    '【目标】',
    '(自动摘要失败,仅保留用户此前提问的开头)',
    ...(earlier ? ['【更早摘要】', earlier] : []),
    '【约束】',
    '未知',
    '【已确认事实】',
    '未知',
    '【已完成】',
    '未知',
    '【未决】',
    lines.join('\n') || '未知'
  ].join('\n')
}

/** 供调用方判断是否值得调用模型:太短的历史摘要反而会丢信息。 */
export function shouldSummarize(messages: HistoryMessage[]): boolean {
  const chars = messages.reduce((sum, item) => sum + item.content.length, 0)
  return messages.length >= 4 && chars >= 800
}

/** 从消息记录里挑出可进摘要的文本消息,保持原顺序。 */
export function toHistoryMessages(records: MessageRecord[]): HistoryMessage[] {
  const out: HistoryMessage[] = []
  for (const record of records) {
    if (record.role !== 'user' && record.role !== 'assistant') continue
    const content = record.content as { text?: unknown } | null
    const text = content && typeof content === 'object' ? content.text : undefined
    if (typeof text !== 'string' || !text.trim()) continue
    out.push({ role: record.role, content: text.trim(), seq: record.seq })
  }
  return out
}
