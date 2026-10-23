import { z } from 'zod'

const ToolListSchema = z.union([
  z.string(),
  z.array(z.string().min(1))
])

export const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,63}$/, 'name 必须是小写字母开头的短横线标识(2-64 字符)'),
  description: z.string().min(1, 'description 不能为空').max(200, 'description 不能超过 200 字符'),
  'allowed-tools': ToolListSchema.optional(),
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