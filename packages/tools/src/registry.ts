import type { z } from 'zod'

export interface ToolEffects {
  writesFilesystem: boolean
  accessesNetwork: boolean
  mayIncurCost: boolean
}

export interface ToolContext {
  workspaceRoot: string
  signal?: AbortSignal
}

export interface ToolDescriptor<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  parameters: z.ZodType<TInput>
  effects: ToolEffects
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>
}

export type AnyToolDescriptor = ToolDescriptor<any, any>

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDescriptor>()

  register<TInput, TOutput>(tool: ToolDescriptor<TInput, TOutput>): void {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`非法工具名: ${tool.name}(只允许小写字母、数字、下划线)`)
    }
    if (this.tools.has(tool.name)) throw new Error(`工具重复注册: ${tool.name}`)
    this.tools.set(tool.name, tool)
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
