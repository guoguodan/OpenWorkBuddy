import { approvalExpiry, type PersistentGrantStore, type SessionGrantStore } from './grants.js'
import type { PathCategory } from './paths.js'
import type { RiskAssessment } from './risk.js'

export type ApprovalScope = 'once' | 'session' | 'always'

export interface ApprovalRequest {
  id: string
  callId: string | null
  conversationId: string
  toolName: string
  groupKey: string
  title: string
  detail: string
  riskKind: RiskAssessment['kind']
  approvalKind?: RiskAssessment['approvalKind']
  argsSummary: string
  path?: string
  pathCategory?: PathCategory
  scopes: ApprovalScope[]
  requestedAt: string
}

export interface ApprovalOutcome {
  approved: boolean
  scope: ApprovalScope
}

export interface GateContext {
  workspaceRoot: string
  conversationId: string
  callId?: string
  now?: () => Date
  ttlDays?: number
  modeAllows: (toolName: string) => boolean
  classifyRisk: (toolName: string, args: Record<string, unknown>) => Promise<RiskAssessment | null>
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalOutcome>
  sessionGrants: SessionGrantStore
  persistentGrants: PersistentGrantStore
  newApprovalId: () => string
  log?: (message: string) => void
}

export type GateVerdict =
  | { action: 'allow' }
  | { action: 'deny'; code: string; message: string; retryable: boolean }
  | { action: 'ask'; risk: RiskAssessment }

export type Decision = Exclude<GateVerdict, { action: 'ask' }>

/** 只保留可读参数,凭据类字段一律掩码;审批卡不能成为泄密通道。 */
export function summarizeArgs(input: Record<string, unknown>, maxChars = 600): string {
  const secretKey = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i
  const seen = new WeakSet<object>()
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 4) return '[深度截断]'
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => walk(item, depth + 1))
    if (typeof value !== 'object') return String(value)
    if (seen.has(value)) return '[循环引用]'
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = secretKey.test(key) ? '[已隐藏]' : walk(item, depth + 1)
    }
    return out
  }
  let text: string
  try {
    text = JSON.stringify(walk(input, 0))
  } catch {
    text = '[无法序列化]'
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

async function hasGrant(risk: RiskAssessment, ctx: GateContext, now: Date): Promise<boolean> {
  // session 授权按会话隔离:换会话必须重新确认,避免"一次同意,处处放行"。
  if (ctx.sessionGrants.has(ctx.conversationId, risk.groupKey)) return true
  return await ctx.persistentGrants.has(risk.groupKey, now)
}

/**
 * 只判定、不询问。把"风险优先"与"模式/路径判定"的先后顺序固化在这里,
 * 便于单测直接覆盖;真正的审批交互在 decide()。
 */
export async function evaluate(
  call: { name: string; arguments: Record<string, unknown> },
  ctx: GateContext
): Promise<GateVerdict> {
  let risk: RiskAssessment | null
  try {
    risk = await ctx.classifyRisk(call.name, call.arguments)
  } catch (err) {
    ctx.log?.(`[gate] 风险分类异常 ${call.name}: ${(err as Error).message}`)
    return {
      action: 'ask',
      risk: {
        kind: 'unknown',
        groupKey: 'gate:unknown',
        title: '无法判定操作风险',
        detail: `风险分类异常,按未知风险处理: ${(err as Error).message}`,
        gateError: true
      }
    }
  }

  const now = ctx.now?.() ?? new Date()

  if (!risk) {
    if (!ctx.modeAllows(call.name)) {
      return { action: 'deny', code: 'MODE_DENIED', message: `当前模式不允许使用 ${call.name}`, retryable: false }
    }
    return { action: 'allow' }
  }

  if (risk.kind === 'unknown') return { action: 'ask', risk }

  if (risk.kind === 'billing' || risk.kind === 'destructive' || risk.kind === 'high-risk') {
    if (await hasGrant(risk, ctx, now)) {
      // 已授权也必须再过模式边界:授权只回答"是否愿意",不扩大工具可见性。
      if (!ctx.modeAllows(call.name)) {
        return { action: 'deny', code: 'MODE_DENIED', message: `当前模式不允许使用 ${call.name}`, retryable: false }
      }
      return { action: 'allow' }
    }
    return { action: 'ask', risk }
  }

  // 路径风险在模式判定之后处理:模式本来就不允许的工具不应弹审批。
  if (!ctx.modeAllows(call.name)) {
    return { action: 'deny', code: 'MODE_DENIED', message: `当前模式不允许使用 ${call.name}`, retryable: false }
  }
  if (risk.kind === 'system-path') {
    return {
      action: 'deny',
      code: 'PATH_SYSTEM_DENIED',
      message: risk.detail,
      retryable: false
    }
  }
  if (risk.kind === 'personal-file') {
    if (await hasGrant(risk, ctx, now)) return { action: 'allow' }
    return { action: 'ask', risk }
  }

  return { action: 'allow' }
}

/**
 * 完整闸门:风险评估 → 模式 → 路径 → 审批 → 执行前置校验。
 * 审批通道异常一律拒绝执行,并标记 retryable,让用户能在界面恢复后重试。
 */
export async function decide(
  call: { name: string; arguments: Record<string, unknown> },
  ctx: GateContext
): Promise<Decision> {
  const verdict = await evaluate(call, ctx)
  if (verdict.action !== 'ask') return verdict

  const risk = verdict.risk
  const now = ctx.now?.() ?? new Date()
  let outcome: ApprovalOutcome
  try {
    outcome = await ctx.requestApproval({
      id: ctx.newApprovalId(),
      callId: ctx.callId ?? null,
      conversationId: ctx.conversationId,
      toolName: call.name,
      groupKey: risk.groupKey,
      title: risk.title,
      detail: risk.detail,
      riskKind: risk.kind,
      ...(risk.approvalKind ? { approvalKind: risk.approvalKind } : {}),
      argsSummary: summarizeArgs(call.arguments),
      ...(risk.path ? { path: risk.path } : {}),
      ...(risk.pathCategory ? { pathCategory: risk.pathCategory } : {}),
      scopes: ['once', 'session', 'always'],
      requestedAt: now.toISOString()
    })
  } catch (err) {
    const code = (err as { code?: unknown }).code
    return {
      action: 'deny',
      code: typeof code === 'string' ? code : 'APPROVAL_UNAVAILABLE',
      message: (err as Error).message,
      retryable: true
    }
  }

  if (!outcome.approved) {
    return { action: 'deny', code: 'USER_DENIED', message: '用户拒绝了该操作', retryable: false }
  }

  // 审批回答的是"是否愿意",不改变模式边界;授权后仍必须回到策略层判定。
  if (!ctx.modeAllows(call.name)) {
    return { action: 'deny', code: 'MODE_DENIED', message: `当前模式不允许使用 ${call.name}`, retryable: false }
  }

  if (outcome.scope === 'session') {
    ctx.sessionGrants.add(ctx.conversationId, risk.groupKey)
  } else if (outcome.scope === 'always') {
    const expiresAt = approvalExpiry(now, ctx.ttlDays)
    await ctx.persistentGrants.add(risk.groupKey, call.name, expiresAt)
  }
  return { action: 'allow' }
}
