import { describe, expect, it } from 'vitest'
import { canTransition, assertTransition, InvalidTaskTransitionError, type TaskStatus } from '../src/tasks.js'

describe('task state machine (WM-TASK-02)', () => {
  it('allows pending -> running -> done', () => {
    expect(canTransition('pending', 'running')).toBe(true)
    expect(canTransition('running', 'done')).toBe(true)
  })

  it('allows pending -> skipped for cancellation', () => {
    expect(canTransition('pending', 'skipped')).toBe(true)
    expect(canTransition('pending', 'interrupted')).toBe(true)
  })

  it('allows failed -> running only as an explicit retry', () => {
    expect(canTransition('failed', 'running')).toBe(true)
    expect(canTransition('failed', 'skipped')).toBe(true)
  })

  it('forbids failed -> done', () => {
    expect(canTransition('failed', 'done')).toBe(false)
    expect(() => assertTransition('failed', 'done')).toThrow(InvalidTaskTransitionError)
  })

  it('forbids done -> anything', () => {
    const targets: TaskStatus[] = ['pending', 'running', 'failed', 'interrupted', 'skipped']
    for (const to of targets) expect(canTransition('done', to)).toBe(false)
  })

  it('forbids skipping running -> pending', () => {
    expect(canTransition('running', 'pending')).toBe(false)
  })

  it('forbids done -> running (must retry from failed)', () => {
    expect(canTransition('done', 'running')).toBe(false)
  })
})