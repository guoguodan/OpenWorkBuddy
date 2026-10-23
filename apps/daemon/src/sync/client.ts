import type { AppDatabase, PendingEventRecord } from '@openwb/storage'
import { duePending, markPendingFailed, markPendingSent } from '@openwb/storage'

export interface SyncConfig {
  baseUrl: string
  token?: string
  /** 便于契约测试注入,生产环境使用全局 fetch */
  fetchImpl?: typeof fetch
  batchSize?: number
  timeoutMs?: number
}

export interface FlushResult {
  sentEvents: number
  sentArtifacts: number
  failed: number
  /** 本轮是否因失败提前停止:队列顺序不能被跳过 */
  stopped: boolean
  lastError?: string
}

export class SyncError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'SyncError'
    this.status = status
  }
}

/** 只允许 http/https;本地同步服务通常是 http://127.0.0.1:port */
export function normalizeSyncUrl(raw: string): string {
  const value = raw.trim()
  if (!value) throw new SyncError('同步地址不能为空')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SyncError(`同步地址不合法: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SyncError('同步地址只支持 http/https')
  }
  if (url.username || url.password) throw new SyncError('同步地址不能包含用户名或密码')
  return url.toString().replace(/\/$/, '')
}

export async function flushPending(
  db: AppDatabase,
  workspaceId: string,
  config: SyncConfig,
  now: Date = new Date()
): Promise<FlushResult> {
  const baseUrl = normalizeSyncUrl(config.baseUrl)
  const fetchImpl = config.fetchImpl ?? fetch
  const limit = Math.max(1, Math.min(config.batchSize ?? 50, 200))
  const pending = duePending(db, workspaceId, { limit, now })
  const result: FlushResult = { sentEvents: 0, sentArtifacts: 0, failed: 0, stopped: false }

  let index = 0
  while (index < pending.length) {
    const item = pending[index]!
    if (item.kind === 'event') {
      // 连续事件合并成一个请求;遇到产物就切断,保持事件与产物的产生顺序。
      const batch: PendingEventRecord[] = []
      while (index < pending.length && pending[index]!.kind === 'event') {
        batch.push(pending[index]!)
        index++
      }
      try {
        await postJson(fetchImpl, `${baseUrl}/v1/sync/events`, { events: batch.map((e) => e.payload) }, config)
        markPendingSent(db, batch.map((e) => e.id), now)
        result.sentEvents += batch.length
      } catch (err) {
        // 整批失败按单条计:服务端去重保证重放安全,不会因重试产生重复消息。
        const message = describeError(err)
        for (const event of batch) markPendingFailed(db, event.id, message, now)
        result.failed += batch.length
        result.stopped = true
        result.lastError = message
        break
      }
      continue
    }

    try {
      await postJson(fetchImpl, `${baseUrl}/v1/artifacts`, item.payload, config, {
        'X-Event-Id': item.id
      })
      markPendingSent(db, [item.id], now)
      result.sentArtifacts++
    } catch (err) {
      const message = describeError(err)
      markPendingFailed(db, item.id, message, now)
      result.failed++
      result.stopped = true
      result.lastError = message
      break
    }
    index++
  }

  return result
}

export interface SyncLoopOptions {
  intervalMs?: number
  onResult?: (result: FlushResult) => void
  onError?: (err: Error) => void
}

export function startSyncLoop(
  db: AppDatabase,
  workspaceId: string,
  config: SyncConfig,
  options: SyncLoopOptions = {}
): () => void {
  const interval = Math.max(1000, options.intervalMs ?? 15_000)
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const result = await flushPending(db, workspaceId, config)
      options.onResult?.(result)
    } catch (err) {
      // 后台同步永不让 daemon 崩溃;界面通过 sync.status 查看队列状态。
      options.onError?.(err as Error)
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), interval)
  timer.unref()
  return () => clearInterval(timer)
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  config: SyncConfig,
  headers: Record<string, string> = {}
): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000)
  timeout.unref?.()
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        ...headers
      },
      body: JSON.stringify(body ?? null),
      signal: controller.signal
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new SyncError(`同步失败: HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`, response.status)
    }
  } catch (err) {
    if (err instanceof SyncError) throw err
    if ((err as Error).name === 'AbortError') throw new SyncError('同步请求超时')
    throw new SyncError((err as Error).message || '同步请求失败')
  } finally {
    clearTimeout(timeout)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
