/**
 * 模型流式请求的自动重试策略。
 *
 * 网关抖动、限流和 5xx 在真实使用里很常见,直接抛给用户会让一次网络波动
 * 变成整轮任务失败。重试必须保守:
 *   1. 只重试明确的临时性错误(限流/超时/5xx/连接中断),鉴权和参数错误立即失败;
 *   2. 只在一个工具步还没有产生任何可见输出时重试,否则会出现重复文本,
 *      甚至把已经执行过的工具再跑一遍;
 *   3. 用户主动停止后绝不重试。
 */

export const DEFAULT_MAX_STREAM_ATTEMPTS = 3
export const DEFAULT_RETRY_BASE_MS = 400

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const RETRYABLE_PATTERN =
  /fetch failed|econnreset|econnrefused|etimedout|eai_again|socket hang up|other side closed|terminated|network|timeout|timed out|rate limit|too many requests|overloaded|temporarily unavailable|server error|bad gateway|service unavailable|gateway timeout/i
const NON_RETRYABLE_PATTERN =
  /invalid api key|incorrect api key|unauthorized|forbidden|authentication|permission denied|model .*not found|does not exist|invalid request|unsupported|bad request/i

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  const candidates = [record.statusCode, record.status, record.status_code]
  const response = record.response
  if (response && typeof response === 'object') {
    const res = response as Record<string, unknown>
    candidates.push(res.status, res.statusCode)
  }
  const cause = record.cause
  if (cause && typeof cause === 'object') {
    const inner = cause as Record<string, unknown>
    candidates.push(inner.statusCode, inner.status, inner.code)
  }
  for (const value of candidates) {
    const numeric = typeof value === 'string' ? Number(value) : value
    if (typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 100) return numeric
  }
  return null
}

export function isRetryableStreamError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof Error && error.name === 'AbortError') return false
  if (error && typeof error === 'object') {
    const retryable = (error as Record<string, unknown>).isRetryable
    if (retryable === true) return true
    if (retryable === false) return false
  }
  const status = statusOf(error)
  if (status !== null) return RETRYABLE_STATUS.has(status)
  const message = messageOf(error)
  if (NON_RETRYABLE_PATTERN.test(message)) return false
  return RETRYABLE_PATTERN.test(message)
}

export interface StreamRetryInput {
  /** 已经尝试过的次数,首次请求为 0。 */
  attempt: number
  /** 本次尝试是否已经向用户输出文本或发起工具调用。 */
  producedOutput: boolean
  aborted: boolean
  error: unknown
  maxAttempts?: number
}

export interface StreamRetryDecision {
  retry: boolean
  reason: string
}

export function decideStreamRetry(input: StreamRetryInput): StreamRetryDecision {
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_STREAM_ATTEMPTS)
  const reason = messageOf(input.error).slice(0, 300)
  if (input.aborted) return { retry: false, reason: '用户已停止' }
  if (input.producedOutput) return { retry: false, reason }
  if (input.attempt + 1 >= maxAttempts) return { retry: false, reason }
  if (!isRetryableStreamError(input.error)) return { retry: false, reason }
  return { retry: true, reason }
}

export interface ModelFallbackInput {
  /** 刚刚失败的主模型尝试序号,从 0 开始。 */
  attempt: number
  maxAttempts?: number
  /** 该步是否已经向用户输出文本或发起工具调用。 */
  producedOutput: boolean
  aborted: boolean
  error: unknown
  primaryModel: string
  fallbackModel?: string | null
  /** 本步是否已经切换过一次;只允许降级一次,避免在多个坏模型间来回试。 */
  alreadyFallenBack: boolean
}

export interface ModelFallbackDecision {
  fallback: boolean
  reason: string
}

/**
 * 判断是否应该在主模型重试耗尽后切换备用模型。
 *
 * 与同模型重试共用同一组安全边界:一旦出现过可见输出或工具调用,切换模型
 * 会让同一条回复前后来自不同模型,甚至重复执行有副作用的工具,因此绝不降级。
 * 鉴权、参数错误换模型也不会变好,同样不降级。
 */
export function decideModelFallback(input: ModelFallbackInput): ModelFallbackDecision {
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_STREAM_ATTEMPTS)
  const reason = messageOf(input.error).slice(0, 300)
  const fallback = input.fallbackModel?.trim() ?? ''
  if (input.aborted) return { fallback: false, reason: '用户已停止' }
  if (input.producedOutput) return { fallback: false, reason }
  if (input.alreadyFallenBack) return { fallback: false, reason }
  if (!fallback || fallback === input.primaryModel) return { fallback: false, reason }
  if (!isRetryableStreamError(input.error)) return { fallback: false, reason }
  // 主模型还有剩余重试次数时先重试主模型,避免一次抖动就换模型。
  if (input.attempt + 1 < maxAttempts) return { fallback: false, reason }
  return { fallback: true, reason }
}

export function retryDelayMs(attempt: number, baseMs = DEFAULT_RETRY_BASE_MS): number {
  const base = Number.isFinite(baseMs) && baseMs >= 0 ? baseMs : DEFAULT_RETRY_BASE_MS
  return Math.round(base * Math.pow(2, Math.max(0, attempt)))
}

/** 退避等待也要能被"停止"打断,否则用户点了停止还要干等一两秒。 */
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}
