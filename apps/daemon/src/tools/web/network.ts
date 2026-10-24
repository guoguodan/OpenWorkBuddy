import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

const blocked = new BlockList()

// IPv4: 非公网、回环、链路本地、组播、保留与文档网段全部拒绝。
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  blocked.addSubnet(address, prefix, 'ipv4')
}

// IPv6: 未指定、回环、唯一本地、链路本地、组播、文档与过渡机制。
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['64:ff9b::', 96]
] as const) {
  blocked.addSubnet(address, prefix, 'ipv6')
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']
const LOCAL_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

/** 判断地址是否属于不可信范围;无法识别的输入按不可信处理。 */
export function isPrivateAddress(raw: string): boolean {
  const address = raw.split('%')[0]?.trim() ?? ''
  const version = isIP(address)
  if (version === 4) return blocked.check(address, 'ipv4')
  if (version === 6) {
    const lower = address.toLowerCase()
    const mapped = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : ''
    const mappedVersion = isIP(mapped)
    if (mappedVersion === 4) return blocked.check(mapped, 'ipv4')
    if (mappedVersion === 6) return blocked.check(mapped, 'ipv6')
    return blocked.check(address, 'ipv6')
  }
  return true
}

export interface UrlPolicy {
  /** 仅本地开发与验收可打开;生产默认拒绝回环与私网。 */
  allowPrivate: boolean
}

/** 校验 http/https URL,并对域名做 DNS 解析,拒绝解析到私网的主机。 */
export async function assertPublicHttpUrl(raw: string | URL, policy: UrlPolicy): Promise<URL> {
  let url: URL
  try {
    url = raw instanceof URL ? new URL(raw.href) : new URL(raw)
  } catch {
    throw new Error(`非法 URL: ${String(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只允许 http/https: ${url.href}`)
  }
  if (url.username || url.password) {
    throw new Error(`URL 不允许携带凭据: ${url.href}`)
  }
  if (policy.allowPrivate) return url

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname) throw new Error(`URL 缺少主机名: ${url.href}`)
  if (LOCAL_HOSTS.has(hostname) || LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error(`拒绝访问回环或内网主机: ${hostname}`)
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(`拒绝访问回环或内网地址: ${hostname}`)
    return url
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error(`无法解析主机: ${hostname}`)
  }
  if (addresses.length === 0) throw new Error(`无法解析主机: ${hostname}`)
  const unsafe = addresses.find((item) => isPrivateAddress(item.address))
  if (unsafe) throw new Error(`拒绝访问解析到内网的主机: ${hostname} -> ${unsafe.address}`)
  return url
}

export interface Deadline {
  signal: AbortSignal
  timedOut: () => boolean
  parentAborted: () => boolean
  cleanup: () => void
}

/** 合并外部取消与超时;超时与用户取消在调用侧给出不同错误。 */
export function withDeadline(parent: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  if (parent?.aborted) controller.abort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    parentAborted: () => parent?.aborted === true,
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    }
  }
}

export interface LimitedText {
  text: string
  bytes: number
  truncated: boolean
  contentType: string | null
}

function charsetOf(contentType: string | null): string {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '')
  return match?.[1]?.trim() ?? 'utf-8'
}

export function decodeText(bytes: Uint8Array, contentType: string | null): string {
  const charset = charsetOf(contentType)
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 流式读取并硬性截断,避免恶意大响应把进程内存打满。 */
export async function readLimitedText(response: Response, maxBytes: number): Promise<LimitedText> {
  const contentType = response.headers.get('content-type')
  const reader = response.body?.getReader()
  if (!reader) {
    return { text: '', bytes: 0, truncated: false, contentType }
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      const room = maxBytes - bytes
      if (value.length > room) {
        if (room > 0) chunks.push(value.subarray(0, room))
        bytes += Math.max(room, 0)
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
      chunks.push(value)
      bytes += value.length
    }
  } finally {
    reader.releaseLock()
  }
  const data = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return { text: decodeText(data, contentType), bytes, truncated, contentType }
}

export function isTextualContentType(contentType: string | null): boolean {
  if (!contentType) return true
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return (
    base.startsWith('text/') ||
    base === 'application/xhtml+xml' ||
    base === 'application/xml' ||
    base === 'application/json' ||
    base.endsWith('+xml') ||
    base.endsWith('+json')
  )
}
