// rrule 是 CommonJS 包(无 exports 字段);Node ESM 下具名导出不可靠,统一走默认导入再取构造器。
import rrulePkg from 'rrule'

type RRuleInstance = InstanceType<typeof rrulePkg.RRule>
const RRuleCtor = rrulePkg.RRule

export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}

export interface AutomationRow {
  id: string
  name: string
  scheduleType: 'once' | 'rrule'
  rrule: string | null
  scheduledAt: string | null
  timezone: string
  validFrom: string | null
  validUntil: string | null
  prompt: string
  modeId: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
}

/**
 * rrule 的 DTSTART 需要"墙上时间",由 tzid 解释。
 * 这里把 ISO 时间换算成目标时区的墙上时间,再用同一 tzid 产出结果,
 * 避免服务器本地时区参与计算(CI 常见 UTC,开发机常见 +08:00)。
 */
function wallClockParts(iso: string, timezone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) throw new ScheduleError(`非法时间: ${iso}`)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour === '24' ? '00' : parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second)
  }
}

function parseRrule(text: string): RRuleInstance {
  const normalized = text.replace(/^RRULE:/i, '').replace(/;?TZID=[^;]+/i, '')
  try {
    return RRuleCtor.fromString(`RRULE:${normalized}`) as RRuleInstance
  } catch (err) {
    throw new ScheduleError(`非法 RRULE: ${(err as Error).message}`)
  }
}

/** 墙上时间 → 真实瞬时:用 Intl 反查该时区在候选时刻的偏移 */
function zonedTimeToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timezone: string
): Date {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  let guess = asUtc
  // 两轮足以覆盖 DST 边界:第一轮取近似偏移,第二轮用修正后的时间再校准
  for (let i = 0; i < 2; i++) {
    const parts = wallClockParts(new Date(guess).toISOString(), timezone)
    const rendered = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s)
    guess += asUtc - rendered
  }
  return new Date(guess)
}

/**
 * rrule 的 dtstart 只能用 Date,且没有独立时区;这里把"目标时区的墙上时间"
 * 编码进 UTC 字段,算完再换回真实瞬时。这样 rrule 内部永远不碰进程本地时区。
 */
function ruleWithStart(text: string, timezone: string, start: Date): RRuleInstance {
  const base = parseRrule(text)
  const parts = wallClockParts(start.toISOString(), timezone)
  const dtstart = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s))
  return new RRuleCtor({ ...base.origOptions, dtstart }) as RRuleInstance
}

function rruleDateToInstant(value: Date, timezone: string): Date {
  return zonedTimeToUtc(
    value.getUTCFullYear(),
    value.getUTCMonth() + 1,
    value.getUTCDate(),
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    timezone
  )
}

/** 计算 after 之后(含同一秒)的第一个发生时间;没有则 null */
export function nextOccurrence(rule: string, after: Date, timezone = DEFAULT_TIMEZONE): Date | null {
  const r = ruleWithStart(rule, timezone, after)
  const found = r.after(new Date(after.getTime() + 1000), true)
  return found ? rruleDateToInstant(found, timezone) : null
}

export interface MissedInfo {
  /** after 之后、now 之前(含)的发生时间 */
  occurrences: Date[]
  count: number
}

/** 统计 (from, now] 之间错过的发生次数,最多数到 cap 次避免长尾 */
export function missedOccurrences(
  rule: string,
  from: Date,
  now: Date,
  timezone = DEFAULT_TIMEZONE,
  cap = 50
): MissedInfo {
  const r = ruleWithStart(rule, timezone, from)
  const occurrences: Date[] = []
  // rrule 的 after() 工作在"墙上时间"域:游标也必须用同一坐标系,
  // 否则每次都拿到同一个发生时间,错过次数会被放大成 cap。
  const fromParts = wallClockParts(from.toISOString(), timezone)
  let cursor = new Date(
    Date.UTC(fromParts.y, fromParts.mo - 1, fromParts.d, fromParts.h, fromParts.mi, fromParts.s) + 1000
  )
  while (occurrences.length < cap) {
    const next = r.after(cursor, true)
    if (!next) break
    const instant = rruleDateToInstant(next, timezone)
    if (instant.getTime() > now.getTime()) break
    occurrences.push(instant)
    cursor = new Date(next.getTime() + 1000)
  }
  return { occurrences, count: occurrences.length }
}

export interface ComputeNextInput {
  scheduleType: 'once' | 'rrule'
  rule?: string | null
  scheduledAt?: string | null
  timezone?: string | null
  validUntil?: string | null
  /** 已经发生的基准时间;一次性任务用 scheduledAt 自身 */
  after: Date
}

