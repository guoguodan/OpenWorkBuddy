import { z } from 'zod'

export const ToolPolicySchema = z.object({
  allow: z.array(z.string().min(1)),
  deny: z.array(z.string().min(1)).default([]),
  defer: z.array(z.string().min(1)).default([])
})

export const ModePolicySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'id 必须是小写字母开头的短横线标识'),
  displayName: z.string().min(1).max(32),
  description: z.string().min(1).max(200),
  toolPolicy: ToolPolicySchema,
  promptFragments: z.array(z.string().min(1)).min(1)
})

export type ModePolicy = z.infer<typeof ModePolicySchema>
export type ToolPolicy = z.infer<typeof ToolPolicySchema>

export function isToolAllowed(policy: ModePolicy, tool: string): boolean {
  const { allow, deny } = policy.toolPolicy
  if (deny.includes('*') || deny.includes(tool)) return false
  return allow.includes('*') || allow.includes(tool)
}

export function visibleTools(policy: ModePolicy, all: string[]): string[] {
  return all.filter((name) => isToolAllowed(policy, name))
}
