import { useCallback, useEffect, useState } from 'react'
import { IconBook, IconCheck, IconLink, IconMail, IconRefresh, IconX } from './Icons'

interface ConnectionsPanelProps {
  provider: ServiceProviderInfo
  onClose: () => void
  onNotify: (kind: 'system' | 'info', text: string) => void
}

interface ProviderMeta {
  id: ServiceProviderInfo
  label: string
  short: string
  description: string
  endpointLabel: string
  endpointPlaceholder: string
  accountLabel: string
  accountPlaceholder: string
  icon: typeof IconMail
}

export const SERVICE_META: ProviderMeta[] = [
  {
    id: 'mailbox',
    label: '我的邮箱',
    short: '邮箱',
    description: '把邮件里的上下文带进任务。连接后，本轮可按你的授权读取邮件摘要与附件。',
    endpointLabel: '邮箱服务地址',
    endpointPlaceholder: 'https://mail.example.com',
    accountLabel: '邮箱账号',
    accountPlaceholder: 'name@example.com',
    icon: IconMail
  },
  {
    id: 'tencentDocs',
    label: '腾讯文档',
    short: '腾讯文档',
    description: '读取团队文档与表格，作为任务上下文。仅保存服务地址与账号，不保存令牌。',
    endpointLabel: '文档服务地址',
    endpointPlaceholder: 'https://docs.qq.com',
    accountLabel: '账号标识',
    accountPlaceholder: '例如：产品组共享账号',
    icon: IconBook
  },
  {
    id: 'ima',
    label: 'ima',
    short: 'ima',
    description: '接入 ima 知识库，把沉淀资料作为可检索来源。没有可用凭据时不会显示为已连接。',
    endpointLabel: 'ima 服务地址',
    endpointPlaceholder: 'https://ima.example.com',
    accountLabel: '知识库标识',
    accountPlaceholder: '例如：产品知识库',
    icon: IconBook
  },
  {
    id: 'lexiang',
    label: '乐享知识库',
    short: '乐享',
    description: '接入乐享知识库，让任务引用内部规范与历史结论。连接状态由真实地址校验决定。',
    endpointLabel: '乐享服务地址',
    endpointPlaceholder: 'https://lexiang.example.com',
    accountLabel: '空间标识',
    accountPlaceholder: '例如：研发中心',
    icon: IconBook
  }
]

const STATUS_TEXT: Record<ServiceStatusInfo, string> = {
  not_connected: '未连接',
  connecting: '配置中',
  connected: '已连接',
  error: '连接异常'
}

function statusClass(status: ServiceStatusInfo): string {
  if (status === 'connected') return 'owb-connection-status owb-connection-status--ok'
  if (status === 'error') return 'owb-connection-status owb-connection-status--error'
  if (status === 'connecting') return 'owb-connection-status owb-connection-status--pending'
  return 'owb-connection-status'
}

/**
 * 第三方服务连接面板。
 *
 * 这里只做"托管配置 + 状态核对",不伪造 OAuth 授权结果:
 * 用户提交后由存储层校验地址,非法地址会落成 error,不会显示成已连接。
 */
