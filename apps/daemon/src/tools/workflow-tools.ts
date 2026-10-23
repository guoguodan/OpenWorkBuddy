import { z } from 'zod'
import type { AnyToolDescriptor, ToolDescriptor } from '@openwb/tools'

const effectsNet = { writesFilesystem: false, accessesNetwork: true, mayIncurCost: false }

/**
 * 工作流专用工具。
 *
 * 与 builtinTools 分开注册:它们不进模型的模式白名单(web_search 不应
 * 变成普通对话的能力),只在 workflow 引擎按 YAML 显式声明时调用。
 * 这样 P2 的模式边界测试(tools.available 精确列表)完全不受影响。
 */

const webSearchParams = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional()
})

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface SearchRunner {
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]>
}

/**
 * 默认检索器:离线可用、结果确定。
 * 真实联网检索需要 provider 凭据与配额,首期不在 P6 范围;留一个可注入接口,
 * 上线时替换实现即可,YAML 契约不变。
 */
export const offlineSearchRunner: SearchRunner = {
  async search(query, limit, signal) {
    if (signal?.aborted) throw new Error('已取消')
    const slug = encodeURIComponent(query.trim()).slice(0, 80)
    const count = Math.min(limit, 3)
    return Array.from({ length: count }, (_, i) => ({
      title: `${query}(来源 ${i + 1})`,
      url: `https://example.com/search?q=${slug}&ref=${i + 1}`,
      snippet: `关于「${query}」的第 ${i + 1} 条检索摘要。当前为离线检索占位实现,P6 只验证工作流编排与来源落盘。`
    }))
  }
}

let runner: SearchRunner = offlineSearchRunner

/** 测试/未来 provider 注入点 */
export function setSearchRunner(next: SearchRunner): void {
  runner = next
}

export const webSearchTool: ToolDescriptor<z.infer<typeof webSearchParams>, string[]> = {
  name: 'web_search',
  description: '检索网页,返回命中的 URL 列表。工作流专用。',
  parameters: webSearchParams,
  effects: effectsNet,
  async execute({ query, limit = 8 }, ctx) {
    const hits = await runner.search(query, limit, ctx.signal)
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
}

/**
 * web_fetch 只允许 http/https;离线模式下不真的发请求,返回占位正文。
 * OPENWB_WEB_FETCH=live 时走全局 fetch(P6 验收默认离线)。
 */
export const webFetchTool: ToolDescriptor<z.infer<typeof webFetchParams>, FetchedPage[]> = {
  name: 'web_fetch',
  description: '抓取网页正文。工作流专用;只接受 http/https URL。',
  parameters: webFetchParams,
  effects: effectsNet,
  async execute({ urls }, ctx) {
    const live = process.env.OPENWB_WEB_FETCH === 'live'
    const pages: FetchedPage[] = []
    for (const raw of urls) {
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        throw new Error(`非法 URL: ${raw}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`只允许 http/https: ${raw}`)
      }
      if (ctx.signal?.aborted) throw new Error('已取消')
      if (!live) {
        pages.push({ url: raw, title: parsed.hostname, text: `离线抓取占位:${raw}` })
        continue
      }
      const res = await fetch(raw, ctx.signal ? { signal: ctx.signal } : {})
      if (!res.ok) throw new Error(`抓取失败 ${res.status}: ${raw}`)
      const body = await res.text()
      pages.push({ url: raw, title: parsed.hostname, text: body.slice(0, 100_000) })
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
