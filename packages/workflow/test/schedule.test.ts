import { describe, expect, it } from 'vitest'
import {
  AutomationScheduler,
  computeNextRun,
  missedOccurrences,
  nextOccurrence,
  planStartup,
  type AutomationRow,
  type ClaimInput,
  type ClaimStore
} from '../src/schedule.js'

const daily = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0'

function row(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: 'auto-1',
    name: 'daily',
    scheduleType: 'rrule',
    rrule: daily,
    scheduledAt: null,
    timezone: 'Asia/Shanghai',
    validFrom: null,
    validUntil: null,
    prompt: 'p',
    modeId: 'craft',
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    ...overrides
  }
}

class MemoryClaimStore implements ClaimStore {
  state = new Map<string, string | null>()
  results: Array<{ id: string; status: string; nextRunAt: string | null }> = []

  constructor(rows: AutomationRow[]) {
    for (const r of rows) this.state.set(r.id, r.nextRunAt)
  }

  claim(input: ClaimInput): boolean {
    const current = this.state.get(input.id)
    if (current !== input.expectedNextRunAt) return false
    this.state.set(input.id, input.nextRunAt)
    return true
  }

  markResult(id: string, status: string, nextRunAt: string | null): void {
    this.results.push({ id, status, nextRunAt })
    this.state.set(id, nextRunAt)
  }
}

describe('rrule next occurrence', () => {
  it('computes a daily occurrence in the explicit timezone', () => {
    const next = nextOccurrence(daily, new Date('2026-03-01T00:30:00.000Z'), 'Asia/Shanghai')
    expect(next?.toISOString()).toBe('2026-03-01T01:00:00.000Z')
  })

  it('does not depend on process local timezone', () => {
    const next = nextOccurrence(daily, new Date('2026-03-01T00:30:00.000Z'), 'America/New_York')
    // 纽约 09:00 = 14:00Z(冬令时 UTC-5)
    expect(next?.toISOString()).toBe('2026-03-01T14:00:00.000Z')
  })

  it('handles DST transitions with tzid', () => {
    // 2026-03-08 美国进入夏令时;纽约 09:00 的 UTC 时刻由 14:00Z 变成 13:00Z
    const before = nextOccurrence(daily, new Date('2026-03-07T15:00:00.000Z'), 'America/New_York')
    const after = nextOccurrence(daily, new Date('2026-03-08T15:00:00.000Z'), 'America/New_York')
    expect(before?.toISOString()).toBe('2026-03-08T13:00:00.000Z')
    expect(after?.toISOString()).toBe('2026-03-09T13:00:00.000Z')
  })

  it('counts missed occurrences', () => {
    const missed = missedOccurrences(daily, new Date('2026-03-01T01:00:00.000Z'), new Date('2026-03-03T01:00:00.000Z'))
    // from 是 Mar 1 09:00 那一刻,严格之后还有 Mar 2 / Mar 3 两次
    expect(missed.count).toBe(2)
    expect(missed.occurrences[0]?.toISOString()).toBe('2026-03-02T01:00:00.000Z')
  })
})

describe('computeNextRun', () => {
  it('returns null for a past one-shot task', () => {
    expect(
      computeNextRun({
        scheduleType: 'once',
        scheduledAt: '2026-01-01T00:00:00.000Z',
        after: new Date('2026-01-02T00:00:00.000Z')
      })
    ).toBeNull()
  })

  it('respects validUntil', () => {
    expect(
      computeNextRun({
        scheduleType: 'rrule',
        rule: daily,
        validUntil: '2026-03-01T00:30:00.000Z',
        after: new Date('2026-03-01T00:00:00.000Z')
      })
    ).toBeNull()
  })
})

describe('startup catch-up', () => {
  it('schedules a future time when next_run_at is missing', () => {
    const action = planStartup(row(), new Date('2026-03-01T00:00:00.000Z'))
    expect(action.kind).toBe('reschedule')
    expect(action.nextRunAt).toBe('2026-03-01T01:00:00.000Z')
  })

  it('catches up once after missing a single day', () => {
    const action = planStartup(
      row({ nextRunAt: '2026-02-28T01:00:00.000Z' }),
      new Date('2026-03-01T02:00:00.000Z')
    )
    expect(action.kind).toBe('run_now')
    expect(action.missed).toBe(1)
    expect(action.nextRunAt).toBe('2026-03-02T01:00:00.000Z')
  })

  it('does not catch up after five missed days but records the skip count', () => {
    const action = planStartup(
      row({ nextRunAt: '2026-02-24T01:00:00.000Z' }),
      new Date('2026-03-01T02:00:00.000Z')
    )
    expect(action.kind).toBe('skipped')
    expect(action.missed).toBeGreaterThan(3)
    expect(action.nextRunAt).toBe('2026-03-02T01:00:00.000Z')
  })

  it('catches up a missed one-shot automation exactly once', () => {
    const action = planStartup(
      row({ scheduleType: 'once', scheduledAt: '2026-02-28T01:00:00.000Z', nextRunAt: '2026-02-28T01:00:00.000Z' }),
      new Date('2026-03-01T02:00:00.000Z')
    )
    expect(action).toEqual({ kind: 'run_now', nextRunAt: null, missed: 1 })
  })
})

describe('automation scheduler', () => {
  it('fires a daily task after the clock advances 24h', () => {
    let now = new Date('2026-03-01T00:55:00.000Z')
    const r = row({ nextRunAt: '2026-03-01T01:00:00.000Z' })
    const store = new MemoryClaimStore([r])
    const scheduler = new AutomationScheduler(store, () => now)
    expect(scheduler.due([r])).toHaveLength(0)
    now = new Date('2026-03-02T01:00:30.000Z')
    const due = scheduler.due([r])
    expect(due.map((x) => x.id)).toEqual(['auto-1'])
    expect(scheduler.finish(r).nextRunAt).toBe('2026-03-03T01:00:00.000Z')
  })

  it('lets only one of two concurrent schedulers claim the same task', () => {
    const now = new Date('2026-03-01T02:00:00.000Z')
    const r = row({ nextRunAt: '2026-03-01T01:00:00.000Z' })
    const store = new MemoryClaimStore([r])
    const scheduler = new AutomationScheduler(store, () => now)
    const first = scheduler.due([r])
    const second = scheduler.due([r])
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('disables a one-shot task after it runs', () => {
    const now = new Date('2026-03-01T02:00:00.000Z')
    const r = row({ scheduleType: 'once', scheduledAt: '2026-03-01T01:00:00.000Z', nextRunAt: '2026-03-01T01:00:00.000Z' })
    const store = new MemoryClaimStore([r])
    const scheduler = new AutomationScheduler(store, () => now)
    scheduler.due([r])
    expect(scheduler.finish(r)).toEqual({ nextRunAt: null, disable: true })
  })
})
