import { readdir, readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  formatZodIssues,
  workflowSchema,
  WorkflowValidationError,
  type WorkflowManifest
} from './manifest.js'

export interface WorkflowSource {
  path: string
  scope: 'builtin' | 'user' | 'project'
}

export interface LoadedWorkflow {
  manifest: WorkflowManifest
  source: WorkflowSource
}

export interface WorkflowIssue {
  path: string
  reason: string
}

export interface LoadWorkflowsResult {
  workflows: Map<string, LoadedWorkflow>
  issues: WorkflowIssue[]
}

export interface WorkflowDirs {
  builtin: string
  user?: string
  project?: string
}

const SCOPE_ORDER: ReadonlyArray<'builtin' | 'user' | 'project'> = ['builtin', 'user', 'project']

async function listYamlFiles(dir: string | undefined): Promise<string[]> {
  if (!dir) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw err
  }
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => resolve(dir, entry.name))
    .sort()
}

function parseManifest(text: string, path: string): WorkflowManifest {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    throw new WorkflowValidationError(path, `YAML 解析失败: ${(err as Error).message}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowValidationError(path, '根节点必须是对象')
  }
  const result = workflowSchema.safeParse(raw)
  if (!result.success) throw new WorkflowValidationError(path, formatZodIssues(result.error))
  const fileId = basename(path).replace(/\.ya?ml$/i, '')
  if (fileId !== result.data.id) {
    throw new WorkflowValidationError(path, `文件名 ${fileId} 必须与 id ${result.data.id} 一致,便于定位`)
  }
  return result.data
}

/**
 * 三级目录合并:内置 → 用户 → 项目,同名后者覆盖前者。
 * 单个文件损坏只记 issue,不阻断其他工作流加载;显式 run 时再抛错。
 */
export async function loadWorkflows(dirs: WorkflowDirs): Promise<LoadWorkflowsResult> {
  const workflows = new Map<string, LoadedWorkflow>()
  const issues: WorkflowIssue[] = []

  for (const scope of SCOPE_ORDER) {
    const dir = dirs[scope]
    for (const path of await listYamlFiles(dir)) {
      try {
        const manifest = parseManifest(await readFile(path, 'utf8'), path)
        workflows.set(manifest.id, { manifest, source: { path, scope } })
      } catch (err) {
        issues.push({ path, reason: (err as Error).message })
      }
    }
  }
  return { workflows, issues }
}

export async function loadWorkflow(dirs: WorkflowDirs, id: string): Promise<LoadedWorkflow> {
  const result = await loadWorkflows(dirs)
  const found = result.workflows.get(id)
  if (found) return found
  const related = result.issues.filter((issue) => basename(issue.path).startsWith(`${id}.`))
  if (related.length > 0) {
    throw new Error(related.map((issue) => issue.reason).join('; '))
  }
  throw new Error(`工作流不存在: ${id}。可用: ${[...result.workflows.keys()].join(', ') || '(无)'}`)
}
