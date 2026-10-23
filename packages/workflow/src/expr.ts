/**
 * 受限表达式:变量 + 管道,不是 JavaScript。
 *
 * 设计上刻意不做 AST 求值器(不 new Function / eval):
 * 只做字符串扫描与路径查表,任何形似函数调用的基础表达式都直接拒绝。
 * 这是 P6 "表达式含 eval( 或 Function( 时被拒绝,不执行" 的实现基础。
 */

export type Scope = Record<string, unknown>

export const ALLOWED_PIPES = new Set(['flatten', 'unique', 'limit', 'truncate', 'join', 'json'])

// 工作流 id / save_as 允许短横线(见 manifest.ts 的 id 正则),
// 表达式路径必须能引用它们;由于本语言完全不支持算术,`-` 不会产生歧义。
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*$/

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpressionError'
  }
}

interface PipeCall {
  name: string
  args: unknown[]
}

interface ParsedExpression {
  path: string[]
  pipes: PipeCall[]
}

/** 扫描字符串字面量,返回结束引号之后的下标;未闭合即时抛错 */
function scanString(input: string, start: number): number {
  const quote = input[start]!
  let i = start + 1
  while (i < input.length) {
    const ch = input[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i += 1
  }
  throw new ExpressionError('字符串字面量未闭合')
}

/** 按顶层分隔符切分,括号/方括号/引号内部的分隔符不生效 */
function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = []
  let depthParen = 0
  let depthBracket = 0
  let start = 0
  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    if (ch === '"' || ch === "'") {
      i = scanString(input, i)
      continue
    }
    if (ch === '(') depthParen += 1
    else if (ch === ')') depthParen -= 1
    else if (ch === '[') depthBracket += 1
    else if (ch === ']') depthBracket -= 1
    else if (ch === separator && depthParen === 0 && depthBracket === 0) {
      parts.push(input.slice(start, i))
      start = i + 1
    }
    if (depthParen < 0 || depthBracket < 0) throw new ExpressionError('括号不平衡')
    i += 1
  }
  if (depthParen !== 0 || depthBracket !== 0) throw new ExpressionError('括号不平衡')
  parts.push(input.slice(start))
  return parts
}

/**
 * 拒绝任何可执行语法的痕迹。
 * 注意:必须在解析前做,保证 eval / Function 这类输入拿到的是明确的拒绝原因,
 * 而不是"未知变量"这种容易被误解成可通过改名绕过的错误。
 */
