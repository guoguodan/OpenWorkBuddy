import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Fragment {
  name: string
  content: string
}

export interface AssembledPrompt {
  text: string
  fragments: Array<{ name: string; bytes: number }>
}

const VAR_PATTERN = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g
const INCLUDE_PATTERN = /^\s*\{%\s*include\s+"([^"]+)"\s*%\}\s*$/gm

export class PromptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptError'
  }
}

/**
 * 只支持两种能力:{{var}} 插值、独占一行的 {% include "x.md" %}。
 * 不支持表达式、循环、函数调用——模板一旦可执行,就变成可被污染的攻击面。
 */
export function renderFragment(
  template: string,
  vars: Record<string, string>,
  resolveInclude?: (name: string) => Fragment | undefined
): string {
  const withIncludes = template.replace(INCLUDE_PATTERN, (_m, name: string) => {
    if (!resolveInclude) throw new PromptError(`模板包含 include 但未提供解析器: ${name}`)
    const inc = resolveInclude(name)
    if (!inc) throw new PromptError(`include 目标不存在: ${name}`)
    return inc.content
  })

  return withIncludes.replace(VAR_PATTERN, (_m, key: string) => {
    const value = vars[key]
    if (value === undefined) throw new PromptError(`未提供的模板变量: ${key}`)
    return value
  })
}

export function assemble(fragments: Fragment[], vars: Record<string, string> = {}): AssembledPrompt {
  if (fragments.length === 0) throw new PromptError('没有可组装的提示词片段')
  const resolveInclude = (name: string) => fragments.find((f) => f.name === name)

  const parts = fragments.map((f) => ({
    name: f.name,
    text: renderFragment(f.content, vars, resolveInclude).trim()
  }))

  const text = parts.filter((p) => p.text.length > 0).map((p) => p.text).join('\n\n')
  return {
    text,
    fragments: parts.map((p) => ({ name: p.name, bytes: Buffer.byteLength(p.text, 'utf8') }))
  }
}

export async function loadFragments(dir: string, names: string[]): Promise<Fragment[]> {
  const out: Fragment[] = []
  for (const name of names) {
    try {
      out.push({ name, content: await readFile(join(dir, name), 'utf8') })
    } catch {
      throw new PromptError(`提示词片段不存在: ${name}`)
    }
  }
  return out
}
