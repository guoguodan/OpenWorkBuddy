/**
 * SKILL.md frontmatter 解析。
 * 只接受 `---` 包裹的 YAML 头,不做任何表达式求值。
 */
import { parse as parseYaml } from 'yaml'

export interface ParsedDocument {
  frontmatter: unknown
  body: string
}

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

const DELIMITER = /^---[ \t]*$/m

export function parseFrontmatter(raw: string): ParsedDocument {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---')) {
    throw new FrontmatterError('缺少 frontmatter:文件必须以 --- 开头')
  }

  const rest = text.slice(3)
  const match = DELIMITER.exec(rest)
  if (!match) throw new FrontmatterError('frontmatter 未闭合:缺少结束的 ---')

  const yamlText = rest.slice(0, match.index)
  const body = rest.slice(match.index + match[0].length).replace(/^\n/, '')

  let frontmatter: unknown
  try {
    frontmatter = parseYaml(yamlText)
  } catch (err) {
    throw new FrontmatterError(`frontmatter YAML 语法错误: ${(err as Error).message}`)
  }
  return { frontmatter, body }
}