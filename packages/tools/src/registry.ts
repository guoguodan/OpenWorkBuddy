import type { z } from 'zod'

const BUILTIN_NAME_RE = /^[a-z][a-z0-9_]*$/
/** 插件工具用 <plugin>__<tool>;插件名允许短横线,工具名保持下划线 */
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]*__[a-z][a-z0-9_]*$/

export function isValidToolName(name: string): boolean {
  return BUILTIN_NAME_RE.test(name) || PLUGIN_NAME_RE.test(name)
}

export interface ToolEffects {
  writesFilesystem: boolean
  accessesNetwork: boolean
  mayIncurCost: boolean
}

export interface ToolContext {
  workspaceRoot: string
  signal?: AbortSignal
  /** 当前任务与会话:交付物落库与事件归属需要 */
  taskId?: string | null
  conversationId?: string | null
  /** 由宿主注入的交付物写入器;缺省时工具只做校验,不落库(例如工作流步骤) */
  artifactSink?: ArtifactSink
}

export interface ArtifactDraft {
  kind: 'file' | 'html' | 'url' | 'image'
  title: string
  description?: string
  path?: string
  url?: string
  size?: number
  sha256?: string
}

export interface ArtifactSink {
  insert(items: ArtifactDraft[]): Promise<Array<{ id: string; deduped: boolean }>>
}

export interface ToolDescriptor<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  parameters: z.ZodType<TInput>
  /** 插件工具携带原始 JSON Schema;有值时优先于 parameters 交给模型 */
  inputSchema?: unknown
  effects: ToolEffects
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>
}

export type AnyToolDescriptor = ToolDescriptor<any, any>

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDescriptor>()

  register<TInput, TOutput>(tool: ToolDescriptor<TInput, TOutput>): void {
    if (!isValidToolName(tool.name)) {
      throw new Error(`非法工具名: ${tool.name}(内置工具只允许小写字母、数字、下划线;插件工具为 <plugin>__<tool>)`)
    }
    if (this.tools.has(tool.name)) throw new Error(`工具重复注册: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): AnyToolDescriptor | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.tools.keys()].sort()
  }

  /** 只把策略允许的工具交给模型;不是"先给全集再拦截" */
  selectFor(isAllowed: (name: string) => boolean): AnyToolDescriptor[] {
    return this.names()
      .filter(isAllowed)
      .map((name) => this.tools.get(name)!)
  }
}
