import { useEffect, useRef, useState } from 'react'
import {
  IconBell,
  IconBook,
  IconBriefcase,
  IconBulb,
  IconChat,
  IconChevron,
  IconClock,
  IconGrid,
  IconMail,
  IconPlus,
  IconTool
} from './Icons'
import brandIcon from '../assets/brand-icon.svg'

export interface ConversationSummary {
  id: string
  title: string
  modeId: string
  channelId?: string | null
  channelName?: string | null
  updatedAt: string
  lastSeq: number
  messageCount?: number
}

export type MoreEntry =
  | 'projects'
  | 'mailbox'
  | 'tencentDocs'
  | 'ima'
  | 'lexiang'
  | 'inspiration'

interface SidebarProps {
  conversations: ConversationSummary[]
  activeId: string
  busy: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onOpenColleagues: () => void
  onOpenSkills: () => void
  onOpenAutomation: () => void
  onOpenLibrary: () => void
  onOpenMessages: () => void
  unreadMessages: number
  onOpenActivity: () => void
  onOpenSupport: () => void
  onOpenMore: (entry: MoreEntry) => void
  onOpenAccount: () => void
}

function dayLabel(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${sameYear ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`
}

const MORE_ITEMS: Array<{ id: MoreEntry; label: string; icon: typeof IconGrid; beta?: boolean; hint?: string }> = [
  { id: 'projects', label: '项目', icon: IconGrid, beta: true },
  { id: 'mailbox', label: '我的邮箱', icon: IconMail },
  { id: 'tencentDocs', label: '腾讯文档', icon: IconBook },
  { id: 'ima', label: 'ima', icon: IconBook },
  { id: 'lexiang', label: '乐享知识库', icon: IconBook },
  { id: 'inspiration', label: '灵感社区', icon: IconBulb }
]

/**
 * 侧栏与真实产品保持同一信息层级:
 *  品牌/发现应用 → 主导航(新建任务/助理/专家·技能·连接器/定时任务/资料库/更多)
 *  → 任务列表(按日期) → 积分卡片 → 账号栏。
 */
export function Sidebar({
  conversations,
  activeId,
  busy,
  collapsed,
  onToggleCollapse,
  onNew,
  onSelect,
  onDelete,
  onOpenColleagues,
  onOpenSkills,
  onOpenAutomation,
  onOpenLibrary,
  onOpenMessages,
  unreadMessages,
  onOpenActivity,
  onOpenSupport,
  onOpenMore,
  onOpenAccount
}: SidebarProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  return (
    <aside className={`owb-sidebar${collapsed ? ' owb-sidebar--collapsed' : ''}`} data-testid="sidebar">
      <div className="owb-sidebar__brand">
        <button className="owb-brand-mark" onClick={onToggleCollapse} title={collapsed ? '展开侧边栏' : '收起侧边栏'} aria-label="切换侧边栏">
          <img src={brandIcon} alt="" aria-hidden="true" />
        </button>
        <div className="owb-brand-text">
          <div className="owb-brand-title">OpenWorkBuddy</div>
          <div className="owb-brand-sub">V0.0.1</div>
        </div>
        <button className="owb-discover" onClick={onOpenSkills} title="发现应用">
          <IconGrid size={14} />
          <span>发现应用</span>
          <IconChevron size={12} />
        </button>
      </div>

      <nav className="owb-sidebar__nav" aria-label="主导航">
        <button className="owb-nav-item owb-nav-item--primary" onClick={onNew} disabled={busy} data-testid="new-task">
          <IconPlus size={17} />
          <span className="owb-nav-item__label">新建任务</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenColleagues} data-testid="open-colleagues">
          <IconBriefcase size={17} />
          <span className="owb-nav-item__label">助理</span>
          <span className="owb-nav-beta">BETA</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenSkills} data-testid="open-skills">
          <IconTool size={17} />
          <span className="owb-nav-item__label">专家·技能·连接器</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenAutomation} data-testid="open-automation">
          <IconClock size={17} />
          <span className="owb-nav-item__label">定时任务</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenLibrary} data-testid="open-library">
          <IconBook size={17} />
          <span className="owb-nav-item__label">资料库</span>
        </button>
        <div className="owb-more" ref={moreRef}>
          <button
            className={`owb-nav-item${moreOpen ? ' owb-nav-item--open' : ''}`}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            data-testid="open-more"
          >
            <IconGrid size={17} />
            <span className="owb-nav-item__label">更多</span>
            <span className="owb-nav-hint">灵感</span>
          </button>
          {moreOpen ? (
            <div className="owb-more__menu" role="menu">
              {MORE_ITEMS.map((item) => (
                <button
                  key={item.id}
                  role="menuitem"
                  className="owb-more__item"
                  onClick={() => {
                    setMoreOpen(false)
                    onOpenMore(item.id)
                  }}
                >
                  <item.icon size={16} />
                  <span>{item.label}</span>
                  {item.beta ? <span className="owb-nav-beta">BETA</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </nav>

      <div className="owb-sidebar__section">
        <span>任务 ({conversations.length})</span>
      </div>

      <div className="owb-sidebar__list">
        {conversations.length === 0 ? <div className="owb-conv-empty">还没有任务</div> : null}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`owb-conv-item${c.id === activeId ? ' owb-conv-item--active' : ''}`}
            data-testid="conversation-item"
            onClick={() => {
              if (!busy && c.id !== activeId) onSelect(c.id)
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy && c.id !== activeId) onSelect(c.id)
            }}
          >
            <span className="owb-conv-item__title" title={c.title}>
              {c.title}
              {c.channelName ? <span className="owb-conv-item__channel">#{c.channelName}</span> : null}
            </span>
            <span className="owb-conv-item__meta">{dayLabel(c.updatedAt)}</span>
            <button
              className="owb-conv-item__del"
              title="删除任务"
              aria-label={`删除任务 ${c.title}`}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                onDelete(c.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="owb-promo">
        <div className="owb-promo__title">做任务赢积分好礼</div>
        <div className="owb-promo__sub">连签抽取 Buddy 周边</div>
        <button className="owb-promo__cta" onClick={onOpenActivity}>立即前往</button>
      </div>

      <div className="owb-sidebar__footer">
        <button className="owb-account" onClick={onOpenAccount} title="账号与设置">
          <span className="owb-account__avatar">蜗</span>
          <span className="owb-account__name">坐房顶吹风的蜗牛先生</span>
        </button>
        <div className="owb-account__actions">
          <button
            className="owb-icon-btn owb-notifications-btn"
            title="通知"
            aria-label={unreadMessages > 0 ? `通知，${unreadMessages} 条未读` : '通知'}
            onClick={onOpenMessages}
          >
            <IconBell size={17} />
            {unreadMessages > 0 ? <span className="owb-notifications-btn__dot" data-testid="notifications-badge" /> : null}
          </button>
          <button className="owb-icon-btn" title="客服" aria-label="客服" onClick={onOpenSupport}>
            <IconChat size={17} />
          </button>
        </div>
      </div>
    </aside>
  )
}
