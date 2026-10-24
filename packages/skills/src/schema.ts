import { z } from 'zod'

const ToolListSchema = z.union([
  z.string(),
  z.array(z.string().min(1))
])

const SkillNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,63}$/, '必须是小写字母开头的短横线标识(2-64 字符)')

export const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,63}$/, 'name 必须是小写字母开头的短横线标识(2-64 字符)'),
  description: z.string().min(1, 'description 不能为空').max(200, 'description 不能超过 200 字符'),
  'allowed-tools': ToolListSchema.optional(),
  /** 依赖技能:加载当前技能前,这些技能必须已安装且未关闭。 */
  requires: ToolListSchema.optional(),
  /** 触发域:多个技能声明同一触发域时由宿主提示冲突,或按 priority 路由。 */
  triggers: ToolListSchema.optional(),
  /** 显式优先级,数值越大越优先;同域且同优先级视为无法自动路由。 */
  priority: z.number().int().min(0).max(1000).optional(),
  /** 允许模型执行的脚本文件名(相对技能目录的 scripts/)。 */
  scripts: ToolListSchema.optional(),
  version: z.string().max(32).optional(),
  license: z.string().max(64).optional()
})

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

/** `read_file, grep` 与 `[read_file, grep]` 两种写法都接受 */
export function parseAllowedTools(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const list = Array.isArray(value) ? value : value.split(',')
  const cleaned = list.map((x) => x.trim()).filter((x) => x.length > 0)
  return cleaned.length > 0 ? [...new Set(cleaned)].sort() : undefined
}

/** 技能名列表与工具列表使用同一种书写方式,但顺序保留(依赖先于正文注入)。 */
export function parseSkillList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const list = Array.isArray(value) ? value : value.split(',')
  const cleaned = list.map((x) => x.trim()).filter((x) => x.length > 0)
  return cleaned.length > 0 ? [...new Set(cleaned)] : undefined
}

/**
 * 脚本名只能是 scripts/ 下的一级文件名,不允许路径分隔符、.. 或控制字符。
 * 真正的路径归属与符号链接检查在运行时再做一次。
 */
export function parseScriptNames(value: string | string[] | undefined): string[] | undefined {
  const names = parseSkillList(value)
  if (!names) return undefined
  const invalid = names.find((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
  if (invalid) throw new Error(`scripts 中的文件名非法: ${invalid}`)
  return [...new Set(names)].sort()
}

export function validateSkillName(name: string): string {
  const result = SkillNameSchema.safeParse(name)
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? `技能名非法: ${name}`)
  return result.data
}
