import type { ApprovalOutcome, ApprovalRequest, ApprovalScope } from '@openwb/security'

export class ApprovalUnavailableError extends Error {
  readonly code: string
  readonly retryable = true

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApprovalUnavailableError'
    this.code = code
  }
}

interface PendingApproval {
  request: ApprovalRequest
  resolve: (outcome: ApprovalOutcome) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export interface ApprovalBridgeOptions {
  emit: (event: Record<string, unknown>) => void
  newId: () => string
  timeoutMs?: number
  maxPending?: number
  /** 通知中心落库钩子:必须在 emit 之外单独失败,不能影响审批本身 */
  onRequest?: (request: ApprovalRequest) => void
  log?: (message: string) => void
}

const VALID_SCOPES: readonly ApprovalScope[] = ['once', 'session', 'always']

/**
 * 审批往返桥。
 *
 * 三条 fail-closed 规则:
 *  1. 界面未声明就绪 → 立即失败(可重试),不排队等一个不会来的回答;
 *  2. 超时/断连 → 失败(可重试);
 *  3. 回答里的 scope 非法 → 当作拒绝,绝不默认成 always。
 */
export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>()
  private uiReady = false
  private readonly timeoutMs: number
  private readonly maxPending: number

  constructor(private readonly options: ApprovalBridgeOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxPending = options.maxPending ?? 16
  }

  markReady(): void {
    this.uiReady = true
  }

  markDisconnected(): void {
    this.uiReady = false
    this.cancelAll('界面已断开,未执行该操作')
  }

  isReady(): boolean {
    return this.uiReady
  }

  newId(): string {
    return this.options.newId()
  }

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (!this.uiReady) {
      throw new ApprovalUnavailableError(
        'APPROVAL_UNAVAILABLE',
        '界面未就绪,无法请求授权。请打开界面后重试;本次操作没有执行。'
      )
    }
    if (this.pending.size >= this.maxPending) {
      throw new ApprovalUnavailableError('APPROVAL_BUSY', '待处理授权过多,请先处理现有审批后重试。')
    }

    return await new Promise<ApprovalOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        this.options.emit({ type: 'approval.expired', approvalId: request.id, toolName: request.toolName })
        reject(
          new ApprovalUnavailableError('APPROVAL_TIMEOUT', '等待授权超时,本次操作没有执行。可以重试。')
        )
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(request.id, { request, resolve, reject, timer })
      try {
        this.options.onRequest?.(request)
      } catch (err) {
        this.options.log?.(`通知写入失败: ${(err as Error).message}`)
      }
      this.options.emit({ type: 'approval.request', request })
    })
  }

  respond(input: unknown): { ok: boolean; code?: string; message?: string } {
    const record = (input ?? {}) as Record<string, unknown>
    const approvalId = typeof record.approvalId === 'string' ? record.approvalId : ''
    if (!approvalId) return { ok: false, code: 'BAD_APPROVAL', message: '缺少 approvalId' }
    const entry = this.pending.get(approvalId)
    if (!entry) return { ok: false, code: 'APPROVAL_NOT_FOUND', message: '该授权请求已结束或不存在' }

    // UI 只能回答"同意/拒绝 + 范围",不能改工具或组;组键始终以服务端请求为准。
    const approved = record.approved === true
    const scopeRaw = record.scope
    const scope = VALID_SCOPES.includes(scopeRaw as ApprovalScope)
      ? (scopeRaw as ApprovalScope)
      : undefined
    if (approved && !scope) {
      return { ok: false, code: 'BAD_SCOPE', message: '授权范围必须是 once / session / always' }
    }

    clearTimeout(entry.timer)
    this.pending.delete(approvalId)
    const outcome: ApprovalOutcome = approved
      ? { approved: true, scope: scope! }
      : { approved: false, scope: 'once' }
    this.options.emit({
      type: 'approval.resolved',
      approvalId,
      toolName: entry.request.toolName,
      approved: outcome.approved,
      scope: outcome.scope
    })
    entry.resolve(outcome)
    return { ok: true }
  }

  /** 用户停止生成:当前等待授权的操作必须直接作废,不能继续挂到超时。 */
  cancelForConversation(conversationId: string, reason: string): number {
    let cancelled = 0
    for (const [id, entry] of this.pending) {
      if (entry.request.conversationId !== conversationId) continue
      clearTimeout(entry.timer)
      this.pending.delete(id)
      this.options.emit({ type: 'approval.cancelled', approvalId: id, toolName: entry.request.toolName })
      entry.reject(new ApprovalUnavailableError('APPROVAL_CANCELLED', reason))
      cancelled++
    }
    return cancelled
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  cancelAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      this.options.emit({ type: 'approval.cancelled', approvalId: id, toolName: entry.request.toolName })
      entry.reject(new ApprovalUnavailableError('APPROVAL_UNAVAILABLE', reason))
    }
  }
}
