export type MemoryScope = 'cloud' | 'user' | 'workspace'
export type MemoryKind = 'fact' | 'preference' | 'summary' | 'log'

export interface MemoryItem {
  id: string
  scope: MemoryScope
  workspaceId: string | null
  kind: MemoryKind
  content: string
  contentHash: string
  sourcePath: string | null
  pinned: boolean
  tokens: number
  createdAt: string
}

export interface InjectionBudget {
  /** 用户级上限,默认 1200 */
  user: number
  /** 工作区级上限,默认 2000 */
  workspace: number
}

export const DEFAULT_BUDGET: InjectionBudget = { user: 1200, workspace: 2000 }

export interface InjectionBlock {
  scope: 'user' | 'workspace'
  text: string
  /** 被预算裁掉的条目数,UI 据此提示"已截断" */
  truncated: number
  /** 注入的条目 id,便于 UI 逐条查看与删除 */
  ids: string[]
}

export interface InjectionResult {
  blocks: InjectionBlock[]
  /** 拼好的 <memory> 文本,直接追加到 system 末尾 */
  text: string
  truncatedTotal: number
}