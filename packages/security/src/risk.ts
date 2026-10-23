import { createHash } from 'node:crypto'
import { normalizePathForCompare, resolveTargetPath, type PathCategory } from './paths.js'

export type RiskKind =
  | 'billing'
  | 'destructive'
  | 'high-risk'
  | 'blocked-command'
  | 'personal-file'
  | 'system-path'
  | 'unknown'

export type ApprovalKind = 'writeExternal' | 'charge' | 'delete'

export interface ManifestToolRisk {
  approvalKind: ApprovalKind
  group: string
}

export interface BuiltinRisk {
  kind: 'high-risk' | 'blocked-command'
  groupKey: string
  title: string
  detail: string
  code?: string
}

export interface RiskAssessment {
  kind: RiskKind
  /** 审批记忆的组粒度键;禁止跨组复用到"所有工具" */
  groupKey: string
  title: string
  detail: string
  approvalKind?: ApprovalKind
  /** 风险来自清单读取/解析失败或路径分类异常时,UI 退化为通用审批卡 */
  gateError?: boolean
  path?: string
  pathCategory?: PathCategory
  /** 该风险允许的授权范围;删除/移动只允许 once,避免把一次确认变成长期免审 */
  scopes?: Array<'once' | 'session' | 'always'>
  /** 破坏性文件工具涉及的完整目标清单,用于生成精确的授权组 */
  targets?: string[]
  code?: string
}

export interface ToolCallView {
  name: string
  arguments: Record<string, unknown>
  effects?: { writesFilesystem?: boolean }
}

const PLUGIN_TOOL_RE = /^([a-z0-9][a-z0-9-]*)__([a-z][a-z0-9_]*)$/

export function pluginNameFromTool(name: string): string | null {
  const m = PLUGIN_TOOL_RE.exec(name)
  return m?.[1] ?? null
}

export function originalToolName(name: string): string | null {
  const m = PLUGIN_TOOL_RE.exec(name)
  return m?.[2] ?? null
}

export function riskFromApprovalKind(
  approvalKind: ApprovalKind,
  group: string,
  pluginName: string
): RiskAssessment {
  const groupKey = `plugin:${pluginName}:${group}`
  if (approvalKind === 'charge') {
    return {
      kind: 'billing',
      groupKey,
      title: '该操作可能产生费用',
      detail: '插件声明此工具会消耗额度或触发外部计费。',
      approvalKind
    }
  }
  if (approvalKind === 'delete') {
    return {
      kind: 'destructive',
      groupKey,
      title: '该操作会删除数据',
      detail: '插件声明此工具具有删除语义,执行前需要确认。',
      approvalKind
    }
  }
  return {
    kind: 'high-risk',
    groupKey,
    title: '该操作会写入外部数据',
    detail: '插件声明此工具会修改插件之外的数据。',
    approvalKind
  }
}

const PATH_KEYS = [
  'path',
  'paths',
  'file',
  'filePath',
  'filepath',
  'target',
  'targetPath',
  'destination',
  'source',
  'from',
  'to'
]

const FILE_DESTRUCTIVE_TOOLS = new Set(['delete_files', 'move_files'])

function collectPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectPaths(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PATH_KEYS.includes(key) && typeof item === 'string' && item.length > 0) {
      out.push(item)
      continue
    }
    if (PATH_KEYS.includes(key) && Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === 'string' && entry.length > 0) out.push(entry)
      }
      continue
    }
    if (typeof item === 'object') collectPaths(item, out, depth + 1)
  }
}

export interface ClassifyRiskDeps {
  workspaceRoot: string
  /** 插件清单解析:读不到/解析失败必须抛错;成功但未声明返回 null */
  resolveManifestTool: (pluginName: string, toolName: string) => Promise<ManifestToolRisk | null>
  classifyPath: (target: string, workspaceRoot: string) => PathCategory
  builtinRisk?: (call: ToolCallView) => BuiltinRisk | null
}

/**
 * 判定顺序(IMPLEMENTATION §9.1):插件声明风险最优先,其次是内置高危命令,
 * 最后是路径风险。任何一个判定抛异常都收敛为 unknown/ask,绝不回落成 allow。
 */
