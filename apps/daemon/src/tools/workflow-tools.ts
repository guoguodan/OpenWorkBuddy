import { z } from 'zod'
import type { AnyToolDescriptor, ToolDescriptor } from '@openwb/tools'
import { extractTitle, htmlToText, plainText } from './web/html.js'
import { assertPublicHttpUrl, isTextualContentType, readLimitedText, withDeadline } from './web/network.js'
import {
  createSearchRunner,
  resolveSearchConfig,
  searchMode,
  type SearchHit,
  type SearchRunner
} from './web/search.js'

export type { SearchHit, SearchRunner } from './web/search.js'

const effectsNet = { writesFilesystem: false, accessesNetwork: true, mayIncurCost: false }

/**
 * 工作流专用工具。
 *
 * 与 builtinTools 分开注册:它们不进模型的模式白名单(web_search 不应
 * 变成普通对话的能力),只在 workflow 引擎按 YAML 显式声明时调用。
 */

const webSearchParams = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional()
})

/**
 * 离线检索器:确定性结果,供 E2E 与无 provider 的环境使用。
 * 它不会被伪装成真实来源——URL 明确指向 example.com,调用方模式也已知是 offline。
 */
export const offlineSearchRunner: SearchRunner = {
  async search(query, limit, signal) {
    if (signal?.aborted) throw new Error('已取消')
    const slug = encodeURIComponent(query.trim()).slice(0, 80)
    const count = Math.min(limit, 3)
    return Array.from({ length: count }, (_, i) => ({
      title: `${query}(离线样例 ${i + 1})`,
      url: `https://example.com/search?q=${slug}&ref=${i + 1}`,
      snippet: `关于「${query}」的第 ${i + 1} 条离线样例摘要。未配置检索 provider 时不代表真实检索结果。`
    }))
  }
}

let injectedRunner: SearchRunner | null = null
let liveRunner: { key: string; runner: SearchRunner } | null = null

/** 测试/宿主 provider 注入点;传 null 恢复按环境变量解析。 */
export function setSearchRunner(next: SearchRunner | null): void {
  injectedRunner = next
}

function configuredRunner(): SearchRunner | null {
  if (injectedRunner) return injectedRunner
  const config = resolveSearchConfig()
  if (!config) return null
  const key = `${config.provider}\u0000${config.endpoint}\u0000${config.apiKey ?? ''}`
  if (liveRunner?.key !== key) liveRunner = { key, runner: createSearchRunner(config) }
  return liveRunner.runner
}

function selectSearchRunner(): SearchRunner {
  const mode = searchMode()
  if (mode === 'offline') return offlineSearchRunner
  const configured = configuredRunner()
  if (configured) return configured
  if (mode === 'live') {
    throw new Error('OPENWB_WEB_SEARCH=live 但未配置检索 provider(见 .env.example)')
  }
  return offlineSearchRunner
}

export const webSearchTool: ToolDescriptor<z.infer<typeof webSearchParams>, string[]> = {
  name: 'web_search',
  description: '检索网页,返回命中的 URL 列表。工作流专用。',
  parameters: webSearchParams,
  effects: effectsNet,
  async execute({ query, limit = 8 }, ctx) {
    const hits = await selectSearchRunner().search(query, limit, ctx.signal)
    return hits.map((hit) => hit.url)
  }
}

const webFetchParams = z.object({
  urls: z.array(z.string().min(1)).max(20)
})

export interface FetchedPage {
  url: string
  title: string
  text: string
  /** 抓取失败时给出原因;成功的页面不带该字段。 */
  error?: string
}

export type FetchMode = 'offline' | 'live' | 'auto'

export function fetchMode(env: NodeJS.ProcessEnv = process.env): FetchMode {
  const raw = env.OPENWB_WEB_FETCH?.trim().toLowerCase() || 'auto'
  if (raw === 'offline' || raw === 'live' || raw === 'auto') return raw
  throw new Error(`OPENWB_WEB_FETCH 只支持 auto / live / offline,收到 ${raw}`)
}

export interface FetchPageOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
  maxChars?: number
  maxRedirects?: number
  /** 仅本地验收使用;生产默认拒绝回环与私网。 */
  allowPrivate?: boolean
}

const FETCH_TIMEOUT_MS = 20_000
const FETCH_MAX_BYTES = 1_000_000
const FETCH_MAX_CHARS = 40_000
const FETCH_MAX_REDIRECTS = 3

/**
 * 抓取单个页面并提取可读正文。
 * 每次重定向都重新走 URL 策略,避免公网域名跳到内网地址。
 */
