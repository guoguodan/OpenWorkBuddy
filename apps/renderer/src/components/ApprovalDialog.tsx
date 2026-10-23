import { useEffect, useState } from 'react'
import { IconCheck, IconTool, IconX } from './Icons'

export type ApprovalScope = 'once' | 'session' | 'always'

export interface ApprovalRequestInfo {
  id: string
  callId: string | null
  conversationId: string
  toolName: string
  groupKey: string
  title: string
  detail: string
  riskKind: string
  argsSummary: string
  path?: string
  pathCategory?: string
  plan?: {
    operation: 'delete' | 'move'
    items: Array<{ path: string; kind: 'file' | 'directory'; size: number; destPath?: string }>
    totalBytes: number
    batchLimit: number
  }
  scopes: ApprovalScope[]
  requestedAt: string
}

export interface ApprovalGrantInfo {
  id: string
  scope: string
  groupKey: string
  toolName: string
  grantedAt: string
  expiresAt: string | null
}

interface ApprovalDialogProps {
  request: ApprovalRequestInfo
  onRespond: (input: { approvalId: string; approved: boolean; scope?: ApprovalScope }) => Promise<void>
}

const SCOPE_LABEL: Record<ApprovalScope, string> = {
  once: '仅本次',
  session: '本次会话',
  always: '始终允许(30 天)'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 审批卡只暴露与本次工具调用相关的信息,不提供"所有工具"批量授权。 */
export function ApprovalDialog({ request, onRespond }: ApprovalDialogProps) {
  const [scope, setScope] = useState<ApprovalScope>('once')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setScope('once')
    setError('')
  }, [request.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) void respond(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const respond = async (approved: boolean) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onRespond({
        approvalId: request.id,
        approved,
        ...(approved ? { scope } : {})
      })
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="owb-approval-overlay" role="presentation">
      <section
        className="owb-approval"
        role="dialog"
        aria-modal="true"
        aria-labelledby="owb-approval-title"
        data-testid="approval-dialog"
      >
        <header className="owb-approval__header">
          <span className={`owb-approval__risk owb-approval__risk--${request.riskKind}`}>
            <IconTool size={14} /> 需要你的确认
          </span>
          <button
            className="owb-icon-btn"
            disabled={busy}
            onClick={() => void respond(false)}
            aria-label="拒绝并关闭"
          >
            <IconX size={14} />
          </button>
        </header>

        <div className="owb-approval__body">
          <h2 className="owb-approval__title" id="owb-approval-title">{request.title}</h2>
          <p className="owb-approval__detail">{request.detail}</p>

          <dl className="owb-approval__meta">
            <div><dt>工具</dt><dd><code>{request.toolName}</code></dd></div>
            <div><dt>请求时间</dt><dd>{new Date(request.requestedAt).toLocaleTimeString()}</dd></div>
            {request.path ? (
              <div><dt>目标路径</dt><dd className="owb-approval__path">{request.path}</dd></div>
            ) : null}
          </dl>

          <div className="owb-approval__args">
            <div className="owb-approval__args-title">参数摘要</div>
            <pre>{request.argsSummary}</pre>
          </div>

          {request.plan ? (
            <div className="owb-approval__plan" data-testid="approval-plan">
              <div className="owb-approval__args-title">
                {request.plan.operation === 'delete' ? '将删除以下内容' : '将移动以下内容'}
                <span className="owb-approval__plan-count">
                  {request.plan.items.length} / {request.plan.batchLimit} 项 · {formatBytes(request.plan.totalBytes)}
                </span>
              </div>
              <ul className="owb-approval__plan-list">
                {request.plan.items.map((item) => (
                  <li key={item.path} className="owb-approval__plan-item">
                    <span className="owb-approval__path" title={item.path}>{item.path}</span>
                    <span className="owb-approval__plan-meta">
                      {item.kind === 'directory' ? '目录' : '文件'} · {formatBytes(item.size)}
                    </span>
                    {item.destPath ? (
                      <span className="owb-approval__plan-dest">→ {item.destPath}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="owb-approval__plan-note">
                执行前会先备份到应用数据目录;删除会送入系统回收站。备份位置会在结果中给出。
              </p>
            </div>
          ) : null}

          <fieldset className="owb-approval__scopes" disabled={busy}>
            <legend>授权范围</legend>
            {(request.scopes ?? []).map((item) => (
              <label key={item} className={scope === item ? 'owb-approval__scope owb-approval__scope--active' : 'owb-approval__scope'}>
                <input
                  type="radio"
                  name={`approval-scope-${request.id}`}
                  value={item}
                  checked={scope === item}
                  onChange={() => setScope(item)}
                />
                <span>{SCOPE_LABEL[item]}</span>
              </label>
            ))}
          </fieldset>
          <p className="owb-approval__note">
            授权只对同一工具组生效,不会放行其他工具。
            {request.plan ? '删除/移动只允许本次确认,不能使用长期授权。' : ''}
            拒绝时本次操作不会执行。
          </p>
          {error ? <p className="owb-approval__error">{error}</p> : null}
        </div>

        <footer className="owb-approval__footer">
          <button className="owb-approval__btn" disabled={busy} onClick={() => void respond(false)}>
            拒绝
          </button>
          <button
            className="owb-approval__btn owb-approval__btn--primary"
            disabled={busy}
            data-testid="approval-allow"
            onClick={() => void respond(true)}
          >
            <IconCheck size={14} /> 允许
          </button>
        </footer>
      </section>
    </div>
  )
}

interface GrantListProps {
  grants: ApprovalGrantInfo[]
  onRevoke: (groupKey: string) => Promise<void>
}

/** 授权管理表:让用户能看见并撤销"始终允许",而不是只能等 30 天。 */
export function ApprovalGrantList({ grants, onRevoke }: GrantListProps) {
  const [busy, setBusy] = useState<string | null>(null)
  if (grants.length === 0) return <div className="owb-approval__note">暂无长期授权。</div>
  return (
    <ul className="owb-approval__grants">
      {grants.map((grant) => (
        <li key={grant.id} className="owb-approval__grant">
          <div className="owb-approval__grant-main">
            <code>{grant.toolName}</code>
            <span className="owb-approval__grant-key">{grant.groupKey}</span>
          </div>
          <span className="owb-approval__grant-expiry">
            {grant.expiresAt ? `${new Date(grant.expiresAt).toLocaleDateString()} 到期` : '长期有效'}
          </span>
          <button
            className="owb-approval__revoke"
            disabled={busy === grant.groupKey}
            onClick={() => {
              setBusy(grant.groupKey)
              void onRevoke(grant.groupKey).finally(() => setBusy(null))
            }}
          >
            撤销
          </button>
        </li>
      ))}
    </ul>
  )
}
