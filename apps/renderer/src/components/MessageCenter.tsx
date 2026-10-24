import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconBell, IconCheck, IconTrash, IconX } from './Icons'

export type NotificationItem = NotificationInfo

interface MessageCenterProps {
  open: boolean
  onClose: () => void
  onOpenConversation: (conversationId: string) => void
  onNotify: (kind: 'system' | 'info', text: string) => void
  onUnreadChange: (unread: number) => void
}

type Tab = 'all' | 'pending'

/** 真实产品的相对时间文案;超过一周直接给日期,避免“12 天前”这种不好定位的表述 */
function timeLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Math.max(0, now - t)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return new Date(t).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

function bizLabel(biz: NotificationItem['biz']): string {
  switch (biz) {
    case 'task':
      return '任务'
    case 'automation':
      return '定时任务'
    case 'approval':
      return '待确认'
    default:
      return '系统'
  }
}

/**
 * 消息中心抽屉。
 *
 * 数据全部来自 daemon 的真实通知表,不在前端伪造。打开时总是重新拉取,
 * 避免用户刚完成一个任务却看不到新提醒。
 */
export function MessageCenter({ open, onClose, onOpenConversation, onNotify, onUnreadChange }: MessageCenterProps) {
  const [tab, setTab] = useState<Tab>('all')
  const [items, setItems] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await window.openwb.notifications.list({ limit: 200 })
      setItems(r.notifications)
      onUnreadChange(r.unread)
    } catch (err) {
      onNotify('system', `消息加载失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify, onUnreadChange])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const visible = useMemo(
    () => (tab === 'pending' ? items.filter((item) => item.isPending) : items),
    [items, tab]
  )

  const pendingCount = items.filter((item) => item.isPending).length
  const unreadCount = items.filter((item) => !item.isRead).length

  const markRead = async (item: NotificationItem) => {
    if (item.isRead) return
    setWorking(item.id)
    try {
      const r = await window.openwb.notifications.read(item.id)
      setItems((list) => list.map((x) => (x.id === item.id ? r.notification : x)))
      onUnreadChange(r.unread)
    } catch (err) {
      onNotify('system', `标记已读失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const markAll = async () => {
    setWorking('all')
    try {
      const r = await window.openwb.notifications.readAll()
      setItems((list) => list.map((item) => ({ ...item, isRead: true })))
      onUnreadChange(r.unread)
      onNotify('info', r.changed > 0 ? `已将 ${r.changed} 条消息标为已读` : '没有未读消息')
    } catch (err) {
      onNotify('system', `全部已读失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const remove = async (item: NotificationItem) => {
    setWorking(item.id)
    try {
      const r = await window.openwb.notifications.remove(item.id)
      setItems((list) => list.filter((x) => x.id !== item.id))
      onUnreadChange(r.unread)
    } catch (err) {
      onNotify('system', `删除失败: ${(err as Error).message}`)
    } finally {
      setWorking(null)
    }
  }

  const toggleExpand = (item: NotificationItem) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
    void markRead(item)
  }

  const openConversation = async (item: NotificationItem) => {
    void markRead(item)
    if (item.conversationId) onOpenConversation(item.conversationId)
    onClose()
  }

  if (!open) return null

  return (
    <div className="owb-messages__overlay" role="presentation" onClick={(e) => {
      if (e.target === e.currentTarget) onClose()
    }}>
      <section className="owb-messages" role="dialog" aria-modal="false" aria-label="消息中心" data-testid="message-center">
        <header className="owb-messages__header">
          <h2>消息中心</h2>
          <div className="owb-messages__header-actions">
            <button
              className="owb-messages__read-all"
              onClick={() => void markAll()}
              disabled={working !== null || unreadCount === 0}
            >
              <IconCheck size={14} />
              全部已读
            </button>
            <button className="owb-icon-btn" onClick={onClose} aria-label="关闭消息中心">
              <IconX size={16} />
            </button>
          </div>
        </header>

        <div className="owb-messages__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'all'}
            className={`owb-messages__tab${tab === 'all' ? ' owb-messages__tab--on' : ''}`}
            onClick={() => setTab('all')}
          >
            全部
            {unreadCount > 0 ? <span className="owb-messages__count">{unreadCount}</span> : null}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'pending'}
            className={`owb-messages__tab${tab === 'pending' ? ' owb-messages__tab--on' : ''}`}
            onClick={() => setTab('pending')}
          >
            待处理
            {pendingCount > 0 ? <span className="owb-messages__count">{pendingCount}</span> : null}
          </button>
        </div>

        <div className="owb-messages__list">
          {loading ? <div className="owb-empty">加载中…</div> : null}
          {!loading && visible.length === 0 ? (
            <div className="owb-empty owb-messages__empty">
              <IconBell size={30} />
              <strong>{tab === 'pending' ? '没有待处理的消息' : '暂无消息'}</strong>
              <span>任务完成、定时执行结果与待确认操作会出现在这里。</span>
            </div>
          ) : null}
          {visible.map((item) => {
            const isExpanded = expanded.has(item.id)
            return (
              <article
                key={item.id}
                className={`owb-message${item.isRead ? '' : ' owb-message--unread'}${item.isPending ? ' owb-message--pending' : ''}`}
                data-testid="notification-item"
                onClick={() => toggleExpand(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toggleExpand(item)
                  }
                }}
                role="button"
                tabIndex={0}
              >
                {!item.isRead ? <span className="owb-message__dot" aria-hidden="true" /> : null}
                <div className="owb-message__head">
                  <span className={`owb-message__tag owb-message__tag--${item.biz}`}>{bizLabel(item.biz)}</span>
                  <span className="owb-message__time">{timeLabel(item.createdAt)}</span>
                </div>
                <div className="owb-message__title">{item.title}</div>
                {item.summary ? (
                  <p className={`owb-message__summary${isExpanded ? ' owb-message__summary--open' : ''}`}>{item.summary}</p>
                ) : null}
                <div className="owb-message__actions">
                  {item.conversationId ? (
                    <button
                      className="owb-message__action"
                      onClick={(e) => {
                        e.stopPropagation()
                        void openConversation(item)
                      }}
                    >
                      查看详情
                    </button>
                  ) : item.isPending ? (
                    <span className="owb-message__hint">请在审批弹窗中处理</span>
                  ) : null}
                  {!item.isRead ? (
                    <button
                      className="owb-message__action"
                      disabled={working !== null}
                      onClick={(e) => {
                        e.stopPropagation()
                        void markRead(item)
                      }}
                    >
                      标为已读
                    </button>
                  ) : null}
                  <button
                    className="owb-message__action owb-message__action--danger"
                    disabled={working !== null}
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(item)
                    }}
                    aria-label={`删除消息 ${item.title}`}
                  >
                    <IconTrash size={13} />
                    删除
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}