function assertNoExecutableSyntax(expr: string): void {
  if (/\beval\s*\(/.test(expr)) throw new ExpressionError('拒绝执行 eval( 表达式')
  if (/\bFunction\s*\(/.test(expr)) throw new ExpressionError('拒绝执行 Function( 表达式')
  if (/=>/.test(expr)) throw new ExpressionError('不支持箭头函数')
  if (/\bnew\s+[A-Za-z_$]/.test(expr)) throw new ExpressionError('不支持 new 表达式')
  // 字符串字面量里的括号/花括号是数据,不是语法;先剥离再检查运算符字符。
  let code = ''
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]!
    if (ch === '"' || ch === "'") {
      i = scanString(expr, i)
      continue
    }
    code += ch
    i += 1
  }
  if (/[`;{}]/.test(code)) throw new ExpressionError('包含不支持的字符(反引号/分号/花括号)')
  // 先去掉标识符(含 inputs.question、steps.search-one 这类路径),再检查运算符。
  // 标识符允许短横线,因此不能再用"看到 - 就拒绝"的粗粒度判断。
  const withoutIdentifiers = code.replace(/[A-Za-z_$][A-Za-z0-9_$-]*/g, '')
  const withoutPipes = withoutIdentifiers.replace(/\|/g, '')
  if (/[+\-*/%<>=!?&]/.test(withoutPipes)) {
    throw new ExpressionError('不支持算术、比较、逻辑或赋值运算')
  }
}

function parseLiteral(raw: string): unknown {
  const text = raw.trim()
  if (text.length === 0) throw new ExpressionError('管道参数为空')
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith('"') || text.startsWith("'")) {
    if (scanString(text, 0) !== text.length) throw new ExpressionError(`非法字符串字面量: ${text}`)
    // 这里的字面量仅来自 YAML 的管道参数,不是用户可执行代码;用 JSON 解析双引号形式即可。
    if (text.startsWith('"')) return JSON.parse(text) as unknown
    const inner = text.slice(1, -1)
    return inner.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new ExpressionError('数组字面量未闭合')
    const body = text.slice(1, -1).trim()
    if (body.length === 0) return []
    return splitTopLevel(body, ',').map((item) => parseLiteral(item))
  }
  throw new ExpressionError(`不支持的管道参数: ${text}`)
}

function parsePipe(raw: string): PipeCall {
  const text = raw.trim()
  if (text.length === 0) throw new ExpressionError('管道名不能为空')
  const open = text.indexOf('(')
  if (open < 0) {
    if (!IDENT_RE.test(text)) throw new ExpressionError(`非法管道名: ${text}`)
    return { name: text, args: [] }
  }
  if (!text.endsWith(')')) throw new ExpressionError(`管道参数未闭合: ${text}`)
  const name = text.slice(0, open).trim()
  if (!IDENT_RE.test(name)) throw new ExpressionError(`非法管道名: ${name}`)
  const body = text.slice(open + 1, -1).trim()
  const args = body.length === 0 ? [] : splitTopLevel(body, ',').map((arg) => parseLiteral(arg))
  return { name, args }
}

function parsePath(raw: string): string[] {
  const text = raw.trim()
  if (text.length === 0) throw new ExpressionError('变量路径不能为空')
  if (text.includes('(')) throw new ExpressionError('基础表达式不支持函数调用')
  if (text.includes('[')) throw new ExpressionError('基础表达式不支持下标访问')
  const segments = text.split('.')
  for (const segment of segments) {
    if (!IDENT_RE.test(segment)) throw new ExpressionError(`非法变量路径: ${text}`)
  }
  return segments
}

export function parseExpression(input: string): ParsedExpression {
  const expr = input.trim()
  if (expr.length === 0) throw new ExpressionError('表达式为空')
  assertNoExecutableSyntax(expr)
  const parts = splitTopLevel(expr, '|')
  const head = parts[0] ?? ''
  const path = parsePath(head)
  const pipes = parts.slice(1).map((part) => parsePipe(part))
  for (const pipe of pipes) {
    if (!ALLOWED_PIPES.has(pipe.name)) throw new ExpressionError(`不支持的管道: ${pipe.name}`)
  }
  return { path, pipes }
}

function requireInt(value: unknown, pipe: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ExpressionError(`${pipe} 的参数必须是非负整数`)
  }
  return value
}

function jsonStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function flattenOnce(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [value]
  const out: unknown[] = []
  for (const item of value) {
    if (Array.isArray(item)) out.push(...item)
    else out.push(item)
  }
  return out
}

function deepKey(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function applyPipe(pipe: PipeCall, value: unknown): unknown {
  switch (pipe.name) {
    case 'flatten':
      if (pipe.args.length > 0) throw new ExpressionError('flatten 不接受参数')
      return flattenOnce(value)
    case 'unique': {
      if (pipe.args.length > 0) throw new ExpressionError('unique 不接受参数')
      const list = Array.isArray(value) ? value : [value]
      const seen = new Set<string>()
      const out: unknown[] = []
      for (const item of list) {
        const key = deepKey(item)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
      return out
    }
    case 'limit': {
      const n = requireInt(pipe.args[0], 'limit')
      if (pipe.args.length !== 1) throw new ExpressionError('limit 需要一个参数')
      return Array.isArray(value) ? value.slice(0, n) : value
    }
    case 'truncate': {
      const n = requireInt(pipe.args[0], 'truncate')
      if (pipe.args.length !== 1) throw new ExpressionError('truncate 需要一个参数')
      const text = jsonStringify(value)
      return text.length <= n ? text : text.slice(0, n)
    }
    case 'join': {
      const sep = pipe.args[0]
      if (pipe.args.length !== 1 || typeof sep !== 'string') {
        throw new ExpressionError('join 需要一个字符串分隔符')
      }
      const list = Array.isArray(value) ? value : [value]
      return list.map((item) => jsonStringify(item)).join(sep)
    }
    case 'json':
      if (pipe.args.length > 0) throw new ExpressionError('json 不接受参数')
      return JSON.stringify(value)
    default:
      throw new ExpressionError(`不支持的管道: ${pipe.name}`)
  }
}

function resolvePath(path: string[], scope: Scope): unknown {
  const root = path[0]!
  if (!(root in scope)) {
    throw new ExpressionError(`未知变量: ${root}。可用: ${Object.keys(scope).join(', ') || '(空)'}`)
  }
  let current: unknown = scope[root]
  for (const key of path.slice(1)) {
    if (current === null || current === undefined) {
      throw new ExpressionError(`变量 ${path.join('.')} 在 .${key} 处为空`)
    }
    if (typeof current !== 'object') {
      throw new ExpressionError(`变量 ${path.join('.')} 不是对象,无法取 .${key}`)
    }
    if (Array.isArray(current)) {
      throw new ExpressionError('不支持通过属性名访问数组元素')
    }
    if (!(key in (current as Record<string, unknown>))) {
      throw new ExpressionError(`变量 ${path.join('.')} 不存在字段 ${key}`)
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export function evaluate(expr: string, scope: Scope): unknown {
  const parsed = parseExpression(expr)
  let value = resolvePath(parsed.path, scope)
  for (const pipe of parsed.pipes) value = applyPipe(pipe, value)
  return value
}

/** 找出模板里所有 {{...}} 片段;花括号出现在字符串字面量里不当作结束 */
export function scanTemplate(template: string): Array<{ start: number; end: number; expr: string }> {
  const found: Array<{ start: number; end: number; expr: string }> = []
  let i = 0
  while (i < template.length) {
    const open = template.indexOf('{{', i)
    if (open < 0) break
    let j = open + 2
    let quote: string | null = null
    let closed = false
    while (j < template.length) {
      const ch = template[j]!
      if (quote) {
        if (ch === '\\') j += 2
        else {
          if (ch === quote) quote = null
          j += 1
        }
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        j += 1
        continue
      }
      if (ch === '}' && template[j + 1] === '}') {
        closed = true
        break
      }
      if (ch === '{') throw new ExpressionError('模板表达式里不允许嵌套花括号')
      j += 1
    }
    if (!closed) throw new ExpressionError('表达式缺少结束标记 }}')
    found.push({ start: open, end: j + 2, expr: template.slice(open + 2, j) })
    i = j + 2
  }
  return found
}

/** 判断是否是"整串就是一个占位符",用于保留类型(数组/对象不被转成字符串) */
function isSinglePlaceholder(value: string): boolean {
  const parts = scanTemplate(value)
  if (parts.length !== 1) return false
  const only = parts[0]!
  return only.start === 0 && only.end === value.length
}

export function interpolate(template: string, scope: Scope): string {
  const parts = scanTemplate(template)
  let out = ''
  let cursor = 0
  for (const part of parts) {
    out += template.slice(cursor, part.start)
    out += jsonStringify(evaluate(part.expr, scope))
    cursor = part.end
  }
  out += template.slice(cursor)
  return out
}

/** 递归求值:整串占位符保留原类型,其余按字符串插值 */
export function evaluateValue(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') {
    if (isSinglePlaceholder(value)) return evaluate(value.slice(2, -2), scope)
    if (value.includes('{{')) return interpolate(value, scope)
    return value
  }
  if (Array.isArray(value)) return value.map((item) => evaluateValue(item, scope))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = evaluateValue(item, scope)
    }
    return out
  }
  return value
}
