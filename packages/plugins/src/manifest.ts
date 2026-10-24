import { z } from 'zod'

/**
 * 插件清单的权威 schema(IMPLEMENTATION §6.1)。
 * 所有字段都显式声明:未知字段直接拒绝,避免第三方塞入宿主不认识的行为开关。
 */

export const HOST_PROVIDED_VARS = ['PLUGIN_ROOT', 'PLUGIN_DATA'] as const

export const PERMISSIONS = [
  'network',
  'filesystem:plugin-data',
  'filesystem:workspace-read',
  'clipboard',
  'shell'
] as const

export type PluginPermission = (typeof PERMISSIONS)[number]

export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/
/** 工具名必须能被宿主注册表接受:小写字母开头,仅小写字母/数字/下划线 */
export const MCP_TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/

const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'version 必须是 semver(如 1.0.0)')

const EnvRecordSchema = z.record(z.string(), z.string())

export const McpServerSpecSchema = z
  .object({
    type: z.literal('stdio').default('stdio'),
    command: z.string().min(1, 'command 不能为空'),
    args: z.array(z.string()).default([]),
    env: EnvRecordSchema.default({}),
    defer_loading: z.boolean().default(false)
  })
  .strict()

export const CredentialDeclSchema = z
  .object({
    key: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/, '凭据 key 必须是大写字母开头的环境变量名'),
    label: z.string().min(1).max(120),
    required: z.boolean().default(true)
  })
  .strict()

export const HighCreditToolSchema = z
  .object({
    approvalKind: z.enum(['writeExternal', 'charge', 'delete']),
    group: z.string().min(1).max(64)
  })
  .strict()

export const PluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().regex(PLUGIN_NAME_RE, 'name 必须是 2-63 位小写字母/数字/短横线'),
    displayName: z.string().min(1).max(80),
    version: SemverSchema,
    kind: z.enum(['connector', 'expert']),
    publisher: z.string().min(1).max(64).optional(),
    minHostVersion: SemverSchema.default('0.0.0'),
    description: z.string().max(400).optional(),
    mcpServers: z.record(z.string(), McpServerSpecSchema).default({}),
    permissions: z.array(z.string()).default([]),
    credentials: z.array(CredentialDeclSchema).default([]),
    highCreditTools: z.record(z.string(), HighCreditToolSchema).default({}),
    /** 声明了 highCreditTools 却不能延迟加载的工具,见 §6.6 */
    skills: z.array(z.string()).optional(),
    /** 专家角色指令:只有 kind=expert 可用,由运行时注入 system prompt */
    instructions: z.string().max(20_000).optional()
  })
  .strict()

export type PluginManifest = z.infer<typeof PluginManifestSchema>
export type McpServerSpec = z.infer<typeof McpServerSpecSchema>
export type CredentialDecl = z.infer<typeof CredentialDeclSchema>

export class ManifestError extends Error {
  constructor(readonly detail: string) {
    super(`插件清单校验失败: ${detail}`)
    this.name = 'ManifestError'
  }
}

/** 只做结构层面的校验;文件名、目录名、体积等交给 install 校验 */
export function parseManifest(data: unknown): PluginManifest {
  const parsed = PluginManifestSchema.safeParse(data)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new ManifestError(detail)
  }
  return parsed.data
}

/** 语义校验:结构合法但组合不自洽的清单在这里拒绝 */
export function assertManifestCoherent(manifest: PluginManifest): void {
  const unknownPermissions = manifest.permissions.filter(
    (p) => !(PERMISSIONS as readonly string[]).includes(p)
  )
  if (unknownPermissions.length > 0) {
    throw new ManifestError(`未知权限: ${unknownPermissions.join(', ')}`)
  }

  if (manifest.kind === 'connector' && Object.keys(manifest.mcpServers).length === 0) {
    throw new ManifestError('connector 插件必须至少声明一个 mcpServers 条目')
  }
  if (manifest.kind === 'expert' && Object.keys(manifest.mcpServers).length > 0) {
    throw new ManifestError('expert 插件是纯清单,不能声明 mcpServers')
  }
  if (manifest.kind === 'connector' && manifest.instructions !== undefined) {
    throw new ManifestError('connector 插件不能声明 instructions')
  }

  const credentialKeys = new Set(manifest.credentials.map((c) => c.key))
  if (credentialKeys.size !== manifest.credentials.length) {
    throw new ManifestError('credentials 存在重复 key')
  }

  for (const [serverName, spec] of Object.entries(manifest.mcpServers)) {
    if (!PLUGIN_NAME_RE.test(serverName)) {
      throw new ManifestError(`mcpServers 名称不合法: ${serverName}`)
    }
    // 插件声明的 env 只能引用自己声明的凭据或宿主提供的变量
    for (const [envKey, value] of Object.entries(spec.env)) {
      for (const ref of expandRefs(value)) {
        if ((HOST_PROVIDED_VARS as readonly string[]).includes(ref)) continue
        if (!credentialKeys.has(ref)) {
          throw new ManifestError(`${envKey} 引用了未声明的变量: ${ref}`)
        }
      }
    }
    if (spec.defer_loading) {
      for (const toolName of Object.keys(manifest.highCreditTools)) {
        // 该 server 下是否真有这个工具要到运行时才知道;
        // 因此保守处理:声明了 highCreditTools 的插件,任何 server 都不允许延迟加载。
        throw new ManifestError(
          `声明了 highCreditTools(${toolName})的插件不允许 defer_loading(${serverName})`
        )
      }
    }
  }

  for (const toolName of Object.keys(manifest.highCreditTools)) {
    if (!MCP_TOOL_NAME_RE.test(toolName)) {
      throw new ManifestError(`highCreditTools 键不是合法工具名: ${toolName}`)
    }
  }
}

/** `1.0.0` vs `1.0.0` / `1.0.0` vs `1.1.0`,只看主次修订三段,忽略预发布后缀 */
export function compareSemver(a: string, b: string): number {
  const pick = (v: string) => v.split(/[+-]/)[0]!.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const [a1 = 0, a2 = 0, a3 = 0] = pick(a)
  const [b1 = 0, b2 = 0, b3 = 0] = pick(b)
  if (a1 !== b1) return a1 - b1
  if (a2 !== b2) return a2 - b2
  return a3 - b3
}


/** 取出 ${VAR} 形式的引用名;不支持默认值与嵌套 */
export function expandRefs(template: string): string[] {
  const out: string[] = []
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) out.push(m[1]!)
  return out
}
