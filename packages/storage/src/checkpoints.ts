import { asc, eq } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { fileCheckpoint } from './schema.js'

export interface FileCheckpointRecord {
  id: string
  conversationId: string
  userMessageId: string
  messageSeq: number
  beforeJson: string
  afterJson: string | null
  createdAt: string
  updatedAt: string
}

/** 在一轮开始、任何文件副作用之前写入基线快照。 */
export function beginFileCheckpoint(
  db: AppDatabase,
  input: {
    conversationId: string
    userMessageId: string
    messageSeq: number
    beforeJson: string
  }
): string {
  const at = nowIso()
  const existing = db
    .select()
    .from(fileCheckpoint)
    .where(eq(fileCheckpoint.userMessageId, input.userMessageId))
    .all()[0]
  if (existing) {
    db.update(fileCheckpoint)
      .set({ beforeJson: input.beforeJson, messageSeq: input.messageSeq, updatedAt: at })
      .where(eq(fileCheckpoint.id, existing.id))
      .run()
    return existing.id
  }
  const id = ulid()
  db.insert(fileCheckpoint)
    .values({
      id,
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      messageSeq: input.messageSeq,
      beforeJson: input.beforeJson,
      afterJson: null,
      createdAt: at,
      updatedAt: at
    })
    .run()
  return id
}

/** 一轮结束后写入结果快照;取消/失败也会落盘,便于下一次回退。 */
export function finishFileCheckpoint(db: AppDatabase, id: string, afterJson: string): void {
  db.update(fileCheckpoint)
    .set({ afterJson, updatedAt: nowIso() })
    .where(eq(fileCheckpoint.id, id))
    .run()
}

export function listFileCheckpoints(
  db: AppDatabase,
  conversationId: string
): FileCheckpointRecord[] {
  return db
    .select()
    .from(fileCheckpoint)
    .where(eq(fileCheckpoint.conversationId, conversationId))
    .orderBy(asc(fileCheckpoint.messageSeq))
    .all() as FileCheckpointRecord[]
}

export function getFileCheckpointByMessage(
  db: AppDatabase,
  userMessageId: string
): FileCheckpointRecord | undefined {
  return db
    .select()
    .from(fileCheckpoint)
    .where(eq(fileCheckpoint.userMessageId, userMessageId))
    .all()[0] as FileCheckpointRecord | undefined
}