export function ConnectionsPanel({ provider, onClose, onNotify }: ConnectionsPanelProps) {
  const [active, setActive] = useState<ServiceProviderInfo>(provider)
  const [connections, setConnections] = useState<ServiceConnectionInfo[]>([])
  const [endpoint, setEndpoint] = useState('')
  const [account, setAccount] = useState('')
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)

  const meta = SERVICE_META.find((item) => item.id === active) ?? SERVICE_META[0]!
  const current = connections.find((item) => item.provider === active)

  const refresh = useCallback(async () => {
    try {
      const r = await window.openwb.connections.list()
      setConnections(r.connections)
    } catch (err) {
      onNotify('system', `服务连接状态加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    setActive(provider)
  }, [provider])

  useEffect(() => {
    setEndpoint(current?.endpoint ?? '')
    setAccount(current?.account ?? '')
  }, [current?.endpoint, current?.account, active])

  const connect = async () => {
    if (!endpoint.trim()) {
      onNotify('system', '请先填写服务地址')
      return
    }
    setWorking(true)
    try {
      const r = await window.openwb.connections.set({
        provider: active,
        status: 'connected',
        endpoint: endpoint.trim(),
        account: account.trim() || null
      })
      await refresh()
      if (r.connection.status === 'connected') {
        onNotify('info', `${meta.label}已连接: ${r.connection.endpoint ?? ''}`)
      } else {
        onNotify('system', r.connection.lastError ?? '连接校验失败')
      }
    } catch (err) {
      onNotify('system', `连接失败: ${(err as Error).message}`)
    } finally {
      setWorking(false)
    }
  }

  const disconnect = async () => {
    setWorking(true)
    try {
      await window.openwb.connections.disconnect(active)
      await refresh()
      onNotify('info', `已断开${meta.label}`)
    } catch (err) {
      onNotify('system', `断开失败: ${(err as Error).message}`)
    } finally {
      setWorking(false)
    }
  }

  return (
    <section
      className="owb-sheet owb-sheet--wide"
      role="dialog"
      aria-modal="true"
      aria-label={meta.label}
      data-testid="connection-panel"
    >
      <header className="owb-sheet__header">
        <div>
          <h2>{meta.label}</h2>
          <p>连接后，任务可在授权范围内引用该服务的内容</p>
        </div>
        <button className="owb-icon-btn" onClick={onClose} aria-label={`关闭${meta.label}`}>
          <IconX size={16} />
        </button>
      </header>

      <div className="owb-sheet__body">
        <div className="owb-connection-tabs" role="tablist" aria-label="服务">
          {SERVICE_META.map((item) => {
            const state = connections.find((c) => c.provider === item.id)?.status ?? 'not_connected'
            return (
              <button
                key={item.id}
                role="tab"
                aria-selected={active === item.id}
                className={`owb-connection-tab${active === item.id ? ' owb-connection-tab--on' : ''}`}
                onClick={() => setActive(item.id)}
                data-testid={`connection-provider-${item.id}`}
              >
                <item.icon size={15} />
                <span>{item.short}</span>
                {state === 'connected' ? <IconCheck size={12} /> : null}
              </button>
            )
          })}
        </div>

        <div className="owb-connection-card" data-testid="connection-card" data-provider={active}>
          <div className="owb-card__head">
            <div className="owb-card__title owb-card__title--colleague">
              <span className="owb-card__icon">
                <meta.icon size={17} />
              </span>
              <span>
                {meta.label}
                <span className={statusClass(current?.status ?? 'not_connected')} data-testid="connection-status">
                  {loading ? '读取中' : STATUS_TEXT[current?.status ?? 'not_connected']}
                </span>
              </span>
            </div>
            <button
              className="owb-icon-btn"
              onClick={() => void refresh()}
              aria-label="刷新连接状态"
              data-testid="connection-refresh"
            >
              <IconRefresh size={14} />
            </button>
          </div>
          <p className="owb-card__text">{meta.description}</p>
          {current?.endpoint ? (
            <div className="owb-card__sub">
              服务地址：{current.endpoint}
              {current.account ? ` · 账号：${current.account}` : ''}
            </div>
          ) : null}
          {current?.lastError ? (
            <div className="owb-status owb-status--error" data-testid="connection-error">
              {current.lastError}
            </div>
          ) : null}
        </div>

        <div className="owb-connection-form">
          <label className="owb-field">
            <span>{meta.endpointLabel}</span>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={meta.endpointPlaceholder}
              data-testid="connection-endpoint"
            />
          </label>
          <label className="owb-field">
            <span>{meta.accountLabel}</span>
            <input
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder={meta.accountPlaceholder}
              data-testid="connection-account"
            />
          </label>
          <div className="owb-connection-note">
            <IconLink size={14} />
            <span>
              提交后会实际探测服务地址（5 秒超时），服务正常响应才会显示已连接。仅保存服务域名与账号别名；查询串、令牌和密码不会写入本地数据库。
            </span>
          </div>
          <div className="owb-form__actions">
            {current?.status === 'connected' || current?.status === 'error' ? (
              <button
                className="owb-sheet__action"
                onClick={() => void disconnect()}
                disabled={working}
                data-testid="connection-disconnect"
              >
                断开连接
              </button>
            ) : null}
            <button
              className="owb-sheet__primary"
              onClick={() => void connect()}
              disabled={working || loading}
              data-testid="connection-connect"
            >
              {working ? '校验中…' : current?.status === 'connected' ? '更新连接' : '连接'}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
