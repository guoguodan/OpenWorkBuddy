import { createHash } from 'node:crypto'
import type { MemoryItem, MemoryKind } from './types.js'

/** 保守估算:中文约 1 字 1 token,英文约 4 字符 1 token。宁可高估也不要挤爆上下文。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code > 0x2e80) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

export function contentHash(scope: string, kind: string, content: string): string {
  return createHash('sha256')
    .update(`${scope}\u0000${kind}\u0000${normalize(content)}`)
    .digest('hex')
}

/** 去重前的规范化:统一空白、去首尾、忽略大小写差异造成的重复 */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export const MAX_LINE_CHARS = 500

export function clipLine(text: string): { text: string; truncated: boolean } {
  const flat = normalize(text)
  if (flat.length <= MAX_LINE_CHARS) return { text: flat, truncated: false }
  return { text: `${flat.slice(0, MAX_LINE_CHARS)}…[truncated]`, truncated: true }
}

/** 工作区日志单行格式: - <ISO> | <kind> | <content> */
export function formatLogLine(item: Pick<MemoryItem, 'createdAt' | 'kind' | 'content'>): string {
  const { text } = clipLine(item.content)
  return `- ${item.createdAt} | ${item.kind} | ${text}\n`
}

export interface ParsedMemoryFile {
  preferences: string[]
  facts: string[]
}

/** 解析用户级 MEMORY.md:必须可人工编辑,只认 ## 偏好 / ## 事实 两个二级标题 */
export function parseUserMemory(markdown: string): ParsedMemoryFile {
  const preferences: string[] = []
  const facts: string[] = []
  let section: 'preference' | 'fact' | null = null
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim()
      if (title.includes('偏好')) section = 'preference'
      else if (title.includes('事实')) section = 'fact'
      else section = null
      continue
    }
    if (!line.startsWith('- ')) continue
    const body = line.slice(2).trim()
    if (!body) continue
    if (section === 'preference') preferences.push(body)
    else if (section === 'fact') facts.push(body)
  }
  return { preferences, facts }
}

export function renderUserMemory(preferences: string[], facts: string[]): string {
  const lines = ['# 用户记忆', '', '## 偏好']
  lines.push(...(preferences.length ? preferences.map((p) => `- ${p}`) : ['- (空)']))
  lines.push('', '## 事实')
  lines.push(...(facts.length ? facts.map((f) => `- ${f}`) : ['- (空)']))
  return `${lines.join('\n')}\n`
}

export function kindOfSection(section: 'preference' | 'fact'): MemoryKind {
  return section
}

export function formatMemoryBlock(
  scope: 'user' | 'workspace',
  items: Array<Pick<MemoryItem, 'content' | 'kind'>>,
  attrs: { readonly?: boolean; retrieved?: boolean } = {}
): string {
  const attrText = [
    `scope="${scope}"`,
    attrs.readonly ? 'readonly="true"' : '',
    attrs.retrieved ? 'retrieved="true"' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const body = items.map((i) => `- [${i.kind}] ${clipLine(i.content).text}`).join('\n')
  return `<memory ${attrText}>\n${body}\n</memory>`
}