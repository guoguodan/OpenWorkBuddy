import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createOpenAI } from '@ai-sdk/openai'

function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.OPENWB_ENV_FILE,
    resolve(process.cwd(), '.env'),
    resolve(here, '../../../.env'),
    resolve(here, '../../.env')
  ]
  for (const path of candidates) {
    if (path && existsSync(path)) {
      config({ path })
      return
    }
  }
}

loadEnv()

const provider = createOpenAI({
  ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {})
})

export const DEFAULT_MODEL_NAME = process.env.OPENWB_MODEL ?? 'gpt-4o-mini'

/** 网关 /v1/models 返回的最小形状;其余字段与本功能无关,不做假设。 */
interface ModelListResponse {
  data?: Array<{ id?: unknown }>
}

export interface RemoteModelList {
  models: string[]
  /** true 表示清单来自网关;false 表示网络不可用或网关不支持,界面需如实标注。 */
  remote: boolean
  error?: string
}

const MODELS_TIMEOUT_MS = 8000

/**
 * 读取当前网关真实提供的模型。
 *
 * 模型候选必须是"这个网关能用的",而不是写死的几个名字:
 * 用户换一个兼容网关后,硬编码候选只会让请求必然失败。
 * 网络失败不能阻断聊天,因此这里只返回空清单 + 原因,由界面回退到自定义输入。
 */
export async function listRemoteModels(signal?: AbortSignal): Promise<RemoteModelList> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
    const key = process.env.OPENAI_API_KEY
    const response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {})
      },
      signal: controller.signal
    })
    if (!response.ok) {
      return { models: [], remote: false, error: `网关返回 ${response.status}` }
    }
    const body = (await response.json()) as ModelListResponse
    const models = Array.from(
      new Set(
        (body.data ?? [])
          .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
          .filter((id) => id.length > 0)
      )
    ).sort((a, b) => a.localeCompare(b))
    if (models.length === 0) {
      return { models: [], remote: false, error: '网关未返回可用模型' }
    }
    return { models, remote: true }
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? '读取模型清单超时' : (err as Error).message
    return { models: [], remote: false, error: message }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 解析本轮实际使用的模型。
 *
 * 工作区设置里的模型是用户显式选择,优先级高于环境变量;
 * 但空值必须回落到默认模型,不能让"未配置"把请求发给一个空模型名。
 * 同一个 daemon 进程会被多个请求复用,因此模型实例按名称缓存。
 */
const models = new Map<string, ReturnType<typeof provider>>()

export type ReasoningEffort = 'low' | 'medium' | 'high'

export function resolveModelName(selected?: string | null): string {
  const name = selected?.trim()
  return name ? name : DEFAULT_MODEL_NAME
}

export function modelFor(selected?: string | null) {
  const name = resolveModelName(selected)
  const cached = models.get(name)
  if (cached) return cached
  const created = provider(name)
  models.set(name, created)
  return created
}

/**
 * 带思考强度的模型实例。
 *
 * 档位是请求级参数,不能写进 provider 的全局配置,否则同一进程里
 * 一次切档会污染其他会话。缓存键包含档位,避免"高"的实例复用给"低"。
 * 未指定档位时沿用 modelFor,保持与原行为一致。
 */
const effortModels = new Map<string, ReturnType<typeof provider>>()

export function modelForEffort(
  selected: string | null | undefined,
  effort: ReasoningEffort | null | undefined
) {
  if (!effort) return modelFor(selected)
  const name = resolveModelName(selected)
  const key = `${name}::${effort}`
  const cached = effortModels.get(key)
  if (cached) return cached
  const created = provider(name, { reasoningEffort: effort })
  effortModels.set(key, created)
  return created
}

export const model = modelFor(null)
