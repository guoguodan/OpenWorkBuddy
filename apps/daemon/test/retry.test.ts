import { describe, expect, it } from 'vitest'
import {
  decideStreamRetry,
  isRetryableStreamError,
  retryDelayMs,
  sleepWithAbort
} from '../src/retry.js'

function apiError(message: string, statusCode?: number, isRetryable?: boolean): Error {
  return Object.assign(new Error(message), {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(isRetryable !== undefined ? { isRetryable } : {})
  })
}

describe('isRetryableStreamError', () => {
  it('retries rate limits, overload and gateway failures', () => {
    expect(isRetryableStreamError(apiError('rate limited', 429))).toBe(true)
    expect(isRetryableStreamError(apiError('overloaded', 503))).toBe(true)
    expect(isRetryableStreamError(apiError('bad gateway', 502))).toBe(true)
    expect(isRetryableStreamError(apiError('server error', 500))).toBe(true)
    expect(isRetryableStreamError(apiError('timeout', 408))).toBe(true)
  })

  it('retries transient network errors without a status code', () => {
    expect(isRetryableStreamError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableStreamError(new Error('read ECONNRESET'))).toBe(true)
    expect(isRetryableStreamError(new Error('socket hang up'))).toBe(true)
    expect(isRetryableStreamError(new Error('请求超时 timeout'))).toBe(true)
  })

  it('does not retry client errors or authentication failures', () => {
    expect(isRetryableStreamError(apiError('bad request', 400))).toBe(false)
    expect(isRetryableStreamError(apiError('unauthorized', 401))).toBe(false)
    expect(isRetryableStreamError(apiError('Incorrect API key provided'))).toBe(false)
    expect(isRetryableStreamError(apiError('model not found', 404))).toBe(false)
  })

  it('honors the provider retry hint', () => {
    expect(isRetryableStreamError(apiError('mystery', undefined, true))).toBe(true)
    expect(isRetryableStreamError(apiError('rate limited', 429, false))).toBe(false)
  })

  it('never retries aborts', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isRetryableStreamError(abort)).toBe(false)
  })
})

describe('decideStreamRetry', () => {
  it('retries a clean step on a transient failure', () => {
    const decision = decideStreamRetry({
      attempt: 0,
      producedOutput: false,
      aborted: false,
      error: apiError('overloaded', 503)
    })
    expect(decision.retry).toBe(true)
    expect(decision.reason).toContain('overloaded')
  })

  it('never retries once text or a tool call was emitted', () => {
    expect(
      decideStreamRetry({
        attempt: 0,
        producedOutput: true,
        aborted: false,
        error: apiError('overloaded', 503)
      }).retry
    ).toBe(false)
  })

  it('stops at the attempt budget', () => {
    expect(
      decideStreamRetry({
        attempt: 2,
        producedOutput: false,
        aborted: false,
        error: apiError('overloaded', 503),
        maxAttempts: 3
      }).retry
    ).toBe(false)
  })

  it('does not retry after abort', () => {
    expect(
      decideStreamRetry({
        attempt: 0,
        producedOutput: false,
        aborted: true,
        error: apiError('overloaded', 503)
      }).retry
    ).toBe(false)
  })
})

describe('retryDelayMs', () => {
  it('backs off exponentially', () => {
    expect(retryDelayMs(0, 400)).toBe(400)
    expect(retryDelayMs(1, 400)).toBe(800)
    expect(retryDelayMs(2, 400)).toBe(1600)
  })
})

describe('sleepWithAbort', () => {
  it('resolves after the delay', async () => {
    const started = Date.now()
    await sleepWithAbort(30, new AbortController().signal)
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })

  it('rejects immediately when aborted', async () => {
    const controller = new AbortController()
    const pending = sleepWithAbort(10_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })
})
