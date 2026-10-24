import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WorkflowManifest } from './manifest.js'

/** 一次 run 的磁盘布局: .openwb/runs/<runId>/{run.json,<phase>.json} */
export interface RunRecord {
  runId: string
  workflowId: string
  /** 发起运行的会话;UI 可据此跳回任务 */
  conversationId?: string
  inputs: Record<string, unknown>
  status: 'running' | 'done' | 'failed' | 'interrupted'
  createdAt: string
  updatedAt: string
  completedPhases: string[]
  currentPhase?: string
  errorCode?: string
  errorMessage?: string
  /** mock / 真实模型都计数,续跑验收靠它证明上游 phase 未被重复调用 */
  modelCalls: number
  /** 最近一次完成的 phase,用于运行列表展示进度 */
  lastPhase?: string
  /** 已写入的输出产物(相对工作区),续跑/列表不必重新求值表达式 */
  outputs?: Array<{ name: string; path: string }>
}

export interface PhaseRecord {
  phaseId: string
  workflowId: string
  status: 'done' | 'failed' | 'interrupted'
  startedAt: string
  finishedAt: string
  outputs: Record<string, unknown>
}

export interface RunStore {
  runDir: string
  init(record: RunRecord): Promise<void>
  writeRun(record: RunRecord): Promise<void>
  readRun(runId: string): Promise<RunRecord>
  writePhase(runId: string, record: PhaseRecord): Promise<string>
  readPhase(runId: string, phaseId: string): Promise<PhaseRecord | null>
  listPhases(runId: string): Promise<string[]>
}

export class FileRunStore implements RunStore {
  readonly runDir: string

  constructor(private readonly workspaceRoot: string) {
    this.runDir = resolve(workspaceRoot, '.openwb', 'runs')
  }

  private runPath(runId: string): string {
    return resolve(this.runDir, runId)
  }

  private assertRunId(runId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(runId)) throw new Error(`非法 runId: ${runId}`)
  }

  async init(record: RunRecord): Promise<void> {
    this.assertRunId(record.runId)
    await mkdir(this.runPath(record.runId), { recursive: true })
    await this.writeRun(record)
  }

  async writeRun(record: RunRecord): Promise<void> {
    this.assertRunId(record.runId)
    const dir = this.runPath(record.runId)
    await mkdir(dir, { recursive: true })
    await writeFile(resolve(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  }

  async readRun(runId: string): Promise<RunRecord> {
    this.assertRunId(runId)
    const text = await readFile(resolve(this.runPath(runId), 'run.json'), 'utf8')
    return JSON.parse(text) as RunRecord
  }

  async writePhase(runId: string, record: PhaseRecord): Promise<string> {
    this.assertRunId(runId)
    const dir = this.runPath(runId)
    await mkdir(dir, { recursive: true })
    const name = `${record.phaseId}.json`
    await writeFile(resolve(dir, name), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return `.openwb/runs/${runId}/${name}`
  }

  async readPhase(runId: string, phaseId: string): Promise<PhaseRecord | null> {
    this.assertRunId(runId)
    try {
      const text = await readFile(resolve(this.runPath(runId), `${phaseId}.json`), 'utf8')
      return JSON.parse(text) as PhaseRecord
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async listPhases(runId: string): Promise<string[]> {
    this.assertRunId(runId)
    try {
      const files = await readdir(this.runPath(runId))
      return files.filter((f) => f.endsWith('.json') && f !== 'run.json').map((f) => f.slice(0, -5)).sort()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }
}

/** 输出路径只允许相对工作区;拒绝绝对路径、.. 越界与 Windows 盘符 */
export function resolveOutputPath(workspaceRoot: string, rel: string): string {
  if (rel.includes('\0')) throw new Error('输出路径含非法字符')
  if (/^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error(`输出路径必须是相对路径: ${rel}`)
  }
  const root = resolve(workspaceRoot)
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) {
    throw new Error(`输出路径越界: ${rel}`)
  }
  return abs
}

export interface OutputBinding {
  name: string
  kind: 'file' | 'text'
  /** 相对工作区路径;kind=file 时必有 */
  path?: string
  /** kind=text 时的内容 */
  text?: string
}

/** 工作总结:`{{inputs.question}}` 这类表达式在 outputs.path 里也要能求值 */
export function summarizeWorkflow(manifest: WorkflowManifest): string {
  const phases = manifest.phases.map((p) => p.id).join(' -> ')
  return `${manifest.id}: ${phases}`
}
