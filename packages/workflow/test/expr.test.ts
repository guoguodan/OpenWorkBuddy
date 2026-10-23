import { describe, expect, it } from 'vitest'
import { evaluate, evaluateValue, ExpressionError, interpolate, parseExpression } from '../src/expr.js'

const scope = {
  inputs: { question: '为什么天空是蓝的', count: 3 },
  steps: { angles: { angles: ['a', 'b'] }, results: [['u1', 'u2'], ['u2', 'u3']] },
  item: 'one',
  run: { id: 'run-1' }
}

describe('restricted expression', () => {
  it('reads variables and keeps array type for a single placeholder', () => {
    expect(evaluate('steps.angles.angles', scope)).toEqual(['a', 'b'])
    expect(evaluate('inputs.count', scope)).toBe(3)
    expect(evaluateValue('{{steps.angles.angles}}', scope)).toEqual(['a', 'b'])
    expect(evaluateValue('q={{inputs.question}}', scope)).toBe('q=为什么天空是蓝的')
  })

  it('applies flatten/unique/limit/truncate/join/json', () => {
    expect(evaluate('steps.results | flatten | unique', scope)).toEqual(['u1', 'u2', 'u3'])
    expect(evaluate('steps.results | flatten | limit(2)', scope)).toEqual(['u1', 'u2'])
    expect(evaluate('inputs.question | truncate(3)', scope)).toBe('为什么')
    expect(evaluate('steps.angles.angles | join(",")', scope)).toBe('a,b')
    expect(evaluate('inputs.count | json', scope)).toBe('3')
  })

  it('rejects eval( and Function( before evaluation', () => {
    expect(() => evaluate('eval("1+1")', scope)).toThrow(/eval/)
    expect(() => evaluate('inputs.count | eval("1")', scope)).toThrow(/eval/)
    expect(() => evaluate('Function("return 1")', scope)).toThrow(/Function/)
    expect(() => parseExpression('inputs.count | Function("x")')).toThrow(ExpressionError)
  })

  it('rejects unknown pipes, arithmetic and member calls', () => {
    expect(() => evaluate('inputs.count | shell', scope)).toThrow(/不支持的管道/)
    expect(() => evaluate('inputs.count + 1', scope)).toThrow(/算术/)
    expect(() => evaluate('inputs.count.toFixed(2)', scope)).toThrow(/函数调用/)
    expect(() => evaluate('inputs["count"]', scope)).toThrow(/下标/)
  })

  it('reports unknown variables instead of returning undefined', () => {
    expect(() => evaluate('inputs.missing', scope)).toThrow(/不存在字段/)
    expect(() => evaluate('nope', scope)).toThrow(/未知变量/)
  })

  it('handles braces inside string literals when scanning templates', () => {
    const text = 'x {{inputs.question | join("}}")}} y'
    expect(interpolate(text, scope)).toBe('x 为什么天空是蓝的 y')
  })

  it('rejects malformed templates', () => {
    expect(() => interpolate('a {{inputs.question', scope)).toThrow(/结束标记/)
  })

  it('supports kebab-case ids in paths while still rejecting arithmetic', () => {
    expect(evaluate('steps.search-one', { steps: { 'search-one': 'ok' } })).toBe('ok')
    expect(() => evaluate('inputs.count - 1', scope)).toThrow(/算术/)
  })
})
