import { eq } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso } from './ids.js'
import { conversationSummary } from './schema.js'

export interface ConversationContextSummary {
  conversationId: string
  /** 摘要覆盖到的最后一条消息序号(含)。 */
  coveredSeq: number
  coveredMessages: number
  summary: string
  sourceChars: number
  createdAt: string
  updatedAt: string
}

export function getConversationSummary(
  db: AppDatabase,
  conversationId: string
): ConversationContextSummary | undefined {
  return db
    .select()
    .from(conversationSummary)
    .where(eq(conversationSummary.conversationId, conversationId))
    .all()[0] as ConversationContextSummary | undefined
}

/**
 * 写入或覆盖摘要。
 *
 * 覆盖而不是追加:一份摘要已经代表"从头到 covered_seq 的所有内容",
 * 保留多份既没有额外信息,也会让上下文预算难以估算。
 */
export function upsertConversationSummary(
  db: AppDatabase,
  input: {
    conversationId: string
    coveredSeq: number
    coveredMessages: number
    summary: string
    sourceChars: number
  }
): ConversationContextSummary {
  const at = nowIso()
  const existing = getConversationSummary(db, input.conversationId)
  db.insert(conversationSummary)
    .values({
      conversationId: input.conversationId,
      coveredSeq: input.coveredSeq,
      coveredMessages: input.coveredMessages,
      summary: input.summary,
      sourceChars: input.sourceChars,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    })
    .onConflictDoUpdate({
      target: conversationSummary.conversationId,
      set: {
        coveredSeq: input.coveredSeq,
        coveredMessages: input.coveredMessages,
        summary: input.summary,
        sourceChars: input.sourceChars,
        updatedAt: at
      }
    })
    .run()
  return getConversationSummary(db, input.conversationId)!
}

/** 消息被回退/重放到 fromSeq 之前时,覆盖到该位置的摘要已经失效。 */
export function invalidateConversationSummaryFrom(
  db: AppDatabase,
  conversationId: string,
  fromSeq: number
): number {
  const existing = getConversationSummary(db, conversationId)
  if (!existing || existing.coveredSeq < fromSeq) return 0
  return db
    .delete(conversationSummary)
    .where(eq(conversationSummary.conversationId, conversationId))
    .run().changes
}
