import type { AppDatabase } from '@openwb/storage'
import { listMemory, searchMemory } from './store.js'
import { parseUserMemory } from './format.js'
import { readFile } from 'node:fs/promises'
import { userMemoryPath } from './paths.js'
import { estimateTokens, formatMemoryBlock } from './format.js'
import { DEFAULT_BUDGET, type InjectionBudget, type InjectionResult, type MemoryItem } from './types.js'

export interface BuildInjectionInput {
  db: AppDatabase
  dataDir: string
  workspaceId: string
  /** 本轮用户输入,用于工作区关键词召回 */
  query?: string
  budget?: Partial<InjectionBudget>
}

/**
 * 三层记忆合并注入。
 * - 用户级:保留 ## 偏好 全部,## 事实 按时间倒序截断
 * - 工作区级:FTS5 召回 Top 20,再按相关度取前 8 条(无查询词时按时间倒序)
 * - 云端画像:本期不落盘,由调用方传入(默认空)
 */
export async function buildInjection(input: BuildInjectionInput): Promise<InjectionResult> {
  const budget: InjectionBudget = { ...DEFAULT_BUDGET, ...input.budget }
  const blocks: InjectionResult['blocks'] = []
  let truncatedTotal = 0

  const userItems = await loadUserItems(input.db, input.dataDir)
  if (userItems.length > 0) {
    const picked = pickWithBudget(userItems, budget.user, {
      keepKindsFirst: ['preference']
    })
    truncatedTotal += picked.truncated
    blocks.push({
      scope: 'user',
      text: formatMemoryBlock('user', picked.items, { readonly: true }),
      truncated: picked.truncated,
      ids: picked.items.map((i) => i.id)
    })
  }

  const workspaceItems =
    input.query && input.query.trim().length > 0
      ? recallWorkspace(input.db, input.workspaceId, input.query)
      : listMemory(input.db, { scope: 'workspace', workspaceId: input.workspaceId, limit: 8 })

  if (workspaceItems.length > 0) {
    const picked = pickWithBudget(workspaceItems, budget.workspace)
    truncatedTotal += picked.truncated
    blocks.push({
      scope: 'workspace',
      text: formatMemoryBlock('workspace', picked.items, { retrieved: true }),
      truncated: picked.truncated,
      ids: picked.items.map((i) => i.id)
    })
  }

  const text = blocks.map((b) => b.text).join('\n')
  return { blocks, text, truncatedTotal }
}

/**
 * 工作区记忆召回。
 *
 * FTS 是隐式 AND 匹配,长句任务很容易一字不差才命中,结果就是"明明有过相关工作却一条记忆都没注入"。
 * 因此命中为空时退回最近的工作区记忆,既保证注入稳定,也让用户能在界面上看到本轮用了哪些记忆。
 */
function recallWorkspace(db: AppDatabase, workspaceId: string, query: string): MemoryItem[] {
  const hits = searchMemory(db, query, { workspaceId, limit: 20 })
    .slice(0, 8)
    .map((h) => h.item)
  if (hits.length > 0) return hits
  return listMemory(db, { scope: 'workspace', workspaceId, limit: 8 })
}

async function loadUserItems(db: AppDatabase, dataDir: string): Promise<MemoryItem[]> {
  const file = userMemoryPath(dataDir)
  const markdown = await readFile(file, 'utf8').catch(() => '')
  const parsed = parseUserMemory(markdown)
  if (parsed.preferences.length === 0 && parsed.facts.length === 0) return []

  const all = listMemory(db, { scope: 'user', limit: 1000 })
  const byContent = new Map(all.map((m) => [m.content, m]))
  const ordered: MemoryItem[] = []
  for (const p of parsed.preferences) {
    const hit = byContent.get(p)
    if (hit) ordered.push(hit)
  }
  // 事实按时间倒序
  const facts = all
    .filter((m) => m.kind === 'fact')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const f of facts) {
    if (!ordered.some((o) => o.id === f.id)) ordered.push(f)
  }
  return ordered
}

function pickWithBudget(
  items: MemoryItem[],
  maxTokens: number,
  opts: { keepKindsFirst?: string[] } = {}
): { items: MemoryItem[]; truncated: number } {
  const priority: MemoryItem[] = []
  const rest: MemoryItem[] = []
  for (const item of items) {
    if (opts.keepKindsFirst?.includes(item.kind)) priority.push(item)
    else rest.push(item)
  }
  // 偏好必须全保留:即便超出预算也不裁偏好,只在 UI 提示
  const picked: MemoryItem[] = [...priority]
  let used = priority.reduce((sum, i) => sum + estimateTokens(i.content), 0)
  let truncated = 0
  for (const item of rest) {
    const cost = estimateTokens(item.content)
    if (used + cost > maxTokens) {
      truncated++
      continue
    }
    picked.push(item)
    used += cost
  }
  return { items: picked, truncated }
}
