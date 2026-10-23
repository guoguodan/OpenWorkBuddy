/**
 * 从自由文本里提取第一个平衡的 JSON 对象/数组。
 *
 * 不能用正则,也不能只数花括号:字符串里出现 "}"、转义引号、嵌套对象
 * 都会让朴素实现提前截断。这里用状态机分别跟踪字符串、转义与括号深度。
 */
export class JsonExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonExtractionError'
  }
}

export function extractJson(text: string): unknown {
  const start = firstJsonStart(text)
  if (start < 0) throw new JsonExtractionError('未找到 JSON 对象或数组')

  const opener = text[start]!
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === opener) depth += 1
    else if (ch === closer) {
      depth -= 1
      if (depth === 0) {
        const slice = text.slice(start, i + 1)
        try {
          return JSON.parse(slice) as unknown
        } catch (err) {
          throw new JsonExtractionError(`JSON 解析失败: ${(err as Error).message}`)
        }
      }
    }
  }
  throw new JsonExtractionError(inString ? 'JSON 字符串未闭合' : 'JSON 括号不平衡')
}

function firstJsonStart(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '{' || ch === '[') return i
  }
  return -1
}

export interface SchemaValidationIssue {
  path: string
  message: string
}

type JsonSchema = Record<string, unknown>

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeOf(value) === type
}

/**
 * 只实现工作流用得到的 JSON Schema 子集。
 * 不引入 ajv:我们不需要远程 $ref / transform,保持校验可审计且零额外依赖。
 */
export function validateJsonSchema(value: unknown, schema: unknown, path = '$'): SchemaValidationIssue[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return [{ path, message: 'schema 必须是对象' }]
  }
  const node = schema as JsonSchema
  const issues: SchemaValidationIssue[] = []

  if (typeof node.type === 'string' && !matchesType(value, node.type)) {
    issues.push({ path, message: `期望 ${node.type},实际 ${typeOf(value)}` })
    return issues
  }
  if (Array.isArray(node.enum) && !node.enum.some((item) => Object.is(item, value))) {
    issues.push({ path, message: `值不在枚举范围内` })
  }
  if (typeof value === 'string') {
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      issues.push({ path, message: `字符串长度小于 ${node.minLength}` })
    }
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
      issues.push({ path, message: `字符串长度大于 ${node.maxLength}` })
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) issues.push({ path, message: `小于最小值 ${node.minimum}` })
    if (typeof node.maximum === 'number' && value > node.maximum) issues.push({ path, message: `大于最大值 ${node.maximum}` })
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) {
      issues.push({ path, message: `数组至少需要 ${node.minItems} 项` })
    }
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
      issues.push({ path, message: `数组最多允许 ${node.maxItems} 项` })
    }
    if (node.items !== undefined) {
      value.forEach((item, index) => {
        issues.push(...validateJsonSchema(item, node.items, `${path}[${index}]`))
      })
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (Array.isArray(node.required)) {
      for (const key of node.required) {
        if (typeof key === 'string' && !(key in record)) {
          issues.push({ path: `${path}.${key}`, message: '缺少必填字段' })
        }
      }
    }
    if (node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      for (const [key, childSchema] of Object.entries(node.properties as Record<string, unknown>)) {
        if (key in record) {
          issues.push(...validateJsonSchema(record[key], childSchema, `${path}.${key}`))
        }
      }
    }
    if (node.additionalProperties === false && node.properties && typeof node.properties === 'object') {
      const allowed = new Set(Object.keys(node.properties as Record<string, unknown>))
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, message: '不允许的额外字段' })
      }
    }
  }
  return issues
}

/** mock / 兜底:按 schema 生成一个满足约束的样例值,让离线验收不等同于跳过校验 */
export function sampleForSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return null
  const node = schema as JsonSchema
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0]
  switch (node.type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      const required = Array.isArray(node.required) ? node.required.filter((k): k is string => typeof k === 'string') : []
      const properties =
        node.properties !== null && typeof node.properties === 'object'
          ? (node.properties as Record<string, unknown>)
          : {}
      for (const key of required) out[key] = sampleForSchema(properties[key] ?? {})
      return out
    }
    case 'array': {
      const count = typeof node.minItems === 'number' ? node.minItems : 1
      return Array.from({ length: Math.max(1, count) }, () => sampleForSchema(node.items ?? { type: 'string' }))
    }
    case 'integer':
    case 'number':
      return typeof node.minimum === 'number' ? node.minimum : 1
    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return 'mock'
  }
}
