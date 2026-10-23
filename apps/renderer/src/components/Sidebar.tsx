import { useEffect, useRef, useState } from 'react'
import {
  IconBrain,
  IconChat,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSparkle,
  IconSun,
  IconTool,
  IconTrash
} from './Icons'

export interface ConversationSummary {
  id: string
  title: string
  modeId: string
  updatedAt: string
  lastSeq: number
}

interface SidebarProps {
  conversations: ConversationSummary[]
  activeId: string
  busy: boolean
  collapsed: boolean
  theme: 'light' | 'dark'
  memoryCount: number
  model: string
  skillCount: number
  focusSearchToken: number
  onToggleCollapse: () => void
  onToggleTheme: () => void
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onToggleMemory: () => void
  onOpenSkills: () => void
  onOpenConnectors: () => void
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function shortModel(model: string): string {
  if (!model || model === 'unknown') return '本地模型'
  const tail = model.split('/').pop() ?? model
  return tail.length > 20 ? `${tail.slice(0, 19)}…` : tail
}

export function Sidebar({
  conversations,
  activeId,
  busy,
  collapsed,
  theme,
  memoryCount,
  model,
  skillCount,
  focusSearchToken,
  onToggleCollapse,
  onToggleTheme,
  onNew,
  onSelect,
  onDelete,
  onToggleMemory,
  onOpenSkills,
  onOpenConnectors
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const filtered = query.trim()
    ? conversations.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()))
    : conversations

  useEffect(() => {
    if (focusSearchToken > 0) {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }, [focusSearchToken])

  return (
    <aside className={`owb-sidebar${collapsed ? ' owb-sidebar--collapsed' : ''}`}>
      <div className="owb-sidebar__brand">
        <div className="owb-brand-mark">W</div>
        <div className="owb-brand-text">
          <div className="owb-brand-title">OpenWorkBuddy</div>
          <div className="owb-brand-sub">V0.0.1</div>
        </div>
        <button
          className="owb-model-pill"
          title={`当前模型:${model || '未知'}`}
          onClick={onOpenConnectors}
        >
          <IconSparkle size={13} />
          <span className="owb-model-pill__text">{shortModel(model)}</span>
        </button>
      </div>

      <div className="owb-sidebar__search">
        <div className="owb-search-pill">
          <IconSearch size={15} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
        </div>
      </div>

      <nav className="owb-sidebar__nav">
        <button className="owb-nav-item" onClick={onNew} disabled={busy}>
          <IconPlus size={17} />
          <span className="owb-nav-item__label">新会话</span>
        </button>
        <button className="owb-nav-item" onClick={onToggleMemory}>
          <IconBrain size={17} />
          <span className="owb-nav-item__label">记忆{memoryCount > 0 ? ` (${memoryCount})` : ''}</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenSkills}>
          <IconTool size={17} />
          <span className="owb-nav-item__label">专家 · 技能{skillCount > 0 ? ` (${skillCount})` : ''}</span>
        </button>
        <button className="owb-nav-item" onClick={onOpenConnectors}>
          <IconSparkle size={17} />
          <span className="owb-nav-item__label">模型 · 连接器</span>
        </button>
      </nav>

      <div className="owb-sidebar__section">
        <span>任务 ({filtered.length})</span>
      </div>

      <div className="owb-sidebar__list">
        {filtered.length === 0 && (
          <div className="owb-conv-empty">
            {query ? '没有匹配的会话' : '还没有会话'}
          </div>
        )}
        {filtered.map((c) => (
          <div
            key={c.id}
            className={`owb-conv-item${c.id === activeId ? ' owb-conv-item--active' : ''}`}
            data-testid="conversation-item"
            onClick={() => { if (!busy && c.id !== activeId) onSelect(c.id) }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy && c.id !== activeId) onSelect(c.id) }}
          >
            <IconChat size={16} className="owb-conv-item__icon" />
            <span className="owb-conv-item__title" title={c.title}>{c.title}</span>
            <span className="owb-conv-item__meta">{formatRelative(c.updatedAt)}</span>
            <button
              className="owb-conv-item__del"
              title="删除会话"
              aria-label={`删除会话 ${c.title}`}
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); onDelete(c.id) }}
            >
              <IconTrash size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="owb-sidebar__footer">
        <button className="owb-nav-item" onClick={onToggleTheme}>
          {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
          <span className="owb-nav-item__label">{theme === 'dark' ? '浅色主题' : '深色主题'}</span>
        </button>
      </div>
    </aside>
  )
}