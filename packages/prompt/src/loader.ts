import { readdir, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ModePolicySchema, type ModePolicy } from './policy.js'

export class PolicyLoadError extends Error {
  constructor(
    readonly file: string,
    readonly detail: string
  ) {
    super(`模式策略加载失败 ${file}: ${detail}`)
    this.name = 'PolicyLoadError'
  }
}

export async function loadMode(dir: string, file: string): Promise<ModePolicy> {
  const full = join(dir, file)
  let raw: string
  try {
    raw = await readFile(full, 'utf8')
  } catch {
    throw new PolicyLoadError(file, '文件不存在或不可读')
  }

  let data: unknown
  try {
    data = parseYaml(raw)
  } catch (err) {
    throw new PolicyLoadError(file, `YAML 语法错误: ${(err as Error).message}`)
  }

  const parsed = ModePolicySchema.safeParse(data)
  if (!parsed.success) {
    const field = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new PolicyLoadError(file, field)
  }

  const expectedId = basename(file, '.yaml')
  if (parsed.data.id !== expectedId) {
    throw new PolicyLoadError(file, `id (${parsed.data.id}) 与文件名 (${expectedId}) 不一致`)
  }
  return parsed.data
}

export async function loadModes(dir: string): Promise<Map<string, ModePolicy>> {
  let entries: string[]
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort()
  } catch {
    throw new PolicyLoadError(dir, '模式目录不存在')
  }
  if (entries.length === 0) throw new PolicyLoadError(dir, '模式目录为空')

  const modes = new Map<string, ModePolicy>()
  for (const file of entries) {
    const mode = await loadMode(dir, file)
    if (modes.has(mode.id)) throw new PolicyLoadError(file, `模式 id 重复: ${mode.id}`)
    modes.set(mode.id, mode)
  }
  return modes
}

export const REQUIRED_MODES = ['craft', 'plan', 'ask', 'expert', 'quick'] as const

export function assertRequiredModes(modes: Map<string, ModePolicy>): void {
  const missing = REQUIRED_MODES.filter((id) => !modes.has(id))
  if (missing.length > 0) throw new PolicyLoadError('<modes>', `缺少必需模式: ${missing.join(', ')}`)
}