export async function fetchPage(raw: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const doFetch = options.fetchImpl ?? fetch
  const allowPrivate = options.allowPrivate ?? false
  const maxRedirects = options.maxRedirects ?? FETCH_MAX_REDIRECTS
  let current = await assertPublicHttpUrl(raw, { allowPrivate })
  const deadline = withDeadline(options.signal, options.timeoutMs ?? FETCH_TIMEOUT_MS)
  try {
    for (let hop = 0; ; hop++) {
      const response = await doFetch(current.href, {
        signal: deadline.signal,
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'user-agent': 'OpenWorkBuddy/1.0 (+workflow web_fetch)'
        }
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location) throw new Error(`重定向缺少 Location: ${current.href}`)
        if (hop >= maxRedirects) throw new Error(`重定向次数超过 ${maxRedirects}: ${raw}`)
        current = await assertPublicHttpUrl(new URL(location, current), { allowPrivate })
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`抓取失败 ${response.status}: ${current.href}`)
      }
      const contentType = response.headers.get('content-type')
      if (!isTextualContentType(contentType)) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`不支持的响应类型 ${contentType ?? 'unknown'}: ${current.href}`)
      }
      const body = await readLimitedText(response, options.maxBytes ?? FETCH_MAX_BYTES)
      const maxChars = options.maxChars ?? FETCH_MAX_CHARS
      const isHtml = /html/i.test(body.contentType ?? '')
      const title = isHtml ? extractTitle(body.text) : ''
      const text = isHtml ? htmlToText(body.text, maxChars) : plainText(body.text, maxChars)
      return {
        url: current.href,
        title: title || current.hostname,
        text
      }
    }
  } catch (error) {
    if (deadline.parentAborted()) throw new Error('已取消')
    if (deadline.timedOut()) throw new Error(`抓取超时: ${current.href}`)
    throw error
  } finally {
    deadline.cleanup()
  }
}

/**
 * web_fetch 只允许 http/https。默认 auto:mock 环境离线,其余真实抓取;
 * OPENWB_WEB_FETCH=offline / live 可显式覆盖。
 */
export const webFetchTool: ToolDescriptor<z.infer<typeof webFetchParams>, FetchedPage[]> = {
  name: 'web_fetch',
  description: '抓取网页并提取标题与正文。工作流专用;只接受 http/https URL。',
  parameters: webFetchParams,
  effects: effectsNet,
  async execute({ urls }, ctx) {
    const configuredMode = fetchMode()
    const mock = process.env.OPENWB_MOCK === '1'
    const live = configuredMode === 'live' || (configuredMode === 'auto' && !mock)
    const allowPrivate = process.env.OPENWB_WEB_FETCH_ALLOW_PRIVATE === '1'
    const pages: FetchedPage[] = []
    let failures = 0
    for (const raw of urls) {
      if (ctx.signal?.aborted) throw new Error('已取消')
      if (!live) {
        const parsed = await assertPublicHttpUrl(raw, { allowPrivate })
        pages.push({
          url: parsed.href,
          title: parsed.hostname,
          text: `离线抓取占位:${parsed.href}(设置 OPENWB_WEB_FETCH=live 可抓取真实正文)`
        })
        continue
      }
      try {
        pages.push(await fetchPage(raw, { ...(ctx.signal ? { signal: ctx.signal } : {}), allowPrivate }))
      } catch (error) {
        if (ctx.signal?.aborted || (error as Error).message === '已取消') throw error
        failures++
        pages.push({ url: raw, title: '', text: '', error: (error as Error).message })
      }
    }
    if (pages.length > 0 && failures === pages.length) {
      throw new Error(`全部页面抓取失败: ${pages[0]?.error ?? 'unknown'}`)
    }
    return pages
  }
}

/**
 * 验收用 sleep 工具:中断测试需要一个可以长时间阻塞的真实工具。
 * 只在工作流工具集里存在,不暴露给对话模型。
 */
export const sleepTool: ToolDescriptor<{ ms: number }, string> = {
  name: 'sleep',
  description: '等待指定毫秒。仅用于验证取消链路。',
  parameters: z.object({ ms: z.number().int().min(1).max(60_000) }),
  effects: { writesFilesystem: false, accessesNetwork: false, mayIncurCost: false },
  async execute({ ms }, ctx) {
    await new Promise<void>((resolve, reject) => {
      if (ctx.signal?.aborted) {
        reject(new Error('已取消'))
        return
      }
      const timer = setTimeout(() => {
        ctx.signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('已取消'))
      }
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
    })
    return `slept ${ms}ms`
  }
}

/** 列出工作流可用的工具描述(供 YAML 校验与 UI 展示) */
export function workflowTools(): AnyToolDescriptor[] {
  return [webSearchTool, webFetchTool, sleepTool]
}
