import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { parseFrontmatter, FrontmatterError } from './frontmatter.js'
import { parseAllowedTools, SkillFrontmatterSchema, type SkillFrontmatter } from './schema.js'

export type SkillScope = 'user' | 'project'

export interface SkillRoot {
  path: string
  scope: SkillScope
}

export interface SkillIndexEntry {
  name: string
  description: string
  /** SKILL.md 绝对路径 */
  path: string
  /** 技能目录绝对路径 */
  dir: string
  scope: SkillScope
}

export interface SkillManifest extends SkillIndexEntry {
  body: string
  /** 未声明时为 undefined,表示"不额外收窄" */
  allowedTools?: string[]
  version?: string
}

export interface SkillIssue {
  /** 出问题的路径;根目录不可读时是根目录本身 */
  path: string
  reason: string
}

export interface DiscoverResult {
  entries: SkillIndexEntry[]
  issues: SkillIssue[]
}

export const MAX_SKILL_BYTES = 5 * 1024 * 1024
const MAX_FILES = 1000

const CREDENTIAL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{3,}/ },
  { label: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{12,}\b/ },
  { label: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { label: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/ },
  { label: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
]

export class SkillError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string
  ) {
    super(`技能校验失败 ${path}: ${detail}`)
    this.name = 'SkillError'
  }
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

async function readSkillFile(mdPath: string): Promise<{ fm: SkillFrontmatter; body: string }> {
  let raw: string
  try {
    raw = await readFile(mdPath, 'utf8')
  } catch {
    throw new SkillError(mdPath, 'SKILL.md 不存在或不可读')
  }

  let parsed: { frontmatter: unknown; body: string }
  try {
    parsed = parseFrontmatter(raw)
  } catch (err) {
    if (err instanceof FrontmatterError) throw new SkillError(mdPath, err.message)
    throw err
  }

  const result = SkillFrontmatterSchema.safeParse(parsed.frontmatter)
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new SkillError(mdPath, detail)
  }

  const dirName = basename(dirname(mdPath))
  if (result.data.name !== dirName) {
    throw new SkillError(mdPath, `name (${result.data.name}) 与目录名 (${dirName}) 不一致`)
  }
  if (parsed.body.trim().length === 0) {
    throw new SkillError(mdPath, '正文为空')
  }
  return { fm: result.data, body: parsed.body.trim() }
}

/**
 * 扫描技能目录:拒绝符号链接、限制文件数与总字节数、扫描明文凭据。
 * 只读,不跟随链接——技能目录来自用户或第三方下载,必须当作不可信输入。
 */
export async function scanSkillDir(dir: string): Promise<void> {
  let totalBytes = 0
  let fileCount = 0
  const queue: string[] = [dir]

  while (queue.length > 0) {
    const current = queue.shift()!
    let items
    try {
      items = await readdir(current, { withFileTypes: true })
    } catch {
      throw new SkillError(current, '目录不可读')
    }

    for (const item of items) {
      const full = join(current, item.name)
      if (item.isSymbolicLink()) throw new SkillError(full, '技能目录不允许包含符号链接')
      if (item.isDirectory()) {
        queue.push(full)
        continue
      }
      if (!item.isFile()) throw new SkillError(full, '只允许普通文件与目录')

      fileCount++
      if (fileCount > MAX_FILES) throw new SkillError(dir, `文件数超过上限 ${MAX_FILES}`)

      const info = await stat(full)
      totalBytes += info.size
      if (totalBytes > MAX_SKILL_BYTES) {
        throw new SkillError(dir, `总大小超过上限 ${MAX_SKILL_BYTES} 字节`)
      }

      const rel = toPosix(relative(dir, full))
      if (!/\.(md|txt|json|ya?ml|js|mjs|cjs|ts|py|sh|ps1|bat|cmd)$/i.test(rel)) continue

      let text: string
      try {
        text = await readFile(full, 'utf8')
      } catch {
        continue
      }
      for (const rule of CREDENTIAL_PATTERNS) {
        if (rule.re.test(text)) throw new SkillError(full, `疑似包含明文凭据(${rule.label})`)
      }
    }
  }
}

/**
 * 发现技能:每个根目录下的一级子目录若含 SKILL.md 即视为技能。
 * 同名时 project 覆盖 user;单个坏技能只记 issue,不阻断其它技能。
 */
export async function discoverSkills(roots: SkillRoot[]): Promise<DiscoverResult> {
  const found = new Map<string, SkillIndexEntry>()
  const issues: SkillIssue[] = []

  for (const root of roots) {
    let items
    try {
      items = await readdir(root.path, { withFileTypes: true })
    } catch {
      issues.push({ path: root.path, reason: '技能根目录不存在或不可读' })
      continue
    }

    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!item.isDirectory()) continue
      const dir = join(root.path, item.name)
      const mdPath = join(dir, 'SKILL.md')
      try {
        // 索引阶段也做一次完整扫描:被污染的技能不应出现在模型可见的索引里
        await scanSkillDir(dir)
        const { fm } = await readSkillFile(mdPath)
        const entry: SkillIndexEntry = {
          name: fm.name,
          description: fm.description,
          path: mdPath,
          dir,
          scope: root.scope
        }
        const existing = found.get(entry.name)
        if (existing && existing.scope === 'project' && entry.scope === 'user') continue
        found.set(entry.name, entry)
      } catch (err) {
        issues.push({ path: mdPath, reason: (err as Error).message })
      }
    }
  }

  const entries = [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { entries, issues }
}

/** 读取正文并按需收窄工具;调用前应已通过 discover 校验 */
export async function loadSkill(entry: SkillIndexEntry): Promise<SkillManifest> {
  const { fm, body } = await readSkillFile(entry.path)
  const allowedTools = parseAllowedTools(fm['allowed-tools'])
  return {
    ...entry,
    body,
    ...(allowedTools ? { allowedTools } : {}),
    ...(fm.version ? { version: fm.version } : {})
  }
}

/**
 * 本轮实际可用工具 = 模式允许 ∩ 技能声明。
 * 技能未声明 allowed-tools 时不额外收窄;声明了就只会更少,绝不会更多。
 */
export function narrowTools(modeAllowed: string[], skillAllowed?: string[]): string[] {
  if (!skillAllowed) return [...modeAllowed]
  const set = new Set(modeAllowed)
  return skillAllowed.filter((name) => set.has(name)).sort()
}

export async function validateSkillDir(dir: string): Promise<SkillManifest> {
  await scanSkillDir(dir)
  const mdPath = join(dir, 'SKILL.md')
  const { fm, body } = await readSkillFile(mdPath)
  const allowedTools = parseAllowedTools(fm['allowed-tools'])
  return {
    name: fm.name,
    description: fm.description,
    path: mdPath,
    dir,
    scope: 'project',
    body,
    ...(allowedTools ? { allowedTools } : {}),
    ...(fm.version ? { version: fm.version } : {})
  }
}
