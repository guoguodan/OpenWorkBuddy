import { eq } from 'drizzle-orm'
import type { AppDatabase } from './client.js'
import { nowIso, ulid } from './ids.js'
import { task } from './schema.js'

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted' | 'skipped'

/**
 * 状态机(WM-TASK-02):
 *   pending -> running -> done | failed | interrupted
 *   failed  -> running 仅允许显式重试,且 attempt + 1
 *   pending -> skipped / interrupted(取消)
 * 明确禁止 failed -> done 的直接跳变。
 */
const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['running', 'skipped', 'interrupted'],
  running: ['done', 'failed', 'interrupted'],
  failed: ['running', 'skipped'],
  interrupted: ['running', 'skipped'],
  done: [],
  skipped: []
}

export class InvalidTaskTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`非法任务状态迁移: ${from} -> ${to}`)
    this.name = 'InvalidTaskTransitionError'
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTaskTransitionError(from, to)
}

export interface CreateTaskInput {
  conversationId: string
  title: string
  parentId?: string
  phase?: string
  inputHash?: string
  /** 该任务服务的用户消息;重放/回退按轮清理时使用。 */
  userMessageId?: string
}

export function createTask(db: AppDatabase, input: CreateTaskInput): string {
  const id = ulid()
  db.insert(task)
    .values({
      id,
      conversationId: input.conversationId,
      title: input.title,
      status: 'pending',
      attempt: 0,
      createdAt: nowIso(),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.inputHash ? { inputHash: input.inputHash } : {}),
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {})
    })
    .run()
  return id
}

export interface TransitionOptions {
  errorCode?: string
  resultRef?: string
}

/** 迁移任务状态;failed/interrupted -> running 视为重试,attempt 自增 */
export function transitionTask(
  db: AppDatabase,
  id: string,
  to: TaskStatus,
  options: TransitionOptions = {}
): { attempt: number } {
  const rows = db.select().from(task).where(eq(task.id, id)).all()
  const row = rows[0]
  if (!row) throw new Error(`任务不存在: ${id}`)

  const from = row.status as TaskStatus
  assertTransition(from, to)

  const isRetry = to === 'running' && (from === 'failed' || from === 'interrupted')
  const attempt = isRetry ? row.attempt + 1 : row.attempt

  const patch: Partial<typeof task.$inferInsert> = { status: to, attempt }
  if (to === 'running' && !isRetry) patch.startedAt = nowIso()
  if (isRetry) patch.startedAt = nowIso()
  if (to === 'done' || to === 'failed' || to === 'skipped') patch.finishedAt = nowIso()
  if (to === 'interrupted') patch.finishedAt = nowIso()
  if (options.errorCode) patch.errorCode = options.errorCode
  if (options.resultRef) patch.resultRef = options.resultRef

  db.update(task).set(patch).where(eq(task.id, id)).run()
  return { attempt }
}
