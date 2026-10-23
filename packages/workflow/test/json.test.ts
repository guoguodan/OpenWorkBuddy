import { describe, expect, it } from 'vitest'
import { extractJson, JsonExtractionError, sampleForSchema, validateJsonSchema } from '../src/json.js'

describe('extractJson', () => {
  it('extracts JSON surrounded by prose', () => {
    const text = '这里是结果:\n```json\n{"angles":["a","b"],"n":{"x":1}}\n```\n请查收'
    expect(extractJson(text)).toEqual({ angles: ['a', 'b'], n: { x: 1 } })
  })

  it('ignores braces inside strings, including escaped quotes', () => {
    const text = 'prefix {"note":"a } b { c","quote":"say \\"}\\"","list":[1,2]} suffix'
    expect(extractJson(text)).toEqual({ note: 'a } b { c', quote: 'say "}"', list: [1, 2] })
  })

  it('supports top-level arrays', () => {
    expect(extractJson('result: [1,{"a":"x"}].')).toEqual([1, { a: 'x' }])
  })

  it('throws on unbalanced or missing JSON', () => {
    expect(() => extractJson('no json here')).toThrow(JsonExtractionError)
    expect(() => extractJson('{"a": "unterminated}')).toThrow(/未闭合|不平衡/)
    expect(() => extractJson('{"a":1')).toThrow(/不平衡/)
  })
})

describe('validateJsonSchema', () => {
  const schema = {
    type: 'object',
    required: ['angles'],
    properties: {
      angles: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } }
    }
  }

  it('accepts a conforming object and reports precise paths', () => {
    expect(validateJsonSchema({ angles: ['a', 'b', 'c'] }, schema)).toEqual([])
    const issues = validateJsonSchema({ angles: ['a'] }, schema)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.path).toBe('$.angles')
  })

  it('reports missing required keys', () => {
    const issues = validateJsonSchema({}, schema)
    expect(issues[0]!.path).toBe('$.angles')
  })

  it('builds a sample that satisfies the schema', () => {
    expect(validateJsonSchema(sampleForSchema(schema), schema)).toEqual([])
  })
})