export async function classifyRisk(call: ToolCallView, deps: ClassifyRiskDeps): Promise<RiskAssessment | null> {
  const plugin = pluginNameFromTool(call.name)
  if (plugin) {
    const original = originalToolName(call.name)
    if (!original) {
      return {
        kind: 'unknown',
        groupKey: `plugin:${plugin}:unknown`,
        title: '无法识别的插件工具',
        detail: '工具名不符合 <plugin>__<tool> 规范,按未知风险处理。',
        gateError: true
      }
    }
    try {
      const declared = await deps.resolveManifestTool(plugin, original)
      if (declared) return riskFromApprovalKind(declared.approvalKind, declared.group, plugin)
    } catch (err) {
      return {
        kind: 'unknown',
        groupKey: `plugin:${plugin}:unknown`,
        title: '插件风险声明不可用',
        detail: `无法读取或解析插件清单,按未知风险处理: ${(err as Error).message}`,
        gateError: true
      }
    }
  }

  const builtin = deps.builtinRisk?.(call) ?? null
  if (builtin) {
    return {
      kind: builtin.kind,
      groupKey: builtin.groupKey,
      title: builtin.title,
      detail: builtin.detail,
      ...(builtin.code ? { code: builtin.code } : {})
    }
  }

  const writes = call.effects?.writesFilesystem === true
  if (!writes) return null

  const paths: string[] = []
  collectPaths(call.arguments, paths)

  // 删除/移动是显式的破坏性工具:即使目标在工作区内也要确认,且只允许本次授权。
  // 组键包含完整目标,否则"对 A 文件始终允许"会变成"以后任意文件都能删"。
  if (FILE_DESTRUCTIVE_TOOLS.has(call.name)) {
    if (paths.length === 0) {
      return {
        kind: 'unknown',
        groupKey: `builtin:${call.name}:empty`,
        title: '破坏性操作缺少目标',
        detail: '没有可确认的文件清单,按未知风险处理。',
        gateError: true
      }
    }
    const resolved: string[] = []
    for (const target of paths) {
      try {
        const abs = resolveTargetPath(target, deps.workspaceRoot)
        const category = deps.classifyPath(abs, deps.workspaceRoot)
        if (category === 'system') {
          return {
            kind: 'system-path',
            groupKey: 'path:system',
            title: '禁止操作系统目录',
            detail: `路径位于受保护的系统目录: ${abs}`,
            path: abs,
            pathCategory: category
          }
        }
        resolved.push(normalizePathForCompare(abs))
      } catch (err) {
        return {
          kind: 'unknown',
          groupKey: 'path:unknown',
          title: '无法判定文件位置',
          detail: `路径分类异常,按未知风险处理: ${(err as Error).message}`,
          gateError: true,
          path: target
        }
      }
    }
    const digest = createHash('sha256').update([...resolved].sort().join('\u0000')).digest('hex').slice(0, 16)
    return {
      kind: 'destructive',
      groupKey: `builtin:${call.name}:${digest}`,
      title: call.name === 'delete_files' ? '要删除这些文件' : '要移动这些文件',
      detail: `${call.name === 'delete_files' ? '删除' : '移动'}前会先备份,删除会送入系统回收站。共 ${resolved.length} 项,单批上限 10 项。`,
      scopes: ['once'],
      targets: resolved
    }
  }

  for (const target of paths) {
    let category: PathCategory
    try {
      category = deps.classifyPath(target, deps.workspaceRoot)
    } catch (err) {
      return {
        kind: 'unknown',
        groupKey: 'path:unknown',
        title: '无法判定文件位置',
        detail: `路径分类异常,按未知风险处理: ${(err as Error).message}`,
        gateError: true,
        path: target
      }
    }
    if (category === 'system') {
      return {
        kind: 'system-path',
        groupKey: 'path:system',
        title: '禁止操作系统目录',
        detail: `路径位于受保护的系统目录: ${target}`,
        path: target,
        pathCategory: category
      }
    }
    if (category === 'personal' || category === 'other') {
      const abs = resolveTargetPath(target, deps.workspaceRoot)
      return {
        kind: 'personal-file',
        // 授权必须精确到目标路径:个人目录是一个集合,不是一次同意的单位。
        groupKey: `path:${category}:${normalizePathForCompare(abs)}`,
        title: category === 'personal' ? '要修改你的个人文件' : '要修改工作区之外的文件',
        detail: `目标不在工作区内,执行前需要确认: ${abs}`,
        path: abs,
        pathCategory: category
      }
    }
  }
  return null
}
