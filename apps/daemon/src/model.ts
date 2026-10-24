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

/**
 * 解析本轮实际使用的模型。
 *
 * 工作区设置里的模型是用户显式选择,优先级高于环境变量;
 * 但空值必须回落到默认模型,不能让"未配置"把请求发给一个空模型名。
 * 同一个 daemon 进程会被多个请求复用,因此模型实例按名称缓存。
 */
const models = new Map<string, ReturnType<typeof provider>>()

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

export const model = modelFor(null)
