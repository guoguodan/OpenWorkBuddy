import { readLimitedText, withDeadline } from './network.js'

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface SearchRunner {
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]>
}

export type SearchProviderId = 'tavily' | 'brave' | 'serper' | 'searxng'

export const SEARCH_PROVIDERS: readonly SearchProviderId[] = ['tavily', 'brave', 'serper', 'searxng']

export interface SearchProviderConfig {
  provider: SearchProviderId
  apiKey?: string
  endpoint: string
}

export interface SearchEnvironment {
  [key: string]: string | undefined
}

const DEFAULT_ENDPOINTS: Record<Exclude<SearchProviderId, 'searxng'>, string> = {
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  serper: 'https://google.serper.dev/search'
}

const KEY_ENV: Record<Exclude<SearchProviderId, 'searxng'>, string[]> = {
  tavily: ['TAVILY_API_KEY', 'OPENWB_SEARCH_API_KEY'],
  brave: ['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY', 'OPENWB_SEARCH_API_KEY'],
  serper: ['SERPER_API_KEY', 'OPENWB_SEARCH_API_KEY']
}

export class SearchConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchConfigError'
  }
}

export function isSearchProviderId(value: string): value is SearchProviderId {
  return (SEARCH_PROVIDERS as readonly string[]).includes(value)
}

export function resolveSearchConfig(env: SearchEnvironment = process.env): SearchProviderConfig | null {
  const providerRaw = env.OPENWB_SEARCH_PROVIDER?.trim().toLowerCase()
  if (!providerRaw) return null
  if (!isSearchProviderId(providerRaw)) {
    throw new SearchConfigError(
      `未知检索 provider: ${providerRaw}(可选 ${SEARCH_PROVIDERS.join(' / ')})`
    )
  }
  const endpointOverride = env.OPENWB_SEARCH_ENDPOINT?.trim()
  if (providerRaw === 'searxng') {
    if (!endpointOverride) {
      throw new SearchConfigError('searxng 需要设置 OPENWB_SEARCH_ENDPOINT(实例的 /search 地址)')
    }
    return { provider: 'searxng', endpoint: assertEndpoint(endpointOverride) }
  }
  const apiKey = KEY_ENV[providerRaw].map((key) => env[key]?.trim()).find(Boolean)
  if (!apiKey) {
    throw new SearchConfigError(
      `${providerRaw} 缺少 API Key(可设置 ${KEY_ENV[providerRaw].slice(0, -1).join(' 或 ')})`
    )
  }
  return {
    provider: providerRaw,
    apiKey,
    endpoint: assertEndpoint(endpointOverride || DEFAULT_ENDPOINTS[providerRaw])
  }
}

function assertEndpoint(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SearchConfigError(`检索接口地址非法: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SearchConfigError(`检索接口只允许 http/https: ${raw}`)
  }
  if (url.username || url.password) {
    throw new SearchConfigError('检索接口地址不允许携带账号密码')
  }
  return url.href
}

/** true 表示本轮应使用真实检索;显式 offline 永远优先。 */
export function searchMode(env: SearchEnvironment = process.env): 'offline' | 'live' | 'auto' {
  const raw = env.OPENWB_WEB_SEARCH?.trim().toLowerCase() || 'auto'
  if (raw === 'offline') return 'offline'
  if (raw === 'live') return 'live'
  if (raw === 'auto' || raw === '') return 'auto'
  throw new SearchConfigError(`OPENWB_WEB_SEARCH 只支持 auto / live / offline,收到 ${raw}`)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function requiredUrl(value: unknown): string | null {
  const raw = textOf(value)
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export function normalizeHits(items: unknown[], limit: number): SearchHit[] {
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const item of items) {
    const record = asRecord(item)
    if (!record) continue
    const url = requiredUrl(record.url ?? record.link)
    if (!url || seen.has(url)) continue
    seen.add(url)
    hits.push({
      title: textOf(record.title) || new URL(url).hostname,
      url,
      snippet: textOf(record.snippet ?? record.content ?? record.description)
    })
    if (hits.length >= limit) break
  }
  return hits
}

export function parseSearchPayload(provider: SearchProviderId, payload: unknown, limit: number): SearchHit[] {
  const root = asRecord(payload)
  if (!root) throw new Error('检索接口返回的不是 JSON 对象')
  if (provider === 'brave') {
    const web = asRecord(root.web)
    return normalizeHits(asArray(web?.results), limit)
  }
  if (provider === 'serper') return normalizeHits(asArray(root.organic), limit)
  return normalizeHits(asArray(root.results), limit)
}

type FetchLike = typeof fetch

export interface CreateSearchRunnerOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
  maxResponseBytes?: number
}

export function createSearchRunner(
  config: SearchProviderConfig,
  options: CreateSearchRunnerOptions = {}
): SearchRunner {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBytes = options.maxResponseBytes ?? 1_000_000

  return {
    async search(query, limit, signal) {
      const deadline = withDeadline(signal, timeoutMs)
      try {
        const request =
          config.provider === 'brave'
            ? buildBraveRequest(config, query, limit)
            : config.provider === 'serper'
              ? buildSerperRequest(config, query, limit)
              : config.provider === 'tavily'
                ? buildTavilyRequest(config, query, limit)
                : buildSearxngRequest(config, query, limit)
        const response = await doFetch(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body ? { body: request.body } : {}),
          signal: deadline.signal,
          redirect: 'error'
        })
        const body = await readLimitedText(response, maxBytes)
        if (!response.ok) {
          throw new Error(
            `检索接口失败 ${response.status}: ${body.text.replace(/\s+/g, ' ').slice(0, 300)}`
          )
        }
        let payload: unknown
        try {
          payload = JSON.parse(body.text)
        } catch {
          throw new Error('检索接口返回的不是合法 JSON')
        }
        return parseSearchPayload(config.provider, payload, limit)
      } catch (error) {
        if (deadline.parentAborted()) throw new Error('已取消')
        if (deadline.timedOut()) throw new Error('检索超时')
        throw error
      } finally {
        deadline.cleanup()
      }
    }
  }
}

interface SearchRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

const ACCEPT_JSON = 'application/json'

function buildTavilyRequest(config: SearchProviderConfig, query: string, limit: number): SearchRequest {
  return {
    url: config.endpoint,
    method: 'POST',
    headers: { accept: ACCEPT_JSON, 'content-type': ACCEPT_JSON, authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_answer: false })
  }
}

function buildBraveRequest(config: SearchProviderConfig, query: string, limit: number): SearchRequest {
  const url = new URL(config.endpoint)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(limit, 20)))
  url.searchParams.set('text_decorations', 'false')
  return {
    url: url.href,
    method: 'GET',
    headers: { accept: ACCEPT_JSON, 'x-subscription-token': config.apiKey ?? '' }
  }
}

function buildSerperRequest(config: SearchProviderConfig, query: string, limit: number): SearchRequest {
  return {
    url: config.endpoint,
    method: 'POST',
    headers: { accept: ACCEPT_JSON, 'content-type': ACCEPT_JSON, 'x-api-key': config.apiKey ?? '' },
    body: JSON.stringify({ q: query, num: Math.min(limit, 20) })
  }
}

function buildSearxngRequest(config: SearchProviderConfig, query: string, limit: number): SearchRequest {
  const url = new URL(config.endpoint)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('language', 'auto')
  url.searchParams.set('safesearch', '1')
  return { url: url.href, method: 'GET', headers: { accept: ACCEPT_JSON } }
}