/** 下一次应执行时间;一次性任务若已过 scheduledAt 返回 null */
export function computeNextRun(input: ComputeNextInput): string | null {
  const timezone = input.timezone ?? DEFAULT_TIMEZONE
  const validUntil = input.validUntil ? new Date(input.validUntil) : null
  if (validUntil && Number.isNaN(validUntil.getTime())) throw new ScheduleError(`非法 validUntil: ${input.validUntil}`)

  if (input.scheduleType === 'once') {
    if (!input.scheduledAt) throw new ScheduleError('once 任务必须提供 scheduledAt')
    const at = new Date(input.scheduledAt)
    if (Number.isNaN(at.getTime())) throw new ScheduleError(`非法 scheduledAt: ${input.scheduledAt}`)
    if (at.getTime() <= input.after.getTime()) return null
    if (validUntil && at.getTime() > validUntil.getTime()) return null
    return at.toISOString()
  }

  if (!input.rule) throw new ScheduleError('rrule 任务必须提供 rrule')
  const next = nextOccurrence(input.rule, input.after, timezone)
  if (!next) return null
  if (validUntil && next.getTime() > validUntil.getTime()) return null
  return next.toISOString()
}

export type StartupAction =
  | { kind: 'none'; nextRunAt: string | null }
  | { kind: 'run_now'; nextRunAt: string | null; missed: number }
  | { kind: 'skipped'; nextRunAt: string | null; missed: number }
  | { kind: 'reschedule'; nextRunAt: string | null }

/**
 * 启动时对过期任务的决策(WM-AUTO-01):
 *  - 没有 next_run_at → 计算一个未来时间
 *  - 过期且错过 ≤3 次 → 立即补跑一次,并推到未来
 *  - 过期且错过 >3 次 → 不补跑,记录跳过次数并推到未来
 *  - 一次性任务过期即视为错过,补跑一次
 */
export function planStartup(row: AutomationRow, now: Date, maxCatchUp = 3): StartupAction {
  const timezone = row.timezone || DEFAULT_TIMEZONE
  if (row.scheduleType === 'once') {
    if (!row.nextRunAt) {
      const next = computeNextRun({
        scheduleType: 'once',
        scheduledAt: row.scheduledAt,
        timezone,
        validUntil: row.validUntil,
        after: new Date(0)
      })
      return { kind: next ? 'reschedule' : 'none', nextRunAt: next }
    }
    if (new Date(row.nextRunAt).getTime() <= now.getTime()) {
      return { kind: 'run_now', nextRunAt: null, missed: 1 }
    }
    return { kind: 'none', nextRunAt: row.nextRunAt }
  }

  if (!row.rrule) return { kind: 'none', nextRunAt: null }
  const base = row.nextRunAt ? new Date(row.nextRunAt) : null
  if (base && Number.isNaN(base.getTime())) throw new ScheduleError(`非法 nextRunAt: ${row.nextRunAt}`)
  if (!base) {
    return {
      kind: 'reschedule',
      nextRunAt: nextOccurrence(row.rrule, now, timezone)?.toISOString() ?? null
    }
  }
  if (base.getTime() > now.getTime()) return { kind: 'none', nextRunAt: row.nextRunAt }

  const missed = missedOccurrences(row.rrule, base, now, timezone)
  const ahead = nextOccurrence(row.rrule, now, timezone)
  const nextRunAt = ahead ? ahead.toISOString() : null
  if (missed.count === 0) return { kind: 'reschedule', nextRunAt }
  if (missed.count <= maxCatchUp) return { kind: 'run_now', nextRunAt, missed: missed.count }
  return { kind: 'skipped', nextRunAt, missed: missed.count }
}

export interface ClaimInput {
  id: string
  expectedNextRunAt: string | null
  now: Date
  nextRunAt: string | null
}

export interface ClaimStore {
  /** 返回 true 表示抢占成功;必须用条件更新 + 事务实现 */
  claim(input: ClaimInput): boolean
  markResult(id: string, status: string, nextRunAt: string | null): void
}

export class AutomationScheduler {
  constructor(
    private readonly store: ClaimStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * 扫描到期任务。抢占在 store 内完成,两个调度器并发时只有一个能拿到。
   * 返回值是"本次真正抢占成功"的任务 id,调用方据此执行。
   */
  due(rows: AutomationRow[], options: { ignoreEnabled?: boolean; now?: Date } = {}): AutomationRow[] {
    const now = options.now ?? this.now()
    const claimed: AutomationRow[] = []
    for (const row of rows) {
      if (!row.enabled && !options.ignoreEnabled) continue
      if (!row.nextRunAt) continue
      if (new Date(row.nextRunAt).getTime() > now.getTime()) continue
      // 抢占时同步推进 next_run_at:否则两个调度器都会看到旧值并各执行一次
      const advanced =
        row.scheduleType === 'once'
          ? null
          : computeNextRun({
              scheduleType: 'rrule',
              rule: row.rrule,
              timezone: row.timezone,
              validUntil: row.validUntil,
              after: now
            })
      if (this.store.claim({ id: row.id, expectedNextRunAt: row.nextRunAt, now, nextRunAt: advanced })) {
        claimed.push(row)
      }
    }
    return claimed
  }

  finish(row: AutomationRow, status: string, from: Date = this.now()): { nextRunAt: string | null; disable: boolean } {
    const nextRunAt =
      row.scheduleType === 'once'
        ? null
        : computeNextRun({
            scheduleType: 'rrule',
            rule: row.rrule,
            timezone: row.timezone,
            validUntil: row.validUntil,
            after: from
          })
    this.store.markResult(row.id, status, nextRunAt)
    return { nextRunAt, disable: row.scheduleType === 'once' }
  }
}
