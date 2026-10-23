import { z } from 'zod'

const ID_RE = /^[a-z][a-z0-9-]{1,62}$/

export const workflowIdSchema = z.string().regex(ID_RE, 'id 必须匹配 ^[a-z][a-z0-9-]{1,62}$')

export const retrySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(5).default(1),
    backoffMs: z.number().int().min(0).max(60_000).default(500)
  })
  .strict()

const jsonSchemaLike = z.record(z.string(), z.unknown())

export const stepSchema = z
  .object({
    id: workflowIdSchema,
    type: z.enum(['prompt', 'tool']),
    title: z.string().max(200).optional(),
    prompt: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    save_as: workflowIdSchema.optional(),
    output: z.enum(['text', 'json', 'markdown']).default('text'),
    schema: jsonSchemaLike.optional(),
    retry: retrySchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === 'prompt' && !value.prompt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'prompt step 必须提供 prompt', path: ['prompt'] })
    }
    if (value.type === 'tool' && !value.tool) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool step 必须提供 tool', path: ['tool'] })
    }
    if (value.output === 'json' && !value.schema) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'output=json 的 step 必须提供 schema', path: ['schema'] })
    }
  })

export const phaseSchema = z
  .object({
    id: workflowIdSchema,
    title: z.string().max(200).optional(),
    parallel: z.boolean().default(false),
    fanout: z.string().min(1).optional(),
    steps: z.array(stepSchema).min(1).max(32)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.fanout && !/^\{\{.*\}\}$/s.test(value.fanout.trim())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fanout 只接受 {{...}} 表达式', path: ['fanout'] })
    }
  })

export const workflowSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: workflowIdSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(''),
    mode: z.string().min(1).default('craft'),
    limits: z
      .object({
        maxDurationSec: z.number().int().min(1).max(3600).default(900),
        maxModelCalls: z.number().int().min(1).max(500).default(40)
      })
      .strict()
      .default({}),
    inputs: z
      .array(
        z
          .object({
            name: workflowIdSchema,
            required: z.boolean().default(false),
            description: z.string().max(500).default(''),
            default: z.unknown().optional()
          })
          .strict()
      )
      .max(32)
      .default([]),
    outputs: z
      .array(
        z
          .object({
            name: workflowIdSchema,
            kind: z.enum(['file', 'text']).default('file'),
            path: z.string().min(1).optional()
          })
          .strict()
          .superRefine((value, ctx) => {
            if (value.kind === 'file' && !value.path) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'file 输出必须提供 path', path: ['path'] })
            }
          })
      )
      .max(16)
      .default([]),
    phases: z.array(phaseSchema).min(1).max(32)
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>()
    for (const phase of value.phases) {
      if (ids.has(phase.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `phase id 重复: ${phase.id}`, path: ['phases'] })
      }
      ids.add(phase.id)
      const stepIds = new Set<string>()
      for (const step of phase.steps) {
        if (stepIds.has(step.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `phase ${phase.id} 内 step id 重复: ${step.id}`,
            path: ['phases']
          })
        }
        stepIds.add(step.id)
      }
    }
    for (const input of value.inputs) {
      if (input.required && input.default !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `必填输入不应有 default: ${input.name}`, path: ['inputs'] })
      }
    }
  })

export type WorkflowManifest = z.infer<typeof workflowSchema>
export type WorkflowPhase = z.infer<typeof phaseSchema>
export type WorkflowStep = z.infer<typeof stepSchema>
export type StepRetry = z.infer<typeof retrySchema>

export class WorkflowValidationError extends Error {
  constructor(
    readonly file: string,
    message: string
  ) {
    super(`${file}: ${message}`)
    this.name = 'WorkflowValidationError'
  }
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}
