/**
 * 第三方服务连接的真实可达性探测。
 *
 * 协议里客户端可以声明任意状态,但"已连接"必须由 daemon 自己验证:
 *   1. 只探测 http/https,地址里不允许内嵌账号密码;
 *   2. 总预算固定,避免 DNS 或半开连接让保存操作长时间卡住;
 *   3. HEAD 失败时用 GET 兜底,兼容拒绝 HEAD 的服务;
 *   4. 2xx/3xx 才算可用;鉴权、限流、5xx 和网络错误都返回原因,不能显示为已连接。
 */
import { sanitizeEndpoint } from '@openwb/storage'

export const DEFAULT_SERVICE_PROBE_TIMEOUT_MS = 5_000

export interface ServiceProbeOptions {
  timeoutMs?: number
}

export interface ServiceProbeResult {
  ok: boolean
  status: number | null
  method: 'HEAD' | 'GET' | null
  error: string | null
}

interface AttemptResult {
  status: number | null
  error: string | null
  timeout: boolean
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  const causeText =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return `${error.message}${causeText ? ` (${causeText})` : ''}`.slice(0, 240)
}

function describeNetworkError(message: string, timedOut: boolean): string {
  if (timedOut) return '连接超时，服务在限定时间内没有响应'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return '无法解析服务域名'
  if (/ECONNREFUSED/i.test(message)) return '服务拒绝连接，请确认地址与端口'
  if (/ECONNRESET|socket hang up|other side closed/i.test(message)) return '连接被服务端重置'
  if (/CERT|certificate|self[- ]signed/i.test(message)) return '服务证书校验失败'
  return `无法连接到服务：${message}`
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return `服务要求身份验证（HTTP ${status}），当前无法确认授权状态`
  }
  if (status === 404) return '服务地址不存在（HTTP 404）'
  if (status === 429) return '服务暂时限流（HTTP 429），请稍后重试'
  if (status >= 500) return `服务暂时不可用（HTTP ${status}）`
  return `服务返回异常状态（HTTP ${status}）`
}

async function requestWithBudget(
  url: string,
  method: 'HEAD' | 'GET',
  timeoutMs: number
): Promise<AttemptResult> {
  if (timeoutMs <= 0) {
    return { status: null, error: '连接超时，服务在限定时间内没有响应', timeout: true }
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'OpenWorkBuddy service-check/1.0'
      }
    })
    // 只关心响应头,不读取正文;GET 兜底也不会把大文件拉进内存。
    await response.body?.cancel()
    return { status: response.status, error: null, timeout: false }
  } catch (error) {
    const message = errorText(error)
    return {
      status: null,
      error: describeNetworkError(message, timedOut || controller.signal.aborted),
      timeout: timedOut
    }
  } finally {
    clearTimeout(timer)
  }
}

function resultFromAttempt(result: AttemptResult, method: 'HEAD' | 'GET'): ServiceProbeResult {
  if (result.status !== null && result.status >= 200 && result.status < 400) {
    return { ok: true, status: result.status, method, error: null }
  }
  return {
    ok: false,
    status: result.status,
    method,
    error: result.status !== null ? describeStatus(result.status) : result.error
  }
}

export async function probeServiceEndpoint(
  raw: string | null | undefined,
  options: ServiceProbeOptions = {}
): Promise<ServiceProbeResult> {
  const endpoint = sanitizeEndpoint(raw)
  if (!endpoint) {
    return {
      ok: false,
      status: null,
      method: null,
      error: '连接地址无效（仅支持 http/https，且不能包含账号密码）'
    }
  }

  const configured = options.timeoutMs ?? DEFAULT_SERVICE_PROBE_TIMEOUT_MS
  const timeoutMs = Number.isFinite(configured) ? Math.max(50, configured) : DEFAULT_SERVICE_PROBE_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const head = await requestWithBudget(endpoint, 'HEAD', timeoutMs)
  if (head.status !== null && head.status >= 200 && head.status < 400) {
    return resultFromAttempt(head, 'HEAD')
  }

  // HEAD 经常被网关以 403/405/501 拒绝,GET 才能代表用户真正打开服务时的结果。
  const remaining = deadline - Date.now()
  if (remaining <= 50 || head.timeout) return resultFromAttempt(head, 'HEAD')
  const get = await requestWithBudget(endpoint, 'GET', remaining)
  return resultFromAttempt(get, 'GET')
}
