import { describe, expect, it } from 'vitest'
import { budgetExceededMessage, evaluateTokenBudget } from '../src/budget.js'

describe('evaluateTokenBudget', () => {
  it('treats zero or invalid limits as unlimited', () => {
    for (const limit of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = evaluateTokenBudget(limit, 10_000)
      expect(decision.exceeded).toBe(false)
      expect(decision.remaining).toBe(Number.POSITIVE_INFINITY)
    }
  })

  it('does not exceed before the limit and rejects exactly at the limit', () => {
    expect(evaluateTokenBudget(100, 99)).toEqual({ exceeded: false, remaining: 1 })
    expect(evaluateTokenBudget(100, 100)).toEqual({ exceeded: true, remaining: 0 })
    expect(evaluateTokenBudget(100, 150)).toEqual({ exceeded: true, remaining: 0 })
  })

  it('ignores negative or non-finite usage instead of failing the run', () => {
    expect(evaluateTokenBudget(100, -5).exceeded).toBe(false)
    expect(evaluateTokenBudget(100, Number.NaN).exceeded).toBe(false)
  })

  it('explains the actual limit and usage', () => {
    const message = budgetExceededMessage(500, 640)
    expect(message).toContain('500')
    expect(message).toContain('640')
    expect(message).toContain('已保留')
  })
})
